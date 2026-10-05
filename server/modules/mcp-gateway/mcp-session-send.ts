/**
 * The MCP gateway's `session_send` handler (AC-249).
 *
 * `session_send` opens a chat run through the SAME control service the
 * WebSocket gateway and the scheduled-message timer use, and returns the run's
 * id IMMEDIATELY — the run keeps going after the tool call resolves. That
 * immediacy is structural, not a timeout: the wait loop lives only inside the
 * `waitSeconds > 0` branch (routed through AC-248's `buildRunGet`), so a
 * default-`waitSeconds` call has no `sleep` reachable from it at all.
 *
 * What this module owns is the ADAPTER half: the caller is the token's owner
 * (`{ userId, via: 'mcp' }`), the control service's structured refusals are
 * translated into JSON-bodied errors the audit wrapper turns into an `isError`
 * result, and the two facts the control service cannot state — the run's
 * recorded `source` and, on `RUN_IN_PROGRESS`, the id of the run that is still
 * in flight — are read back from the run registry.
 *
 * Everything is injected ({@link McpSessionSendDeps}): the control seam, the run
 * reader, and the `run_get` builder plus its deps. Production wires the process
 * singletons (`server/index.ts`); the criterion wires the real control service
 * over its own fixture and the real `buildRunGet` over a fake clock. The module
 * holds no clock of its own — it never calls `Date.now()` or `setTimeout`, so
 * the bounded wait moves only through the injected `now`/`sleep` inside
 * `buildRunGet`.
 */

import { z } from 'zod';

import type { NormalizedMessage } from '@/shared/types.js';

import type { McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_RUN_GET_MAX_WAIT_SECONDS } from './mcp-run-get.js';
import type { McpRunGetDeps, RunGetPayload } from './mcp-run-get.js';

// --------------------------- control-service vocabulary ---------------------------

/**
 * The caller `session_send` presents to the control service.
 *
 * `via: 'mcp'` is what makes the run this adapter opens record its origin as
 * `mcp` (the control service's `SOURCE_BY_VIA`), and `userId` is the token's
 * owner — never null, because the request reached the tool through the auth
 * middleware that attached the principal.
 */
export type McpControlCaller = {
  userId: string | number | null;
  via: 'mcp';
};

/** The refusals `session_send` translates. The vocabulary is the control service's own. */
export type McpControlRefusalCode =
  | 'SESSION_NOT_FOUND'
  | 'UNSUPPORTED_PROVIDER'
  | 'RUN_IN_PROGRESS'
  | 'FORBIDDEN';

/**
 * The control service result `session_send` reads, declared structurally.
 *
 * The control service's own `SendResult` is module-local, so the shape is
 * restated here as the injection contract — deliberately narrower than the real
 * one (it drops the `completion` promise), because the adapter must NOT await
 * the run's outcome when no wait was asked for. That omission is the structural
 * half of "immediate".
 */
export type McpControlSendResult =
  | { ok: true; runId: string; queued: boolean; queuedMessageUuid: string | null }
  | { ok: false; code: McpControlRefusalCode; message: string };

/** The one control verb `session_send` needs: opening a run. */
export type McpControlSeam = {
  send(caller: McpControlCaller, input: { sessionId: string; content: string }): Promise<McpControlSendResult>;
};

// --------------------------- run reading ---------------------------

/**
 * The slice of a run record `session_send` reads, declared structurally because
 * the registry's internal `ChatRun` is not exported.
 *
 * `source` is the run's recorded origin (the `mcp` reading this tool reports);
 * `writer.userId` is the authenticated owner the run was opened for, read back
 * so a caller can see the run really belongs to the token's owner.
 */
export type McpSessionRunRecord = {
  runId: string;
  source: string;
  status: string;
  writer?: { userId?: string | number | null };
};

/** The run reader `session_send` reads the current run and its origin from. */
export type McpRunReader = {
  getRun(sessionId: string): McpSessionRunRecord | undefined;
};

/**
 * The `run_get` seam the bounded-wait branch routes through.
 *
 * `build` is AC-248's `buildRunGet` and `deps` its injected services (registry,
 * activity store, history reader, clock and sleeper). They are a seam rather
 * than an import so the criterion supplies the real builder over a fake clock.
 */
export type McpSessionRunGetSeam = {
  deps: McpRunGetDeps;
  build(input: { runId: string; waitSeconds?: number }, deps: McpRunGetDeps): Promise<RunGetPayload>;
};

/** The services `session_send` answers from, all injected. */
export type McpSessionSendDeps = {
  control: McpControlSeam;
  runs: McpRunReader;
  runGet: McpSessionRunGetSeam;
};

