import { sessionsDb } from '@/modules/database/index.js';
import type {
  ControlBackgroundTaskOutcome,
  ControlStopTaskOutcome,
} from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  assertSessionAccess,
  dispatchRun,
} from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import type {
  AnyRecord,
  HostQueuedInputCancelResult,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';

/**
 * Who asked for a control action, and through which front end.
 *
 * `userId` is `null` for a caller that was never authenticated — an upgrade with
 * no user attached — and that is exactly the value the shared access entry
 * refuses. It is carried here rather than asserted away at the boundary, so the
 * refusal stays the one entry's decision instead of this service inventing a
 * second check.
 *
 * `via` names the adapter that made the call — the WebSocket gateway, the
 * scheduled-message dispatcher, or the MCP gateway. It is carried so the run
 * this service registers can state its origin (`websocket` → `user`,
 * `scheduled` → `scheduled`); the adapter does not get to omit it, because a
 * caller that forgot would otherwise be indistinguishable from one that
 * knowingly came in over a socket.
 */
type ControlCaller = {
  userId: string | number | null;
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
  /**
   * The transport handle a socket front end wants this run's frames streamed
   * to, or `null`/absent for a caller with no live client (scheduled, and the
   * MCP gateway's tools).
   *
   * The control service is transport-free and never sends a frame itself, but a
   * run is only readable live by the socket that asked for it (`chat.send` binds
   * the requesting socket as the run's connection). The WebSocket adapter
   * therefore passes its socket here so the run it dispatches reaches the same
   * audience the old inline `chat.send` did; a timer passes nothing, and the run
   * simply has no live audience until someone subscribes.
   */
  connection?: RealtimeClientConnection | null;
};

/**
 * The value `send` returns. Success is the registered run's id — the id the run
 * registry minted, handed back the moment the run exists, *not* after the turn
 * ends — together with whether the turn was written into a provider process that
 * was already running.
 *
 * `queued` is `false` and `queuedMessageUuid` is `null` for the ordinary send;
 * for a resident session's busy send `queued` is `true` and
 * `queuedMessageUuid` is the uuid the provider stamped the message with, which
 * is the id `cancelQueued` withdraws it by. It can still be `null` on a
 * `queued: true` result when the gateway has no seam to name the queued message
 * — the message is queued all the same, but no later withdrawal can address it,
 * so a null is the honest report rather than a fabricated id.
 *
 * Failure is a value with a stable code, so each adapter can translate it
 * without parsing an exception (the WebSocket handler into a `protocol_error`
 * frame, the MCP gateway into an `isError` tool result).
 */
type SendResult =
  | {
      ok: true;
      runId: string;
      queued: boolean;
      queuedMessageUuid: string | null;
      /**
       * A promise for the run's own outcome, resolving when the provider turn
       * settles. It is *not* awaited by `send` — the run is already admitted and
       * keeps going — but it is handed back so a caller that must report a
       * failure has somewhere to read it from: the scheduled dispatcher records
       * a failed delivery on the message row, and a crash after registration
       * would otherwise be invisible to it (`send` resolves before the provider
       * has run). `error` is the provider runtime's own failure text, or `null`
       * when the turn completed.
       */
      completion: Promise<{ started: boolean; error: string | null }>;
    }
  | {
      ok: false;
      code: 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER' | 'RUN_IN_PROGRESS' | 'FORBIDDEN';
      message: string;
    };

/**
 * What `abort` returns.
 *
 * Success carries the provider's own answer for the aborted turn — `aborted:
 * true` when a live process was really stopped, `false` when there was nothing
 * to stop — so the verdict is never fabricated here. A refusal is a value with a
 * stable `code` in the same vocabulary `send` uses, so each adapter translates
 * it without parsing an exception; `aborted: false` is stated on every refusal
 * so a caller that only reads that field is told the truth rather than left
 * undefined.
 */
type AbortResult =
  | { ok: true; aborted: boolean }
  | {
      ok: false;
      aborted: false;
      code: 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER' | 'FORBIDDEN';
      message: string;
    };

/**
 * The verdicts a transport-free control verb states before it reaches a driver.
 *
 * `forbidden` is the shared access entry's own word, kept in the lowercase the
 * gateway's control verbs already answer in; the two upper-case codes are the
 * ones `send`/`abort` state for a session that does not exist and a provider
 * with no runtime assembled. Keeping one vocabulary across the string-returning
 * verbs lets an adapter translate any of the five without a per-verb table.
 */
type ControlVerbRefusal = 'forbidden' | 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER';

/** What `stopTask` returns: the driver's outcome vocabulary, or a stable refusal. */
type StopTaskResult = ControlStopTaskOutcome | ControlVerbRefusal;

/** What `backgroundTask` returns: the driver's outcome vocabulary, or a refusal. */
type BackgroundTaskResult = ControlBackgroundTaskOutcome | ControlVerbRefusal;

/**
 * Upper bound on how long `send` waits for the provider to hand over a queued
 * message's uuid before degrading to `queuedMessageUuid: null`.
 *
 * The gateway contract is "resolve once the message has been written into the
 * queue", a synchronous act in the resident drivers, so a healthy driver never
 * reaches this bound; it exists so a gateway whose promise never settles cannot
 * hold a `send` — and the caller that is awaiting it — open forever. Degrading
 * to `null` is the conservative direction: the caller learns the message was
 * queued, but learns honestly that it holds no id to withdraw it by.
 */
const QUEUED_UUID_HANDOVER_TIMEOUT_MS = 2_000;

/**
 * Reads the uuid the provider stamped a just-queued message with, bounded.
 *
 * `null` covers every way the uuid can be unavailable — no seam on the gateway,
 * a seam that answers `null`, a seam that rejects, or one that never settles
 * inside the bound. All of them mean the same thing to the caller: the message
 * is queued, but it cannot be named for withdrawal. A missing seam is never
 * read as an empty-string uuid, because an id no withdrawal can match is worse
 * than a stated absence.
 */
async function readQueuedMessageUuid(
  runtime: ProviderRuntimeGateway,
  provider: LLMProvider,
  sessionId: string,
): Promise<string | null> {
  const read = runtime.queuedInputUuid;
  if (typeof read !== 'function') {
    return null;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const bound = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), QUEUED_UUID_HANDOVER_TIMEOUT_MS);
      timer.unref?.();
    });
    const uuid = await Promise.race([read.call(runtime, provider, sessionId), bound]);
    return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

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
  /**
   * The single access entry every control verb shares (`send`, `abort`,
   * `cancelQueued`, `stopTask`, `backgroundTask`).
   *
   * Defaults to this module's own {@link assertSessionAccess}. The seam exists
   * so a criterion can hand over a counting spy and observe that all five verbs
   * go through the *same* entry — delegating to the production one, so the
   * verdict is the real ownership answer rather than a stub — instead of each
   * carrying a check of its own.
   */
  assertSessionAccess?: (
    userId: string | number | null,
    session: ReturnType<typeof sessionsDb.getSessionById>,
  ) => boolean;
};

