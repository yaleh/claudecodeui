/**
 * The MCP gateway's `run_get` handler (AC-248).
 *
 * `run_get` reads one run by id and, when asked, waits a BOUNDED time for it to
 * settle. Everything it reads is injected ({@link McpRunGetDeps}): the run
 * registry (lookup + the boot the run was created under), the activity store
 * (turn phase and pending tool), the provider sessions service (history, for the
 * closing assistant message and the miss fallback), and — this is the point —
 * the clock and the sleeper. The wait loop moves ONLY through `deps.now()` and
 * `deps.sleep()`, never `Date.now()`/`setTimeout` directly, so a criterion can
 * drive it on a fake clock and assert "returned before the full budget" as a
 * number rather than by waiting.
 *
 * Three readings, and what each establishes:
 *
 *  - a HIT (`ChatRunSummary`) is the run's summary plus its live turn phase and
 *    pending tool from the activity store; a settled run additionally carries its
 *    session's last assistant message.
 *  - a MISS is typed. `expired` (the run existed and aged out of retention),
 *    `unknown` (the id was never handed out) and `restarted` (the run belongs to
 *    a previous process boot) each carry a DIFFERENT explanation and, when a
 *    session can be named, a fallback read of that session's recent messages.
 *  - a WAIT returns as soon as one of three things happens — the run reaches a
 *    terminal state, its turn parks on `awaitingPermission`, or the deadline
 *    passes — and never sleeps for a requested `waitSeconds` above
 *    {@link MCP_RUN_GET_MAX_WAIT_SECONDS}. `waitSeconds` absent or `0` returns
 *    the current state without a single `sleep` call: the whole wait loop lives
 *    inside the `waitSeconds > 0` branch, so "immediate" is structural.
 *
 * `expired` / `unknown` have no record to read a session from (that is exactly
 * what `getRunById` refusing them means), so their fallback target is the
 * caller's optional `session` argument; `restarted` reads it from the summary
 * the lookup DID return. When no session can be named at all the fallback says
 * so in words rather than throwing.
 *
 * Cross-module vocabulary comes through the barrels (`ActivityProtocolSnapshot`,
 * `ChatRunLookupResult` from the websocket module). `formatMcpTime` is AC-245's
 * one time renderer — reused rather than restated. The import edge to
 * `mcp-gateway.read-tools.js` closes a cycle whose only members are hoisted
 * function declarations, none read at module-evaluation time, so it cannot
 * touch an uninitialised binding (the overview module avoids the cycle only
 * because it needs nothing but types from the sibling).
 */

import { z } from 'zod';

import type { NormalizedMessage } from '@/shared/types.js';
import type { ActivityProtocolSnapshot, ChatRunLookupResult } from '@/modules/websocket/index.js';

import { formatMcpTime } from './mcp-gateway.read-tools.js';
import type { McpReadToolDeps, McpReadToolSeam, McpTime } from './mcp-gateway.read-tools.js';

// --------------------------- limits and vocabulary ---------------------------

/**
 * The ceiling on how long `run_get` will actually wait, in seconds.
 *
 * The ONE literal for the cap: a request for longer waits this many seconds and
 * no more, so an MCP client cannot pin a request handler open indefinitely. The
 * sibling `session_send` (AC-249) imports this constant rather than writing a
 * second copy.
 */
export const MCP_RUN_GET_MAX_WAIT_SECONDS = 25;

/** How long one wait iteration sleeps before re-reading the run. */
const MCP_RUN_GET_TICK_MS = 250;

/** How many recent messages a settle/miss read takes from history. */
const MCP_RUN_GET_HISTORY_LIMIT = 20;

/** Why a wait returned. Present only when the caller asked to wait. */
export type McpRunGetOutcome = 'settled' | 'awaitingPermission' | 'timeout';

/** Why a by-id read found no run. The three are reported with distinct prose. */
export type McpRunGetMissReason = 'expired' | 'unknown' | 'restarted';