// --------------------------- input and payload ---------------------------

/** The `session_send` tool's typed input. */
export type McpSessionSendInput = {
  /** The session to send to; the transport's target gate resolves a name to an id first. */
  session: string;
  message: string;
  /** A bounded wait for the run to settle, in seconds; absent or `0` returns immediately. */
  waitSeconds?: number;
};

/** The `session_send` tool's Zod input shape, used for registration and validation. */
export const SESSION_SEND_INPUT_SCHEMA = {
  session: z.string(),
  message: z.string(),
  waitSeconds: z.number().optional(),
} satisfies z.ZodRawShape;

/**
 * The `session_send` result.
 *
 * `source` is the run's recorded origin (`mcp` on every run this adapter opens).
 * `run` is attached ONLY when the caller asked to wait, and is AC-248's own
 * reading — its `outcome`, its `lastAssistantMessage` and its final summary, all
 * merged under one key rather than restated here.
 */
export type SessionSendPayload = {
  runId: string;
  queued: boolean;
  queuedMessageUuid: string | null;
  source: string;
  run?: RunGetPayload;
};

/** The hint a `RUN_IN_PROGRESS` refusal carries. `run_get` and `稍后重试` are load-bearing. */
const RUN_IN_PROGRESS_HINT = '该会话已有运行在进行；改用 run_get 查询它的进展，或稍后重试。';

/** Reads and validates `session_send`'s arguments. */
export function readSessionSendInput(args: Record<string, unknown>): McpSessionSendInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new Error('"session" is required and must be a non-empty string.');
  }
  const message = args.message;
  if (typeof message !== 'string' || message.length === 0) {
    throw new Error('"message" is required and must be a non-empty string.');
  }
  const waitSeconds =
    typeof args.waitSeconds === 'number' && Number.isFinite(args.waitSeconds) && args.waitSeconds > 0
      ? args.waitSeconds
      : undefined;
  return { session, message, waitSeconds };
}

/** The effective wait, capped by AC-248's one literal: a positive request, else zero. */
function effectiveWaitSeconds(waitSeconds: number | undefined): number {
  if (waitSeconds === undefined) {
    return 0;
  }
  return Math.min(waitSeconds, MCP_RUN_GET_MAX_WAIT_SECONDS);
}

/** A structured refusal as the JSON body the audit wrapper turns into `isError` text. */
function refusal(body: Record<string, unknown>): Error {
  return new Error(JSON.stringify(body));
}

// --------------------------- buildSessionSend ---------------------------

/**
 * Opens a run for `input.session` and returns its id at once.
 *
 * The caller is the token's owner, and the control service is asked to send with
 * it — so the run this opens is registered and dispatched through the identical
 * path a WebSocket `chat.send` uses, with origin `mcp`. On success the payload
 * is returned immediately; only a positive `waitSeconds` awaits AC-248's
 * `buildRunGet` (capped at {@link MCP_RUN_GET_MAX_WAIT_SECONDS}) and merges its
 * reading under `run`.
 *
 * A refusal is thrown as a JSON-bodied error, which BOTH registration seams turn
 * into an `isError` result. `RUN_IN_PROGRESS` is widened with the in-flight
 * run's id (the control service's message does not carry one) and a hint naming
 * `run_get` as the way to follow it.
 *
 * Consumers: `registerMcpWriteTools` (the registered handler) and this module's
 * criterion, which drives it through the real mount.
 */
export async function buildSessionSend(
  input: McpSessionSendInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionSendDeps,
): Promise<SessionSendPayload> {
  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const result = await deps.control.send(caller, { sessionId: input.session, content: input.message });

  if (!result.ok) {
    if (result.code === 'RUN_IN_PROGRESS') {
      // The current run's id is read from the registry: the control service's
      // refusal message states the fact but not the id, and this is the one
      // reading that tells the caller WHICH run to follow.
      const current = deps.runs.getRun(input.session);
      throw refusal({
        code: 'RUN_IN_PROGRESS',
        runId: current?.runId ?? null,
        message: result.message,
        hint: RUN_IN_PROGRESS_HINT,
      });
    }
    throw refusal({ code: result.code, message: result.message });
  }

  const source = deps.runs.getRun(input.session)?.source ?? 'mcp';
  const payload: SessionSendPayload = {
    runId: result.runId,
    queued: result.queued,
    queuedMessageUuid: result.queuedMessageUuid,
    source,
  };

  const waitSeconds = effectiveWaitSeconds(input.waitSeconds);
  if (waitSeconds > 0) {
    payload.run = await deps.runGet.build({ runId: result.runId, waitSeconds }, deps.runGet.deps);
  }

  return payload;
}
