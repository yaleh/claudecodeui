/**
 * Claude's resident host driver: one CLI process held across turns, behind
 * `IProvider.hostDriver`, which is what makes `lifecycle_mode = 'resident'` a
 * process the user keeps rather than one they restart on every message.
 *
 * ## What one resident host is
 *
 * One SDK query whose prompt iterable never finishes. `submit` does not build a
 * query — it writes the turn's messages into the input queue the process has
 * been reading since it started, which is the whole of "the pid does not
 * change": a second turn is more stdin on the stream that has been open all
 * along. The queue is closed only when the host is, and closing it is stdin EOF,
 * which is the CLI's own graceful exit path. `closeHost` is that and nothing
 * else; the query's own `close` is a backstop for a CLI that does not take the
 * hint (see `CLAUDE_RESIDENT_EXIT_GRACE_MS`).
 *
 * ## Turn boundaries
 *
 * A turn ends at its `result`, exactly as the runtime's own read loop reads it
 * (`claude-runtime.provider.js`), and each round submitted expects one —
 * including an interrupted round, which is why the runtime checks its abort flag
 * at `result` time rather than at the interrupt. So rounds are a FIFO: `submit`
 * appends, a `result` shifts, and the shifted round's own `run` promise settles.
 * That promise is the one the dispatch awaits, so it resolves when the turn
 * really ended — an interrupt asks for the ending, it does not stand in for one.
 * The interrupted round stays in the queue as a tombstone until then, so its
 * `result` is consumed by the turn it belongs to instead of being mistaken for a
 * later turn's; and the terminal `complete` — `aborted` for that round — is
 * written at that same moment, before the round settles, so the run the dispatch
 * is watching is already completed by the time its own safety net runs.
 *
 * ## What it reports, and what it never decides
 *
 * Leases, through the sink `openHost` hands over: `turn` while a round is in
 * flight (dropped at its own `result`), and `resident-policy` — the mode's
 * statement that the process is meant to sit between turns. That second lease is
 * the manager's whole reading of "resident": with it an otherwise empty binding
 * derives `idle` and arms the mode's quiet ceiling, where a per-run host would
 * have closed. Nothing here decides a close: the resident policy is
 * `supersedeOnNewTurn: false`, so a new turn on a bound session is written to
 * the process that is already there, and the host ends only when the manager
 * says so (a quiet ceiling, the close route, a shutdown).
 *
 * Unlike the per-run driver, this one does emit frames: `HostTurnInput` carries
 * no writer, so a resident turn's writer and runtime context arrive through this
 * class's own `run` entry, which the application dispatch calls. What it does
 * *not* emit is the runtime's interactive half — permission prompts, the
 * notification hook and MCP config loading live in `claude-runtime.provider.js`
 * and are deliberately not duplicated here; a resident turn's tool approvals are
 * therefore resolved by the permission mode alone. That is a known boundary of
 * the mode, not an oversight, and it is why the criterion drives turns whose
 * permission mode needs no prompt.
 *
 * ## Why a fresh start asks for a host rather than a binding
 *
 * `openHost`, not `bindSession`. A session's first resident turn needs the
 * manager to open a process *for that session*, and the manager's `bindSession`
 * is a different question — "which live process can take this conversation" —
 * whose answer for a driver that does not multiplex is a refusal. `openHost`
 * also takes the pid, and the manager accepts a pid only at open time, which is
 * why `run` brings the process up *before* asking for the host record: the
 * record is opened knowing the real pid rather than backfilling it later.
 *
 * Consumed by `ClaudeProvider`, which mounts it as `IProvider.hostDriver`, and by
 * the criterion in `tests/claude-resident-process.test.ts`, which drives it
 * against the real `claude` binary.
 */
import { spawn as nodeSpawn } from 'node:child_process';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

import {
  ClaudePerRunHostDriver,
  type ClaudeBackgroundWorkEvent,
} from '@/modules/providers/list/claude/claude-per-run-host-driver.provider.js';
import {
  buildPromptMessages,
  extractCumulativeTokenBudget,
  extractTokenBudget,
  forwardNormalizedFrames,
  mapCliOptionsToSDK,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { resolveModelContextWindowRow } from '@/modules/providers/services/model-launch-spec.service.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  HostCloseReason,
  HostLease,
  HostReconfigurePatch,
  HostTurnInput,
  LLMProvider,
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionBinding,
} from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

/**
 * How long a resident process is given to leave on its own before the SDK query
 * is closed under it.
 *
 * Deliberately far longer than a graceful exit: a Claude CLI told EOF stops in
 * well under a second, so an exit observed inside any ordinary assertion window
 * is the EOF's doing. A shorter backstop would let a kill masquerade as the
 * graceful path this driver exists to provide.
 */
