/**
 * The MCP gateway's stage-3 read tools (AC-245).
 *
 * This module owns the one statement of "which read tools exist at stage 3":
 * {@link MCP_STAGE3_READ_TOOLS} names each tool with the scope it requires, and
 * {@link registerMcpReadTools} installs exactly those names through the audited
 * registration seam AC-244 landed. A later task that fills in `overview`,
 * `run_get` or `quay_snapshot` replaces a handler here; it must NOT add or
 * rename a tool, because the name set is a contract the criterion compares
 * against `tools/list` byte for byte.
 *
 * Every tool in this module is READ-ONLY. The four implemented ones answer from
 * the services the composition root injects (projects, providers' sessions,
 * session hosts, the chat run registry) and never write anything. `overview` and
 * `quay_snapshot` are AC-247's: when the deps carry the quay runner and activity
 * store, `registerMcpReadTools` routes them to `mcp-overview-tools.js`'s real
 * handlers; when those are absent, they keep their body-table refusal with a
 * named `MCP_TOOL_NOT_IMPLEMENTED` code. `run_get` is AC-248's and is routed the
 * same way to `mcp-run-get.js` when the deps carry its bag; until then it keeps
 * the same refusal.
 *
 * Two text-shaping helpers are exported because the criterion drives them
 * directly as well as through a tool: {@link paginateMcpText} (the 4000-character
 * cursor protocol) and {@link formatMcpTime} (the relative + ISO pair every time
 * field carries).
 *
 * Cross-module access goes through the barrels (`@/modules/projects/index.js`
 * and friends) — except for the shared vocabulary in `@/shared/types.js`, which
 * is not a module and is imported directly everywhere in this codebase.
 */

import { z } from 'zod';

import type { HostMode, HostState, LLMProvider, NormalizedMessage, ProcessHost } from '@/shared/types.js';

import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import { isOverviewWired, registerMcpOverviewTools } from './mcp-overview-tools.js';
import type { McpActivityReader, McpOverviewDeps, McpOverviewRegistration, McpQuayRunner } from './mcp-overview-tools.js';
import { isRunGetWired, registerMcpRunGetTool } from './mcp-run-get.js';
import type { McpRunGetDeps, McpRunGetRegistration } from './mcp-run-get.js';

// --------------------------- the stage-3 tool table ---------------------------

/** The scope every stage-3 read tool requires. */
const READ_SCOPE = 'cloudcli:read';

/**
 * Every read tool this stage ships, with the scope a caller's token must carry.
 * The single source of truth for (a) "exactly this set": the criterion compares
 * the SDK's `tools/list` names against this array, and
 * {@link registerMcpReadTools} reads each registration's `requiredScope` from
 * here rather than restating the literal.
 */
export const MCP_STAGE3_READ_TOOLS = [
  {
    name: 'overview',
    requiredScope: READ_SCOPE,
    description: 'Project overview: stage, open work and recent activity as one reading.',
  },
  {
    name: 'projects_list',
    requiredScope: READ_SCOPE,
    description: 'List every project with its session count and last activity.',
  },
  {
    name: 'sessions_list',
    requiredScope: READ_SCOPE,
    description: 'List sessions, optionally filtered by project and by state (running / idle / resident).',
  },
  {
    name: 'session_get',
    requiredScope: READ_SCOPE,
    description: 'Read one session: its metadata, its host (state, pid, leases, peer name) and its current run.',
  },
  {
    name: 'session_read',
    requiredScope: READ_SCOPE,
    description: 'Read one session transcript: latest messages, the user-turn outline, or a window around a message.',
  },
  {
    name: 'run_get',
    requiredScope: READ_SCOPE,
    description: 'Read one run by id, waiting a bounded time for it to settle.',
  },
  {
    name: 'quay_snapshot',
    requiredScope: READ_SCOPE,
    description: 'Refresh and read the quay snapshot for a project.',
  },
] as const;

/** One stage-3 read tool's name, derived from the table so the two cannot drift. */
export type McpStage3ReadToolName = (typeof MCP_STAGE3_READ_TOOLS)[number]['name'];

// --------------------------- injected services ---------------------------

