import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  CommandLifecycleState,
  MessageOrigin,
  NormalizedMessage,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  DEBUG_AGENT_HOST_OPS,
  isDebugAgentHostOp,
  type DebugAgentExitDetail,
  type DebugAgentKeepaliveKind,
  type DebugAgentScenario,
  type DebugAgentScenarioOp,
} from './debug-agent.scenario.js';
import {
  appendTranscriptRow,
  buildCommandLifecycleRow,
  buildMessageRow,
  buildTaskNotificationRow,
  buildTaskProgressRow,
  buildTaskStartedRow,
  buildTaskUpdatedRow,
  buildTextDeltaRow,
  buildThinkingTokensRow,
  buildToolResultRow,
  buildToolUseRow,
  buildTurnResultRow,
  growRowText,
  readTranscriptLines,
  readTranscriptShape,
  rewriteLastTranscriptRow,
  type DebugAgentTranscriptShape,
} from './debug-agent.runtime.js';

/**
 * The debug agent's output engine: it walks a scenario's steps on the scenario's
 * own clock, writes each step's row to the transcript before forwarding the frame
 * that row normalizes to, and evaluates the scenario's expectations by reading
 * the artifact back.
 *
 * "Row first, frame second" is the load-bearing order (ADR-003 decision 4). A
 * terminal `complete` makes every client re-fetch the session's history over
 * REST, so an engine that forwarded without writing would show a client a
 * live conversation whose history is empty — the same live-vs-history divergence
 * this mechanism exists to reproduce, manufactured by the tool that is supposed
 * to reproduce it.
 *
 * The engine never claims what it produced. Everything the expectations are
 * checked against is read from the file, and the forwarder is handed the very row
 * that was just written, so a run cannot report a transcript it did not write.
 */

/**
 * The product's normalization entry (`IProviderSessions['normalizeMessage']`), as
 * the debug agent's seams take it: the row → frame edge, and the only one this
 * module is allowed to have (ADR-003 decision 7).
 *
 * Spelled from the shared contract instead of written out at each seam. The
 * coupling decision 7 permits is exactly "a dialect row goes in, the product's
 * own frames come out", so the seam's signature IS the product's own: if the
 * entry's signature changes, these seams stop compiling rather than drift away
 * from the normalizer they hand rows to.
 */
type DebugAgentNormalizeMessage = IProviderSessions['normalizeMessage'];

/**
 * The normalizer → writer seam, as the product's own forwarder takes it.
 *
 * Typed here rather than imported so this module depends on no other module's
 * internals: the registry hands it the real `forwardNormalizedFrames` when it
 * builds the provider.
 */
export type DebugAgentFrameForwarder = (input: {
  /**
   * The row that was just written, not a frame. `object` rather than `unknown`
   * because that is the whole point of the seam: the forwarded value is a
   * dialect row and the frame is whatever the normalizer makes of it — a
   * forwarder that accepted anything could be handed a pre-built frame, which
   * is the shape decision 7 forbids.
   */
  transformedMessage: object;
  sessionId: string | null;
  normalizeMessage: DebugAgentNormalizeMessage;
  writer: ProviderRuntimeWriter;
}) => void;

/**
 * The host layer, as the engine's host steps take it.
 *
 * Declared here rather than imported from the driver so the engine depends on
 * no other module's internals — the same rule the forwarder above follows, and
 * the reason a run can be driven by a host layer this module has never heard
 * of. The driver is structurally one of these; nothing is registered or
 * injected twice to make it so.
 *
 * Every verb is session-addressed because that is the layer's own addressing: a
 * step names the session, and which process serves it is the host layer's
 * business, not the scenario's.
 */
