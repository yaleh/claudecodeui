import type { AnyRecord } from '@/shared/types.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

/**
 * The scenario document a debug-agent run replays, and the validation that
 * refuses to load one this build cannot execute.
 *
 * ADR-003 decision 7 draws the line this file sits on: a scenario describes what
 * is WRITTEN TO A TRANSCRIPT and when — never a frame, an event, or any other
 * wire name. The frames a client sees are whatever the shared normalizer makes
 * of the rows this document produces, which is why the `op` closed set below is
 * a set of transcript operations rather than a list of frame kinds.
 *
 * Every closed set is a value this build knows how to execute. An unrecognised
 * value is refused with the value and the set printed, never guessed at: a
 * scenario that quietly ran as something else would produce a reading nobody can
 * attribute to a cause.
 */

/** The document version this build loads. A different one is refused, not migrated. */
export const DEBUG_AGENT_SCENARIO_VERSION = 1;

/**
 * Transcript dialects this build can write. One member today, and it is a closed
 * set rather than an implicit default so that a document asking for a dialect
 * that does not exist fails loudly instead of silently writing claude rows.
 */
export const DEBUG_AGENT_DIALECTS = ['claude'] as const;
export type DebugAgentDialect = (typeof DEBUG_AGENT_DIALECTS)[number];

/**
 * Which root a scenario's transcript is written under. `gate` means the root the
 * gate module resolves from `DEBUG_AGENT_HOME` — the fixture home — and it is a
 * closed set of one because "write to the real `~/.claude`" must not be
 * expressible as a scenario value at all.
 */
export const DEBUG_AGENT_HOMES = ['gate'] as const;
export type DebugAgentHome = (typeof DEBUG_AGENT_HOMES)[number];

/**
 * How a step's rows reach the transcript. `per-row-jsonl` appends one JSON object
 * per line, which is the only shape the indexer and the normalizer read.
 */
export const DEBUG_AGENT_TRANSCRIPT_MODES = ['per-row-jsonl'] as const;
export type DebugAgentTranscriptMode = (typeof DEBUG_AGENT_TRANSCRIPT_MODES)[number];

/**
 * What a step does to the transcript.
 *
 * `row` appends a new row (its own uuid). `grow` rewrites the last row in place
 * and keeps its uuid, which is what makes it the same message with different
 * content rather than a second message. `wait` and `scroll` change nothing on
 * disk: they exist so a scenario can express the passage of time and a
 * follow-along intent without inventing a frame to carry them.
 */
export const DEBUG_AGENT_OPS = ['grow', 'row', 'scroll', 'wait'] as const;
export type DebugAgentScenarioOp = (typeof DEBUG_AGENT_OPS)[number];

/** The conversation roles a transcript row can carry in the claude dialect. */
export const DEBUG_AGENT_ROLES = ['assistant', 'user'] as const;
export type DebugAgentRole = (typeof DEBUG_AGENT_ROLES)[number];

/**
 * One step on the scenario clock. `at` is an absolute offset in milliseconds
 * from the start of the run, and the sequence must be non-descending — a clock
 * that can go backwards cannot order two observations of the same file.
 */
export type DebugAgentScenarioStep = { at: number } & (
  | { op: 'grow'; text: string }
  | { op: 'row'; role: DebugAgentRole; text: string }
  | { op: 'scroll' }
  | { op: 'wait' }
);

/**
 * What the run must have produced, stated as an expectation the caller can
 * falsify against the artifact. It is deliberately about the artifact (rows,
 * bytes, content) and not about frames: a document that asserted its own frames
 * would be checking the engine's self-report.
 */
export type DebugAgentScenarioExpectations = {
  /** Rows the run itself appends; the seeded rows are not counted here. */
  rows: { delta: number };
  /** Substrings the transcript must contain once the run is over. */
  content: { mustContain: string[] };
};

/** The rows a session starts with, so it is listable before anything drives it. */
export type DebugAgentScenarioSeed = {
  title: string;
  userText: string;
};

/** A loaded, validated scenario. Only {@link loadScenario} produces one. */
export type DebugAgentScenario = {
  version: typeof DEBUG_AGENT_SCENARIO_VERSION;
  dialect: DebugAgentDialect;
  home: DebugAgentHome;
  transcript: { mode: DebugAgentTranscriptMode };
  seed: DebugAgentScenarioSeed;
  steps: DebugAgentScenarioStep[];
  expect: DebugAgentScenarioExpectations;
};

