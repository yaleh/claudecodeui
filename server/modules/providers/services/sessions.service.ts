import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted, chatRunRegistry } from '@/modules/websocket/index.js';
import { compileStoredSessionFilter } from '@/modules/projects/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
import type { SessionLifecycleReading } from '@/modules/session-hosts/index.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  HostCloseReason,
  HostMode,
  LLMProvider,
  NormalizedMessage,
  ProcessHost,
} from '@/shared/types.js';
import { AppError, sliceTailPage } from '@/shared/utils.js';

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  sessionName: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
  /** App id of the session this one was branched from; null when it started on its own. */
  forkedFromSessionId: string | null;
};

type RecentSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity' | 'forkedFromSessionId'
>;

type RecentSessionsPage = {
  conversations: RecentSessionListItem[];
  total: number;
  hasMore: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isArchived: boolean;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
  } | null;
};

const MAX_CLOUDCLI_SESSION_NAME_WORDS = 4;

function buildCloudCliSessionName(initialMessage: string): string {
  const words = initialMessage.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_CLOUDCLI_SESSION_NAME_WORDS).join(' ') || 'Untitled Session';
}

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Writes one rename through to the provider's own store, best-effort.
 *
 * A rename in this app is stored in the app's database first and written to the
 * provider's store second, so nothing here is allowed to fail the request: the
 * name the user sees has already changed by the time this runs.
 *
 * Skipped — silently, because each case is a complete answer rather than a
 * failure — when the provider keeps no writable title, when the row has no
 * transcript yet (an app-created session whose first run has not produced a
 * file), and when the file the row points at is gone. A rejection from the
 * provider is logged and swallowed for the same reason: surfacing it would make
 * a disk problem look like a rejected rename.
 *
 * The file is checked here rather than left to the provider because providers
 * locate the transcript themselves from the session's working directory; a row
 * whose file is already gone has to be a skip, and the two must not be
 * distinguishable by whether the request succeeded.
 */