/** A project as `projects_list` reports it. */
export type McpProjectReading = {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  lastActivity: McpTime | null;
  isArchived: boolean;
};

/** One session as `sessions_list` reports it. */
export type McpSessionReading = {
  id: string;
  title: string;
  provider: string;
  projectId: string | null;
  lifecycleMode: string;
  hostState: HostState | null;
  running: boolean;
  lastActivity: McpTime | null;
};

/**
 * The services the read tools answer from, all injected.
 *
 * Production passes the process singletons (`server/index.ts`); the criterion
 * passes the same real objects over a temp database and a host manager it drove
 * itself. Only the members a tool actually reads are declared, so a caller
 * cannot be asked for a capability nothing uses.
 */
export type McpReadToolDeps = {
  projects: {
    getProjectsWithSessions(options?: {
      skipSynchronization?: boolean;
      sessionsLimit?: number;
      sessionsOffset?: number;
      includeHidden?: boolean;
    }): Promise<ReadonlyArray<McpProjectPage>>;
    getArchivedProjectsWithSessions(options?: {
      skipSynchronization?: boolean;
    }): Promise<ReadonlyArray<McpProjectPage>>;
    getProjectSessionsPage(
      projectId: string,
      options?: { limit?: number; offset?: number; includeHidden?: boolean },
    ): Promise<McpProjectSessionsPage>;
  };
  sessions: {
    listRecentSessions(limit: number, offset: number): McpRecentSessionsPage;
    readSessionLifecycle(sessionId: string): McpSessionLifecycle | null;
    fetchHistory(sessionId: string, options?: { limit?: number | null; offset?: number }): Promise<McpHistoryPage>;
    fetchOutline(sessionId: string): Promise<McpOutline>;
    fetchWindowAround(
      sessionId: string,
      options: { aroundId: string; before: number; after: number },
    ): Promise<McpMessageWindow>;
  };
  hosts: {
    snapshot(): ProcessHost[];
    liveHostForSession(appSessionId: string): ProcessHost | null;
  };
  runs: {
    listRunningRuns(): McpRunningRun[];
    /**
     * Every run the registry still holds (running plus terminal inside the
     * retention window), as summaries. Consumed by `overview` (AC-247) to read
     * the aborted runs; structurally satisfied by `chatRunRegistry.listRecentRuns`.
     * Optional so a mount that never wires the overview tools (AC-240/244/245's
     * criteria) stays a valid `McpReadToolDeps`; `isOverviewWired` requires it
     * before the overview handlers are installed.
     */
    listRecentRuns?(): McpRunSummary[];
  };
  /**
   * The quay command runner (AC-247). Optional so a mount that predates AC-247 —
   * or a criterion that exercises only the five non-overview read tools — is
   * still a valid `McpReadToolDeps`. When absent, `overview` and `quay_snapshot`
   * keep their named `MCP_TOOL_NOT_IMPLEMENTED` refusal; when present they answer
   * for real. `registerMcpReadTools` branches on this.
   */
  quay?: McpQuayRunner;
  /** The activity store's turn-phase reader (AC-247). Optional; see `quay`. */
  activity?: McpActivityReader;
  /**
   * The services `run_get` answers from (AC-248): the run registry, the activity
   * store, the sessions history reader, and the clock/sleeper the bounded wait
   * moves through. Optional so a mount that predates AC-248 — or a criterion
   * that exercises the other six read tools — is still a valid
   * `McpReadToolDeps`; when absent `run_get` keeps its named
   * `MCP_TOOL_NOT_IMPLEMENTED` refusal, when present `registerMcpReadTools`
   * routes the `run_get` name to {@link registerMcpRunGetTool}. `server/index.ts`
   * assembles it from the process singletons.
   */
  runGet?: McpRunGetDeps;
  /** Clock seam, so every relative time is reproducible in a criterion. */
  now: () => number;
};

/** The slice of a project row the tools read (structurally satisfied by `ProjectListItem`). */
type McpProjectPage = {
  projectId: string;
  path: string;
  displayName: string;
  sessionMeta: { total: number };
  sessions: ReadonlyArray<{ lastActivity?: string | null }>;
  /** Present only on the archived listing; absent on the active one. */
  isArchived?: boolean;
};

