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
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

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
  BackgroundWorkTrigger,
  CommandLifecycleEvent,
  CommandLifecycleState,
  HostCloseReason,
  HostInputPriority,
  HostLease,
  HostQueuedInputCancelResult,
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
 * How long a withdrawal waits for the queue to say a message was cancelled.
 *
 * A budget, not a timeout with a meaning: the queue answers in the same read
 * loop this driver is already consuming, so the wait is over either as soon as
 * the event arrives or when the budget runs out — and running out is not
 * evidence of anything except that no `cancelled` was seen. The verdict is
 * computed from the reading after the wait, never from the wait's expiry.
 */
export const CLAUDE_CANCEL_VERDICT_WAIT_MS = 5_000;

/** How often the withdrawal re-reads the queue while waiting. */
const CLAUDE_CANCEL_VERDICT_POLL_MS = 25;

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
  /**
   * Writes one raw frame to the process's stdin, when this process has a stdin
   * this driver can reach.
   *
   * The SDK's `Query` interface exposes no verb for most of
   * `SDKControlRequestInner` — `cancel_async_message` among them (measured: the
   * `Query` methods are interrupt / setPermissionMode / setModel /
   * setMaxThinkingTokens / applyFlagSettings / stopTask / streamInput /
   * rewindFiles, and nothing else) — so a control frame the SDK has no method
   * for is reachable only by writing the stream-json line itself, which is
   * exactly how the protocol's behavior was measured in the first place
   * (`docs/proposals/claude-resident-sessions-experiments.md` §9).
   *
   * Optional because a process seam may not carry one: a scripted stream has no
   * stdin to write to, and a driver that assumed otherwise would be claiming a
   * capability its own seam never gave it. Absent means the withdrawal entry
   * answers `unknown` rather than pretending to have written anything.
   */
  writeRaw?(frame: AnyRecord): void;
};

/**
 * The tier every message a busy host pushes is written under.
 *
 * `later` is what makes a busy message behave the way the interactive CLI's
 * does: it waits for the turn in flight, is then run as a turn of its own, and
 * is never merged into the turn it arrived during. Measured on the real binary
 * (`§9.2`): pushed under this tier, a message landed in the sixth real agent
 * turn — a later turn, not the one it was pushed during — and the tier that
 * "never lands" is `next`, not this one. `now` exists in the CLI's vocabulary
 * and is deliberately not used: it jumps the queue ahead of other `later`
 * messages, which is not what a message sent during someone else's turn asked
 * for.
 */
export const CLAUDE_QUEUED_INPUT_PRIORITY: HostInputPriority = 'later';

/**
 * One user frame this host wrote into the process while the process was busy.
 *
 * The reading exists because the frame's own facts are unreadable from
 * anywhere else once it has been written: the moment it was handed to the
 * process, the tier it was written under, and the uuid the host assigned it
 * (which is also the CLI's `command_uuid` for it) are all host-side facts.
 * `queuedBeforeResult` is the precomputed half of the AC's write-timing
 * reading — whether the frame reached the process before the turn in flight
 * ended — kept here rather than in the criterion so the two timestamps it
 * compares come from the same clock on the same side.
 */
export type ClaudeQueuedInput = {
  uuid: string;
  /** When this host handed the frame to the process input, in host clock terms. */
  at: number;
  /** The tier the frame was written under. */
  priority: string | null;
  /** The frame verbatim, as it was written. */
  frame: AnyRecord;
  /**
   * When the CLI dequeued this message into a turn of its own, or `null` while
   * it is still queued.
   */
  startedAt: number | null;
  /**
   * How many turns had ended when the frame was pushed. The turn in flight at
   * that moment is the one whose `result` this index points at, so
   * `resultTimes[resultsSeenAtPush]` is the `turnResultAt` of the AC's
   * write-timing reading.
   */
  resultsSeenAtPush: number;
  /** Whether the frame reached the process before that turn's `result`. */
  queuedBeforeResult: boolean | null;
};

/**
 * What a live resident host knows about the messages it pushed while busy, the
 * queue's own account of them, and the control frames it wrote.
 *
 * A copy, like {@link ClaudeUnattendedReading}, and `null` for a session this
 * driver is not hosting. Everything in it is read off the host that owns the
 * process: the push moments and tiers are the host's own marks, the lifecycle
 * list is the CLI's answer as this host read it, and the control frames are the
 * bytes this host wrote.
 */
export type ClaudeBusyInputReading = {
  /** Every frame this host pushed while the process was already busy, in push order. */
  queuedInputs: ClaudeQueuedInput[];
  /** Every `command_lifecycle` event this host read, in arrival order. */
  lifecycle: CommandLifecycleEvent[];
  /** Every control frame this host wrote to the process, in write order. */
  controlFrames: Array<{ at: number; requestId: string; frame: AnyRecord }>;
  /** Every `control_response` the CLI sent back, in arrival order. */
  controlResponses: Array<{ at: number; requestId: string | null }>;
  /**
   * When each turn's `result` was read, in arrival order.
   *
   * Indexed by turns *ended*, which is the same index
   * {@link ClaudeQueuedInput.resultsSeenAtPush} counts, so the two line up
   * without either side knowing a round's identity.
   */
  resultTimes: number[];
  /** How many `session_state_changed` messages the stream carried (E9 §9.1: none). */
  sessionStateChanged: number;
  /** The host process's pid, or null when the seam did not report one. */
  hostPid: number | null;
};

