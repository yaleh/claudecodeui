import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  HostCloseReason,
  HostMode,
  HostReconfigurePatch,
  HostTurnInput,
  ProcessHost,
  ProviderRuntimeWriter,
  SessionBinding,
} from '@/shared/types.js';

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
 * The driver, plus the two facts about it a reader needs before a turn exists.
 *
 * `lifecycleModes` and `multiplexedHost` are the provider's own statements
 * about itself, lifted onto the driver so the provider factory can declare them
 * without inspecting the driver's internals. `processStarts` is the driver's
 * process count — how many processes it has actually brought up — which is what
 * tells "several host records" apart from "several processes".
 */
export type DebugAgentHostDriver = IProviderHostDriver & {
  readonly lifecycleModes: HostMode[];
  /** How many processes this driver has started. One, for a multiplexing driver, however many hosts are opened. */
  readonly processStarts: number;
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
  openUnattendedTurn(input: { appSessionId: string; text: string }): Promise<ProviderRuntimeWriter>;
  /** Reports one more reason the process is held open. */
  addKeepalive(input: { appSessionId: string; kind: DebugAgentKeepaliveKind }): Promise<void>;
  /** Reports that a reason no longer applies. */
  removeKeepalive(input: { appSessionId: string; kind: DebugAgentKeepaliveKind }): Promise<void>;
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

  async function interrupt(_host: ProcessHost, appSessionId: string): Promise<boolean> {
    return turnByAppSession.delete(appSessionId);
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
  }): Promise<ProviderRuntimeWriter> {
    const host = hostFor(input.appSessionId);
    if (!host) {
      throw new Error(
        `No host is bound to session "${input.appSessionId}"; an unattended turn must go through the host layer.`,
      );
    }

    const writer = dependencies.openRun({ appSessionId: input.appSessionId, text: input.text });
    if (!writer) {
      throw new Error(`No run could be opened for session "${input.appSessionId}".`);
    }

    await submit(host, input.appSessionId, { command: input.text, options: {} });
    return writer;
  }

  async function addKeepalive(input: { appSessionId: string; kind: DebugAgentKeepaliveKind }): Promise<void> {
    const host = hostFor(input.appSessionId);
    if (!host) {
      throw new Error(`No host is bound to session "${input.appSessionId}".`);
    }

    // The id is the kind: the manager removes a lease by kind, so a binding
    // holds at most one claim per reason and a second add replaces the first.
    sinkFor(host).leaseAdded(input.appSessionId, { kind: input.kind, id: input.kind });
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

    openUnattendedTurn,
    addKeepalive,
    removeKeepalive,
    reportExit,
  };
}