/** The slice of one project-page session the tools read (structurally satisfied by `SessionSummary`). */
type McpProjectSession = {
  id: string;
  provider: string;
  summary: string;
  lastActivity?: string | null;
};

/** The slice of one recents-list row the tools read (structurally satisfied by `RecentSessionListItem`). */
type McpRecentSession = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  sessionTitle: string;
  lastActivity: string | null;
};

/** One outline turn as the provider service returns it. */
type McpOutlineTurn = { id: string; index: number; timestamp: string; preview: string };

/** The project-sessions page the tools read (structurally satisfied by `ProjectSessionsPageApiView`). */
type McpProjectSessionsPage = { projectId: string; sessions: ReadonlyArray<McpProjectSession> };

/** The recents page the tools read (structurally satisfied by `RecentSessionsPage`). */
type McpRecentSessionsPage = { conversations: ReadonlyArray<McpRecentSession>; total: number };

/** One session's stored lifecycle preference (structurally satisfied by `SessionLifecycleReading`). */
type McpSessionLifecycle = { provider: LLMProvider; mode: HostMode };

/** A history page (structurally satisfied by `FetchHistoryResult`). */
type McpHistoryPage = { messages: ReadonlyArray<NormalizedMessage>; total: number };

/** A turn outline (structurally satisfied by `SessionTurnOutline`). */
type McpOutline = { total: number; turns: ReadonlyArray<McpOutlineTurn> };

/** A window around one message (structurally satisfied by `SessionMessageWindow`). */
type McpMessageWindow = { messages: ReadonlyArray<NormalizedMessage>; startIndex: number; total: number };

/** One live run (structurally satisfied by the chat run registry's reading). */
export type McpRunningRun = { sessionId: string; provider: LLMProvider; startedAt: number; lastSeq: number };

/** One tracked run's read-only summary (structurally satisfied by `ChatRunSummary`). */
export type McpRunSummary = {
  runId: string;
  sessionId: string;
  status: 'running' | 'completed' | 'aborted';
  startedAt: number;
  completedAt: number | null;
};

// --------------------------- time ---------------------------

/** A time as every read tool reports it: both readings of the same instant. */
export type McpTime = { relative: string; iso: string };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Renders one instant as a relative phrase beside its ISO timestamp.
 *
 * Both readings come from the SAME instant, which is the point: a client that
 * only draws "3 minutes ago" cannot tell a stale reading from a fresh one, and a
 * client that only draws the ISO forces a human to subtract. `now` is injected
 * so the relative half is exactly predictable rather than merely plausible.
 *
 * Consumers: every read tool's time field, and the criterion, which pins a
 * clock and asserts both halves verbatim.
 */
export function formatMcpTime(ms: number, now: () => number): McpTime {
  const elapsed = Math.max(0, now() - ms);
  let relative: string;
  if (elapsed < MINUTE_MS) {
    relative = 'just now';
  } else if (elapsed < HOUR_MS) {
    relative = `${Math.floor(elapsed / MINUTE_MS)} minutes ago`;
  } else if (elapsed < DAY_MS) {
    relative = `${Math.floor(elapsed / HOUR_MS)} hours ago`;
  } else {
    relative = `${Math.floor(elapsed / DAY_MS)} days ago`;
  }

  return { relative, iso: new Date(ms).toISOString() };
}

/**
 * The time field for a stored timestamp, or null when the row carries none.
 *
 * The stored value is whatever a session row holds — canonical ISO for rows the
 * session repository normalized, and possibly a SQLite `YYYY-MM-DD HH:MM:SS`
 * form for one it did not. An unparseable value reads as null rather than as
 * "now", because a time field that quietly means "I do not know" is worse than
 * an absent one.
 */
function readTimeField(value: string | null | undefined, now: () => number): McpTime | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : formatMcpTime(parsed, now);
}

// --------------------------- text pagination ---------------------------

/** How many characters one `content` chunk carries. Characters, not bytes. */
export const MCP_TEXT_CHUNK_CHARS = 4000;

/** The opaque continuation token: the character offset of the next chunk. */
function encodeMcpCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

