import path from 'node:path';

import type { WebSocket } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import {
  createClaudeTaskReducer,
  providerModelsService,
  readSessionForegroundToolUseId,
  sessionsService,
} from '@/modules/providers/index.js';
import type {
  ActivityTask,
  ControlBackgroundTaskOutcome,
  ControlStopTaskOutcome,
} from '@/modules/providers/index.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import {
  activityAnnouncement,
  attachActivityHeartbeat,
} from '@/modules/websocket/services/activity-heartbeat.service.js';
import { activityStore } from '@/modules/websocket/services/activity-protocol.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import { CHAT_TURN_OPTION } from '@/shared/types.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  HostQueuedInputCancelResult,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/**
 * The full verdict set one `chat.stop-task` receipt can carry: everything the
 * runtime gateway can answer, plus the two refusals the handler itself decides
 * before the gateway is reached (`forbidden` from the access entry,
 * `unknown-task` from the task table).
 */
type ControlStopTaskResult = ControlStopTaskOutcome | 'forbidden' | 'unknown-task';

/**
 * The full verdict set one `chat.background-task` receipt can carry: everything
 * the runtime gateway can answer, plus the refusal the handler itself decides
 * before the gateway is reached (`forbidden` from the access entry).
 *
 * Deliberately has no `unknown-task`: this verb does not address the task table
 * at all, so there is no table-side refusal — the handler's own
 * `no-foreground-match` (from the Turn Tracker) is the only pre-gate answer, and
 * it is already part of the gateway's union so a driven `false` and a
 * tracker-side mismatch read identically to the caller.
 */
type ControlBackgroundTaskResult = ControlBackgroundTaskOutcome | 'forbidden';

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  /**
   * Whether a turn dispatched right now would be written into a process the
   * session's provider is already holding, rather than run as a process of its
   * own.
   *
   * Optional, and read as `false` when absent, because the absent case is the
   * behaviour every session had before busy input existed: the duplicate-send
   * refusal is the default, and only a gateway that can answer for a live
   * process may lift it. A gateway assembled without this verb therefore
   * degrades to the refusal rather than losing it.
   */
  acceptsBusyInput?(provider: LLMProvider, sessionId: string): boolean;
  /**
   * Withdraws a message a busy send queued, if the provider's process has not
   * started running it yet.
   *
   * Optional for the same reason, and read as `unknown` when absent: the one
   * answer a caller must never receive is "withdrawn" from a seam that never
   * wrote anything.
   */
  cancelQueuedInput?(
    provider: LLMProvider,
    sessionId: string,
    messageUuid: string,
  ): Promise<HostQueuedInputCancelResult>;
  /**
   * Stops one named background task through the provider's own process.
   *
   * Returns `requested` when the driver was called and its call settled, and a
   * failure value otherwise. It deliberately does **not** wait for the task to
   * stop and does not touch the task table: whether the task really stopped is
   * the approval the reducer writes from the `task_notification(stopped)` frame,
   * which the handler waits on with its own bound.
   *
   * Optional, and read as `unsupported` when absent, because a gateway that
   * cannot carry the request must never be read as having placed one.
   */
  controlStopTask?(
    provider: LLMProvider,
    sessionId: string,
    taskId: string,
  ): Promise<ControlStopTaskOutcome>;
  /**
   * Promotes one named *foreground* tool to a background task through the
   * provider's own process.
   *
   * Returns `requested` when the driver was called and its call settled `true`,
   * and a failure value otherwise. Like its stop-task sibling it deliberately
   * does **not** wait for the task to appear and does not touch the task table:
   * the task becomes a row only when the reducer consumes the
   * `task_started` + `task_updated{is_backgrounded:true}` frames the CLI emits,
   * which is a later step than this call.
   *
   * Optional, and read as `unsupported` when absent, because a gateway that
   * cannot carry the request must never be read as having placed one.
   */
  controlBackgroundTask?(
    provider: LLMProvider,
    sessionId: string,
    toolUseId: string,
  ): Promise<ControlBackgroundTaskOutcome>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
  /** Test seam: replaces the default that discards a client-supplied `options.env`. */
  dropClientEnv?: (options: AnyRecord) => AnyRecord;
  /**
   * Where a subscription reports that a browser is now on a session.
   *
   * A subscription is the one client action that says "someone is watching this
   * session", and the host layer is what has to hear it: a resident process is
   * held across turns, so "who is attached" is a fact its lifetime is reasoned
   * about from. The manager's `attachViewer` is deliberately *not* activity (it
   * never moves `lastActivityAt`; see the manager's own rule), so routing it
   * here changes nothing about when a host closes — what it changes is that the
   * host layer is told at all.
   *
   * Optional, defaulting to the process-wide manager, for the same reason
   * `dropClientEnv` is: the composition root has nothing to say about it, while
   * a criterion that drove a manager of its own can hand that one over and see
   * the call land on it. Narrow on purpose — this is the only verb the chat
   * gateway has any business calling.
   */
  sessionHostManager?: Pick<SessionHostManager, 'attachViewer'>;
  /**
   * The task table read seam for the stop-task control verb.
   *
   * Defaults to the process-wide reducer table below. A criterion injects its
   * own reader — built on the same `createClaudeTaskReducer()` — so it can drive
   * a frame sequence into the table and read the very table the handler
   * consulted, rather than a second registry the handler never saw.
   */
  getTask?: (sessionId: string, taskId: string) => { state: ActivityTask['state'] } | null;
  /**
   * How long the handler waits for the task table to show the task settled after
   * a `requested` driver call, and how often it re-reads it.
   *
   * Injectable so the criterion can reach the never-stopped arm in milliseconds.
   * Production's window is short on purpose: the SDK's `task_notification`
   * follows the stop within a round trip when it arrives at all, so a longer
   * wait would only delay the honest `timeout`.
   */
  stopTaskConfirmTimeoutMs?: number;
  stopTaskConfirmPollMs?: number;
};