export type DebugAgentHostOps = {
  /**
   * Opens a turn for a session with no client behind it.
   *
   * `runId` is what the turn's `turn` lease is held under, minted here because
   * the run id is the engine's to name: the step is what decided a turn exists,
   * and a host layer that invented an id would be reporting a turn under a name
   * nothing else in the run used.
   */
  openUnattendedTurn(input: {
    appSessionId: string;
    text: string;
    runId: string;
  }): Promise<ProviderRuntimeWriter>;
  /** Reports that the turn opened above has ended. Distinct from stopping it. */
  endUnattendedTurn(input: { appSessionId: string }): Promise<void>;
  addKeepalive(input: { appSessionId: string; kind: DebugAgentKeepaliveKind }): Promise<void>;
  removeKeepalive(input: { appSessionId: string; kind: DebugAgentKeepaliveKind }): Promise<void>;
  /**
   * Takes the oldest command the process is holding that has not been started or
   * withdrawn, and reports its uuid; null when the queue is empty.
   *
   * Reads AND removes: the command it names is the one the process just started,
   * and a reader that left it in place would hand the next `dequeue` the same
   * command twice. The uuid is the host's, which is why the engine asks for it
   * here rather than reading it off the step — a scenario cannot name a value it
   * never minted.
   */
  readOldestQueuedCommand(input: { appSessionId: string }): string | null;
  /**
   * Acts on the withdrawal most recently asked for: drops that command from the
   * queue and reports its uuid, or null when nothing is waiting to be cancelled.
   *
   * Splitting "the withdrawal arrived" from "the process acted on it" is the
   * point of the step: only the second one produces the `cancelled` fact, and a
   * caller that could not place the two apart could not tell a UI that waited
   * for the process from one that flipped the moment the button was clicked.
   */
  acknowledgeCancel(input: { appSessionId: string }): string | null;
  /** Reports the address the process answers to, for the popover's copy leg. */
  reportIdentity(input: { appSessionId: string; name: string }): Promise<void>;
  reportExit(input: { appSessionId: string; detail: DebugAgentExitDetail }): Promise<void>;
};

export type DebugAgentRunInput = {
  scenario: DebugAgentScenario;
  /** The session id inside every row this run writes. */
  sessionId: string;
  /**
   * The application session id — what the host layer, the run registry and the
   * client all address the session by. Distinct from `sessionId`, which is the
   * provider-native id the rows carry; a run whose host steps went to the wrong
   * one would report against a session nobody is watching.
   */
  appSessionId: string;
  cwd: string;
  transcriptPath: string;
  writer: ProviderRuntimeWriter;
  /** The product's normalizer, supplied through the runtime context. */
  normalizeMessage: DebugAgentNormalizeMessage;
  forwardFrames: DebugAgentFrameForwarder;
  /**
   * The host layer, for the steps that go through it. Optional because a
   * scenario of transcript operations alone needs none; a scenario that carries
   * a host step without one is refused before it runs.
   */
  hostOps?: DebugAgentHostOps;
  /**
   * Called when the writer this run's frames go to changes.
   *
   * A callback rather than a field on the reading, and it is the one thing a
   * caller cannot learn any other way: an unattended turn delivers its frames
   * to the run the host layer opened instead of to the caller, and the terminal
   * frame has to end *that* run. A caller that went on ending the run it passed
   * in would leave the real one open for good, while every client that replayed
   * it saw a turn that never finished.
   */
  onDelivery?: (writer: ProviderRuntimeWriter) => void;
};

/**
 * What the artifact looked like right after one step, read back from disk.
 *
 * This is a measurement, not the step's own report: `row` and `grow` differ in
 * exactly the two numbers recorded here (rows and bytes), so a step that wrote
 * nothing, or one that wrote a second row where it should have grown the last,
 * is visible without trusting anything the engine says about itself.
 */
export type DebugAgentStepObservation = {
  index: number;
  op: DebugAgentScenarioOp;
  rows: number;
  lastRowBytes: number;
  lastRow: DebugAgentTranscriptShape['lastRow'];
};

export type DebugAgentRunReading = {
  /** The transcript's shape before the first step, read from the file. */
  before: DebugAgentTranscriptShape;
  steps: DebugAgentStepObservation[];
};

/**
 * Runs one armed scenario.
 *
 * The clock is absolute: `steps[].at` is milliseconds from the start of the run,
 * so a step's time does not depend on how long the previous step took. `wait` and
 * `scroll` write nothing and forward nothing — a scenario uses them to place
 * time and follow-along intent on the clock, and neither has a transcript shape
 * or a frame of its own.
 */
