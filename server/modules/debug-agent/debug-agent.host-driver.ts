import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  HostCloseReason,
  HostLease,
  HostMode,
  HostReconfigurePatch,
  HostTurnInput,
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionBinding,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { readDebugAgentGate } from './debug-agent.gate.js';
import type { DebugAgentExitDetail, DebugAgentKeepaliveKind } from './debug-agent.scenario.js';

/**
 * The debug agent's host driver: the process-lifetime face of a provider whose
 * "process" is a scenario walking a fixture transcript.
 *
 * Why a driver at all. Every other provider is driven by the session-host
 * manager's default per-run wrapper, which observes a run from the outside and
 * infers the single `turn` lease from the terminal frame. That wrapper can only
 * ever produce one shape — one process per turn — and the debug agent exists to
 * reproduce the *other* shape: a process that outlives a turn, serves several
 * conversations, and is held open for reasons the caller states rather than
 * infers. Being the provider that owns its process is what makes that
 * expressible, and the manager already has the seam for it
 * (`IProviderHostDriver`).
 *
 * What it does NOT do: build frames. ADR-003 decision 7 is intact here — this
 * file reports leases, exits and turn boundaries, and the frames a client sees
 * are whatever the product's normalizer makes of the rows the engine wrote. The
 * one place a run is opened goes through `openRun`, injected, because the run
 * registry belongs to the websocket module and this module may not reach it
 * (the registry registers this module's provider, so the edge back would close
 * a cycle).
 *
 * Nothing here is real. There is no child process, no pid, no OS handle — the
 * host the manager tracks is a record this driver answers about, which is
 * exactly what makes the shapes reachable in a criterion without a 24-hour wait
 * or a killed process. Every claim it makes is therefore a claim about the
 * manager's own arithmetic, which is the subject: who closes a host, when, and
 * for which reason.
 */

/**
 * How this driver opens a run for a turn nobody asked for.
 *
 * Returns the writer that turn's frames must go to — the run's own writer, so
 * whatever the run records is what a late subscriber replays — or null when no
 * run could be opened (one is already in flight for the session, for example).
 * Injected rather than imported: see the module comment.
 */
export type DebugAgentOpenRun = (input: {
  appSessionId: string;
  /** The turn's prompt, as the scenario stated it. */
  text: string;
}) => ProviderRuntimeWriter | null;

export type DebugAgentHostDriverDependencies = {
  openRun: DebugAgentOpenRun;
};

/**
 * The run seam in force for this process, when the composition root installed
 * one.
 *
 * Late-bound for the same reason `sessionHostManager.setUnattendedRunOpener` is
 * (`server/index.ts`): the object that opens runs lives in the websocket module,
 * which imports the providers module, which constructs this driver through the
 * registry — so the wiring can only happen where both halves are already in
 * scope, and that place runs *after* module evaluation. A driver built with the
 * factory's own `openRun` keeps using it until something installs an override,
 * which is what keeps `unwiredOpenRun`'s loud refusal reachable in a build that
 * wires nothing.
 *
 * Module-scoped rather than per-driver because the debug agent has exactly one
 * driver per process, built once by the registry — and the seam is a fact about
 * the build, not about a host.
 */
let openRunOverride: DebugAgentOpenRun | null = null;

/**
 * Installs the process-wide run seam, or clears it with `null`.
 *
 * Called from the composition root with a function that opens a run through the
 * session-host manager's own opener — the very path a real resident process's
 * unattended turn takes — so the debug agent's turn is a run by the same route
 * every other provider's is, and not a second way to open one.
 */
export function setDebugAgentOpenRun(openRun: DebugAgentOpenRun | null): void {
  openRunOverride = openRun;
}

/**
 * The driver, plus the two facts about it a reader needs before a turn exists.
 *
 * `lifecycleModes` and `multiplexedHost` are the provider's own statements
 * about itself, lifted onto the driver so the provider factory can declare them
 * without inspecting the driver's internals. `processStarts` is the driver's
 * process count — how many processes it has actually brought up — which is what
 * tells "several host records" apart from "several processes".
 */