const EXPLANATION_EXPIRED = '该运行曾存在，但已超出保留期，结果不再可取。';
const EXPLANATION_UNKNOWN = '该 runId 从未被发出过。';
const EXPLANATION_RESTARTED = '服务已重启，该运行属于上一次启动。';

const EXPLANATION_BY_REASON: Record<McpRunGetMissReason, string> = {
  expired: EXPLANATION_EXPIRED,
  unknown: EXPLANATION_UNKNOWN,
  restarted: EXPLANATION_RESTARTED,
};

/** The note carried when a session's activity store has no snapshot for it. */
const NO_ACTIVITY_NOTE = '该会话无活动记录。';
/** The note carried when a settled run's session yields no assistant message. */
const NO_ASSISTANT_MESSAGE_NOTE = '该运行已结束，但该会话没有可读的助手消息。';
/** The note carried when a miss cannot name a session to fall back to. */
const NO_FALLBACK_SESSION_NOTE = '无法确定会话，无从回退。';

// --------------------------- injected services ---------------------------

/**
 * The services `run_get` answers from, all injected.
 *
 * `runs.getRunBootId` is the run's creation boot (compared against
 * `bootId()` to detect a restart); `activity.snapshot` supplies the turn phase
 * and pending tool; `sessions.fetchHistory` supplies the closing assistant
 * message and the miss fallback. `sleep` is the wait loop's only clock advance,
 * and `now` its only time read — neither is optional, so production's real
 * timers and a criterion's fake ones are the same code path.
 */
export type McpRunGetDeps = {
  runs: {
    getRunById(runId: string): ChatRunLookupResult;
    /** The boot the run was created under, or `null` when the registry no longer holds it. */
    getRunBootId(runId: string): string | null;
  };
  activity: {
    snapshot(sessionId: string): ActivityProtocolSnapshot | null;
  };
  sessions: {
    fetchHistory(sessionId: string, options: { limit: number }): Promise<{ messages: NormalizedMessage[] }>;
  };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The current process identity; a run whose boot differs from this has been restarted past. */
  bootId: () => string;
};

// --------------------------- payload ---------------------------

/** A miss's fallback read: the named session and the messages it yielded. */
export type McpRunGetFallback = {
  session: string | null;
  messages: NormalizedMessage[];
  /** Why there are no messages (no session named, or the read returned none). */
  note: string | null;
};

/** A run summary, with the activity reading and (on settle) the closing message. */
export type McpRunGetHit = {
  runId: string;
  sessionId: string;
  source: string;
  status: 'running' | 'completed' | 'aborted';
  /** The activity store's turn phase, or `null` when it has no snapshot. */
  phase: string | null;
  /** The pending tool's name, or `null`. */
  toolName: string | null;
  /** Set only when the activity store has no snapshot for the session. */
  activityNote: string | null;
  startedAt: McpTime;
  completedAt: McpTime | null;
  elapsedMs: number;
  bootId: string;
  /** Present only when the caller asked to wait; names why the wait returned. */
  outcome?: McpRunGetOutcome;
  /** The session's last assistant message, attached when a run settled. */
  lastAssistantMessage: NormalizedMessage | null;
  /** Why a field is absent in words (no assistant message), else `null`. */
  note: string | null;
  /** Always `null` on a hit — the field exists so "no explanation" is a value, not a missing key. */
  explanation: null;
};

/** A typed miss: no run, but an explanation of why and a best-effort fallback read. */
export type McpRunGetMiss = {
  runId: string;
  status: 'unknown';
  reason: McpRunGetMissReason;
  explanation: string;
  /** The current process boot, so a caller can see which boot it was told from. */
  bootId: string;
  fallback: McpRunGetFallback;
};

/** The `run_get` tool's result. */
export type RunGetPayload = McpRunGetHit | McpRunGetMiss;

// --------------------------- input ---------------------------