export const CLAUDE_RESIDENT_EXIT_GRACE_MS = 15_000;

/**
 * The slice of the SDK's `Query` a resident process uses.
 *
 * Wider than the per-run driver's stream, because a resident process is
 * reconfigured rather than replaced: the live verbs are optional so a criterion
 * can hand in a scripted stream, and absent means `reconfigure` answers
 * `next-turn` for what it would have applied.
 */
export type ClaudeResidentQuery = AsyncIterable<AnyRecord> & {
  /** Stops the turn in flight; the process itself stays up. */
  interrupt(): Promise<void>;
  /** Backstop teardown, used only after {@link CLAUDE_RESIDENT_EXIT_GRACE_MS}. */
  close?(): void;
  /** Live model switch, SDK permitting. */
  setModel?(model?: string): Promise<void>;
  /** Live permission-mode switch, SDK permitting. */
  setPermissionMode?(mode: string): Promise<void>;
};

/**
 * One resident process: the SDK query, plus the pid the manager's record needs.
 *
 * `pid` is a getter rather than a value so a caller can read it after the
 * spawn hook has run, however many ticks later that is.
 */
export type ClaudeResidentProcess = {
  query: ClaudeResidentQuery;
  readonly pid: number | null;
};

/**
 * Builds one resident process.
 *
 * Injected for the same reason the per-run driver injects its query factory: the
 * SDK's `query` is a module-level function, so there is no seam to stub. The
 * default is the real SDK plus the pid capture; a criterion that wants a
 * scripted stream — or a fake process that really dies — hands in its own.
 */
export type ClaudeResidentProcessFactory = (input: {
  prompt: AsyncIterable<AnyRecord>;
  options: AnyRecord;
}) => ClaudeResidentProcess;

/**
 * The manager surface this driver needs, as a port rather than the singleton.
 *
 * `openHost` is how a resident session gets a process (see the file header for
 * why not `bindSession`), `snapshot` is how the driver finds the host a later
 * turn belongs to, and `bindSession` is only ever passed through to the per-run
 * driver this one composes. Taking it as a constructor option is what lets a
 * criterion inject a manager with its own clock — the quiet ceiling a resident
 * host is held under is that manager's policy, not a number this file knows.
 */
export type ClaudeResidentHostPort = Pick<
  SessionHostManager,
  'openHost' | 'snapshot' | 'bindSession'
>;

/**
 * The notification a resident turn's end makes.
 *
 * The same shape the runtime's own run reports, so a resident turn stops the
 * same way a per-run one does and nothing downstream has to learn a second
 * vocabulary. `sessionId` is the *application* session id, which is what the
 * runtime passes (it prefers the app id over the provider-native one here), and
 * `sessionName` comes from the turn's own options.
 */
export type ClaudeResidentRunStoppedEvent = {
  userId: string | number | null;
  provider: LLMProvider;
  sessionId: string | null;
  sessionName: string | null;
  stopReason: 'completed' | 'aborted';
};

export type ClaudeResidentHostDriverOptions = {
  host: ClaudeResidentHostPort;
  /** Background-work completion, forwarded to the per-run driver this one composes. */
  notifyBackgroundWork: (event: ClaudeBackgroundWorkEvent) => void;
  /** Called once per completed round, mirroring the runtime's own stop notification. */
  notifyRunStopped: (event: ClaudeResidentRunStoppedEvent) => void;
  /** Process seam; defaults to the real SDK with the pid capture installed. */
  createProcess?: ClaudeResidentProcessFactory;
};

/**
 * The never-ending prompt iterable one resident process reads.
 *
 * The SDK writes each yielded message to the CLI's stdin and, when the iterable
 * is exhausted, closes it (stdin EOF, which the CLI reads as "wind down"). So
 * this queue is two things at once: the channel a turn is delivered through
 * (`push`) and the process's own off switch (`end`). A pull with something
 * buffered yields it; a pull on an ended queue finishes the generator.
 */
type ResidentInputQueue = {
  stream: AsyncIterable<AnyRecord>;
  push(...messages: AnyRecord[]): void;
  end(): void;
};