/** Decodes a cursor; anything unreadable restarts at the beginning. */
function decodeMcpCursor(cursor: string | undefined): number {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return 0;
  }
  const decoded = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded > 0 ? decoded : 0;
}

/**
 * Slices one piece of text for transport, returning the rest as a cursor.
 *
 * The protocol is stateless and lossless: a chunk is at most
 * {@link MCP_TEXT_CHUNK_CHARS} characters, a cursor names the character offset
 * of the next chunk (base64, opaque), and calling again with that cursor — and
 * the SAME selection arguments — yields the next chunk. Concatenating every
 * chunk's `content` in order reproduces the input byte for byte, whitespace and
 * newlines included.
 *
 * A text that fits returns no `cursor` at all. That is a deliberate reading:
 * "there is more" must be a field's presence, so a client that loops until the
 * cursor disappears cannot loop forever on a chunk that was already the last
 * one.
 *
 * Consumers: `session_read`'s output, and the criterion, which drives both the
 * multi-chunk reassembly and the single-chunk negative control.
 */
export function paginateMcpText(text: string, cursor?: string): { content: string; cursor?: string } {
  const offset = decodeMcpCursor(cursor);
  const content = text.slice(offset, offset + MCP_TEXT_CHUNK_CHARS);
  const next = offset + content.length;
  return next < text.length ? { content, cursor: encodeMcpCursor(next) } : { content };
}

// --------------------------- transcript rendering ---------------------------

/** Cap on one inlined argument/result summary, so a tool call stays one line. */
const INLINE_SUMMARY_CHARS = 200;

/** One value's text on a single line: every run of whitespace becomes one space. */
function collapseToOneLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * One value as a single line.
 *
 * Tool calls carry structures (an argument bag, a result body that may hold
 * newlines); a transcript line that leaked those would turn one tool call into
 * many drawn rows, which is exactly what folding exists to prevent. The cap
 * belongs to these summaries and not to a message's own text: a long message is
 * what the cursor protocol exists for, and truncating it here would make that
 * protocol unreachable.
 */
function inline(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? null) ?? 'null';
  const collapsed = collapseToOneLine(raw);
  return collapsed.length > INLINE_SUMMARY_CHARS ? `${collapsed.slice(0, INLINE_SUMMARY_CHARS)}…` : collapsed;
}

/**
 * One normalized message as one line.
 *
 * A `tool_use` and the result that belongs to it are ONE line — the call, then
 * its outcome — because the provider's history reader folds the result onto the
 * call and a reader that drew them separately would show a tool call twice. The
 * fold is observable: the line names the tool, its arguments and its result.
 */
function renderMessageLine(message: NormalizedMessage): string {
  const stamp = message.timestamp ?? '';
  if (message.kind === 'tool_use') {
    const name = message.toolName ?? 'tool';
    const errorFlag = message.toolResult?.isError ? ' [error]' : '';
    const result = message.toolResult === undefined ? '(no result)' : inline(message.toolResult.content);
    return `[${stamp}] tool ${name}(${inline(message.toolInput)})${errorFlag} -> ${result}`;
  }
  if (message.kind === 'tool_result') {
    return `[${stamp}] tool_result ${inline(message.content)}`;
  }
  return `[${stamp}] ${message.role ?? message.kind}: ${collapseToOneLine(String(message.content ?? message.text ?? ''))}`;
}

// --------------------------- argument reading ---------------------------

/** The JSON-RPC code a tool returns when it is registered but owned by a later task. */
export const MCP_TOOL_NOT_IMPLEMENTED_CODE = 'MCP_TOOL_NOT_IMPLEMENTED';

function requireStringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      `"${key}" is required and must be a non-empty string.`,
    );
  }
  return value;
}

function optionalPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

// --------------------------- shared session reads ---------------------------

/** How many recent sessions one `sessions_list` page reads. */
const SESSION_LIST_PAGE_SIZE = 200;

/** `session_read` returns this many messages when the caller names no limit. */
const DEFAULT_LATEST_LIMIT = 5;

type SessionRow = {
  id: string;
  title: string;
  provider: string;
  projectId: string | null;
  lastActivity: string | null;
};