/**
 * How this driver runs one turn inside the process it is holding.
 *
 * The resident-mode entry point (`providerRuntimeService` calls
 * `driver.run(appSessionId, turn, writer, context)` for a session whose stored
 * mode is `resident`). Set after construction rather than injected, because the
 * thing it runs — the provider's own runtime — is built from this driver, and
 * the driver is what the runtime reports its host steps through: the two are
 * mutually recursive and one of the edges has to be late-bound.
 *
 * Without it the driver carries no `run`, `provider-runtime.service` reads the
 * session as "not resident for dispatch", and every scenario drive opens a
 * per-run host that *supersedes* the resident one — a criterion could then never
 * observe a resident process across a turn, which is the shape this agent exists
 * to make observable.
 */
export type DebugAgentTurnRunner = (
  appSessionId: string,
  turn: HostTurnInput,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) => Promise<void>;

export type DebugAgentHostDriver = IProviderHostDriver & {
  readonly lifecycleModes: HostMode[];
  /** How many processes this driver has started. One, for a multiplexing driver, however many hosts are opened. */
  readonly processStarts: number;
  /**
   * Runs one turn inside the held process, through whatever runner was bound.
   *
   * The `ResidentTurnEntry` shape `provider-runtime.service` looks for, and the
   * reason it is on the driver rather than on the runtime: the dispatch reads it
   * off `provider.hostDriver`, so a driver without it makes the whole resident
   * path unreachable no matter what the runtime can do. See
   * {@link DebugAgentTurnRunner} for why the binding is late.
   */
  run(
    appSessionId: string,
    turn: HostTurnInput,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void>;
  /** Binds the turn runner above. Called once, by the factory that built both halves. */
  setTurnRunner(runner: DebugAgentTurnRunner): void;
  /**
   * Opens a turn for a session with no client behind it and returns the writer
   * its frames belong to.
   *
   * The session-addressed entry point the engine's `unattended-turn` step
   * drives: it resolves the session's process, opens the run through
   * `openRun`, and records the turn as in flight so `interrupt` has something
   * to stop. Throws when the session has no process or no run could be opened —
   * a step that silently produced nothing would be a reading nobody can
   * attribute to a cause.
   */
  openUnattendedTurn(input: {
    appSessionId: string;
    text: string;
    /** The run id the turn's `turn` lease is held under. */
    runId: string;
  }): Promise<ProviderRuntimeWriter>;
  /**
   * Reports that the turn opened above has finished, and releases its `turn`
   * lease.
   *
   * A separate verb from `interrupt`, and not a no-op when no turn is in flight:
   * the two say different things about the same host ("the turn ended" vs "the
   * turn was stopped") and only the second is a user's decision. The reader that
   * needs the difference is the host state — a released turn leaves the process
   * `idle` (or `lingering`, when a keepalive still holds it), which is the state
   * the status bar draws as 空闲.
   */
  endUnattendedTurn(input: { appSessionId: string }): Promise<void>;
  /** Reports one more reason the process is held open. */
  addKeepalive(input: { appSessionId: string; kind: DebugAgentKeepaliveKind }): Promise<void>;
  /** Reports that a reason no longer applies. */
  removeKeepalive(input: { appSessionId: string; kind: DebugAgentKeepaliveKind }): Promise<void>;
  /**
   * Reports the address this process answers to.
   *
   * A statement about the process's own peer registry, never one this module
   * computed: the fixture's "registry" is the scenario step that names it, and
   * the value reaches the binding through the sink's `identity` verb so the REST
   * projection publishes a name that was reported rather than derived.
   */
  reportIdentity(input: { appSessionId: string; name: string }): Promise<void>;
  /** Reports that the process is gone, with the detail the scenario saw. */
  reportExit(input: { appSessionId: string; detail: DebugAgentExitDetail }): Promise<void>;
};

/**
 * Builds the driver, or null when the gate is closed.
 *
 * The same gate rule the provider factory applies, for the same reason: a
 * closed gate means nothing is constructed at all, so there is no object a
 * later bug could hand to the manager and no host to appear in a listing.
 *
 * Written with closure-scoped functions rather than methods on an object
 * literal, because every verb is called through whatever reference the manager
 * holds — a criterion that wraps this in a counting proxy must not be able to
 * break it by changing what `this` is.
 */
/**
 * How far ahead the placeholder `cron` lease says it will next fire.
 *
 * Picked to outlast any run this build could plausibly drive — the manager's
 * own per-run quiet ceiling is half an hour — so a lease that was only ever a
 * stand-in for "a timer holds this open" is never read as one that has already
 * lapsed. See {@link leaseFor}.
 */
const CRON_PLACEHOLDER_HORIZON_MS = 24 * 60 * 60 * 1000;

export function createDebugAgentHostDriver(
  dependencies: DebugAgentHostDriverDependencies,
): DebugAgentHostDriver | null {
  const gate = readDebugAgentGate();
  if (!gate.enabled || !gate.home) {
    return null;
  }

  /** Where each bound session's process is. Written by `bind`/`submit`, cleared by `unbind`/`closeHost`. */
  const hostByAppSession = new Map<string, ProcessHost>();
  /** The sink the manager handed over per host, so reported facts have somewhere to go. */
  const sinkByHostId = new Map<string, IProviderHostDriverSink>();
  /** The turn in flight per session, as `submit` recorded it. */
  const turnByAppSession = new Map<string, HostTurnInput>();
  /**
   * The one process this driver runs, once it has been started.
   *
   * A driver that declares `multiplexedHost` is stating that one process serves
   * several sessions, so a second `startHost` reuses this handle instead of
   * bringing up a second process — and `processStarts` counts creations of it,
   * not calls, which is the only way the two readings can disagree.
   */
  let processHandle: ProcessHost | null = null;
  let processStarts = 0;
  /** The provider-side runner that executes one turn inside the held process. Bound once, by the factory. */
  let turnRunner: DebugAgentTurnRunner | null = null;
  /**
   * The writer frames most recently went to, so a turn that cannot open a run of
   * its own still has somewhere to deliver.
   *
   * The manager's own opener documents this fallback as the pre-seam behaviour
   * ("the frames stay with the last writer and no run is opened", which is the
   * ordinary outcome when the registry already has a run in flight for the
   * session), and it is the only honest one here: a walk that opens two
   * unattended turns cannot open two runs, and refusing the second would make a
   * scenario's second divider unreachable rather than merely unrunned.
   *
   * Written by `run` (when a turn is dispatched through the host) and by a
   * successful `openUnattendedTurn`, so it is the writer of the most recent run
   * THIS driver was handed. That is what the fallback needs to be: the fallback
   * is only reached when `openRun` answered null, i.e. when a run is already in
   * flight for the session, and a script that reaches that state through this
   * driver's own steps reached it through the writer just recorded. It is
   * deliberately not cleared when a turn's execution returns — a walk's first
   * run stays open across the steps that follow it, and the second unattended
   * turn is precisely the case that needs it.
   */
  let lastWriter: ProviderRuntimeWriter | null = null;

  function setTurnRunner(runner: DebugAgentTurnRunner): void {
    turnRunner = runner;
  }

  /**
   * Runs one turn inside the process this driver is holding.
   *
   * Two things happen here, and only one of them is delegation. The turn is
   * recorded and reported as a lease first, for the same reason
   * `openUnattendedTurn` does it: a reader polling the host listing must never
   * catch the moment after a turn was accepted and before anything says so. The
   * runner is then awaited inside `try`, and the lease is released in `finally`
   * — a runner that threw has still ended its turn, and a lease left behind by
   * a failure is the stuck 运行中 this whole layer exists to make impossible.
   */
  async function run(
    appSessionId: string,
    turn: HostTurnInput,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void> {
    if (!turnRunner) {
      throw new Error(
        `The debug agent's host driver was asked to run a turn for "${appSessionId}" before its runner was bound.`,
      );
    }

    const host = hostFor(appSessionId);
    if (host) {
      await submit(host, appSessionId, turn);
    }

    lastWriter = writer;

    try {
      await turnRunner(appSessionId, turn, writer, context);
    } finally {
      if (host) {
        await endUnattendedTurn({ appSessionId });
      }
    }
  }

  function hostFor(appSessionId: string): ProcessHost | null {
    return hostByAppSession.get(appSessionId) ?? null;
  }

  function sinkFor(host: ProcessHost): IProviderHostDriverSink {
    const sink = sinkByHostId.get(host.hostId);
    if (!sink) {
      throw new Error(
        `The debug agent's host driver was asked to report on host "${host.hostId}" before it was started.`,
      );
    }

    return sink;
  }

  async function startHost(host: ProcessHost, sink: IProviderHostDriverSink): Promise<ProcessHost> {
    sinkByHostId.set(host.hostId, sink);
    if (!processHandle) {
      processHandle = host;
      processStarts += 1;
    }

    return processHandle;
  }

  async function bind(host: ProcessHost, binding: SessionBinding): Promise<void> {
    hostByAppSession.set(binding.appSessionId, host);
  }

  async function submit(host: ProcessHost, appSessionId: string, turn: HostTurnInput): Promise<void> {
    hostByAppSession.set(appSessionId, host);
    turnByAppSession.set(appSessionId, turn);
    sinkFor(host).activity(appSessionId);
  }

  async function interrupt(host: ProcessHost, appSessionId: string): Promise<boolean> {
    const stopped = turnByAppSession.delete(appSessionId);
    if (stopped) {
      // Stopping a turn is not ending it: the two reach the same state (no turn
      // in flight) from opposite directions, and only the caller knows which one
      // happened. The lease is dropped either way, because a `turn` lease left
      // behind is a host the status bar would draw as 运行中 with nothing running.
      sinkFor(host).leaseRemoved(appSessionId, 'turn');
    }

    return stopped;
  }

  async function reconfigure(
    _host: ProcessHost,
    _appSessionId: string,
    _patch: HostReconfigurePatch,
  ): Promise<'live' | 'next-turn'> {
    // Nothing about a model, an effort level or a permission mode can be
    // applied to a process that does not exist. A scenario re-reads its whole
    // configuration from the armed document at the next turn, which is what
    // `next-turn` reports — and reporting `live` here would claim an effect
    // that nothing in this module could observe.
    return 'next-turn';
  }

  async function unbind(_host: ProcessHost, appSessionId: string, _reason: HostCloseReason): Promise<void> {
    hostByAppSession.delete(appSessionId);
    turnByAppSession.delete(appSessionId);
  }

  async function closeHost(host: ProcessHost, _reason: HostCloseReason): Promise<void> {
    sinkByHostId.delete(host.hostId);

    for (const [appSessionId, bound] of hostByAppSession) {
      if (bound.hostId === host.hostId) {
        hostByAppSession.delete(appSessionId);
        turnByAppSession.delete(appSessionId);
      }
    }

    // The process serves every host this driver started, so one record closing
    // is not the same act as the process dying: it is gone only when no host is
    // left to report on. A driver that dropped the handle on the first close
    // would bring a second process up for a host the first one was still
    // serving, which is the one thing `multiplexedHost` promises it will not do.
    if (sinkByHostId.size === 0) {
      processHandle = null;
    }
  }

  async function openUnattendedTurn(input: {
    appSessionId: string;
    text: string;
    runId: string;
  }): Promise<ProviderRuntimeWriter> {
    const host = hostFor(input.appSessionId);
    if (!host) {
      throw new Error(
        `No host is bound to session "${input.appSessionId}"; an unattended turn must go through the host layer.`,
      );
    }

    const openRun = openRunOverride ?? dependencies.openRun;
    // A refused open is not a failure to deliver. The registry declines by
    // answering null — the ordinary case is a run already in flight for this
    // session — and what that means is "the frames belong to the run that is
    // already there", which is exactly what the last writer holds. Refusing
    // outright would make the second unattended turn of a walk impossible, and
    // the walk is how a scenario states that a session can receive two.
    const writer = openRun({ appSessionId: input.appSessionId, text: input.text }) ?? lastWriter;
    if (!writer) {
      throw new Error(
        `No run could be opened for session "${input.appSessionId}", and no writer has been handed out yet to deliver its frames to.`,
      );
    }

    lastWriter = writer;

    // The turn lease is reported BEFORE the run is submitted, so the binding is
    // never briefly "idle with a turn starting": a reader that polled between
    // the two writes would see the pre-turn state of a session that already has
    // a turn going, which is the one reading this agent must not manufacture.
    sinkFor(host).leaseAdded(input.appSessionId, { kind: 'turn', runId: input.runId });
    await submit(host, input.appSessionId, { command: input.text, options: {} });
    return writer;
  }

  async function endUnattendedTurn(input: { appSessionId: string }): Promise<void> {
    const host = hostFor(input.appSessionId);
    if (!host) {
      return;
    }

    // Only a turn that was actually in flight has a lease to release. Releasing
    // one unconditionally would report a removal for a lease that was never
    // added — which a manager that treats "removed" as activity would read as
    // the host having done something, and which leaves the two verbs (`end` and
    // `interrupt`) indistinguishable in the one case where they differ: a turn
    // the user already stopped has no lease left to end.
    if (!turnByAppSession.delete(input.appSessionId)) {
      return;
    }

    sinkFor(host).leaseRemoved(input.appSessionId, 'turn');
  }

  /**
   * The lease a keepalive is recorded as.
   *
   * The id is the kind for the two reasons that have no schedule of their own,
   * which is also what makes a second add replace the first (the manager keys a
   * lease by kind and id, and removes by kind). A `cron` lease cannot carry that
   * shape — the contract has `{id, recurring, expiresAt}` on it — so the three
   * schedule fields are filled with the only reading a fixture can honestly
   * give: the scenario stated a REASON, not a timetable, and nothing in a debug
   * run ever consults the schedule. A horizon far beyond any run's length keeps
   * the manager's quiet-deadline arithmetic from treating the lease as expired
   * mid-run, which is the one way a placeholder could be observed.
   */
  function leaseFor(kind: DebugAgentKeepaliveKind): HostLease {
    if (kind !== 'cron') {
      return { kind, id: kind };
    }

    return {
      kind: 'cron',
      id: 'scenario-cron',
      recurring: true,
      expiresAt: Date.now() + CRON_PLACEHOLDER_HORIZON_MS,
    };
  }

  async function addKeepalive(input: { appSessionId: string; kind: DebugAgentKeepaliveKind }): Promise<void> {
    const host = hostFor(input.appSessionId);
    if (!host) {
      throw new Error(`No host is bound to session "${input.appSessionId}".`);
    }

    sinkFor(host).leaseAdded(input.appSessionId, leaseFor(input.kind));
  }

  async function removeKeepalive(input: {
    appSessionId: string;
    kind: DebugAgentKeepaliveKind;
  }): Promise<void> {
    const host = hostFor(input.appSessionId);
    if (!host) {
      throw new Error(`No host is bound to session "${input.appSessionId}".`);
    }

    sinkFor(host).leaseRemoved(input.appSessionId, input.kind);
  }

  async function reportIdentity(input: { appSessionId: string; name: string }): Promise<void> {
    const host = hostFor(input.appSessionId);
    if (!host) {
      throw new Error(`No host is bound to session "${input.appSessionId}".`);
    }

    // Through the sink rather than onto any record here. The binding the REST
    // projection publishes is the manager's, and a name this driver kept to
    // itself would be an address the listing never showed.
    sinkFor(host).identity(input.appSessionId, input.name);
  }

  async function reportExit(input: { appSessionId: string; detail: DebugAgentExitDetail }): Promise<void> {
    const host = hostFor(input.appSessionId);
    if (!host) {
      throw new Error(`No host is bound to session "${input.appSessionId}".`);
    }

    sinkFor(host).exited({ hostId: host.hostId, detail: input.detail });
  }

  return {
    lifecycleModes: ['per-run', 'resident'],
    multiplexedHost: true,
    get processStarts() {
      return processStarts;
    },

    startHost,
    bind,
    submit,
    interrupt,
    reconfigure,
    unbind,
    closeHost,

    run,
    setTurnRunner,
    openUnattendedTurn,
    endUnattendedTurn,
    addKeepalive,
    removeKeepalive,
    reportIdentity,
    reportExit,
  };
}