/** The `run_get` tool's typed input. */
export type McpRunGetInput = {
  runId: string;
  waitSeconds?: number;
  /** Fallback target when no run is found (see the module doc). */
  session?: string;
};

/** Reads and validates `run_get`'s arguments. */
function readRunGetInput(args: Record<string, unknown>): McpRunGetInput {
  const runId = args.runId;
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    throw new Error('"runId" is required and must be a non-empty string.');
  }
  const waitSeconds =
    typeof args.waitSeconds === 'number' && Number.isFinite(args.waitSeconds) ? args.waitSeconds : undefined;
  const session = typeof args.session === 'string' && args.session.length > 0 ? args.session : undefined;
  return { runId, waitSeconds, session };
}

// --------------------------- reading a hit ---------------------------

/**
 * Projects a found run onto its reading. Async only because a settled run's
 * session history is fetched; the other outcomes attach no history (the wait
 * ended for a reason other than the run settling, so there is no "last message"
 * to mean).
 */
async function buildHit(
  runId: string,
  deps: McpRunGetDeps,
  summary: Extract<ChatRunLookupResult, { runId: string }>,
  outcome: McpRunGetOutcome | undefined,
): Promise<McpRunGetHit> {
  const snapshot = deps.activity.snapshot(summary.sessionId);
  const at = deps.now();

  let lastAssistantMessage: NormalizedMessage | null = null;
  let note: string | null = null;
  if (outcome === 'settled') {
    const history = await deps.sessions.fetchHistory(summary.sessionId, { limit: MCP_RUN_GET_HISTORY_LIMIT });
    const assistant = [...history.messages].reverse().find((message) => message.role === 'assistant');
    if (assistant === undefined) {
      note = NO_ASSISTANT_MESSAGE_NOTE;
    } else {
      lastAssistantMessage = assistant;
    }
  }

  return {
    runId: summary.runId,
    sessionId: summary.sessionId,
    source: summary.source,
    status: summary.status,
    // `phase`/`toolName` come from the activity store and nowhere else; a store
    // that has never been told about the session says so in words rather than
    // by dropping the keys.
    phase: snapshot?.turn.phase ?? null,
    toolName: snapshot?.turn.toolName ?? null,
    activityNote: snapshot === null ? NO_ACTIVITY_NOTE : null,
    startedAt: formatMcpTime(summary.startedAt, deps.now),
    completedAt: summary.completedAt === null ? null : formatMcpTime(summary.completedAt, deps.now),
    elapsedMs: Math.max(0, at - summary.startedAt),
    bootId: deps.runs.getRunBootId(runId) ?? deps.bootId(),
    ...(outcome === undefined ? {} : { outcome }),
    lastAssistantMessage,
    note,
    explanation: null,
  };
}

// --------------------------- reading a miss ---------------------------

/**
 * Builds a typed miss.
 *
 * `sessionHint` is the session the lookup itself named (only `restarted` has
 * one, because its record is still returned); otherwise the caller's optional
 * `session` is used. When neither exists the fallback says so in words — a miss
 * is a reading, not an error.
 */
async function buildMiss(
  input: McpRunGetInput,
  deps: McpRunGetDeps,
  reason: McpRunGetMissReason,
  sessionHint?: string,
): Promise<McpRunGetMiss> {
  const target = sessionHint ?? input.session ?? null;
  let messages: NormalizedMessage[] = [];
  let note: string | null = null;
  if (target === null) {
    note = NO_FALLBACK_SESSION_NOTE;
  } else {
    const history = await deps.sessions.fetchHistory(target, { limit: MCP_RUN_GET_HISTORY_LIMIT });
    messages = history.messages;
  }

  return {
    runId: input.runId,
    status: 'unknown',
    reason,
    explanation: EXPLANATION_BY_REASON[reason],
    bootId: deps.bootId(),
    fallback: { session: target, messages, note },
  };
}

// --------------------------- buildRunGet ---------------------------