/**
 * The process-wide task table the stop-task verb reads.
 *
 * It is the reducer AC-191 built — the same `getTasks(sessionId)` shape the
 * activity aggregator will read — and it is instantiated here rather than
 * re-implemented, so there is exactly one task-registration mechanism. It is
 * empty until the frame forwarder feeds it (`observe`), which is the activity
 * protocol's job; the control verb's contract is to read whatever the one table
 * holds, never to invent a second one.
 */
let claudeTaskTable: ReturnType<typeof createClaudeTaskReducer> | null = null;
function taskTable(): ReturnType<typeof createClaudeTaskReducer> {
  // Built on first read rather than at module load: the factory is reached
  // through the providers barrel, and instantiating it while this module's own
  // import graph is still evaluating can run the reducer before its module's
  // helpers are installed. A lazy singleton has the same lifetime and none of
  // that ordering hazard.
  claudeTaskTable ??= createClaudeTaskReducer();
  return claudeTaskTable;
}

const DEFAULT_STOP_TASK_CONFIRM_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TASK_CONFIRM_POLL_MS = 25;

/**
 * The reducer's terminal states, read here as the set "the task is no longer in
 * flight" that ends the confirmation wait. `running` and `blocked` are the two
 * that do not.
 */
const TERMINAL_TASK_STATES: ReadonlySet<ActivityTask['state']> = new Set<ActivityTask['state']>([
  'stopped',
  'completed',
  'failed',
  'ended',
]);

/** The default task-table reader: one row out of the process-wide reducer table. */
function defaultGetTask(sessionId: string, taskId: string): { state: ActivityTask['state'] } | null {
  const task = taskTable().getTasks(sessionId).find((candidate) => candidate.taskId === taskId);
  return task ? { state: task.state } : null;
}

