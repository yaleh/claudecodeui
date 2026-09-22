import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

import { getDebugAgentProjectsRoot } from './debug-agent.gate.js';
import { loadScenario, type DebugAgentScenario } from './debug-agent.scenario.js';

/**
 * The debug agent's transcript face: the claude dialect's row shapes, the file
 * operations the engine drives them with, and the armed-scenario store a run
 * looks its script up in.
 *
 * This is the ONE place that knows the dialect's field names, which is the whole
 * point of the split ADR-003 decision 4 asks for: the engine decides WHEN a row
 * is written, this module decides WHAT a row looks like, and the normalizer —
 * the product's own, reused rather than reimplemented — decides what a frame
 * made from that row contains.
 *
 * Nothing here names a frame kind or an event: the rows below are written and
 * read, and the wire shapes are whatever `sessions.normalizeMessage` makes of
 * them.
 */

/** The row shape written for one conversation turn in the claude dialect. */
type DebugAgentMessageRowInput = {
  sessionId: string;
  cwd: string;
  role: string;
  text: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
};

/**
 * Builds one conversation row: a JSON object carrying the session id and cwd the
 * indexer reads, and the uuid that decides the normalized message's id.
 *
 * The role is written twice — as the row's `type` and inside `message` — because
 * that is the dialect's own redundancy, not this module's choice.
 */
export function buildMessageRow(input: DebugAgentMessageRowInput): AnyRecord {
  return {
    type: input.role,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    message: {
      role: input.role,
      content: [{ type: 'text', text: input.text }],
    },
  };
}

/**
 * Builds the row that names a session, so the session is listable by name before
 * anything drives it. It carries `sessionId`/`cwd` like any other row, which is
 * what keeps a fixture transcript readable by the same code as a real one.
 */
export function buildTitleRow(input: { sessionId: string; cwd: string; title: string; timestamp: string }): AnyRecord {
  return {
    type: 'custom-title',
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    customTitle: input.title,
  };
}

/**
 * Rewrites one row's text in place, keeping every other field — the uuid above
 * all, which is what makes the rewrite the same message with different content
 * instead of a second message.
 *
 * Refuses a row that has no text part to grow rather than inventing one: a
 * silently-created part would turn "grow" into "row" and leave a scenario
 * asserting in-place growth against a row that was never grown.
 */
export function growRowText(row: AnyRecord, text: string): AnyRecord {
  const message = readObjectRecord(row.message);
  const content = message?.content;
  if (!message || !Array.isArray(content)) {
    return refuse(`cannot grow a row of type ${JSON.stringify(row.type)}: it is not a message row`);
  }

  const textPartIndex = content.findIndex((part: unknown) => readObjectRecord(part)?.type === 'text');
  if (textPartIndex === -1) {
    return refuse(`cannot grow a row of type ${JSON.stringify(row.type)}: it carries no text part`);
  }

  const parts = content.map((part: unknown, index: number) =>
    index === textPartIndex ? { ...readObjectRecord(part), text } : part,
  );

  return { ...row, message: { ...message, content: parts } };
}

/**
 * The directory a project's transcripts are grouped under.
 *
 * The indexer reads a transcript's session id and cwd from the ROWS, never from
 * this name, so the grouping is cosmetic — it is here so a fixture transcript
 * sits exactly where a real one would, and no reader can tell them apart by
 * shape.
 */