/**
 * The access entry a control verb must call: the injected seam when one was
 * provided, the process default otherwise.
 *
 * Every control verb resolves it here rather than reaching for the module
 * function directly, so an injected entry sees all five. That is the seam the
 * criterion (`server/modules/websocket/tests/chat-control-access.test.ts`) reads
 * to prove the five verbs share one entry rather than each carrying an inline
 * check. It mirrors the gateway's own helper of the same name.
 */
function accessEntry(
  dependencies: ChatControlDependencies,
): (userId: string | number | null, session: ReturnType<typeof sessionsDb.getSessionById>) => boolean {
  return dependencies.assertSessionAccess ?? assertSessionAccess;
}

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
 * no frames and reports nothing by emitting. It ships `send` — including the
 * resident-session busy branch that queues into a running process and hands the
 * queued message's uuid back — `cancelQueued`, which withdraws a message by that
 * uuid, and `abort`/`stopTask`/`backgroundTask`, which reach the provider's own
 * control verbs. All five take the one shared access entry before any driver
 * call. The remaining verbs (`editSend`/`answerApproval`/`pendingApprovals`)
 * arrive with a later AC.
 *
 * Consumed by this module's criteria
 * (`server/modules/websocket/tests/chat-control-send.test.ts`,
 * `chat-control-busy.test.ts`, `chat-control-access.test.ts`); the composition
 * root (`server/index.ts`) wires the single instance in AC-233.
 */
