/**
 * The MCP gateway's `session_create` / `session_interrupt` handlers (AC-250).
 *
 * These are the two stage-4 write tools that create and stop a session. Both are
 * ADAPTERS: they translate a tool call into calls on the production services the
 * WebSocket gateway already uses — `sessionsService.createAppSession` and the
 * shared `ChatControlService`'s `send` / `abort` — and translate the services'
 * structured answers back into the JSON-bodied payload the audited registration
 * seam renders.
 *
 * `session_create` creates the session ROW first, then, only when a non-empty
 * `message` was given, opens the first run through the SAME control service a UI
 * send uses and returns the run's id alongside the session's. With no message the
 * control service is never called, so "created a session" and "started a run"
 * stay different acts: the run id is produced by exactly one thing (a real send)
 * and its absence is the honest reading of "no run was started".
 *
 * `session_interrupt` stops the run a session currently has and NOTHING ELSE.
 * It calls the control service's `abort` and reports what that answered: a
 * resident session's process is owned by its host driver, so interrupting leaves
 * the process (and its pid) untouched — the adapter has no host-manager seam to
 * close a host with, which is what makes "the resident process survives" a
 * property of the shape rather than of a branch a later edit could flip. An idle
 * session is reported as `aborted: false` with a message that literally says
 * there was no run to abort, never as a fabricated success.
 *
 * Everything is injected ({@link McpSessionCreateDeps} /
 * {@link McpSessionInterruptDeps}): production wires the process singletons
 * (`server/index.ts`); the criterion wires the real `sessionsService` and the
 * real control service over its own fixture. The `project` / `session` arguments
 * arrive already rewritten to an id by AC-246's target gate, which is why the
 * create path only has to look the id up, never resolve a name itself.
 */

import { z } from 'zod';

import type { LLMProvider } from '@/shared/types.js';

import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpControlCaller, McpControlRefusalCode, McpControlSeam } from './mcp-session-send.js';

// --------------------------- injected services ---------------------------

/**
 * One project a `session_create` call may target, as the write tool reads it.
 *
 * Structurally satisfied by AC-245's `McpProjectPage` (the `projects_list` read
 * shape): `id` is what AC-246's gate leaves in the `project` argument, `path` is
 * the filesystem path `createAppSession` is given, and `title` is unused here
 * but kept so one project projection serves both read and write callers.
 */
export type McpProjectEntry = {
  id: string;
  title: string;
  path: string;
};

/**
 * The `abort` verb of the shared control service, as `session_interrupt` reads
 * it.
 *
 * `ok: false` is the control service's own structured refusal (a missing session
 * / provider, or a caller not allowed to abort); `ok: true` carries the
 * provider's own answer, where `aborted: false` means there was no run in flight
 * to stop — never a fabricated stop.
 */
export type McpControlAbortResult =
  | { ok: true; aborted: boolean }
  | { ok: false; aborted: false; code: McpControlRefusalCode; message: string };

/** The one control verb `session_interrupt` needs: stopping a run. */
export type McpControlAbortSeam = {
  abort(caller: McpControlCaller, input: { sessionId: string }): Promise<McpControlAbortResult>;
};

/**
 * The services `session_create` answers from, all injected.
 *
 * `projects.list()` is the active-project projection (production:
 * `getProjectsWithSessions`); `sessions.create` /
 * `sessions.switchLifecycle` are `sessionsService.createAppSession` /
 * `sessionsService.switchSessionLifecycleMode`; `control` is the shared chat
 * control service. Narrowing `sessions` to the two members this tool reads keeps
 * the criterion from having to stand up the whole service surface.
 */
export type McpSessionCreateDeps = {
  projects: {
    list(): ReadonlyArray<McpProjectEntry>;
  };
  sessions: {
    create(
      provider: LLMProvider,
      projectPath: string,
      initialMessage: string,
    ): { sessionId: string };
    switchLifecycle(provider: LLMProvider, sessionId: string, mode: string): unknown;
  };
  control: McpControlSeam;
};

/** The services `session_interrupt` answers from. */
export type McpSessionInterruptDeps = {
  control: McpControlAbortSeam;
};

// --------------------------- input and payload ---------------------------

/** The `session_create` tool's typed input. */
export type McpSessionCreateInput = {
  /** The target project; the transport's target gate resolves a name to an id first. */
  project: string;
  /** The first message. Absent or empty means "create the session, start nothing". */
  message?: string;
  /** The provider to create the session under; absent means `claude`. */
  provider?: LLMProvider;
  /** The model preference recorded on the session. */
  model?: string;
  /** The lifecycle mode to store before any turn runs. */
  lifecycleMode?: string;
};

/** The `session_create` tool's Zod input shape, used for registration and validation. */
export const SESSION_CREATE_INPUT_SCHEMA = {
  project: z.string(),
  message: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  lifecycleMode: z.string().optional(),
} satisfies z.ZodRawShape;

/**
 * The `session_create` result.
 *
 * `runId` is present ONLY when the caller supplied a message, because it is the
 * id of the run that send actually opened — omitting the field is how "no run
 * was started" reaches a caller rather than a null placeholder it might read as
 * "a run whose id we do not know".
 */
export type SessionCreatePayload = {
  sessionId: string;
  runId?: string;
};

/** The `session_interrupt` tool's typed input. */
export type McpSessionInterruptInput = {
  /** The session to interrupt; the gate resolves a title fragment to an id first. */
  session: string;
};