/**
 * Every session the recents read sees, as the flat rows the tools project.
 *
 * One page is enough for this stage's fixture and for any workspace a caller
 * reads interactively; a workspace with more sessions than one page simply
 * reads the first page, which is the same bound every other recents consumer
 * takes.
 */
function readRecentSessionRows(deps: McpReadToolDeps): SessionRow[] {
  const page = deps.sessions.listRecentSessions(SESSION_LIST_PAGE_SIZE, 0);
  return page.conversations.map((row) => ({
    id: row.sessionId,
    title: row.sessionTitle,
    provider: row.provider,
    projectId: row.projectId,
    lastActivity: row.lastActivity,
  }));
}

/** The sessions of one project, as the same flat rows. */
async function readProjectSessionRows(deps: McpReadToolDeps, projectId: string): Promise<SessionRow[]> {
  const page = await deps.projects.getProjectSessionsPage(projectId, {
    limit: SESSION_LIST_PAGE_SIZE,
    offset: 0,
    includeHidden: true,
  });
  return page.sessions.map((row) => ({
    id: row.id,
    title: row.summary,
    provider: row.provider,
    projectId,
    lastActivity: row.lastActivity ?? null,
  }));
}

/**
 * Projects one session row into its listing reading.
 *
 * The three state predicates are defined in exactly one place each:
 * `running` is membership in the run registry's live set, `resident` is the
 * session's own stored lifecycle mode, and `idle` is the complement of both —
 * which is what makes the three sets disjoint by construction rather than by
 * the fixture happening to avoid an overlap.
 */
function toSessionReading(row: SessionRow, deps: McpReadToolDeps, running: ReadonlySet<string>): McpSessionReading {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    projectId: row.projectId,
    lifecycleMode: deps.sessions.readSessionLifecycle(row.id)?.mode ?? 'per-run',
    hostState: deps.hosts.liveHostForSession(row.id)?.state ?? null,
    running: running.has(row.id),
    lastActivity: readTimeField(row.lastActivity, deps.now),
  };
}

function isResident(reading: McpSessionReading): boolean {
  return reading.lifecycleMode === 'resident';
}

// --------------------------- tool bodies ---------------------------

/** The registered body of one tool: everything except the table-owned scope. */
type McpReadToolBody = {
  // AC-288: a raw shape, or a built schema carrying a constraint a raw shape
  // cannot express (`session_read`'s bounded `limit` and its `aroundId` /
  // `cursor` exclusivity). The wrapper advertises and enforces whichever it gets.
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
  handle: (args: Record<string, unknown>, deps: McpReadToolDeps) => unknown | Promise<unknown>;
};

const timeSchema = z.object({ relative: z.string(), iso: z.string() });
const nullableTimeSchema = timeSchema.nullable();

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  sessionCount: z.number(),
  lastActivity: nullableTimeSchema,
  isArchived: z.boolean(),
});

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  projectId: z.string().nullable(),
  lifecycleMode: z.string(),
  hostState: z.string().nullable(),
  running: z.boolean(),
  lastActivity: nullableTimeSchema,
});

const hostSchema = z.object({
  hostId: z.string(),
  mode: z.string(),
  state: z.string(),
  pid: z.number().nullable(),
  startedAt: timeSchema,
  idleForMs: z.number(),
  peerName: z.string().nullable(),
  leases: z.array(z.unknown()),
});

const runSchema = z.object({
  sessionId: z.string(),
  provider: z.string(),
  startedAt: timeSchema,
  lastSeq: z.number(),
});

/**
 * The refusal a registered-but-unwired tool answers with: `overview` /
 * `quay_snapshot` when the deps carry no quay runner (AC-247), and `run_get`
 * when the deps carry no run-get bag (AC-248). AC-247's real handlers live in
 * `mcp-overview-tools.js` and AC-248's in `mcp-run-get.js`; this fallback is
 * what an AC-240/244/245 mount — which wires neither — still reads, so those
 * criteria keep the exact tool behaviour they had.
 */