function createResidentInputQueue(): ResidentInputQueue {
  const buffered: AnyRecord[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  const stream = (async function* () {
    for (;;) {
      const next = buffered.shift();
      if (next) {
        yield next;
        continue;
      }
      if (ended) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  })();

  return {
    stream,
    push(...messages: AnyRecord[]): void {
      if (ended || messages.length === 0) {
        return;
      }
      buffered.push(...messages);
      const resume = wake;
      wake = null;
      resume?.();
    },
    end(): void {
      if (ended) {
        return;
      }
      ended = true;
      const resume = wake;
      wake = null;
      resume?.();
    },
  };
}

/**
 * The SDK's process contract as it really is at this seam: a Node child, which
 * carries a pid.
 *
 * The SDK interface leaves `pid` out (`SpawnedProcess` is what the transport
 * consumes, and its own default spawn returns a facade that hides the child),
 * but both spawn paths this driver can end up wrapping — the SDK's default and
 * the session-scope hook — return the real `ChildProcess`. Widening it here is
 * what makes the pid readable without pretending the SDK promised one.
 */
type ClaudeResidentProcessHandle = SpawnedProcess & { readonly pid?: number };

/**
 * Spawns the CLI the way the SDK's own default spawn does.
 *
 * Used only when the SDK options carry no `spawnClaudeCodeProcess` hook — a host
 * with no usable systemd user manager, where `mapCliOptionsToSDK` leaves the
 * hook unset. It mirrors that default's stdio shape (the CLI's stderr is dropped
 * unless SDK debugging is on) and forwards the abort signal, which the SDK has
 * already delayed past its own stdin-EOF grace window.
 */
function spawnResidentCli(spawnOptions: SdkSpawnOptions): ClaudeResidentProcessHandle {
  const pipedStderr = Boolean(process.env.DEBUG_CLAUDE_AGENT_SDK);
  const child = nodeSpawn(spawnOptions.command, spawnOptions.args, {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    signal: spawnOptions.signal,
    stdio: ['pipe', 'pipe', pipedStderr ? 'pipe' : 'ignore'],
    windowsHide: true,
  });

  if (pipedStderr) {
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  }

  return child as unknown as ClaudeResidentProcessHandle;
}

/**
 * The real SDK, plus the one fact the SDK does not expose: the child pid.
 *
 * The launch options are the runtime's own — `mapCliOptionsToSDK` is the same
 * builder a per-run turn goes through, so a resident process is launched with
 * the same env overlay, executable resolution, effort and permission mapping the
 * per-run path produces. What is added is a spawn hook that wraps whatever hook
 * the builder installed (the memory-capped systemd scope, when this host has
 * one) and keeps the child it returns.
 */
function createSdkResidentProcess(input: {
  prompt: AsyncIterable<AnyRecord>;
  options: AnyRecord;
}): ClaudeResidentProcess {
  const sdkOptions = mapCliOptionsToSDK(input.options);
  const installedSpawn = sdkOptions.spawnClaudeCodeProcess as
    | ((options: SdkSpawnOptions) => SpawnedProcess)
    | undefined;
  let pid: number | null = null;

  sdkOptions.spawnClaudeCodeProcess = (spawnOptions: SdkSpawnOptions): SpawnedProcess => {
    const child = installedSpawn
      ? (installedSpawn(spawnOptions) as ClaudeResidentProcessHandle)
      : spawnResidentCli(spawnOptions);
    if (typeof child?.pid === 'number') {
      pid = child.pid;
    }
    return child;
  };

  const stream = query({
    prompt: input.prompt,
    options: sdkOptions,
  } as unknown as Parameters<typeof query>[0]) as unknown as ClaudeResidentQuery;

  return {
    query: stream,
    get pid() {
      return pid;
    },
  };
}

/**
 * One turn handed to a resident process, and the promise its dispatcher awaits.
 *
 * `settled` is what makes "the turn is over" idempotent across the two paths
 * that can end a round — its own `result` and an `interrupt` that got there
 * first — and `interrupted` is how the `result` that follows an interrupt knows
 * not to write a terminal `complete` the abort path has already written.
 */
type ResidentRound = {
  appSessionId: string;
  turn: HostTurnInput;
  writer: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  done: Promise<void>;
  settle(): void;
  fail(error: Error): void;
  settled: boolean;
  interrupted: boolean;
};

/**
 * One resident host: the process, the queue it reads, and the turns waiting on it.
 *
 * Per host rather than per driver because all four are per-process facts. The
 * manager's host record stays the manager's; this is what the driver needs to
 * deliver a turn and to answer for the process's lifetime.
 */
type ResidentHostState = {
  hostId: string;
  appSessionId: string;
  sink: IProviderHostDriverSink;
  queue: ResidentInputQueue;
  process: ClaudeResidentProcess;
  /** The turn in flight is the front one; interrupted rounds stay until their `result`. */
  rounds: ResidentRound[];
  /** The last runtime context seen, so frames arriving outside a round still normalize. */
  context: ProviderRuntimeContext | null;
  /** The last writer seen, for frames no round owns. */
  writer: ProviderRuntimeWriter | null;
  /** Provider-native session id, captured once from the stream. */
  providerSessionId: string | null;
  /** True when this process was launched resuming an existing conversation. */
  resumed: boolean;
  sessionCreatedSent: boolean;
  assistantBudgetSent: boolean;
  modelContextWindow: ReturnType<typeof resolveModelContextWindowRow>;
  /** Set once the manager closed this host or the stream ended under it. */
  closed: boolean;
  /** The failure the stream ended with, when it ended on its own. */
  loopError: Error | null;
};

/** The next resident process's state, handed to `startHost` through `openHost`. */
type PendingHost = {
  queue: ResidentInputQueue;
  process: ClaudeResidentProcess;
  modelContextWindow: ReturnType<typeof resolveModelContextWindowRow>;
};

/**
 * The SDK's `transformMessage`, inlined.
 *
 * The runtime's own transformer is module-private and its whole body is this one
 * copy: subagent traffic carries `parent_tool_use_id` and every frame the
 * normalizer makes of such a message needs it as `parentToolUseId` to stay
 * grouped under the tool card that spawned it. Copying it here rather than
 * exporting it keeps a `.js` file outside this task's touched set untouched.
 */
function transformResidentMessage(message: AnyRecord): AnyRecord {
  if (message?.parent_tool_use_id) {
    return { ...message, parentToolUseId: message.parent_tool_use_id };
  }
  return message;
}

/** Interrupts a query, treating a refused interrupt as the turn having moved on. */
async function stopResidentTurn(queryStream: ClaudeResidentQuery): Promise<void> {
  try {
    await queryStream.interrupt();
  } catch {
    // The turn is going away either way; a refused interrupt is not a failure to
    // stop, so there is nothing left for the caller to branch on.
  }
}

/**
 * Owns the process lifetime of Claude's `resident` hosts.
 *
 * Constructed per provider (one instance serves every session, because a driver
 * holds no per-process state outside its maps). See the file header for what it
 * reports, what it never decides, and what it deliberately does not own.
 */
export class ClaudeResidentHostDriver implements IProviderHostDriver {
  private readonly provider: LLMProvider = 'claude';
  /**
   * One conversation per process. Stated rather than left absent because the
   * manager reads this as `=== true`, and because it is the reason a second
   * resident session gets its own process instead of a second binding.
   */
  readonly multiplexedHost = false;
  private readonly host: ClaudeResidentHostPort;
  private readonly notifyRunStopped: (event: ClaudeResidentRunStoppedEvent) => void;
  private readonly createProcess: ClaudeResidentProcessFactory;
  /**
   * The per-run facet, composed rather than replaced.
   *
   * The provider mounts exactly one `hostDriver`, so whoever holds the slot
   * serves every mode its capabilities declare — and `claude` declares both. A
   * `per-run` host opened by anyone (the criterion in `claude-host-per-run.test.ts`
   * is one) must still have working verbs, and the file that already implements
   * them owns the per-run process rules; reimplementing them here would be a
   * second copy to keep in step. Nothing on the per-run *dispatch* path goes
   * through a host driver at all — the manager's default wrapper owns it — so
   * this is about the facet being complete, not about per-run turn routing.
   */
  private readonly perRun: ClaudePerRunHostDriver;
  /** The live state per host. */
  private readonly hosts = new Map<string, ResidentHostState>();
  /** What the next `startHost` should adopt, since `openHost` decides the host id. */
  private pending: PendingHost | null = null;
  /** Counted turn ids: one per armed round, so a reading of the lease is repeatable. */
  private serial = 0;

  constructor(options: ClaudeResidentHostDriverOptions) {
    this.host = options.host;
    this.notifyRunStopped = options.notifyRunStopped;
    this.createProcess = options.createProcess ?? createSdkResidentProcess;
    this.perRun = new ClaudePerRunHostDriver({
      host: options.host,
      notify: options.notifyBackgroundWork,
    });
  }

  /**
   * Dispatches one turn for one session, and answers when the turn is over.
   *
   * This is the resident counterpart to `IProviderRuntime.run`, and the
   * application dispatch awaits it for exactly the reason it awaits the
   * runtime's own promise: the websocket layer's run settles with this turn, and
   * a driver that returned as soon as the messages were written would report
   * every resident turn as instantly complete.
   *
   * The process is found or started first. A session with a live resident host is
   * one whose process is already reading stdin, so the turn is written to it —
   * that is the pid stability this mode is made of. A session without one gets a
   * process of its own, brought up on this turn's messages.
   */
  async run(
    appSessionId: string,
    turn: HostTurnInput,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void> {
    const existing = this.liveStateFor(appSessionId);
    if (existing) {
      const round = this.createRound(appSessionId, turn, writer, context);
      // A later turn is more stdin on the stream that is already open: the
      // messages go into the queue the process has been reading since it
      // started, which is the whole of "the pid does not change".
      this.armRound(existing, round, await this.turnMessages(turn), false);
      await round.done;
      return;
    }

    const round = this.createRound(appSessionId, turn, writer, context);
    const messages = await this.turnMessages(turn);
    const state = await this.startResidentHost(appSessionId, messages, turn, context);
    // The first round's messages are already in the queue — they seeded it before
    // the process was spawned — so this only arms the round and its lease.
    this.armRound(state, round, messages, true);
    await round.done;
  }

  /**
   * Remembers the sink this host reports through, and adopts the process `run`
   * brought up for it.
   *
   * `startHost` is reached from `openHost`, after the record exists and before
   * the first binding is written, which is the one moment the manager and the
   * driver can be introduced. The process itself is already running: the manager
   * takes a pid only at open time, so a driver that wanted its record to carry
   * one has to have the child in hand before it asks for the host (see the file
   * header).
   */
  async startHost(host: ProcessHost, sink: IProviderHostDriverSink): Promise<ProcessHost> {
    if (host.mode !== 'resident') {
      return this.perRun.startHost(host, sink);
    }

    const pending = this.pending;
    this.pending = null;
    if (!pending) {
      throw new Error(
        `Resident host ${host.hostId} was opened without a process; a resident host is started by the driver's run entry.`,
      );
    }

    this.hosts.set(host.hostId, {
      hostId: host.hostId,
      appSessionId: host.bindings.keys().next().value as string,
      sink,
      queue: pending.queue,
      process: pending.process,
      rounds: [],
      context: null,
      writer: null,
      providerSessionId: null,
      resumed: false,
      sessionCreatedSent: false,
      assistantBudgetSent: false,
      modelContextWindow: pending.modelContextWindow,
      closed: false,
      loopError: null,
    });

    return host;
  }

  /** Records which session this host serves. One binding per resident host. */
  async bind(host: ProcessHost, binding: SessionBinding): Promise<void> {
    if (host.mode !== 'resident') {
      return this.perRun.bind(host, binding);
    }

    const state = this.hosts.get(host.hostId);
    if (state) {
      state.appSessionId = binding.appSessionId;
    }
  }

  /**
   * Delivers one turn with no client-facing writer.
   *
   * A resident turn's frames belong to the run that dispatched it, and a run's
   * writer arrives through this class's own `run` entry — `HostTurnInput` is the
   * command and its options and nothing else. So a call that reaches a resident
   * host here has no writer to send frames to, and writing the turn anyway would
   * run it blind: the CLI would take the turn and no client would ever see it.
   * Refusing and naming the entry that can serve it is the honest answer; for a
   * per-run host the sibling driver's rule applies instead.
   */
  async submit(host: ProcessHost, appSessionId: string, turn: HostTurnInput): Promise<void> {
    if (host.mode !== 'resident') {
      return this.perRun.submit(host, appSessionId, turn);
    }

    throw new Error(
      `A resident turn needs the writer and runtime context its frames belong to; dispatch it through this driver's run entry instead of submit.`,
    );
  }

  /**
   * Stops the turn in flight, leaving the process up.
   *
   * This is the whole of what abort means in resident mode: the CLI is asked to
   * stop the turn it is running (the SDK's own interrupt, which does not end the
   * process), and the turn's lease goes away.
   *
   * The round is deliberately **not** settled here. An interrupted round still
   * ends at its own `result`, exactly like a completed one (see the file header),
   * and settling it early would let the dispatch go before the turn's terminal
   * frame had been written: the dispatcher's own safety net completes a run that
   * resolves while it is still running, so an early settle is what would make an
   * aborted turn reach the client as a normal completion. The interrupt is the
   * request; the `result` is the ending.
   */
  async interrupt(host: ProcessHost, appSessionId: string): Promise<boolean> {
    if (host.mode !== 'resident') {
      return this.perRun.interrupt(host, appSessionId);
    }

    const state = this.hosts.get(host.hostId);
    const round = state?.rounds[0];
    if (!state || !round || round.appSessionId !== appSessionId) {
      return false;
    }

    round.interrupted = true;
    await stopResidentTurn(state.process.query);
    state.sink.leaseRemoved(appSessionId, 'turn');
    return true;
  }

  /**
   * Applies a live setting change where the SDK has a verb for it, and defers
   * everything else to the next turn.
   *
   * A resident process is the mode's reason to have a live surface at all, so the
   * two settings the SDK can change under a running turn are applied here:
   * `setModel` and `setPermissionMode`. Effort is a launch argument — it is
   * folded into the SDK options' env and effort flags when the process starts —
   * so a patch that names one is answered `next-turn` rather than claimed as
   * live. A verb the SDK build does not have is answered the same way, and the
   * answer is never `live` on faith: only a call that returned without throwing
   * is reported as applied.
   */
  async reconfigure(
    host: ProcessHost,
    appSessionId: string,
    patch: HostReconfigurePatch,
  ): Promise<'live' | 'next-turn'> {
    if (host.mode !== 'resident') {
      return this.perRun.reconfigure();
    }

    const state = this.hosts.get(host.hostId);
    if (!state || state.closed) {
      return 'next-turn';
    }

    let applied = false;
    if (typeof patch.model === 'string' && typeof state.process.query.setModel === 'function') {
      try {
        await state.process.query.setModel(patch.model);
        applied = true;
      } catch {
        // The verb is there but the process refused it; the next turn's options
        // carry the model again, so nothing is lost by deferring.
      }
    }
    if (
      typeof patch.permissionMode === 'string' &&
      typeof state.process.query.setPermissionMode === 'function'
    ) {
      try {
        await state.process.query.setPermissionMode(patch.permissionMode);
        applied = true;
      } catch {
        // As above.
      }
    }

    return applied ? 'live' : 'next-turn';
  }

  /**
   * Detaches one session from the host.
   *
   * A resident host serves one conversation, so the detach is followed by the
   * manager's own close (a host with no bindings left is closed under the same
   * reason) and ending the process is that close's job, not this verb's. What
   * this does is settle whatever round was in flight: the session that asked for
   * it is gone, so nobody is waiting for its answer any more.
   */
  async unbind(host: ProcessHost, appSessionId: string, reason: HostCloseReason): Promise<void> {
    if (host.mode !== 'resident') {
      return this.perRun.unbind(host, appSessionId);
    }

    const state = this.hosts.get(host.hostId);
    if (!state) {
      return;
    }

    for (const round of state.rounds.splice(0)) {
      round.settle();
    }
  }

  /**
   * Ends the host: stdin EOF first, the query's own close only as a backstop.
   *
   * The graceful path is the input queue's `end`, which the SDK turns into stdin
   * EOF and the CLI answers by winding down. The `close` that follows is not a
   * second attempt at the same thing — it is the SDK's transport teardown, the
   * one that escalates to SIGTERM and SIGKILL — and it is deliberately late
   * enough ({@link CLAUDE_RESIDENT_EXIT_GRACE_MS}) that an exit observed inside
   * an ordinary assertion window is the EOF's doing rather than this. It is
   * unref'd so a host held at shutdown cannot keep the server's event loop alive.
   */
  async closeHost(host: ProcessHost, reason: HostCloseReason): Promise<void> {
    if (host.mode !== 'resident') {
      return this.perRun.closeHost(host, reason);
    }

    const state = this.hosts.get(host.hostId);
    this.hosts.delete(host.hostId);
    if (!state || state.closed) {
      return;
    }
    state.closed = true;

    // Every round still waiting has lost the process that was going to answer it;
    // the close is that answer.
    for (const round of state.rounds.splice(0)) {
      round.settle();
    }

    state.queue.end();
    const backstop = setTimeout(() => {
      try {
        state.process.query.close?.();
      } catch {
        // The process is on its way out either way.
      }
    }, CLAUDE_RESIDENT_EXIT_GRACE_MS);
    backstop.unref?.();
  }

  /**
   * Starts one resident process and asks the manager to track it.
   *
   * The order is forced by what the manager accepts: the record's pid is written
   * when the host is opened, so the child has to exist first — which is also why
   * the first turn's messages are in the queue before the process is spawned. The
   * host is then read back from `snapshot()` because `openHost` answers with a
   * copy; `startHost` has already put the live state in `hosts`.
   */
  private async startResidentHost(
    appSessionId: string,
    messages: AnyRecord[],
    turn: HostTurnInput,
    context: ProviderRuntimeContext,
  ): Promise<ResidentHostState> {
    const options = turn.options;
    const resolvedModel = await context.resolveResumeModel(appSessionId, options.model);
    let effortModels: unknown;
    try {
      effortModels = await context.getProviderModels();
    } catch {
      // The runtime warns and carries on with the predefined effort table; the
      // launch must not fail because the model catalogue could not be read.
      effortModels = undefined;
    }

    const queue = createResidentInputQueue();
    queue.push(...messages);

    const process = await this.createProcess({
      prompt: queue.stream,
      options: {
        ...options,
        providerSessionId: context.resolveProviderSessionId(appSessionId),
        model: resolvedModel || options.model,
        effortModels,
      },
    });

    this.pending = {
      queue,
      process,
      modelContextWindow: resolveModelContextWindowRow('claude', resolvedModel || options.model),
    };

    const host = await this.host.openHost({
      provider: this.provider,
      mode: 'resident',
      appSessionId,
      driver: this,
      pid: await this.resolvePid(process),
    });

    const state = this.hosts.get(host.hostId);
    if (!state) {
      throw new Error(`Resident host ${host.hostId} was opened but its driver state was not adopted.`);
    }

    state.resumed = Boolean((options.resume as string | undefined) || (options.providerSessionId as string | null));
    this.consume(state);
    return state;
  }

  /**
   * The pid, once the spawn hook has run.
   *
   * The SDK spawns eagerly for a streaming prompt, so the hook has almost always
   * fired by the time `query()` returns; the extra tick is for a build that
   * defers it by a microtask, and a pid that never appears is recorded as the
   * truth (`null`) rather than waited on.
   */
  private async resolvePid(process: ClaudeResidentProcess): Promise<number | null> {
    if (process.pid !== null) {
      return process.pid;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    return process.pid;
  }

  /** Builds one turn's prompt messages through the runtime's own builder. */
  private turnMessages(turn: HostTurnInput): Promise<AnyRecord[]> {
    const options = turn.options;
    return buildPromptMessages(turn.command, options.images, options.files, options.cwd);
  }

  /** One round record, with the settlement its dispatcher awaits. */
  private createRound(
    appSessionId: string,
    turn: HostTurnInput,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): ResidentRound {
    let resolveDone: () => void = () => {};
    let rejectDone: (error: Error) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const round: ResidentRound = {
      appSessionId,
      turn,
      writer,
      context,
      done,
      settled: false,
      interrupted: false,
      settle(): void {
        if (round.settled) {
          return;
        }
        round.settled = true;
        resolveDone();
      },
      fail(error: Error): void {
        if (round.settled) {
          return;
        }
        round.settled = true;
        rejectDone(error);
      },
    };

    return round;
  }

  /**
   * Arms one round: its messages into the queue, its lease into the manager.
   *
   * `messages` are passed rather than rebuilt because the cold-start path has
   * already spent them seeding the queue before the process existed.
   */
  private armRound(
    state: ResidentHostState,
    round: ResidentRound,
    messages: AnyRecord[],
    alreadyQueued: boolean,
  ): void {
    state.context = round.context;
    state.writer = round.writer;
    if (!alreadyQueued) {
      state.queue.push(...messages);
    }
    state.rounds.push(round);
    state.sink.leaseAdded(state.appSessionId, {
      kind: 'turn',
      runId: `turn-${++this.serial}`,
    } satisfies HostLease);
  }

  /** The live resident state for a session, or null when it has no process. */
  private liveStateFor(appSessionId: string): ResidentHostState | null {
    for (const state of this.hosts.values()) {
      if (state.appSessionId === appSessionId && !state.closed) {
        return state;
      }
    }
    return null;
  }

  /** Runs the read loop detached, with a rejection sink so nothing floats unhandled. */
  private consume(state: ResidentHostState): void {
    this.readStream(state).catch(() => undefined);
  }

  /**
   * Reads one host's stream to its end.
   *
   * Not stopped when the manager closes the host: the close ends the *input*, and
   * the stream's own end is the fact being watched for — breaking out early would
   * drop whatever the CLI says on its way out. Continuing is safe, because the
   * sink's verbs refuse once the manager has closed the host.
   */
  private async readStream(state: ResidentHostState): Promise<void> {
    try {
      for await (const message of state.process.query) {
        this.observe(state, message);
      }
    } catch (error) {
      state.loopError = error instanceof Error ? error : new Error(String(error));
    }
    this.reportExit(state);
  }

  /**
   * Reports one round's ending to the notification layer.
   *
   * The call the runtime's own read loop makes at its turn boundary, made from
   * the same place here for the same reason: a client listening for run-ended
   * events has to hear about a stopped resident turn as well as a completed one,
   * and this driver is where either ending is reached. The application session id
   * is preferred over the provider-native one (mirroring the runtime, which
   * prefers the app id in this report and the native one in the frame), and a
   * turn that carried no session name reports none rather than inventing one.
   */
  private reportRoundEnd(
    round: ResidentRound,
    stopReason: 'completed' | 'aborted',
    providerSessionId: string | null,
  ): void {
    const sessionName = round.turn.options?.sessionSummary;
    this.notifyRunStopped({
      userId: round.writer.userId ?? null,
      provider: 'claude',
      sessionId: round.appSessionId || providerSessionId,
      sessionName: typeof sessionName === 'string' ? sessionName : null,
      stopReason,
    });
  }

  /**
   * Reports a stream that ended on its own, unless the manager already closed
   * the host.
   *
   * Every round still waiting has lost its process, so each is failed rather
   * than left hanging: the dispatcher that awaits one has to be able to report a
   * run that died, and a promise that never settles is not that. `error` is the
   * closest detail the close vocabulary carries for a stream that ended by
   * itself; `oom` and `signal` are kernel facts this layer cannot see.
   */
  private reportExit(state: ResidentHostState): void {
    if (state.closed) {
      return;
    }
    state.closed = true;

    const error = state.loopError ?? new Error('The resident Claude process ended before the turn did.');
    for (const round of state.rounds.splice(0)) {
      round.fail(error);
    }

    state.sink.exited({ hostId: state.hostId, detail: 'error' });
  }

  /**
   * Folds one SDK message into the host's reported state.
   *
   * The order is the runtime's own read loop, minus the interactive half this
   * mode does not carry (see the file header): capture the provider session id
   * once, hand the normalized frames to the current writer, publish the token
   * budget, mark the binding active, and read a `result` as the end of a turn.
   */
  private observe(state: ResidentHostState, message: AnyRecord): void {
    const round = state.rounds[0] ?? null;
    const writer = round?.writer ?? state.writer;
    const context = round?.context ?? state.context;

    if (typeof message?.session_id === 'string' && message.session_id && !state.providerSessionId) {
      state.providerSessionId = message.session_id;
      writer?.setSessionId?.(message.session_id);
      if (!state.resumed && !state.sessionCreatedSent) {
        state.sessionCreatedSent = true;
        writer?.send(
          createNormalizedMessage({
            kind: 'session_created',
            newSessionId: message.session_id,
            sessionId: message.session_id,
            provider: 'claude',
          }),
        );
      }
    }

    const sessionId = state.providerSessionId;

    if (writer && context) {
      forwardNormalizedFrames({
        transformedMessage: transformResidentMessage(message),
        sessionId,
        normalizeMessage: context.normalizeMessage,
        writer,
      });
    }

    const tokenBudget =
      extractTokenBudget(message, state.modelContextWindow) ||
      (state.assistantBudgetSent ? null : extractCumulativeTokenBudget(message, state.modelContextWindow));
    if (tokenBudget && writer) {
      if (message.type === 'assistant') {
        state.assistantBudgetSent = true;
      }
      writer.send(
        createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId,
          provider: 'claude',
        }),
      );
    }

    // Every message is real work on the binding: a streamed frame, a tool call, a
    // turn boundary. This is what holds the quiet ceiling off a process that is
    // actively being used.
    state.sink.activity(state.appSessionId);

    if (message?.type !== 'result') {
      return;
    }

    const finished = state.rounds.shift();
    if (!finished) {
      // A result nobody is waiting for: the process pushed a turn of its own —
      // the resident shape of the background-work follow-up. The mode already
      // holds the process open, so there is no lease to drop, and the frames
      // above have reached the client. The turn boundary is simply not this
      // driver's to report.
      return;
    }

    state.sink.leaseRemoved(state.appSessionId, 'turn');

    // Every round writes its own terminal frame, interrupted or not, and it is
    // written *before* the round settles. Both halves matter: the frame is what
    // flips the run to completed in the registry, so writing it first is what
    // keeps the dispatch's safety net (`completeRunIfCurrent`) from reporting an
    // interrupted turn as a normal exit; and an interrupted round has to carry
    // `aborted`, which is only known here, at its `result`.
    //
    // The abort path (`chat.abort`) writes a terminal frame of its own for the
    // run as soon as `interrupt` answers, so one of the two is a duplicate — the
    // registry drops whichever arrives second, and both say `aborted: true`, so
    // the client sees the same event either way.
    finished.writer.send(
      createCompleteMessage({
        provider: 'claude',
        sessionId: sessionId || finished.appSessionId || null,
        exitCode: 0,
        aborted: finished.interrupted,
      }),
    );
    // Both endings are *reported* too, exactly as the runtime reports an aborted
    // and a completed run from the same place.
    this.reportRoundEnd(finished, finished.interrupted ? 'aborted' : 'completed', sessionId);

    finished.settle();

    if (state.rounds.length > 0) {
      // A turn was written while this one was running. The CLI is already working
      // on it, so the host is busy again and the lease has to be there before its
      // frames are read as a quiet binding.
      state.sink.leaseAdded(state.appSessionId, {
        kind: 'turn',
        runId: `turn-${++this.serial}`,
      });
    }
  }
}
