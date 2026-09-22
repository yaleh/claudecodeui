import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { AnyRecord, NormalizedMessage, ProviderRuntimeWriter } from '@/shared/types.js';

import type { DebugAgentScenario, DebugAgentScenarioOp } from './debug-agent.scenario.js';
import {
  appendTranscriptRow,
  buildMessageRow,
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
  normalizeMessage: (raw: unknown, sessionId: string | null) => NormalizedMessage[];
  writer: ProviderRuntimeWriter;
}) => void;

export type DebugAgentRunInput = {
  scenario: DebugAgentScenario;
  /** The session id inside every row this run writes. */
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  writer: ProviderRuntimeWriter;
  /** The product's normalizer, supplied through the runtime context. */
  normalizeMessage: (raw: unknown, sessionId: string | null) => NormalizedMessage[];
  forwardFrames: DebugAgentFrameForwarder;
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
  const { scenario, sessionId, cwd, transcriptPath, writer, normalizeMessage, forwardFrames } = input;
  const before = readTranscriptShape(transcriptPath);
  const steps: DebugAgentStepObservation[] = [];
  const startedAt = Date.now();

  const forward = (row: AnyRecord): void => {
    forwardFrames({ transformedMessage: row, sessionId, normalizeMessage, writer });
  };

  for (const [index, step] of scenario.steps.entries()) {
    const due = startedAt + step.at;
    const remaining = due - Date.now();
    if (remaining > 0) {
      await delay(remaining);
    }

    switch (step.op) {
      case 'row': {
        // The new row chains onto whatever is on disk right now, so the
        // transcript keeps the parent/uuid links the dialect's readers expect.
        const parent = readTranscriptShape(transcriptPath).lastRow;
        const row = buildMessageRow({
          sessionId,
          cwd,
          role: step.role,
          text: step.text,
          uuid: crypto.randomUUID(),
          parentUuid: typeof parent?.uuid === 'string' ? parent.uuid : null,
          timestamp: new Date().toISOString(),
        });

        appendTranscriptRow(transcriptPath, row);
        forward(row);
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

      default:
        break;
    }

    steps.push({ index, op: step.op, ...readTranscriptShape(transcriptPath) });
  }

  return { before, steps };
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
  normalizeMessage: (raw: unknown, sessionId: string | null) => NormalizedMessage[];
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