function notImplemented(name: McpStage3ReadToolName, owner: string): never {
  throw new McpToolError(
    MCP_TOOL_NOT_IMPLEMENTED_CODE,
    `${name} is registered by AC-245 but its behaviour is delivered by ${owner}.`,
    false,
    { tool: name, owner },
  );
}

/** The largest page `session_read` will take. A caller asking for more is refused. */
const MCP_SESSION_READ_MAX_LIMIT = 200;

/**
 * `session_read`'s declared input (AC-288): the shape of its arguments PLUS two
 * constraints a raw shape cannot state — `limit` is bounded to
 * `[1, MCP_SESSION_READ_MAX_LIMIT]`, and `aroundId` and `cursor` are mutually
 * exclusive (`aroundId` selects a window; `cursor` pages a whole transcript, so
 * naming both is a contradiction, not a refinement).
 *
 * One schema, two duties: it is handed to the SDK so `tools/list` advertises the
 * bounds and the exclusivity note, and it is parsed by the audited wrapper so a
 * violating call becomes one `INVALID_ARGUMENT` envelope with a per-field
 * `problem` rather than a silently clamped page.
 */
const sessionReadInputSchema = z
  .object({
    session: z.string(),
    mode: z.enum(['latest', 'outline', 'around']).optional(),
    limit: z.number().int().min(1).max(MCP_SESSION_READ_MAX_LIMIT).optional(),
    aroundId: z.string().optional(),
    before: z.number().optional(),
    after: z.number().optional(),
    cursor: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.aroundId !== undefined && value.cursor !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['aroundId'],
        message: 'aroundId and cursor cannot be combined; name only one.',
      });
    }
  });