/** The `session_interrupt` tool's Zod input shape. */
export const SESSION_INTERRUPT_INPUT_SCHEMA = {
  session: z.string(),
} satisfies z.ZodRawShape;

/**
 * The `session_interrupt` result.
 *
 * `aborted: true` means a run was in flight and the provider stopped it.
 * `aborted: false` means there was nothing to stop; it carries a message saying
 * so, so a caller is never left to read a silent `false` as an error.
 */
export type SessionInterruptPayload = {
  aborted: boolean;
  message?: string;
};

/**
 * The idle reading `session_interrupt` returns. The phrase 「没有可中止的运行」 is
 * load-bearing: it is what AC-250's criterion matches, and what tells a caller
 * the `false` is "nothing was running" rather than "the stop failed".
 */
const NO_RUN_TO_ABORT_MESSAGE = '该会话当前没有正在运行的运行，没有可中止的运行。';

/** A structured refusal as the JSON body the audit wrapper turns into `isError` text. */
function refusal(body: Record<string, unknown>): Error {
  return new Error(JSON.stringify(body));
}

/** Reads and validates `session_create`'s arguments. */
export function readSessionCreateInput(args: Record<string, unknown>): McpSessionCreateInput {
  const project = args.project;
  if (typeof project !== 'string' || project.trim().length === 0) {
    throw new Error('"project" is required and must be a non-empty string.');
  }
  const message = typeof args.message === 'string' ? args.message : undefined;
  const provider = typeof args.provider === 'string' ? (args.provider as LLMProvider) : undefined;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const lifecycleMode = typeof args.lifecycleMode === 'string' ? args.lifecycleMode : undefined;
  return { project, message, provider, model, lifecycleMode };
}

/** Reads and validates `session_interrupt`'s arguments. */
export function readSessionInterruptInput(args: Record<string, unknown>): McpSessionInterruptInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new Error('"session" is required and must be a non-empty string.');
  }
  return { session };
}

// --------------------------- buildSessionCreate ---------------------------

/**
 * Creates a session under `input.project`, starting a run only when a message
 * was given.
 *
 * The `project` argument is an id already (the target gate resolved it), so the
 * only lookup left is id -> project row, and a miss is a structured
 * `TARGET_NOT_FOUND` thrown BEFORE anything is created — an id that names no
 * project must not mint a session. The row is created through the injected
 * `sessions.create`; the lifecycle preference, when asked for, is stored BEFORE
 * the send, because a resident session must be resident at dispatch time rather
 * than after its first turn.
 *
 * A non-empty message is sent through the same control service the WebSocket
 * gateway uses, with the token's owner as caller, and the resulting run id is
 * returned verbatim. A refusal from the control service carries the created
 * session's id in its body — the row exists whether or not the first send
 * succeeded, and hiding that would make the caller create a second session for a
 * conversation that already has one.
 *
 * Consumers: `registerMcpWriteTools` (the registered handler) and this module's
 * criterion, which drives it through the real mount.
 */
export async function buildSessionCreate(
  input: McpSessionCreateInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionCreateDeps,
): Promise<SessionCreatePayload> {
  const entry = deps.projects.list().find((project) => project.id === input.project);
  if (entry === undefined) {
    throw refusal({
      code: 'TARGET_NOT_FOUND',
      message: `没有 id 为 "${input.project}" 的项目。`,
    });
  }

  const provider = input.provider ?? ('claude' as LLMProvider);
  const created = deps.sessions.create(provider, entry.path, input.message ?? '');

  if (input.lifecycleMode !== undefined) {
    // Before any send: the mode is read at dispatch time, so a resident session
    // whose preference were stored after the first turn would run that turn
    // per-run and only become resident once it had already ended.
    deps.sessions.switchLifecycle(provider, created.sessionId, input.lifecycleMode);
  }

  const message = input.message;
  if (message === undefined || message.length === 0) {
    return { sessionId: created.sessionId };
  }

  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const sent = await deps.control.send(caller, { sessionId: created.sessionId, content: message });
  if (!sent.ok) {
    throw refusal({ code: sent.code, message: sent.message, sessionId: created.sessionId });
  }
  return { sessionId: created.sessionId, runId: sent.runId };
}

// --------------------------- buildSessionInterrupt ---------------------------

/**
 * Interrupts the run `input.session` currently has, leaving its host alone.
 *
 * The control service's `abort` decides: `ok: false` is passed through verbatim
 * (code and message), `ok: true` reports the provider's own answer. When there
 * was no run in flight the payload says so in words — the adapter adds the
 * explanation, it never rewrites `aborted`.
 *
 * The adapter calls ONLY `abort`. It holds no host-manager seam, so it cannot
 * close a resident host or kill a process: "the resident process survives an
 * interrupt" is therefore a property of the adapter's shape, not of a check it
 * performs.
 *
 * Consumers: `registerMcpWriteTools` (the registered handler) and this module's
 * criterion, which reads the resident host's pid before and after.
 */
export async function buildSessionInterrupt(
  input: McpSessionInterruptInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionInterruptDeps,
): Promise<SessionInterruptPayload> {
  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const result = await deps.control.abort(caller, { sessionId: input.session });

  if (!result.ok) {
    throw refusal({ code: result.code, message: result.message });
  }
  if (result.aborted) {
    return { aborted: true };
  }
  return { aborted: false, message: NO_RUN_TO_ABORT_MESSAGE };
}
