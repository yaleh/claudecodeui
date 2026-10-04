import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  assertSessionAccess,
  dispatchRun,
} from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

/**
 * Who asked for a control action, and through which front end.
 *
 * `via` names the adapter that made the call — the WebSocket gateway, the
 * scheduled-message dispatcher, or the MCP gateway. It is carried so the run
 * this service registers can state its origin (`websocket` → `user`,
 * `scheduled` → `scheduled`); the adapter does not get to omit it, because a
 * caller that forgot would otherwise be indistinguishable from one that
 * knowingly came in over a socket.
 */
type ControlCaller = {
  userId: string | number;
  via: 'websocket' | 'mcp' | 'scheduled';
};

/**
 * The input `send` accepts. `interruptActiveRun` is the scheduled-message
 * semantics: a timer fires knowing it may land on a busy session, and the send
 * outranks whatever is running instead of being refused.
 */
type SendInput = {
  sessionId: string;
  content: string;
  options?: AnyRecord;
  interruptActiveRun?: boolean;
};

/**
 * The value `send` returns. Success is the registered run's id — the id the run
 * registry minted, handed back the moment the run exists, *not* after the turn
 * ends. Failure is a value with a stable code, so each adapter can translate it
 * without parsing an exception (the WebSocket handler into a `protocol_error`
 * frame, the MCP gateway into an `isError` tool result).
 */
type SendResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      code: 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER' | 'RUN_IN_PROGRESS' | 'FORBIDDEN';
      message: string;
    };

/**
 * The seams the control service is assembled from.
 *
 * `runtime` is the same provider gateway the WebSocket handlers use, so a run
 * dispatched here is dispatched through the identical path. `assertSessionAccess`
 * defaults to this module's own entry — the one AC-196/197/198 established for
 * the control verbs — so a caller cannot end up with a control plane that checks
 * ownership a different way than the surface does.
 */
type ChatControlDependencies = {
  runtime: ProviderRuntimeGateway;
  assertSessionAccess?: (
    userId: string | number | null,
    session: ReturnType<typeof sessionsDb.getSessionById>,
  ) => boolean;
};

/**
 * Builds the transport-agnostic control plane for chat sessions.
 *
 * This is the seam the WebSocket gateway, the scheduled-message dispatcher and
 * (later) the MCP gateway share: a run opened here is registered and dispatched
 * through the very `chatRunRegistry` + `dispatchRun` path the interactive
 * `chat.send` handler uses, so a run any front end opens is the same run the UI
 * can watch, subscribe to and abort.
 *
 * The service is deliberately transport-free: it accepts no socket, constructs
 * no frames and reports nothing by emitting. It only ships `send` today; the
 * remaining verbs (`editSend`/`abort`/`cancelQueued`/`stopTask`/
 * `backgroundTask`/`answerApproval`/`pendingApprovals`) arrive with AC-231/232.
 *
 * Consumed by this module's criterion
 * (`server/modules/websocket/tests/chat-control-send.test.ts`); the composition
 * root (`server/index.ts`) wires the single instance in AC-233.
 */
export function createChatControlService(deps: ChatControlDependencies) {
  const accessEntry = deps.assertSessionAccess ?? assertSessionAccess;

  /**
   * Registers a run for one session and returns its id immediately.
   *
   * Everything that can refuse happens before a run exists: the session must
   * exist (`SESSION_NOT_FOUND`), its provider must have a runtime
   * (`UNSUPPORTED_PROVIDER`), and the caller must own it (`FORBIDDEN`). Only
   * then is the turn handed to `dispatchRun`, which registers the run and starts
   * the provider in the background.
   *
   * The return is *immediate* — the run keeps going after this resolves. That is
   * achieved without a timeout by racing two facts `dispatchRun` produces in a
   * known order: the run id, surfaced through its `beforeRun` hook (called only
   * after `chatRunRegistry.startRun` succeeded), and the dispatch attempt
   * settling. A refused dispatch settles before `beforeRun` can run, so a
   * refusal wins the race and a registration reports its id first; neither arm
   * is decided by a clock.
   */
  async function send(caller: ControlCaller, input: SendInput): Promise<SendResult> {
    const session = sessionsDb.getSessionById(input.sessionId);
    if (!session) {
      return {
        ok: false,
        code: 'SESSION_NOT_FOUND',
        message: `Session "${input.sessionId}" was not found.`,
      };
    }

    const provider = session.provider as LLMProvider;
    if (!deps.runtime.hasRuntime(provider)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_PROVIDER',
        message: `Provider "${provider}" is not available.`,
      };
    }

    // Ownership is checked through the shared entry, before any driver call, so
    // a forbidden caller can neither register a run nor reach the provider.
    if (!accessEntry(caller.userId, session)) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: `Caller is not allowed to send to session "${input.sessionId}".`,
      };
    }

    // A scheduled send outranks whatever is running: mirroring
    // `runDetachedChatTurn`, an `interruptActiveRun` call aborts the session's
    // current run and emits its terminal `complete` on its behalf, so every
    // watching client sees the interrupted run end before the new one begins.
    if (input.interruptActiveRun) {
      const activeRun = chatRunRegistry.getRun(input.sessionId);
      if (activeRun && activeRun.status === 'running') {
        const aborted = await deps.runtime.abort(activeRun.provider, input.sessionId);
        chatRunRegistry.completeRun(input.sessionId, {
          exitCode: aborted ? 0 : 1,
          aborted: true,
        });
      }
    }

    // The "this run was registered" signal. Resolved by the `beforeRun` hook,
    // which `dispatchRun` reaches only once `startRun` has returned a run.
    let resolveRunId!: (runId: string) => void;
    const runIdPromise = new Promise<string>((resolve) => {
      resolveRunId = resolve;
    });

    const data: AnyRecord = {
      sessionId: input.sessionId,
      content: input.content,
      options: input.options ?? {},
    };

    // The run continues after `send` resolves, so its promise is guarded: a
    // rejection would otherwise surface as an unhandled rejection. It is logged
    // and settled rather than propagated, because a failure *after* the run was
    // admitted is the run's business, not this call's result.
    const dispatchPromise = dispatchRun(
      null,
      caller.userId,
      input.sessionId,
      session,
      data,
      deps,
      {},
      (run) => {
        resolveRunId(run.runId);
      },
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ChatControl] Provider run "${provider}" for session "${input.sessionId}" failed`,
        { error: message },
      );
      return { started: true, error: message };
    });

    const outcome = await Promise.race([
      runIdPromise.then((runId) => ({ registered: true as const, runId })),
      dispatchPromise.then((result) => ({ registered: false as const, result })),
    ]);

    if (!outcome.registered) {
      return {
        ok: false,
        code: 'RUN_IN_PROGRESS',
        message: `Session "${input.sessionId}" already has a run in progress.`,
      };
    }

    return { ok: true, runId: outcome.runId };
  }

  return { send };
}