const TOOL_BODIES = {
  overview: {
    inputSchema: { project: z.string().optional() },
    outputSchema: { overview: z.unknown().optional() },
    handle: () => notImplemented('overview', 'AC-247'),
  },
  projects_list: {
    inputSchema: { includeArchived: z.boolean().optional() },
    outputSchema: { projects: z.array(projectSchema) },
    async handle(args, deps) {
      const includeArchived = args.includeArchived === true;
      const read = (options: { skipSynchronization?: boolean; includeHidden?: boolean }) =>
        deps.projects.getProjectsWithSessions(options);
      const active = await read({ skipSynchronization: true, includeHidden: true });
      const archived = includeArchived
        ? await deps.projects.getArchivedProjectsWithSessions({ skipSynchronization: true })
        : [];

      // Newest activity first, so the reading is ordered by the same fact the
      // recents list orders by rather than by the database's insertion order.
      const projects: McpProjectReading[] = [...active, ...archived]
        .map((project) => ({
          id: project.projectId,
          name: project.displayName,
          path: project.path,
          sessionCount: project.sessionMeta.total,
          lastActivity: readTimeField(project.sessions[0]?.lastActivity, deps.now),
          isArchived: project.isArchived === true,
        }))
        .sort((left, right) => (right.lastActivity?.iso ?? '').localeCompare(left.lastActivity?.iso ?? ''));

      return { projects };
    },
  },
  sessions_list: {
    inputSchema: {
      project: z.string().optional(),
      state: z.enum(['running', 'idle', 'resident', 'any']).optional(),
    },
    outputSchema: { sessions: z.array(sessionSchema), total: z.number() },
    async handle(args, deps) {
      const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : null;
      const state = typeof args.state === 'string' ? (args.state as 'running' | 'idle' | 'resident' | 'any') : 'any';
      const rows = project === null ? readRecentSessionRows(deps) : await readProjectSessionRows(deps, project);
      const running = new Set(deps.runs.listRunningRuns().map((run) => run.sessionId));

      const sessions = rows
        .map((row) => toSessionReading(row, deps, running))
        .filter((session) => {
          // An empty result is a legitimate answer, not a failure: "no session
          // of this project is running" is exactly what a caller asking for
          // `state: 'running'` wanted to hear.
          if (state === 'running') return session.running;
          if (state === 'resident') return isResident(session);
          if (state === 'idle') return !session.running && !isResident(session);
          return true;
        });

      return { sessions, total: sessions.length };
    },
  },
  session_get: {
    inputSchema: { session: z.string() },
    outputSchema: {
      session: sessionSchema,
      host: hostSchema.nullable(),
      hostNote: z.string().nullable(),
      run: runSchema.nullable(),
    },
    handle(args, deps) {
      const sessionId = requireStringArgument(args, 'session');
      const rows = readRecentSessionRows(deps);
      const row = rows.find((candidate) => candidate.id === sessionId);
      if (!row) {
        throw new McpToolError(MCP_ERROR_CODES.SESSION_NOT_FOUND, `No session has id "${sessionId}".`);
      }

      const running = new Set(deps.runs.listRunningRuns().map((run) => run.sessionId));
      const session = toSessionReading(row, deps, running);
      const live = deps.hosts.liveHostForSession(sessionId);
      const binding = live?.bindings.get(sessionId) ?? null;
      const run = deps.runs.listRunningRuns().find((candidate) => candidate.sessionId === sessionId) ?? null;

      return {
        session,
        host: live === null || binding === null
          ? null
          : {
              hostId: live.hostId,
              mode: live.mode,
              state: live.state,
              pid: live.pid,
              startedAt: formatMcpTime(live.startedAt, deps.now),
              idleForMs: Math.max(0, deps.now() - binding.lastActivityAt),
              peerName: binding.peerName,
              // Verbatim, never summarized: a lease IS the reason a process is
              // still alive, and a client that has to guess it cannot tell a
              // held host from a stuck one.
              leases: binding.leases.map((lease) => ({ ...lease })),
            },
        // A cold session says so in words rather than by an absent key: "there
        // is no host" is a reading, and a missing field is not.
        hostNote:
          live === null || binding === null
            ? 'No host: this session currently has no host process (per-invocation process mode and not running).'
            : null,
        run:
          run === null
            ? null
            : {
                sessionId: run.sessionId,
                provider: run.provider,
                startedAt: formatMcpTime(run.startedAt, deps.now),
                lastSeq: run.lastSeq,
              },
      };
    },
  },
  session_read: {
    inputSchema: sessionReadInputSchema,
    outputSchema: {
      session: z.string(),
      mode: z.string(),
      content: z.string(),
      cursor: z.string().optional(),
    },
    async handle(args, deps) {
      const sessionId = requireStringArgument(args, 'session');
      const mode = typeof args.mode === 'string' ? (args.mode as 'latest' | 'outline' | 'around') : 'latest';
      let text: string;

      if (mode === 'outline') {
        const outline = await deps.sessions.fetchOutline(sessionId);
        text = outline.turns
          .map((turn) => `[${turn.timestamp}] #${turn.index} ${turn.id}: ${inline(turn.preview)}`)
          .join('\n');
      } else if (mode === 'around') {
        const window = await deps.sessions.fetchWindowAround(sessionId, {
          aroundId: requireStringArgument(args, 'aroundId'),
          before: optionalPositiveInteger(args.before, 0),
          after: optionalPositiveInteger(args.after, 0),
        });
        text = window.messages.map(renderMessageLine).join('\n');
      } else {
        const history = await deps.sessions.fetchHistory(sessionId, {
          limit: optionalPositiveInteger(args.limit, DEFAULT_LATEST_LIMIT),
          offset: 0,
        });
        text = history.messages.map(renderMessageLine).join('\n');
      }

      const cursor = typeof args.cursor === 'string' && args.cursor.length > 0 ? args.cursor : undefined;
      const page = paginateMcpText(text, cursor);
      return {
        session: sessionId,
        mode,
        content: page.content,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    },
  },
  run_get: {
    inputSchema: {
      runId: z.string().optional(),
      waitSeconds: z.number().optional(),
      session: z.string().optional(),
      // AC-245's placeholder declared `{ run, wait }`, and its criterion still
      // calls `run_get` with those keys to read the NAMED
      // `MCP_TOOL_NOT_IMPLEMENTED` refusal. Keeping them accepted-but-ignored
      // lets that call reach the handler instead of failing schema validation —
      // AC-248's real handler reads `runId`/`waitSeconds` and enforces `runId`
      // itself, so the name set and AC-245's reading are both untouched.
      run: z.string().optional(),
      wait: z.boolean().optional(),
    },
    outputSchema: { run: z.unknown().optional() },
    handle: () => notImplemented('run_get', 'AC-248'),
  },
  quay_snapshot: {
    inputSchema: { project: z.string().optional(), refresh: z.boolean().optional() },
    outputSchema: { snapshot: z.unknown().optional() },
    handle: () => notImplemented('quay_snapshot', 'AC-247'),
  },
} satisfies Record<McpStage3ReadToolName, McpReadToolBody>;

// --------------------------- registration ---------------------------

/** One read tool as it is handed to the registration seam. */
export type McpReadToolRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /** AC-288: a raw shape, or a built schema carrying a constraint a raw shape cannot express. */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
};

