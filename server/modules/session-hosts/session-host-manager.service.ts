import { randomUUID } from 'node:crypto';

import type {
  HostCloseReason,
  HostLease,
  LLMProvider,
  ProcessHost,
  ProviderRuntimeWriter,
  SessionBinding,
} from '@/shared/types.js';

/**
 * One turn the default per-run wrapper is tracking.
 *
 * The host record is what callers read; this record is the private bookkeeping
 * the close decision is computed from. `turnEnded` is set by the terminal frame
 * the runtime writes, `settled` by the run's own promise — and the gap between
 * the two is exactly the held-stdin window that used to be invisible.
 */
type PerRunTurn = {
  appSessionId: string;
  runId: string;
  turnEnded: boolean;
  settled: boolean;
  aborted: boolean;
  /** True once the gap above outlived the macrotask it was observed in. */
  lingering: boolean;
  settleGate: NodeJS.Immediate | null;
};

export type SessionHostManagerOptions = {
  /** Clock seam, so the lifecycle readings are reproducible in tests. */
  now?: () => number;
  createHostId?: () => string;
  createRunId?: () => string;
};

/**
 * One turn handed to the manager by the application-facing dispatcher.
 *
 * `start` receives the observing writer the manager builds around `writer`: the
 * caller's own dispatch runs inside it, so the manager sees each frame on its
 * way to the client without being able to alter it.
 */
export type PerRunTurnInput = {
  provider: LLMProvider;
  /** Stable application session id, or null for a caller that has none (then no host is tracked). */
  appSessionId: string | null;
  writer: ProviderRuntimeWriter;
  start(writer: ProviderRuntimeWriter): Promise<unknown>;
};

/**
 * Owns the process-host view of every provider, in every lifecycle mode.
 *
 * Consumed by the providers module's `provider-runtime.service` (which routes
 * every dispatched run through `trackPerRunTurn`) and by this module's tests,
 * which read `snapshot()`. The manager never touches frames: it wraps the
 * caller's writer with an observing proxy and forwards each frame unchanged.
 *
 * Two indices back it — `hostId → host` for reads and `appSessionId → hostId`
 * to enforce the single-writer invariant (a new turn supersedes the host a
 * previous turn was still holding). Retention is deliberately unbounded for now:
 * closed hosts stay readable so a close reason survives the run that produced
 * it, and a pruning policy belongs to the AC that adds host listing.
 */