export async function runDebugAgentScenario(input: DebugAgentRunInput): Promise<DebugAgentRunReading> {
  const { scenario, sessionId, appSessionId, cwd, transcriptPath, normalizeMessage, forwardFrames } = input;
  const hostOps = input.hostOps;

  // Refused before anything is written. A host step with no host layer is a
  // document this build cannot execute, and discovering that halfway through
  // would leave a transcript that is neither the old one nor the new one.
  const hostSteps = scenario.steps
    .map((step, index) => ({ op: step.op, index }))
    .filter((step) => isDebugAgentHostOp(step.op));
  if (hostSteps.length > 0 && !hostOps) {
    throw new AppError(
      `Scenario step(s) ${hostSteps
        .map((step) => `steps[${step.index}].${step.op}`)
        .join(', ')} need a host layer, and this run was given none. This build knows the host steps: ${DEBUG_AGENT_HOST_OPS.join(', ')}.`,
      { code: 'DEBUG_AGENT_HOST_OPS_UNAVAILABLE', statusCode: 400 },
    );
  }

  const before = readTranscriptShape(transcriptPath);
  const steps: DebugAgentStepObservation[] = [];
  const startedAt = Date.now();

  // Which writer this run's frames go to. It starts as the caller's own and is
  // replaced by the run's writer when an unattended turn opens one: the turn
  // exists before its frames do, and frames delivered to the caller's writer
  // instead would reach the socket but never the run a late subscriber replays.
  let delivery = input.writer;
  const forward = (row: AnyRecord): void => {
    forwardFrames({ transformedMessage: row, sessionId, normalizeMessage, writer: delivery });
  };

  const appendRow = (role: string, text: string, origin?: MessageOrigin): void => {
    // The new row chains onto whatever is on disk right now, so the transcript
    // keeps the parent/uuid links the dialect's readers expect.
    const parent = readTranscriptShape(transcriptPath).lastRow;
    const row = buildMessageRow({
      sessionId,
      cwd,
      role,
      text,
      uuid: crypto.randomUUID(),
      parentUuid: typeof parent?.uuid === 'string' ? parent.uuid : null,
      timestamp: new Date().toISOString(),
      // Carried onto the row, never onto a frame: what the trigger and the
      // sender mean on the wire is the normalizer's reading of this field (see
      // `debug-agent.runtime.ts`). An engine that built a frame itself would be
      // the second implementation ADR-003 decision 7 forbids.
      ...(origin ? { origin } : {}),
    });

    appendTranscriptRow(transcriptPath, row);
    forward(row);
  };

  /**
   * Writes one command's queue state and forwards the frame it normalizes to.
   *
   * The same row-then-frame order `appendRow` keeps, and for the same reason: a
   * client told "this command started" before the transcript said so would be
   * reading a live conversation whose history disagrees with it.
   *
   * This is the engine's ONLY way to state a queue fact, and it exists as its own
   * helper rather than as a branch of `appendRow` because the two write different
   * rows: a message row is a turn, and a lifecycle row is a statement about one
   * that has not run. `buildCommandLifecycleRow` decides the latter's shape, so
   * the dialect's field names stay in the runtime module (ADR-003 decision 4).
   */
  /**
   * Writes one dialect row and forwards the frame it normalizes to, chaining it
   * onto the row currently on disk.
   *
   * The same row-then-frame order `appendRow` keeps. It exists so the turn-phase
   * steps below state their row shapes through the runtime builders — where the
   * dialect's field names live — rather than growing `appendRow`'s text-only
   * shape into something it was never meant to be.
   */
  const appendDialectRow = (build: (parentUuid: string | null) => AnyRecord): void => {
    const parent = readTranscriptShape(transcriptPath).lastRow;
    const row = build(typeof parent?.uuid === 'string' ? parent.uuid : null);
    appendTranscriptRow(transcriptPath, row);
    forward(row);
  };

  /**
   * The `tool_use` id of the call still awaiting its result, or null.
   *
   * A tool result pairs with the call it answers by id, so the id is minted here
   * — where the call is written — rather than named by the scenario: a document
   * that restated it would be a second place the two could disagree, and the
   * id is the engine's to mint exactly as a command's uuid is the host's.
   */
  let pendingToolUseId: string | null = null;

  /**
   * The `tool_use` id of the most recent tool call, kept until the next call.
   *
   * Distinct from {@link pendingToolUseId}, which the paired result consumes: a
   * `task-started` step joins its task to the card that launched it by that id,
   * and the card is drawn from a call whose result may never arrive (a
   * backgrounded task has no result until it finishes). Cleared only by the next
   * call, so a task step names the call that is still on screen.
   */
  let lastToolUseId: string | null = null;

  const appendCommandLifecycle = (commandUuid: string, state: CommandLifecycleState): void => {
    const row = buildCommandLifecycleRow({
      sessionId,
      cwd,
      commandUuid,
      state,
      timestamp: new Date().toISOString(),
    });

    appendTranscriptRow(transcriptPath, row);
    forward(row);
  };

  for (const [index, step] of scenario.steps.entries()) {
    const due = startedAt + step.at;
    const remaining = due - Date.now();
    if (remaining > 0) {
      await delay(remaining);
    }

    switch (step.op) {
      case 'row': {
        appendRow(step.role, step.text);
        break;
      }

      case 'unattended-turn': {
        // The run is opened by the host layer, not here: the engine's job is to
        // write the turn's row and hand it to whatever writer the host layer
        // answered with. An engine that opened its own run would be reporting a
        // turn the host layer never saw, which is the difference this step
        // exists to make measurable.
        //
        // The lease is named before the row is written, so a reader that polls
        // between the two writes sees a turn whose content is still landing
        // rather than a session that has not started one.
        const runId = crypto.randomUUID();
        // A turn that states no cause writes a row with no `origin` at all,
        // rather than one whose cause is null: absent and "stated as nothing"
        // are the same reading to every consumer, and the omission keeps the row
        // byte-identical to the one this step wrote before it could carry a
        // cause.
        const origin: MessageOrigin | undefined = step.trigger
          ? {
              trigger: step.trigger,
              // The sender is the step's own statement about who sent this, and
              // it is only meaningful for the one trigger that has another
              // conversation behind it — the loader refuses a sender on any
              // other, so this is a narrowing rather than a rule applied twice.
              sender: step.trigger === 'cross-session' ? (step.sender ?? null) : null,
            }
          : undefined;
        delivery = await requireHostOps(hostOps).openUnattendedTurn({
          appSessionId,
          text: step.text,
          runId,
        });
        input.onDelivery?.(delivery);
        appendRow('user', step.text, origin);
        break;
      }

      case 'dequeue': {
        // The process took the command it had been holding and started it. What
        // it writes is the queue's account of that and nothing else: the
        // substitute never runs a pushed command's turn, so writing the turn's
        // own row would be claiming output that does not exist.
        const dequeued = requireHostOps(hostOps).readOldestQueuedCommand({ appSessionId });
        if (dequeued) {
          appendCommandLifecycle(dequeued, 'started');
        }
        break;
      }

      case 'cancel-ack': {
        // The process acted on the withdrawal. A no-op when nothing is waiting:
        // the step is on the clock whether or not a client ever asked, and a
        // scenario whose document is the same for a withdrawn and a
        // never-clicked run must not fail halfway through for the second one.
        const cancelled = requireHostOps(hostOps).acknowledgeCancel({ appSessionId });
        if (cancelled) {
          appendCommandLifecycle(cancelled, 'cancelled');
        }
        break;
      }

      case 'turn-end': {
        // Writes nothing. The step exists to place "the turn that was running
        // has finished" on the clock, which is the 空闲 state, and the host
        // layer is the only place that fact is true.
        await requireHostOps(hostOps).endUnattendedTurn({ appSessionId });
        break;
      }

      case 'identity': {
        await requireHostOps(hostOps).reportIdentity({ appSessionId, name: step.name });
        break;
      }

      case 'keepalive-add': {
        await requireHostOps(hostOps).addKeepalive({ appSessionId, kind: step.kind });
        break;
      }

      case 'keepalive-remove': {
        await requireHostOps(hostOps).removeKeepalive({ appSessionId, kind: step.kind });
        break;
      }

      case 'exit': {
        await requireHostOps(hostOps).reportExit({ appSessionId, detail: step.detail });
        break;
      }

      case 'grow': {
        // In place: the row keeps its uuid, so it normalizes to the SAME message
        // id with different content. A step that appended here instead would
        // still show the text to a client while breaking every reader that
        // addresses the message by that id.
        const grown = rewriteLastTranscriptRow(transcriptPath, (row) => growRowText(row, step.text));
        forward(grown);
        break;
      }

      case 'thinking-tokens': {
        // The turn has started reasoning. The row carries no message content —
        // it is the estimate signal itself, and the forwarder reduces it to the
        // turn's `thinking` phase.
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildThinkingTokensRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid,
        }));
        break;
      }

      case 'tool-call': {
        // A pending tool call. The id is minted here and remembered so the
        // `tool-result` step below answers *this* call and no other.
        const toolUseId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildToolUseRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid, toolUseId, name: step.name,
          toolInput: step.input,
        }));
        pendingToolUseId = toolUseId;
        lastToolUseId = toolUseId;
        break;
      }

      case 'task-started': {
        // The task whose card this join is for is whichever call is still on
        // screen (`lastToolUseId`), never a value the document names: the id is
        // the engine's to mint, and a scenario that restated it would be a
        // second place the two could disagree.
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildTaskStartedRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid,
          taskId: step.taskId, taskType: step.taskType, description: step.description,
          toolUseId: lastToolUseId, startedAt: Date.now(),
        }));
        break;
      }

      case 'task-progress': {
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildTaskProgressRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid,
          taskId: step.taskId, description: step.description,
        }));
        break;
      }

      case 'task-updated': {
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildTaskUpdatedRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid,
          taskId: step.taskId, status: step.status, endedAt: Date.now(),
        }));
        break;
      }

      case 'task-notification': {
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildTaskNotificationRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid,
          taskId: step.taskId, status: step.status, summary: step.summary, endedAt: Date.now(),
        }));
        break;
      }

      case 'schedule-plan': {
        // A plan is not a task: it has no lifecycle events of its own. The
        // reducer reads it from a `CronCreate` call and its paired result, so
        // the step writes both rows — the call (carrying the expression and the
        // prompt on its input) and the result (whose text names the job id and
        // the CLI's human description). The id is minted here; the result text
        // states the job id the next Stop hook would name, which is what makes
        // the provisional row and the authoritative one the same key.
        const toolUseId = crypto.randomUUID();
        const jobId = `cron-${toolUseId.slice(0, 8)}`;
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildToolUseRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid, toolUseId,
          name: 'CronCreate',
          toolInput: { cron: step.expression, prompt: step.prompt, recurring: true },
        }));
        appendDialectRow((parentUuid) => buildToolResultRow({
          sessionId, cwd, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), parentUuid,
          toolUseId,
          text: `Scheduled recurring job ${jobId} (${step.human}). Auto-expires after 7 days.`,
        }));
        break;
      }

      case 'tool-result': {
        // The answer to the pending call. A no-op when nothing is pending: the
        // step is on the clock whether or not a call preceded it, and a result
        // with no call to pair with would be a row the reducer correctly ignores.
        if (pendingToolUseId !== null) {
          const toolUseId = pendingToolUseId;
          const timestamp = new Date().toISOString();
          appendDialectRow((parentUuid) => buildToolResultRow({
            sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid, toolUseId, text: step.text,
          }));
          pendingToolUseId = null;
        }
        break;
      }

      case 'text-delta': {
        // A fragment of the message the turn is writing out.
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildTextDeltaRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid, text: step.text,
        }));
        break;
      }

      case 'turn-result': {
        // The turn's own terminal record: the signal that returns the session to
        // `idle`. It writes no message content and carries nothing.
        const timestamp = new Date().toISOString();
        appendDialectRow((parentUuid) => buildTurnResultRow({
          sessionId, cwd, timestamp, uuid: crypto.randomUUID(), parentUuid,
        }));
        break;
      }

      default:
        break;
    }

    steps.push({ index, op: step.op, ...readTranscriptShape(transcriptPath) });
  }

  return { before, steps };
}