/**
 * The seam `registerMcpReadTools` installs through.
 *
 * The transport supplies one backed by AC-244's `withMcpAudit` — so every read
 * tool inherits the single audit row and the scope refusal without restating
 * either. The criterion supplies a recording seam instead, which is how it
 * reads back the names, descriptions and required scopes a registration
 * actually declared.
 */
export type McpReadToolSeam = (registration: McpReadToolRegistration) => void;

/**
 * Registers every stage-3 read tool exactly once.
 *
 * The scope comes from {@link MCP_STAGE3_READ_TOOLS} — the table is the one
 * place the pair (name, scope) is written down, and the body table is keyed by
 * the same names under a `satisfies`, so a tool added to one and not the other
 * is a type error rather than a silently missing registration.
 *
 * `overview` and `quay_snapshot` are AC-247's. When the injected deps are wired
 * with the quay runner and the activity store, those two names are registered by
 * {@link registerMcpOverviewTools} — the real handlers, with their metadata
 * passed down from this same table so the tool set stays one statement. When the
 * deps are NOT wired (AC-240/244/245's mounts), the two keep their body-table
 * refusal, so those criteria read exactly what they read before this task.
 * Either way the registered NAME SET is unchanged — this replaces handlers, it
 * does not add or rename a tool.
 *
 * `run_get` is AC-248's and follows the same routing: when `deps.runGet` is
 * supplied it is registered by `mcp-run-get.js`'s real handler, otherwise it
 * keeps the body-table refusal. The name set is untouched either way.
 */
export function registerMcpReadTools(seam: McpReadToolSeam, deps: McpReadToolDeps): void {
  const overviewDeps: McpOverviewDeps | null = isOverviewWired(deps) ? deps : null;
  const runGetDeps: McpRunGetDeps | null = isRunGetWired(deps) ? deps.runGet : null;
  const table = new Map<string, (typeof MCP_STAGE3_READ_TOOLS)[number]>(
    MCP_STAGE3_READ_TOOLS.map((tool) => [tool.name, tool]),
  );

  /** A tool's metadata, read from the one table so a name cannot drift from its scope. */
  const registration = (name: McpStage3ReadToolName): McpOverviewRegistration => {
    const tool = table.get(name);
    const body = TOOL_BODIES[name];
    if (tool === undefined) {
      throw new Error(`the stage-3 read table is missing "${name}"`);
    }
    return {
      name: tool.name,
      description: tool.description,
      requiredScope: tool.requiredScope,
      inputSchema: body.inputSchema,
      outputSchema: body.outputSchema,
    };
  };

  for (const tool of MCP_STAGE3_READ_TOOLS) {
    if (overviewDeps !== null && (tool.name === 'overview' || tool.name === 'quay_snapshot')) {
      continue;
    }
    if (runGetDeps !== null && tool.name === 'run_get') {
      continue;
    }
    const body = TOOL_BODIES[tool.name];
    seam({
      name: tool.name,
      description: tool.description,
      requiredScope: tool.requiredScope,
      inputSchema: body.inputSchema,
      outputSchema: body.outputSchema,
      handler: (args) => body.handle(args, deps),
    });
  }

  if (overviewDeps !== null) {
    registerMcpOverviewTools(seam, overviewDeps, {
      overview: registration('overview'),
      quaySnapshot: registration('quay_snapshot'),
    });
  }

  if (runGetDeps !== null) {
    const runGet: McpRunGetRegistration = registration('run_get');
    registerMcpRunGetTool(seam, runGetDeps, runGet);
  }
}
