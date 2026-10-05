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
 * session hosts, the chat run registry) and never write anything; the three
 * owned by AC-247/AC-248 are registered with their real name, scope,
 * description and input schema and a handler that refuses with a named
 * `MCP_TOOL_NOT_IMPLEMENTED` code.
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
  };
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
type McpRunningRun = { sessionId: string; provider: LLMProvider; startedAt: number; lastSeq: number };

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
 * only draws "3 分钟前" cannot tell a stale reading from a fresh one, and a
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
    relative = '刚刚';
  } else if (elapsed < HOUR_MS) {
    relative = `${Math.floor(elapsed / MINUTE_MS)} 分钟前`;
  } else if (elapsed < DAY_MS) {
    relative = `${Math.floor(elapsed / HOUR_MS)} 小时前`;
  } else {
    relative = `${Math.floor(elapsed / DAY_MS)} 天前`;
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
    throw new Error(`"${key}" is required and must be a non-empty string.`);
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
  inputSchema: z.ZodRawShape;
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

/** The refusal the three AC-247/AC-248 tools answer with until their owner lands. */
function notImplemented(name: McpStage3ReadToolName, owner: string): never {
  throw new Error(
    JSON.stringify({
      code: MCP_TOOL_NOT_IMPLEMENTED_CODE,
      tool: name,
      owner,
      message: `${name} is registered by AC-245 but its behaviour is delivered by ${owner}.`,
    }),
  );
}

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
        throw new Error(`Session "${sessionId}" was not found.`);
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
            ? '没有宿主：该会话当前没有宿主进程（按次进程模式且未运行）。'
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
    inputSchema: {
      session: z.string(),
      mode: z.enum(['latest', 'outline', 'around']).optional(),
      limit: z.number().optional(),
      aroundId: z.string().optional(),
      before: z.number().optional(),
      after: z.number().optional(),
      cursor: z.string().optional(),
    },
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
    inputSchema: { run: z.string(), wait: z.boolean().optional() },
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
  inputSchema: z.ZodRawShape;
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
 */
export function registerMcpReadTools(seam: McpReadToolSeam, deps: McpReadToolDeps): void {
  for (const tool of MCP_STAGE3_READ_TOOLS) {
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
}