/**
 * The host layer, narrowed to non-null for a step that needs it.
 *
 * Only reachable after the up-front refusal above has established that a step
 * carrying a host op implies a host layer, so this cannot throw in practice —
 * and it exists so the steps read as the calls they are instead of as a chain
 * of optional checks whose failure mode would be a silent no-op.
 */
function requireHostOps(hostOps: DebugAgentHostOps | undefined): DebugAgentHostOps {
  if (!hostOps) {
    throw new AppError('A host step ran with no host layer.', {
      code: 'DEBUG_AGENT_HOST_OPS_UNAVAILABLE',
      statusCode: 400,
    });
  }

  return hostOps;
}

/** One in-place growth, read as: did the row count hold, and what changed? */
export type DebugAgentGrowReading = {
  stepIndex: number;
  rowsBefore: number;
  rowsAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  /** The normalized message id before the rewrite, or null when the row produced none. */
  idBefore: string | null;
  idAfter: string | null;
  contentChanged: boolean;
};

export type DebugAgentScenarioEvaluation = {
  rows: number;
  rowsDelta: number;
  lastRowBytes: number;
  missingContent: string[];
  grows: DebugAgentGrowReading[];
  /** True when at least one grow ran and every one of them grew in place. */
  lastRowGrew: boolean;
  /** Every expectation this run did not meet, each naming what it measured. */
  failures: string[];
};