async function writeRenameToProviderTranscript(
  session: {
    session_id: string;
    provider: string;
    provider_session_id: string | null;
    project_path: string | null;
    jsonl_path: string | null;
  },
  title: string,
): Promise<void> {
  try {
    const rename = providerRegistry.resolveProvider(session.provider).rename;
    if (!rename) {
      return;
    }

    const transcriptPath = session.jsonl_path;
    if (!transcriptPath || !session.provider_session_id) {
      return;
    }

    try {
      await fsp.stat(transcriptPath);
    } catch {
      return;
    }

    await rename.renameSession({
      providerSessionId: session.provider_session_id,
      projectPath: session.project_path ?? '',
      title,
    });
  } catch (error) {
    console.warn(
      `[sessions] could not write the rename of session "${session.session_id}" back to the "${session.provider}" store:`,
      error,
    );
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return chatRunRegistry.listRunningRuns();
  },

  /**
   * Returns the active conversation feed in true global activity order.
   */
  listRecentSessions(limit: number, offset: number): RecentSessionsPage {
    const page = sessionsDb.getRecentSessionsPage(limit, offset, (sessionName, filterJson) =>
      compileStoredSessionFilter(filterJson)(sessionName),
    );
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const conversations = page.sessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        // Carried so the recents list can mark a branch even though the source
        // it was forked from is usually on another project's page.
        forkedFromSessionId: session.forked_from_session_id ?? null,
      };
    });

    return {
      conversations,
      total: page.total,
      hasMore: offset + conversations.length < page.total,
    };
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run. Its title
   * comes directly from the first visible CloudCLI message and is limited to
   * four whole words before any provider-owned storage exists.
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    initialMessage: string,
  ): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    // The id is minted here, and the row is written before this call returns:
    // no client can name the session before its row exists, which is what keeps
    // a first message's permission mode from ever arriving ahead of the row it
    // belongs to (see the send path's `resolveSendTarget`).
    const sessionId = randomUUID();
    const sessionName = buildCloudCliSessionName(initialMessage);
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, sessionName);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
      sessionName,
    };
  },

  /**
   * Branches a session into an independent one containing its conversation up
   * to `upToAnchorId` (the whole thing when omitted).
   *
   * The source is left completely untouched — this is the "try two approaches"
   * action, not a destructive one.
   */
  async forkSessionById(
    sessionId: string,
    options: { upToAnchorId?: string; title?: string } = {},
  ): Promise<CreateAppSessionResult> {
    const source = sessionsDb.getSessionById(sessionId);
    if (!source) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = source.provider as LLMProvider;
    const fork = providerRegistry.resolveProvider(provider).fork;
    if (!fork) {
      throw new AppError(`Sessions cannot be forked for provider "${provider}".`, {
        code: 'FORK_NOT_SUPPORTED',
        statusCode: 409,
      });
    }

    // A session that has never run has no transcript to copy, so there is
    // nothing a fork of it could resume from.
    if (!source.provider_session_id || !source.jsonl_path) {
      throw new AppError('This session has not produced a transcript yet.', {
        code: 'FORK_SOURCE_NOT_READY',
        statusCode: 409,
      });
    }

    // A branch keeps its source's name instead of gaining a "(fork)" suffix.
    // The name states the topic and the lineage is structure the sidebar draws,
    // so the marker survives a narrow row: a suffix is the first thing an
    // ellipsis removes. It also does not generalise — a second branch would
    // carry the identical constant suffix and the two would be as
    // indistinguishable as the pair was before.
    const sessionName = options.title?.trim()
      || source.custom_name?.trim()
      || 'Session';

    const forked = await fork.forkSession({
      providerSessionId: source.provider_session_id,
      jsonlPath: source.jsonl_path,
      projectPath: source.project_path ?? '',
      upToAnchorId: options.upToAnchorId,
      title: sessionName,
    });

    const forkSessionId = randomUUID();
    sessionsDb.createForkedSession({
      sessionId: forkSessionId,
      provider,
      projectPath: source.project_path ?? '',
      customName: sessionName,
      providerSessionId: forked.providerSessionId,
      jsonlPath: forked.jsonlPath,
      forkedFromSessionId: sessionId,
      // A fork that silently dropped to the catalog default would answer
      // differently from the conversation it was branched from.
      model: source.model,
      effort: source.effort,
      // Same reasoning for the permission mode: a fork inherits how the
      // conversation it branches from was actually being run.
      permissionMode: source.permission_mode,
    });

    await broadcastSessionUpserted(forkSessionId);

    return {
      sessionId: forkSessionId,
      provider,
      projectPath: source.project_path ?? '',
      sessionName,
    };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  /**
   * Resolves where a conversation must resume from so that one already-sent
   * message, and everything after it, is replaced.
   *
   * Returns `null` when the provider cannot do this at all, which is how the
   * chat gateway knows to refuse the request rather than silently sending the
   * edit as a new message at the end of the conversation.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null } | null> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    if (!sessions.resolveEditAnchor) {
      return null;
    }

    return sessions.resolveEditAnchor(sessionId, anchorId);
  },

  /**
   * Whether editing a message on this session's provider means rewinding it on
   * disk first, rather than handing the anchor to the runtime as a resume
   * option.
   *
   * Answering this without doing anything is the point: the rewind moves the
   * session onto a different provider transcript and cannot be undone, so the
   * gateway has to know which shape the run takes before it commits to one.
   */
  providerRewindsForEdit(sessionId: string): boolean {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return Boolean(providerRegistry.resolveProvider(session.provider as LLMProvider).sessions.rewindSession);
  },

  /**
   * Rewinds a session on disk so `keepThroughId` is the last row it holds.
   *
   * Only call this once the run is admitted — see `providerRewindsForEdit`.
   */
  async rewindSessionForEdit(sessionId: string, keepThroughId: string | null): Promise<void> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    await sessions.rewindSession?.(sessionId, keepThroughId);
  },

  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const providerSessions = providerRegistry.resolveProvider(provider).sessions;
    const providerSessionId = session.provider_session_id;
    const projectPath = session.project_path ?? '';
    const requestedLimit = options.limit ?? null;
    const requestedOffset = options.offset ?? 0;

    // Claude and Codex history readers parse `jsonl_path` itself, so a page
    // can be sliced from the stat-validated full-transcript cache instead of
    // re-parsing the whole file per request. Cursor and OpenCode read their
    // messages from elsewhere (store.db / shared SQLite), so that file's stat
    // says nothing about their history — they stay on the direct path.
    const transcriptPath = provider === 'claude' || provider === 'codex'
      ? session.jsonl_path
      : null;
    const fullHistory = await sessionHistoryCache.getFullHistory({
      sessionId,
      transcriptPath,
      loadFull: () => providerSessions.fetchHistory(sessionId, {
        limit: null,
        offset: 0,
        projectPath,
        providerSessionId,
      }),
    });

    let result: FetchHistoryResult;
    if (fullHistory) {
      // Providers slice with this same helper, so a cached page is identical
      // to what a direct `(limit, offset)` read would have returned.
      const { page, hasMore } = sliceTailPage(fullHistory.messages, requestedLimit, Math.max(0, requestedOffset));
      result = {
        ...fullHistory,
        messages: page,
        hasMore,
        offset: requestedOffset,
        limit: requestedLimit,
      };
    } else {
      result = await providerSessions.fetchHistory(sessionId, {
        limit: requestedLimit,
        offset: requestedOffset,
        projectPath,
        providerSessionId,
      });
    }

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
          }
        : null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
        forkedFromSessionId: session.forked_from_session_id ?? null,
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk) {
      // Every file the conversation has lived in, not just the one the row
      // points at now: editing a message on a provider that rewinds by
      // branching moves the session onto a copy and leaves the earlier
      // transcript behind. Deleting only the current one would leave the
      // replaced turns on disk, and unreachable through the app.
      const transcripts = [
        ...(session.jsonl_path ? [session.jsonl_path] : []),
        ...sessionsDb.getSupersededTranscriptPaths(sessionId),
      ];
      for (const transcript of transcripts) {
        removedFromDisk = (await removeFileIfExists(transcript)) || removedFromDisk;
      }
    }

    sessionsDb.clearSupersededProviderSessions(sessionId);
    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   *
   * The new name is announced like any other session change: a rename made on
   * one client has to appear on the others without them refetching, and the
   * `session_upserted` delta is the same one the on-disk watcher sends when a
   * transcript renames a session by itself.
   *
   * Order is deliberate: the database write and its broadcast happen first, and
   * the provider's own copy of the name is written afterwards, best-effort. The
   * reverse order has the worse failure — a provider store that carries the new
   * name while this app, and so the user, still shows the old one.
   */
  async renameSessionById(
    sessionId: string,
    summary: string,
  ): Promise<{ sessionId: string; summary: string }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    await broadcastSessionUpserted(sessionId);
    await writeRenameToProviderTranscript(session, summary);
    return { sessionId, summary };
  },

  /**
   * Reads the two facts a host-lifecycle verb needs about one session: the
   * provider whose driver would serve it, and the lifecycle mode the user asked
   * for.
   *
   * Consumed by `session-hosts`' `/start` and `/close` routes, which receive it
   * as an injected reader rather than importing this module — that direction is
   * closed (this module already imports the host layer), so the composition root
   * wires the two together. The mode is read through
   * `getSessionLifecycleMode` and never off the raw column: a row written before
   * the column existed carries NULL, and the reader is what turns that into the
   * `per-run` every caller is promised.
   *
   * Returns null for an unknown id. The two refusals that follow from that —
   * "no such session" and "this session's mode forbids the verb" — are
   * deliberately not collapsed here; the route needs them apart.
   */
  readSessionLifecycle(sessionId: string): SessionLifecycleReading | null {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      provider: session.provider as LLMProvider,
      mode: sessionsDb.getSessionLifecycleMode(sessionId),
    };
  },

  /**
   * Records a new lifecycle-mode preference for one session and moves any live
   * host out of the way.
   *
   * The three facts the write is checked against, in the order they are checked:
   *
   *  1. **The provider's declaration.** A preference is a promise about how a
   *     turn will run, and only a provider that declared the mode can keep it.
   *     Checked against `lifecycleModes` rather than a literal list, so the
   *     matrix stays the single statement of what each integration supports —
   *     and checked before the session is looked up, because the request is
   *     invalid for this provider whether or not that particular row exists.
   *  2. **The session's existence.** Nothing to record a preference against.
   *  3. **The host's state.** A live process cannot become the other mode — the
   *     two modes differ in who owns the process — so the transition ends the
   *     old host and lets the new mode open its own. That is only honest when
   *     no turn is in flight: closing a resident host mid-turn kills the turn,
   *     and a preference that arrives during one must not do that. `busy` is
   *     therefore a refusal with a named code rather than a deferred write; the
   *     caller retries once the turn ends, which is the same "not on a running
   *     turn" invariant stated the other way round.
   *
   * The ordered steps are the reason this is a service and not a route: the
   * route parses, calls this, and formats what it returns.
   */
  switchSessionLifecycleMode(
    provider: LLMProvider,
    sessionId: string,
    mode: HostMode,
  ): LifecycleModeSwitchResult {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // The matrix that decides is the *session's own* provider's, not the one in
    // the path. The route family passes `provider` as a label — `active-model`
    // and `active-effort` write the same way — but a mode is not a label: it
    // decides whether a process exists at all. Consulting the path's provider
    // would let a caller name a provider whose matrix does list `resident` and
    // store that mode on a session running under one that does not, which is
    // exactly the write this refusal exists to stop.
    const owner = session.provider as LLMProvider;
    const declared = providerCapabilitiesService.getProviderCapabilities(owner).lifecycleModes;
    if (!declared.includes(mode)) {
      throw new AppError(
        `Provider "${owner}" does not implement "${mode}" lifecycle mode.`,
        { code: 'LIFECYCLE_MODE_NOT_SUPPORTED', statusCode: 409 },
      );
    }

    const current = sessionsDb.getSessionLifecycleMode(sessionId);
    if (current === mode) {
      // A write that would change nothing must not close the host serving the
      // session: the preference already says what the caller asked for, so the
      // only effect of continuing would be ending a process for a no-op.
      return { provider, sessionId, mode, changed: false, closedHostReason: null };
    }

    const host = liveHostForSession(sessionId);
    if (host?.state === 'busy') {
      throw new AppError(
        `Session "${sessionId}" is mid-turn; its lifecycle mode cannot change under it.`,
        { code: 'LIFECYCLE_MODE_HOST_BUSY', statusCode: 409 },
      );
    }

    // The host transition, before the write: a stored preference that moved
    // while the old process was still alive would describe a session running
    // under a mode it is not running under. Each target mode has its own close
    // reason, because the reason is the record of *why* the process ended —
    // `mode-change` for the resident host the mode itself retired, `superseded`
    // for the per-run host a resident session's process replaces.
    let closedHostReason: HostCloseReason | null = null;
    if (host) {
      closedHostReason = mode === 'per-run' ? 'mode-change' : 'superseded';
      sessionHostManager.closeHost(host.hostId, closedHostReason);
    }

    if (!sessionsDb.setSessionLifecycleMode(sessionId, mode)) {
      // Unreachable while the row above was found — the write is addressed by
      // the same id — but a failed write must not be reported as a success.
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return { provider, sessionId, mode, changed: true, closedHostReason };
  },
};

/**
 * What one mode switch did.
 *
 * A result rather than a bare boolean because the two halves are separately
 * interesting: `changed: false` is a successful no-op (the preference already
 * said what was asked), while `closedHostReason` says what happened to the
 * process that was serving the session, which a client cannot infer from the
 * stored mode alone.
 */
export type LifecycleModeSwitchResult = {
  provider: LLMProvider;
  sessionId: string;
  mode: HostMode;
  /** Whether the stored preference moved; false when it already read `mode`. */
  changed: boolean;
  /** The reason the previous host was closed with, or null when none was serving. */
  closedHostReason: HostCloseReason | null;
};

/**
 * The live host serving one application session, as the manager reports it.
 *
 * The same read the host module's own routes make, for the same reason: it goes
 * through `snapshot()`, the manager's detached port, and skips closed hosts so a
 * host already past its life cannot be mistaken for one a switch should end.
 */
function liveHostForSession(appSessionId: string): ProcessHost | null {
  return (
    sessionHostManager
      .snapshot()
      .find((host) => host.state !== 'closed' && host.bindings.has(appSessionId)) ?? null
  );
}