export function createSessionHostManager(options: SessionHostManagerOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const createHostId = options.createHostId ?? (() => `host-${randomUUID()}`);
  const createRunId = options.createRunId ?? (() => `run-${randomUUID()}`);

  const hosts = new Map<string, ProcessHost>();
  const hostIdByAppSession = new Map<string, string>();
  const perRunTurns = new Map<string, PerRunTurn>();

  function closeHost(hostId: string, reason: HostCloseReason): void {
    const host = hosts.get(hostId);
    if (!host || host.state === 'closed') {
      return;
    }

    host.state = 'closed';
    host.closeReason = reason;
    for (const [appSessionId, binding] of host.bindings) {
      binding.leases = [];
      binding.state = 'idle';
      binding.detachReason = reason;
      binding.lastActivityAt = now();
      if (hostIdByAppSession.get(appSessionId) === hostId) {
        hostIdByAppSession.delete(appSessionId);
      }
    }

    const turn = perRunTurns.get(hostId);
    if (turn?.settleGate) {
      clearImmediate(turn.settleGate);
      turn.settleGate = null;
    }
  }

  /** Drops the `turn` lease and decides whether the host is done or held open. */
  function endTurn(hostId: string): void {
    const host = hosts.get(hostId);
    const turn = perRunTurns.get(hostId);
    if (!host || !turn || host.state === 'closed' || turn.turnEnded) {
      return;
    }

    turn.turnEnded = true;
    const binding = host.bindings.get(turn.appSessionId);
    if (binding) {
      binding.leases = binding.leases.filter((lease) => lease.kind !== 'turn');
      binding.state = 'idle';
      binding.lastActivityAt = now();
    }

    if (turn.settled) {
      closeHost(hostId, 'turn-complete');
      return;
    }

    // The terminal frame has arrived while the run's promise is still pending.
    // That is the shape of Claude's held-stdin window — but it is also the shape
    // of a run whose complete frame is written a tick before it resolves, so the
    // host only becomes `lingering` if the gap outlives the macrotask it was
    // opened in. Every provider that ends its turn by exiting (its complete frame
    // comes from the process-exit handler) settles first and stays `turn-complete`.
    turn.settleGate = setImmediate(() => {
      turn.settleGate = null;
      if (!turn.settled && host.state !== 'closed') {
        turn.lingering = true;
        host.state = 'lingering';
      }
    });
    turn.settleGate.unref?.();
  }

  /** Records that the run's promise is done and closes the host under it. */
  function settleTurn(hostId: string): void {
    const host = hosts.get(hostId);
    const turn = perRunTurns.get(hostId);
    if (!host || !turn || turn.settled) {
      return;
    }

    turn.settled = true;
    if (turn.settleGate) {
      clearImmediate(turn.settleGate);
      turn.settleGate = null;
    }
    if (host.state === 'closed') {
      return;
    }
    if (turn.aborted) {
      closeHost(hostId, 'aborted');
      return;
    }
    if (!turn.turnEnded) {
      // The run ended without ever writing a terminal frame: the process went
      // away on its own rather than finishing a turn.
      closeHost(hostId, 'exited');
      return;
    }

    closeHost(hostId, turn.lingering ? 'released' : 'turn-complete');
  }

  /**
   * Wraps the caller's writer so each frame is observed on its way through.
   *
   * A proxy rather than a copy: the runtimes read capability flags off the
   * writer (`isWebSocketWriter`, `isSSEStreamWriter`) and the SSE writer keeps
   * its own request state on `this`, so the manager must hand over the very same
   * object with only `send` (and the provider-session-id announcement) observed.
   */
  function createObservingWriter(
    writer: ProviderRuntimeWriter,
    host: ProcessHost,
    turn: PerRunTurn,
  ): ProviderRuntimeWriter {
    const observingSend = (data: unknown): void => {
      if ((data as { kind?: unknown } | null | undefined)?.kind === 'complete') {
        endTurn(host.hostId);
      }
      writer.send(data);
    };

    const observingSetSessionId =
      typeof writer.setSessionId === 'function'
        ? (sessionId: string): void => {
            const binding = host.bindings.get(turn.appSessionId);
            if (binding && sessionId) {
              binding.providerSessionId = sessionId;
            }
            writer.setSessionId?.(sessionId);
          }
        : undefined;

    return new Proxy(writer, {
      get(target, property, receiver) {
        if (property === 'send') {
          return observingSend;
        }
        if (property === 'setSessionId' && observingSetSessionId) {
          return observingSetSessionId;
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /**
   * Registers one application session against the run about to be dispatched.
   *
   * Consumed by the providers module's `provider-runtime.service.run`, which
   * calls this instead of the runtime directly, so every turn dispatched through
   * the application has a host.
   */
  function trackPerRunTurn(input: PerRunTurnInput): Promise<unknown> {
    const { provider, appSessionId, writer, start } = input;

    // A caller with no application session id has nothing to bind a host to;
    // dispatch it unchanged so such callers keep the behavior they had.
    if (!appSessionId) {
      return start(writer);
    }

    const supersededHostId = hostIdByAppSession.get(appSessionId);
    if (supersededHostId) {
      closeHost(supersededHostId, 'superseded');
    }

    const runId = createRunId();
    const binding: SessionBinding = {
      appSessionId,
      providerSessionId: null,
      state: 'busy',
      leases: [{ kind: 'turn', runId } satisfies HostLease],
      lastActivityAt: now(),
      detachReason: null,
    };
    const host: ProcessHost = {
      hostId: createHostId(),
      provider,
      mode: 'per-run',
      state: 'busy',
      pid: null,
      startedAt: now(),
      bindings: new Map([[appSessionId, binding]]),
      closeReason: null,
    };
    const turn: PerRunTurn = {
      appSessionId,
      runId,
      turnEnded: false,
      settled: false,
      aborted: false,
      lingering: false,
      settleGate: null,
    };

    hosts.set(host.hostId, host);
    hostIdByAppSession.set(appSessionId, host.hostId);
    perRunTurns.set(host.hostId, turn);

    let runPromise: Promise<unknown>;
    try {
      runPromise = Promise.resolve(start(createObservingWriter(writer, host, turn)));
    } catch (error) {
      // Preserve the synchronous throw the runtime would have produced, and do
      // not leave a host behind for a run that never started.
      closeHost(host.hostId, 'exited');
      throw error;
    }

    // Observe the promise without replacing it: `Promise.resolve` returns the
    // runtime's own promise unchanged, so the caller still receives exactly what
    // it would have received without the manager in the path.
    runPromise.then(
      () => settleTurn(host.hostId),
      () => settleTurn(host.hostId),
    );

    return runPromise;
  }

  /**
   * Marks the host bound to this application session as aborted and closes it.
   *
   * Consumed by the providers module's `provider-runtime.service.abort` after the
   * runtime confirms it stopped something. For a per-run host, stopping the turn
   * *is* killing the process, so the host closes here rather than waiting for the
   * run's promise. Returns whether a live host was found.
   */
  function requestAbort(appSessionId: string): boolean {
    const hostId = hostIdByAppSession.get(appSessionId);
    if (!hostId) {
      return false;
    }

    const turn = perRunTurns.get(hostId);
    if (turn) {
      turn.aborted = true;
    }
    closeHost(hostId, 'aborted');
    return true;
  }

  /**
   * Read port for the whole host view, closed hosts included.
   *
   * Consumed by this module's tests and (later) by the host-listing API. Each
   * call returns detached copies, so a reader cannot mutate the manager's state
   * by holding on to a snapshot.
   */
  function snapshot(): ProcessHost[] {
    return [...hosts.values()].map((host) => ({
      ...host,
      bindings: new Map(
        [...host.bindings].map(([appSessionId, binding]) => [
          appSessionId,
          { ...binding, leases: binding.leases.map((lease) => ({ ...lease })) },
        ]),
      ),
    }));
  }

  return {
    trackPerRunTurn,
    requestAbort,
    snapshot,
  };
}

export type SessionHostManager = ReturnType<typeof createSessionHostManager>;

/**
 * Process-wide host view.
 *
 * A singleton rather than a per-caller instance because a host is a process the
 * whole server shares: the dispatcher that opens one and the code that later
 * lists or closes it must be looking at the same record.
 */
export const sessionHostManager = createSessionHostManager();