export function encodeProjectBucket(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Writes a transcript from scratch: one JSON object per line, parent directories
 * created first.
 *
 * Synchronous on purpose. The engine's whole contract is "the row is on disk
 * before its frame is forwarded", and a synchronous write is what makes that
 * ordering structural instead of a promise the next `await` could reorder.
 */
export function writeTranscript(filePath: string, rows: AnyRecord[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
}

/** Appends one row to a transcript, creating the file if the seed has not. */
export function appendTranscriptRow(filePath: string, row: AnyRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * Replaces the last row of a transcript with whatever `grow` returns, keeping
 * the replaced row's uuid.
 *
 * The uuid is re-applied here rather than left to the caller: "grow keeps the
 * uuid" is the invariant every read-back depends on, so it is enforced where the
 * write happens instead of being a convention each caller remembers.
 */
export function rewriteLastTranscriptRow(
  filePath: string,
  grow: (row: AnyRecord) => AnyRecord,
): AnyRecord {
  const rows = readTranscriptRows(filePath);
  const last = rows.at(-1);
  if (!last) {
    return refuse('cannot rewrite the last row of an empty transcript');
  }

  const grown = { ...grow(last), uuid: last.uuid };
  rows[rows.length - 1] = grown;
  writeTranscript(filePath, rows);
  return grown;
}

/**
 * Reads a transcript's rows. A line that does not parse is an error rather than
 * a skipped line: this function is what the run's own read-back measures the
 * artifact with, and a reader that silently ignored damage would report a
 * healthy transcript for a file nothing downstream can index.
 */
export function readTranscriptRows(filePath: string): AnyRecord[] {
  return readTranscriptLines(filePath).map((line, index) => {
    const parsed = readObjectRecord(JSON.parse(line) as unknown);
    if (!parsed) {
      return refuse(`${path.basename(filePath)}:${index + 1} is not a JSON object`);
    }

    return parsed;
  });
}

/** The transcript's non-empty lines, in file order. */
export function readTranscriptLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/** What one read of a transcript can say about it. Everything here comes off disk. */
export type DebugAgentTranscriptShape = {
  rows: number;
  lastRowBytes: number;
  lastRow: AnyRecord | null;
};

/**
 * Reads a transcript's shape — row count, byte length of the last line, and the
 * last row itself — in exactly one read.
 *
 * The byte length is taken from the line as written rather than from a
 * re-serialization of the parsed row, so a reading of "the last row grew" is a
 * statement about the file's own bytes and cannot be satisfied by a rewrite that
 * changed nothing on disk.
 */
export function readTranscriptShape(filePath: string): DebugAgentTranscriptShape {
  const lines = readTranscriptLines(filePath);
  const lastLine = lines.at(-1);

  return {
    rows: lines.length,
    lastRowBytes: lastLine === undefined ? 0 : Buffer.byteLength(lastLine, 'utf8'),
    lastRow: lastLine === undefined ? null : (readObjectRecord(JSON.parse(lastLine) as unknown) ?? null),
  };
}

/** Arming refuses through the same error type the scenario loader uses. */
function refuse(reason: string): never {
  throw new AppError(`Debug agent scenario refused: ${reason}`, {
    code: 'DEBUG_AGENT_SCENARIO_INVALID',
    statusCode: 400,
  });
}

/**
 * A scenario that has been written to a fixture home and indexed, waiting to be
 * driven.
 */
export type ArmedDebugAgentScenario = {
  /**
   * The session id the armed scenario is addressed by: the one recorded on the
   * indexed row, and the id a run is started for.
   */
  sessionId: string;
  /** The id inside the transcript rows; equal to `sessionId` for a freshly armed scenario. */
  providerSessionId: string;
  transcriptPath: string;
  projectPath: string;
  /** Rows the seed wrote; the run's own row delta is measured from here. */
  seedRows: number;
  scenario: DebugAgentScenario;
};

export type DebugAgentArmInput = {
  projectPath: string;
  /** The scenario document; validated before anything is written. */
  scenario: unknown;
  /**
   * Indexes the seeded transcript, returning the session id it recorded.
   *
   * Injected because this module may not reach the providers module (that edge
   * would close a cycle through the registry that registers this provider), and
   * because arming an unindexed transcript would hand back a session nobody can
   * list, select or send to.
   */
  synchronizeTranscript: (filePath: string) => Promise<string | null>;
};

/** Armed scenarios, keyed by the session id a run is started for. */
const armedScenarios = new Map<string, ArmedDebugAgentScenario>();

/**
 * Writes a scenario's seed rows into the fixture home and indexes them, so the
 * session is listable, selectable and sendable BEFORE it is driven.
 *
 * The order is the contract: rows first, then the index. A run started against a
 * session whose row does not exist yet would fail to resolve its transcript, and
 * one started against a transcript whose row exists but has no path would have
 * its frames diverge from a history that answers with nothing.
 */
export async function armDebugAgentScenario(input: DebugAgentArmInput): Promise<ArmedDebugAgentScenario> {
  const scenario = loadScenario(input.scenario);

  const projectsRoot = getDebugAgentProjectsRoot();
  if (!projectsRoot) {
    return refuse('the debug agent gate is closed, so there is no fixture home to write into');
  }

  const projectPath = path.resolve(input.projectPath);
  const providerSessionId = crypto.randomUUID();
  const transcriptPath = path.join(
    projectsRoot,
    encodeProjectBucket(projectPath),
    `${providerSessionId}.jsonl`,
  );
  const timestamp = new Date().toISOString();

  // The title row goes first so the LAST row of the seed is a message row: that
  // is the row an in-place growth attaches to, and a scenario is free to open
  // with one.
  writeTranscript(transcriptPath, [
    buildTitleRow({ sessionId: providerSessionId, cwd: projectPath, title: scenario.seed.title, timestamp }),
    buildMessageRow({
      sessionId: providerSessionId,
      cwd: projectPath,
      role: 'user',
      text: scenario.seed.userText,
      uuid: crypto.randomUUID(),
      parentUuid: null,
      timestamp,
    }),
  ]);

  const indexedSessionId = await input.synchronizeTranscript(transcriptPath);
  if (indexedSessionId !== providerSessionId) {
    return refuse(
      `the seeded transcript was not indexed as "${providerSessionId}" (the indexer said ${JSON.stringify(indexedSessionId)}), so the session would not be listable`,
    );
  }

  const armed: ArmedDebugAgentScenario = {
    sessionId: providerSessionId,
    providerSessionId,
    transcriptPath,
    projectPath,
    seedRows: 2,
    scenario,
  };

  armedScenarios.set(armed.sessionId, armed);
  return armed;
}

/**
 * The scenario armed for a session, or null when that session has none.
 *
 * A run looks its script up by the id it was started for, which is also the id
 * the armed rows were indexed under — there is no second mapping to keep in
 * step.
 */
export function readArmedDebugAgentScenario(sessionId: string): ArmedDebugAgentScenario | null {
  return armedScenarios.get(sessionId) ?? null;
}

/** Drops one armed scenario. Returns whether there was one. */
export function disarmDebugAgentScenario(sessionId: string): boolean {
  return armedScenarios.delete(sessionId);
}