/**
 * Grants or refuses a control verb access to one session.
 *
 * The single entry the "stop something" verbs share (AC-196's `chat.stop-task`
 * today; AC-197's `chat.background-task` and AC-198's reworked
 * `chat.cancel-queued` next). It is deliberately the only place that decides
 * this: the alternative — each handler re-deriving it — is how one verb ends up
 * without a check while its sibling has one, which is exactly what happened to
 * `chat.cancel-queued`.
 *
 * A session row carries no owner column, so "belongs to this user" cannot be
 * read off the row. The app authenticates at the websocket upgrade, so access is
 * granted to an authenticated request (a user id was read off the upgrade) and
 * refused otherwise; an unauthenticated socket gets `forbidden` and no driver is
 * called. `session` is taken as a parameter so the shape of the check does not
 * change when the row grows an owner: only this function has to move.
 */
export function assertSessionAccess(
  userId: string | number | null,
  _session: ReturnType<typeof sessionsDb.getSessionById>,
): boolean {
  return userId !== null && userId !== undefined && `${userId}`.trim().length > 0;
}

/** The wire protocol carries the model selection; a client-supplied `options.env` is discarded. */
function withoutClientEnv(options: AnyRecord): AnyRecord {
  const { env: _ignoredClientEnv, ...rest } = options;
  return rest;
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }

  await dispatchRun(ws, userId, resolved.sessionId, resolved.session, data, dependencies);
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>) => void | Promise<void>,
): Promise<{ started: boolean; error: string | null }> {
  const provider = session.provider as LLMProvider;

  const startInput = {
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  };

  let run = chatRunRegistry.startRun(startInput);

  // The refusal is asked first, and only then is the session asked whether it
  // can take this turn anyway. That order is what keeps the answer correct for
  // every provider that runs a process per turn: it never reaches the second
  // question, so its behaviour is byte-for-byte what it was. A provider that
  // holds one process across turns answers yes, and the turn gets a run of its
  // own — the registry holds one run per session, so `supersedeRunning` is how
  // the newer turn becomes the session's current one instead of being refused.
  // Note that the first call is a pure probe: it returns null precisely when it
  // has changed nothing, which is what makes the retry safe.
  if (!run && dependencies.runtime.acceptsBusyInput?.(provider, sessionId)) {
    run = chatRunRegistry.startRun({ ...startInput, supersedeRunning: true });
  }

  if (!run) {
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId
      );
    }
    return { started: false, error: 'A run is already in progress for this session.' };
  }

  const rawClientOptions = (data.options ?? {}) as AnyRecord;
  const clientOptions = (dependencies.dropClientEnv ?? withoutClientEnv)(rawClientOptions);
  const command = typeof data.content === 'string' ? data.content : '';

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }
  // The permission mode is a session attribute the client no longer persists
  // anywhere, so this send is the only place it can be recorded. Only a mode
  // the provider's capability matrix lists is stored; an unsupported one is
  // ignored rather than rejected, because the run still has to go out and the
  // client would otherwise be told its message failed over a display detail.
  if (typeof clientOptions.permissionMode === 'string' && clientOptions.permissionMode.trim()) {
    providerModelsService.setSessionPermissionMode(provider, sessionId, clientOptions.permissionMode);
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    // This dispatch's `command` is a message somebody composed — typed now, or
    // scheduled earlier and fired by the timer below. Marked here and not left
    // to the runtime to infer, because the runtime cannot: an internal driver
    // reaching the same entry passes the same option keys with a *label* in
    // `command`, and a provider that records the prompt it was handed (the
    // debug agent, whose "process" runs a scenario instead of a CLI that would
    // write the row itself) has no other way to tell the two apart.
    [CHAT_TURN_OPTION]: true,
  };

  let failure: string | null = null;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run);
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }

  return { started: true, error: failure };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
  );
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const success = await dependencies.runtime.abort(run.provider, sessionId);

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.cancel-queued`: withdraws a message that a busy send queued in
 * the provider's own process, before that process has started running it.
 *
 * The withdrawal is not the same request as `chat.abort`: aborting stops the
 * turn that is running, while this one takes back a turn that has not started
 * and leaves the running one alone. The address is the message, not the session
 * — a session can have several messages queued, and only the sender knows which
 * one it is taking back — and the id is the one the host stamped the frame with
 * when it wrote it.
 *
 * The verdict is reported as it is, including `already-started`: a message the
 * process has begun running cannot be withdrawn any more, and saying so is the
 * honest answer. `unknown` means the seam could not carry the question at all
 * (no live resident host, or a gateway with no withdrawal verb), which is
 * deliberately not the same answer as "it was already running".
 */
async function handleChatCancelQueued(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.cancel-queued requires a sessionId.');
    return;
  }

  const messageUuid = typeof data.messageUuid === 'string' ? data.messageUuid.trim() : '';
  if (!messageUuid) {
    sendProtocolError(
      ws,
      'MESSAGE_UUID_REQUIRED',
      'chat.cancel-queued requires the messageUuid of the queued message.',
      sessionId
    );
    return;
  }

  // The session row is read for its provider only. No run is consulted: the
  // message being withdrawn is by definition not the session's current run, and
  // a withdrawal that arrived just as the run turned over is answered by the
  // provider's queue, which is the only thing that knows what it still holds.
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const result =
    (await dependencies.runtime.cancelQueuedInput?.(
      session.provider as LLMProvider,
      sessionId,
      messageUuid
    )) ?? 'unknown';

  sendJson(ws, {
    kind: 'queued_input_cancel_result',
    sessionId,
    messageUuid,
    result,
    timestamp: new Date().toISOString(),
  });
}

/** Waits `ms`, never longer than the caller still has left. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Waits, within a bound, for the task table to show the named task settled.
 *
 * This is the second of the control verb's two bounds, and the only one that
 * reads the reducer: the first (the driver call) belongs to the runtime gateway
 * and answers whether the request was placed. Reaching a terminal state here —
 * driven by the `task_notification(stopped)` the provider emits, never by this
 * handler — is the confirmation that turns the driver's `requested` into the
 * caller's `requested`; not reaching one inside the bound is `timeout`, and the
 * table is left exactly as it was.
 *
 * A row that has left the table counts as settled: the handler already proved it
 * was there before the call, so a row that is gone is no longer in flight.
 */
async function waitForTaskSettled(
  getTask: (sessionId: string, taskId: string) => { state: ActivityTask['state'] } | null,
  sessionId: string,
  taskId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = getTask(sessionId, taskId);
    if (!task || TERMINAL_TASK_STATES.has(task.state)) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await delay(Math.min(pollMs, remaining));
  }
}

/**
 * Handles `chat.stop-task`: stops one named background task of a session, with
 * the request placed through the provider's own process and the confirmation
 * taken from the task table's own event.
 *
 * The shape is deliberately "validate, place, wait, report", and every refusal
 * happens **before** the driver is touched:
 *
 *  1. the three fields (`sessionId`, `taskId`, `requestId`) are required;
 *  2. the session must exist;
 *  3. the request must belong to the session (`assertSessionAccess`);
 *  4. the task must be in the table and not already terminal;
 *  5. only then is the runtime asked, and the capability matrix decides whether
 *     the provider can carry it at all.
 *
 * The receipt never carries a task state and never writes one. `requested` means
 * the request was placed *and* the table confirmed the task left `running`
 * inside the bound; `timeout` means it was placed but no such confirmation
 * arrived, with the table left untouched; `forbidden` and `unknown-task` are the
 * two refusals the task table and the access entry produce. The
 * `task_notification(stopped)` frame is what actually moves the table — this
 * handler reads it, it does not stand in for it.
 */
async function handleChatStopTask(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.stop-task requires a sessionId.');
    return;
  }

  const taskId = typeof data.taskId === 'string' ? data.taskId.trim() : '';
  if (!taskId) {
    sendProtocolError(ws, 'TASK_ID_REQUIRED', 'chat.stop-task requires a taskId.', sessionId);
    return;
  }

  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
  if (!requestId) {
    sendProtocolError(ws, 'REQUEST_ID_REQUIRED', 'chat.stop-task requires a requestId.', sessionId);
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const reply = (result: ControlStopTaskResult): void => {
    sendJson(ws, {
      kind: 'control_result',
      sessionId,
      requestId,
      result,
      timestamp: new Date().toISOString(),
    });
  };

  // Ownership is checked before the task table and long before any driver call,
  // so a forbidden request can neither learn what tasks exist nor place a stop.
  if (!assertSessionAccess(userId, session)) {
    reply('forbidden');
    return;
  }

  const getTask = dependencies.getTask ?? defaultGetTask;
  const task = getTask(sessionId, taskId);
  if (!task || TERMINAL_TASK_STATES.has(task.state)) {
    reply('unknown-task');
    return;
  }

  const provider = session.provider as LLMProvider;
  const outcome =
    (await dependencies.runtime.controlStopTask?.(provider, sessionId, taskId)) ?? 'unsupported';
  if (outcome !== 'requested') {
    reply(outcome);
    return;
  }

  const settled = await waitForTaskSettled(
    getTask,
    sessionId,
    taskId,
    dependencies.stopTaskConfirmTimeoutMs ?? DEFAULT_STOP_TASK_CONFIRM_TIMEOUT_MS,
    dependencies.stopTaskConfirmPollMs ?? DEFAULT_STOP_TASK_CONFIRM_POLL_MS,
  );
  reply(settled ? 'requested' : 'timeout');
}

/**
 * The per-socket activity-protocol subscriptions, so a socket that subscribes to
 * the same session twice is left with one feed and a dead socket leaves none.
 *
 * Mirrors the heartbeat's own bookkeeping: the subscription is keyed by the
 * session on the socket that opened it, and its unsubscribe is dropped on the
 * socket's close/error.
 */
const activityFeedsBySocket = new WeakMap<WebSocket, Map<string, () => void>>();

/**
 * Subscribes one socket to the activity protocol's frames for one session.
 *
 * The store hands the joiner its current snapshot the instant it subscribes
 * (`activity.snapshot`, whole — every field, tasks and schedules included) and
 * a whole-snapshot `activity.upsert` on every `recordChange` after that. That is
 * what lets the client draw the background panel from a snapshot on first load
 * and then watch it change without a reload or a poll — the two readings AC-194
 * turns on. A session already fed on this socket is left alone so a re-sent
 * `activity.subscribe` does not double the frame rate.
 *
 * Reached only through {@link handleActivitySubscribe}, never through
 * `chat.subscribe`: the run's frame sequence is a frozen contract, and the
 * `activity.snapshot` this hands a joiner is a frame that contract does not
 * carry (see the comment in `handleChatSubscribe`).
 */
function attachActivityFeed(ws: WebSocket, sessionId: string): void {
  const bySession = activityFeedsBySocket.get(ws) ?? new Map<string, () => void>();
  activityFeedsBySocket.set(ws, bySession);
  if (bySession.has(sessionId)) {
    return;
  }

  const sendFrame = (frame: unknown): void => {
    if (ws.readyState !== WS_OPEN_STATE) {
      return;
    }
    try {
      sendJson(ws, frame);
    } catch {
      // A socket that throws on send is one the close/error path would have
      // handled anyway; the feed is dropped with it.
    }
  };

  const unsubscribe = activityStore.subscribe(sessionId, sendFrame);

  const stopFeed = (): void => {
    unsubscribe();
    bySession.delete(sessionId);
    if (bySession.size === 0) {
      activityFeedsBySocket.delete(ws);
    }
    ws.off('close', stopFeed);
    ws.off('error', stopFeed);
  };

  ws.on('close', stopFeed);
  ws.on('error', stopFeed);
  bySession.set(sessionId, stopFeed);
}

/**
 * Handles `activity.subscribe`: starts feeding this socket the activity
 * protocol's frames for one session.
 *
 * It is deliberately its own verb rather than a side effect of `chat.subscribe`.
 * A `chat.subscribe` reply is the run's frame sequence, and that sequence is a
 * frozen contract: the per-run frame-parity criterion
 * (`session-host-per-run-parity.test.ts`, AC-155) compares it against a baseline
 * recorded on the tree that predates the session-host layer and flags any added
 * frame as a regression. Attaching the feed there injected an `activity.snapshot`
 * frame into that stream and red the criterion; splitting the verb keeps the run
 * stream byte-stable for a client (or a criterion) that never asks for activity,
 * and makes the subscription an explicit opt-in for a client that wants the
 * task/schedule panel. The reply is the store's own contract: a whole
 * `activity.snapshot` for the joiner first, then a whole-snapshot
 * `activity.upsert` per change.
 */
function handleActivitySubscribe(ws: WebSocket, data: AnyRecord): void {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'INVALID_SESSION_ID', 'activity.subscribe requires a sessionId');
    return;
  }
  attachActivityFeed(ws, sessionId);
}

/**
 * Handles `chat.background-task`: promotes one running *foreground* tool of a
 * session to a background task, with the request placed through the provider's
 * own process.
 *
 * The address is the Turn Tracker, not the task table. A foreground tool is not
 * a task until the CLI backgrounds it, so at the moment the request arrives the
 * table has no row for it — the id names a `tool_use` the tracker still holds as
 * pending. The handler therefore refuses every request whose `toolUseId` is not
 * the tracker's currently pending foreground tool, and never reads the task table
 * at all.
 *
 * The shape is "validate, address, place, report", and every refusal happens
 * **before** the driver is touched:
 *
 *  1. the three fields (`sessionId`, `toolUseId`, `requestId`) are required — the
 *     no-toolUseId "background everything" form is refused here, so the driver is
 *     only ever reached with a string id;
 *  2. the session must exist;
 *  3. the request must belong to the session (`assertSessionAccess`);
 *  4. the requested `toolUseId` must equal the Turn Tracker's pending foreground
 *     tool (`readSessionForegroundToolUseId`) — anything else is
 *     `no-foreground-match`, with the driver un-called and no state moved;
 *  5. only then is the runtime asked, and the capability matrix decides whether
 *     the provider can carry it at all.
 *
 * The receipt never carries or writes a task state. `requested` means the request
 * was accepted and placed; whether the task then appears is the reducer's, driven
 * by the frames the CLI emits — this handler writes nothing and the tracker is
 * only ever read.
 */
async function handleChatBackgroundTask(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.background-task requires a sessionId.');
    return;
  }

  const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId.trim() : '';
  if (!toolUseId) {
    sendProtocolError(
      ws,
      'TOOL_USE_ID_REQUIRED',
      'chat.background-task requires the toolUseId of the foreground tool.',
      sessionId
    );
    return;
  }

  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
  if (!requestId) {
    sendProtocolError(ws, 'REQUEST_ID_REQUIRED', 'chat.background-task requires a requestId.', sessionId);
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const reply = (result: ControlBackgroundTaskResult): void => {
    sendJson(ws, {
      kind: 'control_result',
      sessionId,
      requestId,
      result,
      timestamp: new Date().toISOString(),
    });
  };

  // Ownership is checked before the tracker and long before any driver call, so
  // a forbidden request can neither learn what foreground tools exist nor place a
  // background request.
  if (!assertSessionAccess(userId, session)) {
    reply('forbidden');
    return;
  }

  // The addressing store is the Turn Tracker, never the task table: a foreground
  // tool has no task row yet, and a request that does not name the tracker's
  // pending tool is refused with no driver call and no state moved.
  const pendingToolUseId = readSessionForegroundToolUseId(sessionId);
  if (pendingToolUseId !== toolUseId) {
    reply('no-foreground-match');
    return;
  }

  const provider = session.provider as LLMProvider;
  const outcome =
    (await dependencies.runtime.controlBackgroundTask?.(provider, sessionId, toolUseId)) ?? 'unsupported';
  reply(outcome);
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    // The run the client's `lastSeq` was recorded against, if it tracks run
    // ids. Omitted by clients that predate them (and by any client that has
    // seen no run yet), which keeps the plain `seq > lastSeq` replay rule.
    const runIdRaw = (target as AnyRecord).runId;
    const requestedRunId = typeof runIdRaw === 'string' && runIdRaw.length > 0 ? runIdRaw : undefined;

    // A browser is now on this session. Reported before anything else in the
    // loop because it is about the session rather than about the run: a session
    // with no run in flight has no host change to trigger, and one that does is
    // still a session somebody is watching.
    (dependencies.sessionHostManager ?? sessionHostManager).attachViewer(sessionId);

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    // The ack names the run the server is currently on, so the client can
    // reset a cursor that was recorded against an earlier run. Omitted when no
    // run is in flight — there is no run identity to report.
    // The hello also carries the activity contract: which process this is
    // (`bootId`), the session's current activity revision, and the two timings
    // the heartbeat below will use. A client that compares `bootId` across
    // reconnects can tell a restart from a hiccup, and it can degrade to
    // "unreachable" when no frame arrives inside the announced threshold —
    // neither is possible from the invisible protocol-level ping.
    const ack: AnyRecord = {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      ...activityAnnouncement(sessionId),
      timestamp: new Date().toISOString(),
    };
    if (run) {
      ack.runId = run.runId;
    }
    sendJson(ws, ack);

    // A browser is now watching this session, so the server starts proving it
    // is still alive on the beat it just announced.
    attachActivityHeartbeat(ws, sessionId);

    // The activity feed is deliberately NOT attached here: a `chat.subscribe`
    // reply is the run's frame sequence, and attaching the feed would inject an
    // `activity.snapshot` frame into it. That sequence is a frozen contract (the
    // per-run frame-parity criterion compares it against a pre-wrapper baseline
    // and forbids any added frame), so the activity feed has its own opt-in —
    // `activity.subscribe` — handled below.

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq, requestedRunId)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.cancel-queued`       { sessionId, messageUuid }
 * - `chat.stop-task`           { sessionId, taskId, requestId }
 * - `chat.background-task`     { sessionId, toolUseId, requestId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `activity.heartbeat`, `session_upserted`,
 * `loading_progress`, `queued_input_cancel_result`, `control_result`,
 * `protocol_error`).
 */