export function createChatControlService(deps: ChatControlDependencies) {
  /**
   * Registers a run for one session and returns its id immediately.
   *
   * The shared access entry is consulted first — before the session-not-found
   * verdict and long before any driver call — so an unauthenticated caller
   * (`FORBIDDEN`) can neither register a run nor reach the provider. Only then
   * must the session exist (`SESSION_NOT_FOUND`) and its provider have a runtime
   * (`UNSUPPORTED_PROVIDER`); the turn is handed to `dispatchRun`, which
   * registers the run and starts the provider in the background.
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

    // The shared access entry runs before the session-not-found verdict, so an
    // unauthenticated caller gets one answer for every session — it cannot tell
    // a session it may not touch from one that does not exist.
    if (!accessEntry(deps)(caller.userId, session)) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: `Caller is not allowed to send to session "${input.sessionId}".`,
      };
    }

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
    // which `dispatchRun` reaches only once `startRun` has returned a run. The
    // same hook reports whether that run took the resident-session busy path, so
    // the two facts `send` needs — the id and whether the turn was queued into a
    // running process — arrive together, and neither is re-derived by probing
    // the registry.
    let resolveRunId!: (runId: string) => void;
    const runIdPromise = new Promise<string>((resolve) => {
      resolveRunId = resolve;
    });
    let busyAccepted = false;

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
      // `ws` is deliberately `null`: the run's refusal is reported as this
      // call's result (translated by the adapter), never as a frame written
      // inside `dispatchRun`, so passing the socket here would double-send a
      // `RUN_IN_PROGRESS` frame. The socket still binds to the run — as the
      // connection override below — so its frames stream to the requesting client.
      null,
      caller.userId,
      input.sessionId,
      session,
      data,
      deps,
      {},
      (run, info) => {
        busyAccepted = info.busyAccepted;
        resolveRunId(run.runId);
      },
      input.connection ?? null,
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

    if (busyAccepted) {
      // The message is in the provider's own queue now. The uuid it was stamped
      // with comes from the provider, never minted here, because only that uuid
      // can be withdrawn later; a gateway with no such seam degrades to `null`.
      const queuedMessageUuid = await readQueuedMessageUuid(deps.runtime, provider, input.sessionId);
      return { ok: true, runId: outcome.runId, queued: true, queuedMessageUuid, completion: dispatchPromise };
    }

    return { ok: true, runId: outcome.runId, queued: false, queuedMessageUuid: null, completion: dispatchPromise };
  }

  /**
   * Withdraws a message a busy send queued, before the provider's process has
   * started running it.
   *
   * The refusal is the same shared access entry every other control verb uses
   * (`send`, `abort`, `stopTask`, `backgroundTask`), and it is taken before the
   * driver is reached, so a caller with no access can neither withdraw a queued
   * message nor learn whether a uuid is live. The verdict itself is the
   * provider's own: this function does not decide whether the message was still
   * queued, it reports what the queue said, and reads a gateway with no
   * withdrawal seam as `unknown` — the one answer that must not be confused with
   * a successful withdrawal.
   */
  async function cancelQueued(
    caller: ControlCaller,
    input: { sessionId: string; messageUuid: string },
  ): Promise<HostQueuedInputCancelResult | 'forbidden'> {
    const session = sessionsDb.getSessionById(input.sessionId);

    if (!accessEntry(deps)(caller.userId, session)) {
      return 'forbidden';
    }

    if (!session) {
      return 'unknown';
    }

    const provider = session.provider as LLMProvider;
    return (
      (await deps.runtime.cancelQueuedInput?.(provider, input.sessionId, input.messageUuid)) ??
      'unknown'
    );
  }

  /**
   * Stops the run a session currently has, through the provider's own process.
   *
   * The same shape as `send`: the shared access entry runs first, so an
   * unauthenticated caller is refused without the provider being told anything;
   * the session must then exist and its provider must have a runtime before the
   * driver is reached. The verdict is the provider's own `abort` answer, so a
   * process that had already ended reports `aborted: false` rather than a
   * fabricated success.
   *
   * "Is there a run to abort" is deliberately **not** decided here. The registry
   * is the adapter's state and reading it around this call races the run's own
   * terminal event — an abort that kills a process can let that process's exit
   * path complete the run first, and a registry check made here would then turn a
   * real stop into a false `NO_ACTIVE_RUN`. The WebSocket handler checks the
   * registry *before* delegating (as it always has).
   *
   * The terminal `complete` for the aborted run is emitted here, immediately
   * after the provider answers, for the same timing reason: a stop that releases
   * an in-process generator (codex's forged stream, and its real SDK's abort)
   * can otherwise let that generator settle — and the run's own dispatch finish —
   * before an adapter several microtasks away got to write the client's frame,
   * which would surface the run as a plain failure instead of an abort. Emitting
   * it here keeps the exactly-one-complete contract identical to the old inline
   * handler. Every front end that aborts (the WebSocket gateway now, the MCP
   * gateway later) gets the same ending.
   */
  async function abort(caller: ControlCaller, input: { sessionId: string }): Promise<AbortResult> {
    const session = sessionsDb.getSessionById(input.sessionId);

    if (!accessEntry(deps)(caller.userId, session)) {
      return {
        ok: false,
        aborted: false,
        code: 'FORBIDDEN',
        message: `Caller is not allowed to abort session "${input.sessionId}".`,
      };
    }

    if (!session) {
      return {
        ok: false,
        aborted: false,
        code: 'SESSION_NOT_FOUND',
        message: `Session "${input.sessionId}" was not found.`,
      };
    }

    const provider = session.provider as LLMProvider;
    if (!deps.runtime.hasRuntime(provider)) {
      return {
        ok: false,
        aborted: false,
        code: 'UNSUPPORTED_PROVIDER',
        message: `Provider "${provider}" is not available.`,
      };
    }

    const aborted = await deps.runtime.abort(provider, input.sessionId);

    // Runtimes skip their own terminal event for an aborted turn, and the
    // registry drops a duplicate if one still arrives; this is the client's
    // `complete`. A no-op when no run is live.
    chatRunRegistry.completeRun(input.sessionId, {
      exitCode: aborted ? 0 : 1,
      aborted: true,
    });

    return { ok: true, aborted };
  }

  /**
   * Stops one named background task of a session through the provider's process.
   *
   * Transport-free and, for now, deliberately thin: it takes the shared access
   * entry first, then requires the session and a runtime, and hands the request
   * to the runtime's `controlStopTask`. The gateway handler's full "validate,
   * place, wait for the task table to settle" sequence is AC-233's to build on
   * top of this seam — a service that repeated it here would run the
   * confirmation wait for a caller that had not yet been authenticated through
   * the handler.
   */
  async function stopTask(
    caller: ControlCaller,
    input: { sessionId: string; taskId: string },
  ): Promise<StopTaskResult> {
    const session = sessionsDb.getSessionById(input.sessionId);

    if (!accessEntry(deps)(caller.userId, session)) {
      return 'forbidden';
    }

    if (!session) {
      return 'SESSION_NOT_FOUND';
    }

    const provider = session.provider as LLMProvider;
    if (!deps.runtime.hasRuntime(provider)) {
      return 'UNSUPPORTED_PROVIDER';
    }

    return (await deps.runtime.controlStopTask?.(provider, input.sessionId, input.taskId)) ?? 'unsupported';
  }

  /**
   * Promotes one named foreground tool to a background task through the
   * provider's process.
   *
   * The stop-task sibling's shape, with the runtime's `controlBackgroundTask` as
   * its driver. The Turn Tracker match the gateway handler performs is AC-233's
   * to add; here the request only has to pass the one access entry first and
   * then reach the driver.
   */
  async function backgroundTask(
    caller: ControlCaller,
    input: { sessionId: string; toolUseId: string },
  ): Promise<BackgroundTaskResult> {
    const session = sessionsDb.getSessionById(input.sessionId);

    if (!accessEntry(deps)(caller.userId, session)) {
      return 'forbidden';
    }

    if (!session) {
      return 'SESSION_NOT_FOUND';
    }

    const provider = session.provider as LLMProvider;
    if (!deps.runtime.hasRuntime(provider)) {
      return 'UNSUPPORTED_PROVIDER';
    }

    return (
      (await deps.runtime.controlBackgroundTask?.(provider, input.sessionId, input.toolUseId)) ??
      'unsupported'
    );
  }

  return { send, abort, cancelQueued, stopTask, backgroundTask };
}