/**
 * Builds one resident process.
 *
 * Injected for the same reason the per-run driver injects its query factory: the
 * SDK's `query` is a module-level function, so there is no seam to stub. The
 * default is the real SDK plus the pid capture; a criterion that wants a
 * scripted stream — or a fake process that really dies — hands in its own.
 */
/**
 * Readings the driver takes out of the process it is about to spawn.
 *
 * The `Stop` hook is the only place the CLI says what it is still holding
 * (`background_tasks`, `session_crons`), and it is not on the message stream:
 * the SDK delivers it to a callback, so the only way to have it is to install
 * one. Installing it through the process factory rather than inside the driver
 * is what keeps the seam honest — the factory owns the SDK options, so a
 * criterion that substitutes a factory is also the thing that decides whether
 * the hook ever runs, instead of the driver reading a hook it quietly added.
 */
export type ClaudeResidentProcessSeams = {
  /** Called with every `Stop` hook input verbatim, in arrival order. */
  onStop?: (input: AnyRecord) => void;
};

export type ClaudeResidentProcessFactory = (input: {
  prompt: AsyncIterable<AnyRecord>;
  options: AnyRecord;
  seams?: ClaudeResidentProcessSeams;
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
  'openHost' | 'snapshot' | 'bindSession' | 'openUnattendedRun'
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
  /**
   * Background work reported by a turn the process opened by itself.
   *
   * A separate verb from `notifyBackgroundWork` because the two carry different
   * facts, not because they are different notifications: the per-run report has
   * no trigger to give (its turn arrived as a request, so there is nothing to
   * reconcile) and this one always does. Both reach the same notification in
   * production; a host that composes this driver names where each goes.
   */
  notifyUnattendedWork: (event: ClaudeUnattendedWorkEvent) => void;
  /** Called once per completed round, mirroring the runtime's own stop notification. */
  notifyRunStopped: (event: ClaudeResidentRunStoppedEvent) => void;
  /** Process seam; defaults to the real SDK with the pid capture installed. */
  createProcess?: ClaudeResidentProcessFactory;
};

/**
 * The unattended-turn entry, named where the run it opens would have to live.
 *
 * `openUnattendedRun` is on the manager's surface rather than in this file for
 * the same reason the rest of the port is: what opens a *run* is the websocket
 * module's registry, and the providers module already imports the websocket
 * module — so an edge back from here would close a cycle. The manager carries
 * the seam (`setUnattendedRunOpener`) and the composition root fills it; the
 * driver only calls it. What it answers with is the writer the turn's frames
 * belong to, or null when no run could be opened (no seam installed, or one
 * already in flight for the session).
 */
export type ClaudeResidentUnattendedRun = {
  /** The open run's writer; frames the host routes to it are client-facing frames. */
  writer: ProviderRuntimeWriter;
};

/**
 * The notification an unattended turn's end makes.
 *
 * The per-run background-work report's own shape, plus the one fact only the
 * host can reconcile: what the reporting turn was *for*. A resident process that
 * opens a turn of its own sends no request, so nothing in the turn says why it
 * happened; the trigger is derived from the `Stop` hook's task list as it read
 * when the turn opened (see {@link deriveBackgroundWorkTrigger}) and carried
 * here, rather than guessed from the turn's contents.
 */
export type ClaudeUnattendedWorkEvent = Omit<ClaudeBackgroundWorkEvent, 'userId'> & {
  /**
   * Never `null`-for-no-connection the way the per-run event's is: this turn
   * has no connection either, but it does have a predecessor, so the user is
   * the last round's — the same reading `ClaudeResidentRunStoppedEvent` already
   * reports, and wide in the same way for the same reason (a user id is a
   * database id, which is a number in every path that produces one).
   */
  userId: string | number | null;
  trigger: BackgroundWorkTrigger;
};

/**
 * The identification of an unattended turn, read off a live resident host.
 *
 * The whole record exists because the two halves of "a turn nobody pushed" live
 * on opposite sides of the process boundary: the uuids this host stamped are
 * only known here (the stream never echoes one), while the uuid the CLI minted
 * for the turn's opener is only known to the CLI. Neither is a readable fact
 * from a transcript or a frame, so a reader that has to prove a turn was
 * unattended reads them together, from the host that holds both.
 *
 * Read-only by construction: it is a copy, taken on demand, and the caller is a
 * test that reports what it saw rather than one that can change it. The
 * `server/modules/providers/tests/claude-resident-unattended-turn.test.ts`
 * criterion is its consumer — the identification and the tool-table readings the
 * criterion prints come from here.
 */
export type ClaudeUnattendedReading = {
  /** Every uuid this host stamped on a user frame it pushed, in push order. */
  pushedUuids: string[];
  /** The last of them, or `null` when nothing was ever pushed. */
  lastPushedUuid: string | null;
  /** The opener uuid of the last unattended turn this host opened, if any. */
  unattendedCommandUuid: string | null;
  /** The tool names the process reported at `system/init`. */
  initTools: string[];
  /** The `system/task_started` task type, if the process started one. */
  backgroundTaskType: string | null;
};

/**
 * What made a turn nobody pushed, from the CLI's own account of what it holds.
 *
 * Only two things can make this CLI open a turn by itself: a background task
 * finishing, or a session cron firing. Both are reported by the `Stop` hook, so
 * both are readable — and everything else is `non-user`, which is the reading
 * for a turn with no list to explain it rather than a claim about who asked.
 *
 * `non-user` is the whole of the fallback on purpose: an unreadable hook, a
 * missing field and an empty list are the same fact from this side (nothing the
 * CLI holds explains the turn), and three names for it would be three ways for a
 * reader to disagree about which one they got.
 */
export function deriveBackgroundWorkTrigger(
  readings: { backgroundTasks?: unknown; sessionCrons?: unknown } | null,
): BackgroundWorkTrigger {
  const tasks = Array.isArray(readings?.backgroundTasks) ? readings.backgroundTasks : [];
  if (tasks.length > 0) {
    return 'background-task';
  }
  const crons = Array.isArray(readings?.sessionCrons) ? readings.sessionCrons : [];
  if (crons.length > 0) {
    return 'session-cron';
  }
  return 'non-user';
}

/**
 * What the CLI's own `Stop` hook has said about the work it is holding.
 *
 * One reading per hook firing, newest kept. The list is a *ledger* rather than a
 * single value because the hook fires at the end of every turn: at the end of
 * the turn that started background work it lists that work, and at the end of
 * the unattended turn that work produced it lists nothing again. Reading it
 * "latest first" is therefore only correct if the read happens at the right
 * moment — which is why the trigger is taken when an unattended turn *opens*
 * (no round armed, the previous turn's hook the newest entry) and not when it
 * ends (by then the hook has already reported the empty list it leaves behind).
 */
type BackgroundWorkLedger = {
  record(input: AnyRecord): void;
  /** The newest reading that carried a task list, or null when none has. */
  latest(): { backgroundTasks?: unknown; sessionCrons?: unknown } | null;
  /** How many hook firings this process has reported. */
  readonly size: number;
};

function createBackgroundWorkLedger(): BackgroundWorkLedger {
  let entries: Array<{ backgroundTasks?: unknown; sessionCrons?: unknown }> = [];

  return {
    record(input: AnyRecord): void {
      if (!input || typeof input !== 'object') {
        return;
      }
      if (!Array.isArray(input.background_tasks) && !Array.isArray(input.session_crons)) {
        // A hook firing that carries neither list says nothing about what the
        // process holds; keeping it would make the newest entry an empty one and
        // read every later turn as unexplained.
        return;
      }
      entries.push({ backgroundTasks: input.background_tasks, sessionCrons: input.session_crons });
      if (entries.length > 8) {
        entries = entries.slice(-8);
      }
    },
    latest() {
      return entries.at(-1) ?? null;
    },
    get size() {
      return entries.length;
    },
  };
}

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
  seams?: ClaudeResidentProcessSeams;
}): ClaudeResidentProcess {
  const sdkOptions = mapCliOptionsToSDK(input.options);
  const installedSpawn = sdkOptions.spawnClaudeCodeProcess as
    | ((options: SdkSpawnOptions) => SpawnedProcess)
    | undefined;
  let pid: number | null = null;
  let stdin: Writable | null = null;

  // The `Stop` hook, appended to whatever `hooks` the launch builder produced —
  // the same way the spawn hook below wraps whatever hook it found — so nothing
  // the builder set is replaced. The callback returns an empty object, which is
  // the hook contract's "no decision": a hook that answered anything else here
  // would change the turn it is only supposed to be read from.
  //
  // The write goes through a record view because `hooks` is not part of the
  // builder's declared return; it is still the same object that is handed to
  // `query`, which reads `hooks` off it at runtime like any other option.
  const launchOptions = sdkOptions as unknown as Record<string, unknown>;
  const onStop = input.seams?.onStop;
  if (onStop) {
    const installedHooks = (launchOptions.hooks ?? {}) as Record<string, unknown>;
    const installedStop = Array.isArray(installedHooks.Stop) ? installedHooks.Stop : [];
    launchOptions.hooks = {
      ...installedHooks,
      Stop: [
        ...installedStop,
        {
          hooks: [
            async (hookInput: AnyRecord) => {
              onStop(hookInput);
              return {};
            },
          ],
        },
      ],
    };
  }

  sdkOptions.spawnClaudeCodeProcess = (spawnOptions: SdkSpawnOptions): SpawnedProcess => {
    const child = installedSpawn
      ? (installedSpawn(spawnOptions) as ClaudeResidentProcessHandle)
      : spawnResidentCli(spawnOptions);
    if (typeof child?.pid === 'number') {
      pid = child.pid;
    }
    // The stdin the SDK writes its own prompt messages to. Kept because a
    // control frame the SDK's `Query` has no verb for has to be written to the
    // same stream by hand (see `ClaudeResidentProcess.writeRaw`). Both writers
    // go through one `Writable`, which preserves write order and writes each
    // chunk whole — a JSON line is far inside the pipe's atomic-write bound.
    if (child?.stdin) {
      stdin = child.stdin;
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
    writeRaw(frame: AnyRecord): void {
      if (!stdin || stdin.destroyed) {
        return;
      }
      stdin.write(`${JSON.stringify(frame)}\n`);
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
  /**
   * The uuids this round's own messages were pushed under, when it was armed
   * while the process was busy.
   *
   * Empty for a cold round: its message is the process's first work rather than
   * a queue entry, so there is nothing behind it to withdraw it from. Non-empty
   * is what makes the round findable by uuid, which is the only handle a
   * withdrawal has — the CLI cancels a uuid, not a round.
   */
  queuedUuids: string[];
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
  /**
   * Every uuid this host has stamped on a user frame it pushed.
   *
   * The host's own mark on the turns it sent. It is not the CLI's id for a turn
   * — the stream never echoes a pushed uuid (measured: a pushed uuid appears in
   * no message the SDK emits) — so the set can only ever be read from this side,
   * and that is the reading it is for: a turn whose opener carries a uuid that
   * is not in this set was not pushed by anyone here.
   */
  pushedUuids: Set<string>;
  /** The `Stop` hook's own account of what this process is holding. */
  ledger: BackgroundWorkLedger;
  /** The user and session name of the last armed round, for a report no round owns. */
  lastUserId: string | number | null;
  lastSessionName: string | null;
  /** The turn this process opened by itself, while it is open. */
  unattended: {
    /** The CLI-minted uuid of the turn's opener: the value no push accounts for. */
    commandUuid: string;
    /** What the `Stop` hook said the process held when the turn opened. */
    trigger: BackgroundWorkTrigger;
    /** The run's writer. */
    writer: ProviderRuntimeWriter;
  } | null;
  /**
   * The opener uuid of the last unattended turn, kept after that turn ends.
   *
   * The live `unattended` record is cleared when its turn finishes, but the
   * identification it carries outlives it: a reader asking "did this process
   * open a turn nobody pushed?" is asking after the fact, once the turn's text
   * has landed. Held separately so the answer does not depend on the timing.
   */
  lastUnattendedCommandUuid: string | null;
  /**
   * The tool names the process reported at `system/init`.
   *
   * Recorded because the tool table is a launch decision, not a stream fact —
   * it is what says whether a trigger could have been a tool call at all, and
   * it is otherwise unreadable from outside the process.
   */
  initTools: string[];
  /** The `system/task_started` task type, when the process started one. */
  backgroundTaskType: string | null;
  /**
   * Every frame this host pushed while the process was already busy.
   *
   * Busy means a round or an unattended turn was in flight at the push: that is
   * the only state in which a frame is *not* the thing the process is about to
   * work on, and so the only state in which what it was written under (a tier,
   * a queue position) is a fact worth keeping. A cold start's frames are the
   * process's first work and are not recorded here.
   */
  queuedInputs: ClaudeQueuedInput[];
  /** Every `command_lifecycle` event read off the stream, in arrival order. */
  lifecycle: CommandLifecycleEvent[];
  /** Every control frame written to the process's stdin, in write order. */
  controlFrames: Array<{ at: number; requestId: string; frame: AnyRecord }>;
  /** Every `control_response` the CLI sent back, in arrival order. */
  controlResponses: Array<{ at: number; requestId: string | null }>;
  /** When each turn's `result` was read; see {@link ClaudeBusyInputReading.resultTimes}. */
  resultTimes: number[];
  /** How many `session_state_changed` messages the stream carried. */
  sessionStateChanged: number;
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
  /** The hook ledger built for this process, carried over with the queue. */
  ledger: BackgroundWorkLedger;
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
  private readonly notifyUnattendedWork: (event: ClaudeUnattendedWorkEvent) => void;
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
    this.notifyUnattendedWork = options.notifyUnattendedWork;
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
      //
      // Busy is read *now*, before the await that builds the messages, and it
      // is read off the two things that make the process busy rather than off
      // the turn count: a round in flight, or an unattended turn the process
      // opened for itself. Either one means the frame being written is not the
      // process's next piece of work but a queue entry behind one — which is
      // the fact the tier states and the fact the criterion reads the write
      // moment against.
      const busy = existing.rounds.length > 0 || Boolean(existing.unattended);
      this.armRound(existing, round, await this.turnMessages(turn, busy), false);
      await round.done;
      return;
    }

    const round = this.createRound(appSessionId, turn, writer, context);
    const messages = await this.turnMessages(turn, false);
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
      pushedUuids: new Set<string>(),
      ledger: pending.ledger,
      lastUserId: null,
      lastSessionName: null,
      unattended: null,
      lastUnattendedCommandUuid: null,
      initTools: [],
      backgroundTaskType: null,
      queuedInputs: [],
      lifecycle: [],
      controlFrames: [],
      controlResponses: [],
      resultTimes: [],
      sessionStateChanged: 0,
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
    // the close is that answer, and an unattended turn still open loses the same
    // thing — its `result` — so its run is ended here rather than left open.
    for (const round of state.rounds.splice(0)) {
      round.settle();
    }
    this.abandonUnattendedTurn(state, 1);

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
   * Reports what a live resident host knows about pushes and unattended turns.
   *
   * A copy, so the caller cannot reach into host state, and `null` for a session
   * this driver is not hosting — both properties a reading has to have to be
   * worth printing. The uuids are the point: the pushed set is the host's own
   * mark and the opener uuid is the CLI's, and a turn whose opener is absent from
   * the set is one nobody pushed (see {@link ResidentHostState.pushedUuids}).
   * `initTools` and `backgroundTaskType` ride along because they are facts of the
   * same process that nothing outside it can read.
   */
  unattendedReading(appSessionId: string): ClaudeUnattendedReading | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }

    const pushedUuids = [...state.pushedUuids];
    return {
      pushedUuids,
      lastPushedUuid: pushedUuids.at(-1) ?? null,
      unattendedCommandUuid: state.unattended?.commandUuid ?? state.lastUnattendedCommandUuid,
      initTools: [...state.initTools],
      backgroundTaskType: state.backgroundTaskType,
    };
  }

  /**
   * Reports what a live resident host knows about its busy-time writes.
   *
   * A copy, and `null` for a session this driver is not hosting — the same two
   * properties {@link unattendedReading} has, for the same reason. What is in
   * it is everything the write side of this driver produces that nothing else
   * can read: when each frame was handed over and under which tier, the CLI's
   * own queue account of it, the control frames this host wrote, and the
   * responses that came back to them.
   */
  busyInputReading(appSessionId: string): ClaudeBusyInputReading | null {
    const state = this.liveStateFor(appSessionId);
    if (!state) {
      return null;
    }

    return {
      queuedInputs: state.queuedInputs.map((input) => ({ ...input, frame: { ...input.frame } })),
      lifecycle: [...state.lifecycle],
      controlFrames: state.controlFrames.map((entry) => ({ ...entry, frame: { ...entry.frame } })),
      controlResponses: [...state.controlResponses],
      resultTimes: [...state.resultTimes],
      sessionStateChanged: state.sessionStateChanged,
      hostPid: state.process.pid,
    };
  }

  /**
   * Withdraws a message this host wrote, if the CLI still has it queued.
   *
   * The frame is written by hand because the SDK's `Query` has no verb for
   * `cancel_async_message` (see `ClaudeResidentProcess.writeRaw`), and the
   * verdict is read from the queue's own account rather than from a response:
   * measured at all three timings — still queued, already dequeued, uuid that
   * never existed — the CLI answers this frame with **no** `control_response`
   * at all (`§9.2`). The one thing that changes when the withdrawal worked is
   * a `state=cancelled` event for that uuid, so that is what is waited for.
   *
   * Returns `unknown` when there is no live process to write to or no raw
   * write seam on it: a driver that cannot write has not withdrawn anything,
   * and reporting `already-started` there would be claiming knowledge of a
   * queue it never reached.
   */
  async cancelQueuedInput(
    appSessionId: string,
    messageUuid: string,
  ): Promise<HostQueuedInputCancelResult> {
    const state = this.liveStateFor(appSessionId);
    if (!state || state.closed || !messageUuid) {
      return 'unknown';
    }
    const writeRaw = state.process.writeRaw;
    if (typeof writeRaw !== 'function') {
      return 'unknown';
    }

    const requestId = randomUUID();
    const frame: AnyRecord = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'cancel_async_message', message_uuid: messageUuid },
    };
    // Recorded before the write so the reading holds the bytes even if the
    // process dies mid-write.
    state.controlFrames.push({ at: Date.now(), requestId, frame });
    writeRaw.call(state.process, frame);

    const withdrawn = await this.waitForLifecycle(state, messageUuid, 'cancelled');
    if (withdrawn) {
      this.dropWithdrawnRound(state, messageUuid);
      return 'withdrawn';
    }
    // No `cancelled`, so the message was not withdrawn. It is only
    // `already-started` if the CLI actually dequeued it; a uuid this process
    // never queued is `unknown`, which is a different answer and stays one.
    const dequeued = state.lifecycle.some(
      (event) => event.commandUuid === messageUuid && event.state === 'started',
    );
    return dequeued ? 'already-started' : 'unknown';
  }

  /**
   * Drops the round a withdrawn message was armed as, and ends it.
   *
   * A round exists per turn the dispatcher asked for, and the dispatcher awaits
   * it: without this, a withdrawn message's round would sit in the FIFO forever,
   * because the CLI never starts a message it cancelled and so never emits the
   * `system/init`/`result` pair the round would settle on. Three things go wrong
   * while it sits there, and all three are the same bug seen from three sides:
   * the dispatcher's promise never settles, the next turn's `result` shifts the
   * wrong round (settling the withdrawal on a turn it never ran), and the FIFO
   * is never empty — which is exactly the reading an unattended turn's opener is
   * refused by, so the process's own turn would be misread as a queued one.
   *
   * The terminal frame goes through the round's **own** writer, like every other
   * round's: that run was opened for this message and the message will now never
   * run, so the run is over and has to say so. `aborted` rather than a clean exit
   * — the turn did not run and was stopped by a person, which is what that flag
   * means everywhere else in this file. No round-end report is made: the caller
   * of the withdrawal is the person who asked for it and gets a verdict frame
   * back, and a "your run stopped" notification about their own withdrawal is
   * noise about a turn that never started.
   */
  private dropWithdrawnRound(state: ResidentHostState, messageUuid: string): void {
    const index = state.rounds.findIndex((round) => round.queuedUuids.includes(messageUuid));
    if (index < 0) {
      // Either a cold round (its message was the process's first work and was
      // never a queue entry) or a round that already settled. Nothing to drop:
      // the CLI answered `cancelled` for a uuid this host has no turn waiting on.
      return;
    }

    const [withdrawn] = state.rounds.splice(index, 1);
    // The lease accounting is the same one the `result` path keeps: one lease
    // per live round. The dropped round is gone, so its lease goes with it.
    state.sink.leaseRemoved(state.appSessionId, 'turn');
    withdrawn.writer.send(
      createCompleteMessage({
        provider: this.provider,
        sessionId: state.providerSessionId || withdrawn.appSessionId,
        exitCode: 0,
        aborted: true,
      }),
    );
    // Settles the dispatcher's await for this turn. `settled` also keeps a
    // `result` that somehow arrives anyway from settling it a second time.
    withdrawn.settle();
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
    // One ledger per process, created before the spawn so the hook installed on
    // it can never fire into nowhere: the first turn can end before this method
    // returns, and its `Stop` reading is the one an unattended turn will need.
    const ledger = createBackgroundWorkLedger();

    const process = await this.createProcess({
      prompt: queue.stream,
      options: {
        ...options,
        providerSessionId: context.resolveProviderSessionId(appSessionId),
        model: resolvedModel || options.model,
        effortModels,
      },
      seams: { onStop: (input) => ledger.record(input) },
    });

    this.pending = {
      queue,
      process,
      modelContextWindow: resolveModelContextWindowRow('claude', resolvedModel || options.model),
      ledger,
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

  /**
   * Builds one turn's prompt messages through the runtime's own builder, each
   * stamped with the uuid this host pushes it under.
   *
   * The stamp is the host's mark on the turn and is recorded in the host's own
   * pushed set (see `armRound`). It is deliberately *not* claimed to be the
   * CLI's id for the turn: the stream echoes no pushed uuid, so the set answers
   * one question only — "did this host push this turn?" — which is the question
   * an unattended turn's opener has to be measured against.
   */
  private async turnMessages(turn: HostTurnInput, queuedBehindTurn: boolean): Promise<AnyRecord[]> {
    const options = turn.options;
    const messages = await buildPromptMessages(turn.command, options.images, options.files, options.cwd);
    return messages.map((message) => ({
      ...message,
      uuid: randomUUID(),
      // A frame written while the process is busy is written under the tier that
      // makes it wait for the turn in flight and then run as a turn of its own.
      // A cold start's frame is the process's first work, so it carries no tier:
      // there is nothing for it to queue behind, and stating one anyway would
      // make the frame say something about a queue that does not exist yet.
      ...(queuedBehindTurn ? { priority: CLAUDE_QUEUED_INPUT_PRIORITY } : {}),
    }));
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
      queuedUuids: [],
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
    // What an unattended report needs when no round is left to ask: who to
    // report to, and what to call the session. Kept here rather than read off
    // the round at report time because by then the round is gone.
    state.lastUserId = round.writer.userId ?? null;
    const sessionName = round.turn.options?.sessionSummary;
    state.lastSessionName = typeof sessionName === 'string' ? sessionName : null;
    for (const message of messages) {
      if (typeof message?.uuid === 'string' && message.uuid) {
        state.pushedUuids.add(message.uuid);
      }
    }
    if (!alreadyQueued) {
      // Read before the push: `rounds` is appended to below, and the frame's
      // tier and write moment have to be judged against the process's state as
      // it was when the frame was handed over, not after this round joined.
      const busy = state.rounds.length > 0 || Boolean(state.unattended);
      const at = Date.now();
      const resultsSeenAtPush = state.resultTimes.length;
      for (const message of messages) {
        if (busy && typeof message?.uuid === 'string' && message.uuid) {
          round.queuedUuids.push(message.uuid);
          state.queuedInputs.push({
            uuid: message.uuid,
            at,
            priority: typeof message.priority === 'string' ? message.priority : null,
            frame: message,
            startedAt: null,
            resultsSeenAtPush,
            // Read off the turn's own `result` once it has one; the frame is
            // written strictly earlier by construction, and leaving this null
            // until then is what keeps the reading from being an assertion
            // dressed up as a measurement.
            queuedBeforeResult: null,
          });
        }
      }
      state.queue.push(...messages);
    }
    state.rounds.push(round);
    state.sink.leaseAdded(state.appSessionId, {
      kind: 'turn',
      runId: `turn-${++this.serial}`,
    } satisfies HostLease);
  }

  /**
   * Opens a run for a turn the process started by itself, at the moment that
   * turn announces itself.
   *
   * The reading is structural and has to be: a turn nobody pushed sends no
   * request, so there is nothing to correlate a run with. What the CLI does say
   * is that a conversation turn is beginning (`system/init`) at a moment when no
   * round is armed **and** under a uuid this host never pushed. Neither half is
   * the reading on its own — round 1's own init also carries a uuid no push
   * accounts for, and it arrives armed — and together they are exactly "a turn
   * this host did not send".
   *
   * Never throws and never reports. An unattended turn that cannot be opened is
   * not a failure: the run registry may already hold a run for the session, and
   * in that case the frames stay with the last writer, which is what this mode
   * did before it could open runs at all.
   */
  private openUnattendedTurnIfOwn(
    state: ResidentHostState,
    message: AnyRecord,
    sessionId: string | null,
  ): void {
    if (state.closed || state.unattended) {
      return;
    }
    if (message?.type !== 'system' || message.subtype !== 'init') {
      return;
    }
    if (state.rounds.length > 0) {
      return;
    }
    const commandUuid = typeof message.uuid === 'string' ? message.uuid : null;
    if (!commandUuid || state.pushedUuids.has(commandUuid)) {
      return;
    }

    const handle = this.host.openUnattendedRun({
      provider: this.provider,
      appSessionId: state.appSessionId,
      providerSessionId: sessionId,
      userId: state.lastUserId,
      sessionName: state.lastSessionName,
    });
    if (!handle) {
      return;
    }

    // Read at the opener and not at the end: the hook fires at every turn's
    // end, so by the time this turn's own `result` arrives the newest reading
    // is the empty list the turn itself left behind.
    const trigger = deriveBackgroundWorkTrigger(state.ledger.latest());
    state.unattended = { commandUuid, trigger, writer: handle.writer };
    state.lastUnattendedCommandUuid = commandUuid;
    if (sessionId) {
      handle.writer.setSessionId?.(sessionId);
    }
  }

  /**
   * Ends the unattended turn a `result` closed: its terminal frame, then the
   * report that says what the turn was for.
   *
   * The frame comes first for the same reason a round's does — it is what flips
   * the run to completed in the registry, and a notification about a run that
   * has ended should not be able to arrive before the ending it describes. No
   * lease is touched: an unattended turn never held one, because nothing asked
   * the manager for it.
   */
  private finishUnattendedTurn(state: ResidentHostState, sessionId: string | null): void {
    const unattended = state.unattended;
    if (!unattended) {
      return;
    }
    state.unattended = null;
    unattended.writer.send(
      createCompleteMessage({
        provider: 'claude',
        sessionId: sessionId || state.appSessionId,
        exitCode: 0,
        aborted: false,
      }),
    );
    this.notifyUnattendedWork({
      appSessionId: state.appSessionId,
      provider: 'claude',
      userId: state.lastUserId,
      sessionId: state.appSessionId,
      sessionName: state.lastSessionName,
      trigger: unattended.trigger,
    });
  }

  /**
   * Drops an unattended run whose turn will never end.
   *
   * The process is gone (or the manager closed the host), so no `result` is
   * coming and the run would otherwise stay open for its session forever. The
   * frame is terminal and says `aborted` rather than claiming an exit the turn
   * never had, and no report is made — the notification is about background work
   * that *completed*, and a turn that never finished is not that.
   */
  private abandonUnattendedTurn(state: ResidentHostState, exitCode: number): void {
    const unattended = state.unattended;
    if (!unattended) {
      return;
    }
    state.unattended = null;
    unattended.writer.send(
      createCompleteMessage({
        provider: 'claude',
        sessionId: state.providerSessionId || state.appSessionId,
        exitCode,
        aborted: true,
      }),
    );
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

  /**
   * Reads the queue facts off one stream message.
   *
   * Three readings, and each is kept for a different reason: the lifecycle
   * list is the CLI's own account of what became of a message this host wrote,
   * the `control_response` list is what came back to a control frame (measured:
   * nothing does for `cancel_async_message` — `§9.2` — so this list exists to
   * let the criterion say so from a reading rather than from an absence), and
   * the `session_state_changed` count is the boundary check that the stream
   * says nothing about turn starts or ends (`§9.1`).
   *
   * The lifecycle event's shape is accepted in both plausible encodings — a
   * top-level `command_lifecycle` type and a `system` subtype — because §9
   * records the event's name and payload but not which envelope carried it, and
   * a parser that picked one would silently read nothing on the other. The
   * fields it needs are the same either way: `command_uuid` and `state`.
   */
  private recordQueueFacts(state: ResidentHostState, message: AnyRecord): void {
    if (message?.type === 'system' && message.subtype === 'session_state_changed') {
      state.sessionStateChanged += 1;
    }

    if (message?.type === 'control_response') {
      const inner = message.response as AnyRecord | undefined;
      const requestId =
        typeof inner?.request_id === 'string'
          ? inner.request_id
          : typeof message.request_id === 'string'
            ? message.request_id
            : null;
      state.controlResponses.push({ at: Date.now(), requestId });
      return;
    }

    const isLifecycle =
      message?.type === 'command_lifecycle' ||
      (message?.type === 'system' && message.subtype === 'command_lifecycle');
    const commandUuid = typeof message?.command_uuid === 'string' ? message.command_uuid : null;
    const lifecycleState = typeof message?.state === 'string' ? message.state : null;
    if (!isLifecycle || !commandUuid || !lifecycleState) {
      return;
    }

    const at = Date.now();
    state.lifecycle.push({
      commandUuid,
      state: lifecycleState as CommandLifecycleState,
      at,
    });

    // The first `started` for a uuid is the dequeue moment — the point after
    // which a withdrawal can no longer succeed. A re-started uuid (there is no
    // such event today) does not move it.
    if (lifecycleState === 'started') {
      const input = state.queuedInputs.find(
        (candidate) => candidate.uuid === commandUuid && candidate.startedAt === null,
      );
      if (input) {
        input.startedAt = at;
      }
    }
  }

  /**
   * Waits for a specific lifecycle state to be read for a specific uuid.
   *
   * Polls the reading rather than being woken by the read loop: the stream is
   * consumed by one loop this class owns, and handing the queue a callback
   * registry so a withdrawal could be notified would make the wait a second
   * consumer of the same state. `true` only when the state was actually read;
   * the budget expiring is `false`, which the caller must interpret (and does,
   * from the reading — never from the expiry).
   */
  private async waitForLifecycle(
    state: ResidentHostState,
    commandUuid: string,
    wanted: CommandLifecycleState,
  ): Promise<boolean> {
    const deadline = Date.now() + CLAUDE_CANCEL_VERDICT_WAIT_MS;
    for (;;) {
      if (state.lifecycle.some((event) => event.commandUuid === commandUuid && event.state === wanted)) {
        return true;
      }
      if (state.closed || Date.now() >= deadline) {
        return false;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, CLAUDE_CANCEL_VERDICT_POLL_MS);
      });
    }
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
    this.abandonUnattendedTurn(state, 1);

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

    // Two launch facts the stream states and nothing else can answer for: which
    // tools this process was given, and what kind of background task it started.
    // The tool table is a launch decision, so "no tool here could have made that
    // trigger" is only readable next to it; the task type is the CLI's own word
    // for the work the hook ledger reports as a bare id. Both outlive the turn
    // that reported them, so they are recorded as they arrive.
    if (message?.type === 'system' && message.subtype === 'init' && Array.isArray(message.tools)) {
      state.initTools = message.tools.filter((tool: unknown): tool is string => typeof tool === 'string');
    }
    if (message?.type === 'system' && message.subtype === 'task_started' && typeof message.task_type === 'string') {
      state.backgroundTaskType = message.task_type;
    }
    this.recordQueueFacts(state, message);

    // A turn this host did not push announces itself here, and from this point
    // its frames are that run's. Read before the forwarding below so the
    // opener's own frames reach the run it opened instead of the last round's.
    this.openUnattendedTurnIfOwn(state, message, sessionId);

    // The unattended turn comes first while it is open, because the CLI runs
    // one turn at a time: a round armed during an unattended turn is queued
    // *behind* it, and the frames still arriving belong to the turn that is
    // actually running. Preferring the round would send the unattended turn's
    // own frames — its text, its tool calls, its `result` — into a run that has
    // not started, and leave the run the turn really belongs to empty. After
    // that, the round in flight owns its frames; a turn nothing owns belongs to
    // the run opened for it, and only then to the last writer this host saw.
    const frameWriter = state.unattended?.writer ?? round?.writer ?? state.writer;

    if (frameWriter && context) {
      forwardNormalizedFrames({
        transformedMessage: transformResidentMessage(message),
        sessionId,
        normalizeMessage: context.normalizeMessage,
        writer: frameWriter,
      });
    }

    const tokenBudget =
      extractTokenBudget(message, state.modelContextWindow) ||
      (state.assistantBudgetSent ? null : extractCumulativeTokenBudget(message, state.modelContextWindow));
    if (tokenBudget && frameWriter) {
      if (message.type === 'assistant') {
        state.assistantBudgetSent = true;
      }
      frameWriter.send(
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

    state.resultTimes.push(Date.now());
    // Every queued frame whose turn in flight has now ended gets its write-timing
    // reading closed out here, at the only moment both timestamps exist.
    for (const input of state.queuedInputs) {
      if (input.queuedBeforeResult === null && state.resultTimes.length > input.resultsSeenAtPush) {
        input.queuedBeforeResult = input.at < (state.resultTimes[input.resultsSeenAtPush] as number);
      }
    }

    // The unattended turn's own `result`, and it has to be read as such before
    // the round FIFO is consulted. The CLI runs one turn at a time, so a result
    // arriving while an unattended turn is open is *that* turn's ending — any
    // round armed since was pushed behind it and has not started yet. Shifting
    // the FIFO here would settle a round on a turn it never ran, and the round's
    // own `result` would then find an empty queue and be read as another ending
    // of the unattended turn.
    if (state.unattended) {
      this.finishUnattendedTurn(state, sessionId);
      return;
    }

    const finished = state.rounds.shift();
    if (!finished) {
      // A result nobody is waiting for: the process pushed a turn of its own —
      // the resident shape of the background-work follow-up. The mode already
      // holds the process open, so there is no lease to drop, and the frames
      // above have reached the client. What there is to do is end the run the
      // opener made for that turn, if this driver made one.
      this.finishUnattendedTurn(state, sessionId);
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