/**
 * Raised for every refusal below, so a caller (the control plane, the arming
 * step) can tell "this document is not one I can run" apart from "the run
 * itself failed" without reading the message.
 */
function refuse(reason: string): never {
  throw new AppError(`Debug agent scenario refused: ${reason}`, {
    code: 'DEBUG_AGENT_SCENARIO_INVALID',
    statusCode: 400,
  });
}

function readClosedValue<T extends string>(
  value: unknown,
  closedSet: readonly T[],
  where: string,
): T {
  if (typeof value === 'string' && (closedSet as readonly string[]).includes(value)) {
    return value as T;
  }

  return refuse(
    `${where} is ${JSON.stringify(value)}; this build knows: ${closedSet.join(', ')}`,
  );
}

function readText(value: unknown, where: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return refuse(`${where} must be a non-empty string`);
}

function readStep(input: unknown, index: number): DebugAgentScenarioStep {
  const where = `steps[${index}]`;
  const step = readObjectRecord(input);
  if (!step) {
    return refuse(`${where} must be an object`);
  }

  const at = step.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    return refuse(`${where}.at must be a non-negative number of milliseconds`);
  }

  const op = readClosedValue(step.op, DEBUG_AGENT_OPS, `${where}.op`);
  switch (op) {
    case 'row':
      return {
        at,
        op,
        role: readClosedValue(step.role, DEBUG_AGENT_ROLES, `${where}.role`),
        text: readText(step.text, `${where}.text`),
      };
    case 'grow':
      return { at, op, text: readText(step.text, `${where}.text`) };
    default:
      // `scroll` and `wait` carry nothing: they are the two steps whose whole
      // content IS their position on the clock.
      return { at, op } as DebugAgentScenarioStep;
  }
}

function readSeed(input: unknown): DebugAgentScenarioSeed {
  const seed = readObjectRecord(input);
  if (!seed) {
    return refuse('seed must be an object');
  }

  return {
    title: readText(seed.title, 'seed.title'),
    userText: readText(seed.userText, 'seed.userText'),
  };
}

function readExpectations(input: unknown): DebugAgentScenarioExpectations {
  const expect = readObjectRecord(input);
  if (!expect) {
    return refuse('expect must be an object');
  }

  const rows = readObjectRecord(expect.rows);
  const delta = rows?.delta;
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta < 0) {
    return refuse('expect.rows.delta must be a non-negative integer');
  }

  const content = readObjectRecord(expect.content);
  const mustContain = content?.mustContain;
  if (!Array.isArray(mustContain) || mustContain.some((entry) => typeof entry !== 'string')) {
    return refuse('expect.content.mustContain must be an array of strings');
  }

  return { rows: { delta }, content: { mustContain: mustContain as string[] } };
}

/**
 * Validates one scenario document, or refuses it with a reason naming the value
 * it did not recognise and the set it was expected to come from.
 *
 * Validation is complete before any caller touches the filesystem: an arming
 * step that wrote a fixture transcript first and then discovered the document
 * was unreadable would leave half a scenario behind for the next run to find.
 */
export function loadScenario(input: unknown): DebugAgentScenario {
  const document: AnyRecord | null = readObjectRecord(input);
  if (!document) {
    return refuse('expected a scenario object');
  }

  if (document.version !== DEBUG_AGENT_SCENARIO_VERSION) {
    return refuse(
      `version is ${JSON.stringify(document.version)}; this build loads version ${DEBUG_AGENT_SCENARIO_VERSION}`,
    );
  }

  const transcript = readObjectRecord(document.transcript);
  if (!transcript) {
    return refuse('transcript must be an object');
  }

  if (!Array.isArray(document.steps) || document.steps.length === 0) {
    return refuse('steps must be a non-empty array');
  }

  const steps = document.steps.map(readStep);
  let previousAt = -Infinity;
  for (const [index, step] of steps.entries()) {
    if (step.at < previousAt) {
      return refuse(
        `steps[${index}].at is ${step.at}, after ${previousAt}: the scenario clock must not go backwards`,
      );
    }

    previousAt = step.at;
  }

  return {
    version: DEBUG_AGENT_SCENARIO_VERSION,
    dialect: readClosedValue(document.dialect, DEBUG_AGENT_DIALECTS, 'dialect'),
    home: readClosedValue(document.home, DEBUG_AGENT_HOMES, 'home'),
    transcript: {
      mode: readClosedValue(transcript.mode, DEBUG_AGENT_TRANSCRIPT_MODES, 'transcript.mode'),
    },
    seed: readSeed(document.seed),
    steps,
    expect: readExpectations(document.expect),
  };
}