/** The effective wait: a positive finite request, else zero (no waiting). */
function readWaitSeconds(waitSeconds: number | undefined): number {
  return typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 0;
}

/**
 * Reads one run by id, optionally waiting a bounded time for it to settle.
 *
 * The immediate path (`waitSeconds` absent or `0`) reads the run once and
 * returns it: no `sleep` call is reachable from here. The waiting path re-reads
 * the run and its turn on every iteration and returns as soon as the run is
 * terminal (attaching its closing assistant message), the turn parks on
 * `awaitingPermission`, or the deadline passes. The deadline is
 * `now() + min(waitSeconds, {@link MCP_RUN_GET_MAX_WAIT_SECONDS}) * 1000`.
 */
export async function buildRunGet(input: McpRunGetInput, deps: McpRunGetDeps): Promise<RunGetPayload> {
  const initial = deps.runs.getRunById(input.runId);
  if (initial.status === 'unknown') {
    return buildMiss(input, deps, initial.reason);
  }
  if (isRestarted(input.runId, deps)) {
    return buildMiss(input, deps, 'restarted', initial.sessionId);
  }

  const waitSeconds = readWaitSeconds(input.waitSeconds);
  if (waitSeconds === 0) {
    return buildHit(input.runId, deps, initial, undefined);
  }

  const effectiveWaitSeconds = Math.min(waitSeconds, MCP_RUN_GET_MAX_WAIT_SECONDS);
  const deadline = deps.now() + effectiveWaitSeconds * 1000;

  for (;;) {
    const current = deps.runs.getRunById(input.runId);
    if (current.status === 'unknown') {
      return buildMiss(input, deps, current.reason);
    }
    if (isRestarted(input.runId, deps)) {
      return buildMiss(input, deps, 'restarted', current.sessionId);
    }
    if (current.status === 'completed' || current.status === 'aborted') {
      return buildHit(input.runId, deps, current, 'settled');
    }

    const phase = deps.activity.snapshot(current.sessionId)?.turn.phase ?? null;
    if (phase === 'awaitingPermission') {
      return buildHit(input.runId, deps, current, 'awaitingPermission');
    }

    if (deps.now() >= deadline) {
      return buildHit(input.runId, deps, current, 'timeout');
    }

    await deps.sleep(MCP_RUN_GET_TICK_MS);
  }
}

/** Whether the stored run belongs to a boot other than the current process. */
function isRestarted(runId: string, deps: McpRunGetDeps): boolean {
  const runBoot = deps.runs.getRunBootId(runId);
  return runBoot !== null && runBoot !== deps.bootId();
}

// --------------------------- registration ---------------------------

/**
 * `run_get`'s metadata, as `registerMcpReadTools` passes it down from the one
 * {@link MCP_STAGE3_READ_TOOLS} table (name / description / scope / schemas), so
 * this module only attaches a real handler to a name the table already owns.
 */
export type McpRunGetRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
};

/**
 * Whether a read-tool deps bag carries a wired `run_get` deps bag.
 * `registerMcpReadTools` uses it to route the `run_get` NAME to the real handler
 * when the composition root supplied one, and to keep the named
 * `MCP_TOOL_NOT_IMPLEMENTED` refusal on a mount that did not (AC-240/244/245's
 * criteria) — the registered name set is unchanged either way.
 */
export function isRunGetWired(deps: McpReadToolDeps): deps is McpReadToolDeps & { runGet: McpRunGetDeps } {
  return deps.runGet !== undefined;
}

/**
 * Registers `run_get` with its real handler through the audited registration
 * seam. Consumers: `registerMcpReadTools`, which routes the one name here when
 * its deps are wired, and the criterion, which drives the seam directly to read
 * back the registered name.
 */
export function registerMcpRunGetTool(
  seam: McpReadToolSeam,
  deps: McpRunGetDeps,
  registration: McpRunGetRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: (args) => buildRunGet(readRunGetInput(args), deps),
  });
}