/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The run is registered exactly
 * like an interactive one, so anyone who opens the session while it is going
 * subscribes and replays it from the start, and the session shows as busy
 * everywhere in the meantime.
 *
 * Resolves when the provider run settles. Returns false when the session has
 * gone away or is busy without `interruptActiveRun`, which the caller reports
 * on the schedule.
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
    /**
     * Aborts a run already in progress instead of refusing to start. A
     * scheduled message sets this: the user picked the time knowing it might
     * land mid-run, so the timer outranks whatever is running.
     */
    interruptActiveRun?: boolean;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{ started: boolean; error: string | null }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  const activeRun = chatRunRegistry.getRun(input.sessionId);
  if (activeRun && activeRun.status === 'running') {
    if (!input.interruptActiveRun) {
      return { started: false, error: 'A run was already in progress for this session.' };
    }
    // Same shape as `chat.abort`: cancel the provider run and emit the
    // terminal `complete` on its behalf, so every watching client sees the
    // interrupted run end before this turn's stream begins. The interrupted
    // run's own dispatch settles later through completeRunIfCurrent, which is
    // scoped to that run and cannot touch the one started here.
    const aborted = await dependencies.runtime.abort(activeRun.provider, input.sessionId);
    chatRunRegistry.completeRun(input.sessionId, {
      exitCode: aborted ? 0 : 1,
      aborted: true,
    });
  }

  return dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    { sessionId: input.sessionId, content: input.content, options: input.options ?? {} },
    dependencies,
  );
}

export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, dependencies);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.cancel-queued':
          await handleChatCancelQueued(ws, data, dependencies);
          return;
        case 'chat.stop-task':
          await handleChatStopTask(ws, userId, data, dependencies);
          return;
        case 'chat.background-task':
          await handleChatBackgroundTask(ws, userId, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'activity.subscribe':
          handleActivitySubscribe(ws, data);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