function firstMessageId(messages: NormalizedMessage[]): string | null {
  const id = messages[0]?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function normalizedContent(messages: NormalizedMessage[]): string {
  return messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('');
}

/**
 * Checks a scenario's expectations against the artifact, as it stands after a run.
 *
 * Nothing here reads the run's own report: the row count, the last row's bytes
 * and the file's text all come off disk, and the two message ids a growth is
 * judged by come from normalizing the rows that were read back. That is what lets
 * this evaluator disagree with the engine — an evaluator that consumed the
 * engine's claims could only ever confirm them.
 */
export function evaluateScenarioExpectations(input: {
  scenario: DebugAgentScenario;
  transcriptPath: string;
  reading: DebugAgentRunReading;
  sessionId: string | null;
  normalizeMessage: DebugAgentNormalizeMessage;
}): DebugAgentScenarioEvaluation {
  const { scenario, transcriptPath, reading, sessionId, normalizeMessage } = input;
  const shape = readTranscriptShape(transcriptPath);
  const text = readTranscriptLines(transcriptPath).join('\n');
  const failures: string[] = [];

  const rowsDelta = shape.rows - reading.before.rows;
  if (rowsDelta !== scenario.expect.rows.delta) {
    failures.push(
      `rows: the run wrote ${rowsDelta} row(s) (${reading.before.rows} -> ${shape.rows}); the scenario expects ${scenario.expect.rows.delta}`,
    );
  }

  const missingContent = scenario.expect.content.mustContain.filter((entry) => !text.includes(entry));
  for (const entry of missingContent) {
    failures.push(`content: the transcript does not contain ${JSON.stringify(entry)}`);
  }

  const stateBefore = (index: number): DebugAgentTranscriptShape =>
    reading.steps[index - 1] ?? reading.before;

  const grows: DebugAgentGrowReading[] = [];
  for (const step of reading.steps) {
    if (step.op !== 'grow') {
      continue;
    }

    const previous = stateBefore(step.index);
    const messagesBefore = previous.lastRow ? normalizeMessage(previous.lastRow, sessionId) : [];
    const messagesAfter = step.lastRow ? normalizeMessage(step.lastRow, sessionId) : [];
    const grow: DebugAgentGrowReading = {
      stepIndex: step.index,
      rowsBefore: previous.rows,
      rowsAfter: step.rows,
      bytesBefore: previous.lastRowBytes,
      bytesAfter: step.lastRowBytes,
      idBefore: firstMessageId(messagesBefore),
      idAfter: firstMessageId(messagesAfter),
      contentChanged: normalizedContent(messagesBefore) !== normalizedContent(messagesAfter),
    };
    grows.push(grow);

    if (grow.rowsAfter !== grow.rowsBefore) {
      failures.push(
        `grow at steps[${grow.stepIndex}]: the row count changed ${grow.rowsBefore} -> ${grow.rowsAfter}; a grow must not add or remove a row`,
      );
    }

    if (grow.bytesAfter <= grow.bytesBefore) {
      failures.push(
        `grow at steps[${grow.stepIndex}]: the last row is ${grow.bytesAfter} bytes, down from ${grow.bytesBefore}; a grow must grow it`,
      );
    }

    if (grow.idBefore === null || grow.idAfter === null) {
      failures.push(
        `grow at steps[${grow.stepIndex}]: a row produced no normalized message to compare ids with (before=${JSON.stringify(grow.idBefore)}, after=${JSON.stringify(grow.idAfter)})`,
      );
    } else if (grow.idBefore !== grow.idAfter) {
      failures.push(
        `grow at steps[${grow.stepIndex}]: the normalized message id changed ${JSON.stringify(grow.idBefore)} -> ${JSON.stringify(grow.idAfter)}; a grow rewrites one message, it does not replace it`,
      );
    } else if (!grow.contentChanged) {
      failures.push(
        `grow at steps[${grow.stepIndex}]: the message ${JSON.stringify(grow.idAfter)} normalized to identical content`,
      );
    }
  }

  return {
    rows: shape.rows,
    rowsDelta,
    lastRowBytes: shape.lastRowBytes,
    missingContent,
    grows,
    lastRowGrew:
      grows.length > 0 &&
      grows.every(
        (grow) =>
          grow.rowsAfter === grow.rowsBefore &&
          grow.bytesAfter > grow.bytesBefore &&
          grow.idBefore !== null &&
          grow.idBefore === grow.idAfter &&
          grow.contentChanged,
      ),
    failures,
  };
}
