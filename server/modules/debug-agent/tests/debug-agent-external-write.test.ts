import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

import chokidar from 'chokidar';

import { initializeDatabase } from '@/modules/database/index.js';
import {
  closeSessionsWatcher,
  initializeSessionsWatcher,
  resolveProviderWatchPaths,
  sessionSynchronizerService,
  sessionsService,
} from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

import {
  DEBUG_AGENT_PROVIDER_ID,
  armDebugAgentScenario,
  getDebugAgentProjectsRoot,
  readDebugAgentGate,
  type ArmedDebugAgentScenario,
  type DebugAgentScenario,
} from '../index.js';
import { appendTranscriptRow, buildMessageRow, readTranscriptRows } from '../debug-agent.runtime.js';

/**
 * The criterion for the external-write path: somebody (or some script) appends a
 * row to a transcript file and the app only watches — file observer → re-index →
 * `session_upserted` → the client re-fetches the session's history over its REST
 * read, with the appended content in it.
 *
 * This is the half of the delivery chain that has NO runtime in it. The
 * browser-side stand-ins used elsewhere replace `window.WebSocket` and inject
 * frames, which skips the backend entirely; a run of the debug agent's own engine
 * produces its rows through the runtime. Neither ever exercises "the file changed
 * underneath the app and the app noticed". So this file drives the real chokidar
 * observer (`initializeSessionsWatcher`) against a real fixture transcript, and
 * appends to that file the way an outside writer would — a plain file append
 * through no interface the app exposes, with no runtime in the loop.
 *
 * Three things the criterion has to do, none of them optional:
 *
 *  (i) DRAIN FIRST. Arming the fixture writes a new file into the observed root,
 *      and the observer reads it as an `add` at its next poll. "Wait for an
 *      upsert and pass" is therefore a blind criterion: the load satisfies it and
 *      the external write is never proven. So the criterion waits until an upsert
 *      has been seen AND the observer has then been silent for more than one
 *      polling period, and only then appends.
 * (ii) Demand a NEW upsert after the append, inside an observation window at
 *      least as wide as the worst case. The window is a SAFE UPPER BOUND, never a
 *      lower bound: nothing here asserts that delivery takes that long.
 * (iii) POSITIVE CONTROL: the observer's own log line naming THIS file with a
 *      `change` event, after the append. Without it, "an upsert arrived" cannot
 *      be attributed to the observer, and a build that wrote the database
 *      directly would be indistinguishable from one that watched the file — see
 *      the anti-fake arm below, which is exactly that build.
 *
 * Why every reading comes from a CHILD process. The gate is cached at first read
 * and the registry registers the debug provider during module evaluation, so
 * whether the debug agent exists at all is decided before any test body runs.
 * Each arm therefore re-executes this file in a child with the gate open and
 * `HOME` redirected into a scratch directory, so no arm can reach the machine's
 * real `~/.claude`, its real database, or a stale fixture root. This mirrors the
 * two sibling criteria in this directory; the three files share no code because
 * the readings differ.
 */

// Spelled through constants so this file never becomes a second reader of the
// gate variable: `debug-agent-gate.test.ts` scans everything under `server/` for
// a direct read of it outside the gate module, and this file must pass that scan.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';
const PROBE_VAR = 'DEBUG_AGENT_EXTERNAL_WRITE_PROBE';
const MODE_VAR = 'DEBUG_AGENT_EXTERNAL_WRITE_MODE';
const PROBE_MARKER = '__DEBUG_AGENT_EXTERNAL_WRITE_READING__';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);

/**
 * The observer's polling interval, copied from the watcher's `chokidar.watch`
 * options. A drain shorter than this proves nothing: the observer could still be
 * sitting on a poll that has not happened yet.
 */
const POLL_INTERVAL_MS = 6_000;
/** How deep the observer's walk goes, copied from the same `chokidar.watch` call. */
const WATCH_DEPTH = 6;
/** The drain's silence requirement — strictly more than one polling period. */
const DRAIN_SILENCE_MS = 6_500;
/**
 * The observation window: deliberately wider than the worst case (one polling
 * period plus the flush debounce) so the criterion covers it. The latencies this
 * run actually measures are printed and sit far below it; a criterion that
 * asserted a lower bound here would be a different and wrong one.
 */
const OBSERVATION_WINDOW_MS = 8_000;
/** The false form of the same window, used by the falsification reading below. */
const SHORT_WINDOW_MS = 1_000;
const SHORT_WINDOW_TRIALS = 3;
/**
 * How long one load attempt waits for its own `add` line, and how many attempts
 * are allowed. See `armObservedFixture` — an attempt that is not seen is
 * re-armed rather than waited on, so this is a bound on a pathological observer,
 * not a sleep.
 */
const LOAD_ATTEMPT_MS = POLL_INTERVAL_MS + 2_000;
const MAX_LOAD_ATTEMPTS = 3;
/** Bound on the wait for the load event, so a dead observer reds instead of hanging. */
const LOAD_TIMEOUT_MS = 40_000;
/** Bound on a whole child, so a hung arm cannot stall the suite. */
const CHILD_TIMEOUT_MS = 150_000;

/**
 * The seed's own text, and the text the external writer appends. Different
 * strings on purpose: the history leg asserts the APPENDED one is present, and
 * that must not be satisfiable by the seed that was there all along.
 */
const SEED_USER_TEXT = 'the seed row the arming step wrote before anything was observed';
const APPENDED_TEXT = 'a row appended by an external writer, not by the app';

/**
 * The scenario the fixture is armed with. It carries no transcript step at all:
 * this criterion is about the row an OUTSIDE writer appends, so the armed
 * scenario's only job is to put an indexable session in the fixture root. A
 * single `wait` keeps `steps` non-empty, which the loader requires, and writes
 * nothing.
 */
const SCENARIO: DebugAgentScenario = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: 'external write fixture', userText: SEED_USER_TEXT },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [] } },
};

const OBSERVER_LINE = /Session synchronization triggered by (add|change) event for provider "([^"]+)"/;

type ChildMode = 'external-write' | 'bypass';

/** One `session_upserted` as it reached a connected client. */
type UpsertReading = { at: number; sessionId: string | null; providerSessionId: string | null };

/** One line the observer logged, captured in-process so it carries a timestamp. */
type ObserverLine = { at: number; eventType: string; provider: string; text: string };

/** One attempt at producing the load event, and whether the observer saw it. */
type LoadAttempt = { attempt: number; transcriptPath: string; addObserved: boolean };

type ExternalWriteReading = {
  gate: { enabled: boolean; home: string | null; reason: string };
  mode: ChildMode;
  fixture: { root: string | null; rootListed: boolean; transcriptPath: string; projectPath: string };
  session: { sessionId: string; providerSessionId: string; seedRows: number };
  /** Producing the load event, and how many tries the observer needed to see it. */
  load: { attempts: LoadAttempt[]; observedOn: number | null };
  /** (i) — the drain: what it saw, and how quiet it then had to be. */
  drain: { upsertsObserved: number; silenceMs: number; tookMs: number; loadUpsertAt: number | null };
  /** The external write itself, and what the arm had to do to make it one. */
  append: {
    at: number;
    text: string;
    /** The number AC4 asks for: how much room the load event left before the write. */
    loadToAppendMs: number | null;
    observerClosed: boolean;
  };
  /** (ii) — what arrived after the append, and how long it took. */
  delivery: {
    windowMs: number;
    newUpserts: number;
    deliveryMs: number | null;
    upsertsSinceAppend: UpsertReading[];
  };
  /** (iii) — the positive control. */
  positiveControl: {
    changeLinesForThisFile: number;
    changeLinesAfterAppend: number;
    addLinesForThisFile: number;
    lines: ObserverLine[];
  };
  /** The REST re-fetch leg, driven by the same call the route handler makes. */
  history: { count: number; total: number; containsAppended: boolean; containsSeed: boolean; ids: string[] };
  /** The blind criterion's own satisfaction — and whether it predates the write. */
  blind: { upsertsBeforeAppend: number; satisfiedBeforeAppend: boolean };
  /** AC3's false form: the same observation with a window far too small. */
  windowFalsification: { windowMs: number; trials: Array<{ delivered: boolean; elapsedMs: number }> };
};

// --------------------------- child process ---------------------------

/** The real `console.log`, saved before the capture below wraps it. */
const emit = console.log.bind(console);

type CapturedLine = { at: number; text: string };

const captured: CapturedLine[] = [];

/** Tees one console method into `captured`, keeping its original behaviour. */
function captureConsole(method: 'log' | 'warn' | 'error'): void {
  const original = console[method].bind(console) as (...data: unknown[]) => void;
  const tee = (...data: unknown[]): void => {
    captured.push({ at: Date.now(), text: util.format(...data) });
    original(...data);
  };

  if (method === 'log') {
    console.log = tee;
    return;
  }

  if (method === 'warn') {
    console.warn = tee;
    return;
  }

  console.error = tee;
}

/**
 * The observer's own log lines, timestamped at capture. `util.format` is used
 * because the watcher passes its file path as a second console argument, and the
 * positive control has to be bound to THIS transcript rather than to any event.
 */
function readObserverLines(lines: CapturedLine[]): ObserverLine[] {
  const readings: ObserverLine[] = [];
  for (const entry of lines) {
    const match = OBSERVER_LINE.exec(entry.text);
    if (!match) {
      continue;
    }

    readings.push({ at: entry.at, eventType: match[1], provider: match[2], text: entry.text });
  }

  return readings;
}

/** A connected client that records the deltas it is handed, and nothing else. */
class RecordingConnection {
  readyState = WS_OPEN_STATE;
  readonly upserts: UpsertReading[] = [];

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame.kind !== 'session_upserted') {
      return;
    }

    this.upserts.push({
      at: Date.now(),
      sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : null,
      providerSessionId: typeof frame.providerSessionId === 'string' ? frame.providerSessionId : null,
    });
  }
}

/** Waits for one more upsert than `since`, or gives up when the window elapses. */
async function waitForUpsertAfter(
  upserts: UpsertReading[],
  since: number,
  windowMs: number,
): Promise<{ arrived: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    if (upserts.length > since) {
      return { arrived: true, elapsedMs: Date.now() - startedAt };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= windowMs) {
      return { arrived: false, elapsedMs: elapsed };
    }

    await delay(Math.min(50, windowMs - elapsed));
  }
}

/**
 * (i) — the drain. Returns once at least one upsert has been seen AND the
 * observer has then been silent for more than one polling period.
 *
 * Both halves are load-bearing. Without the first, "silence" is satisfied by a
 * child that has seen nothing at all, which is also what a closed gate looks
 * like; without the second, the load event is still in flight and would satisfy
 * the very upsert the criterion waits for next.
 */
async function drainObserver(
  upserts: UpsertReading[],
): Promise<{ upsertsObserved: number; silenceMs: number; tookMs: number; loadUpsertAt: number | null }> {
  const startedAt = Date.now();
  for (;;) {
    const now = Date.now();
    const last = upserts.at(-1);
    const silenceMs = last ? now - last.at : now - startedAt;
    const settled = upserts.length >= 1 && silenceMs > DRAIN_SILENCE_MS;

    if (settled || now - startedAt > LOAD_TIMEOUT_MS) {
      return { upsertsObserved: upserts.length, silenceMs, tookMs: now - startedAt, loadUpsertAt: last?.at ?? null };
    }

    await delay(100);
  }
}

/**
 * Appends one row to the fixture transcript the way an outside writer would: a
 * plain file append carrying the dialect's row shape, through no app interface.
 */
function appendExternally(transcriptPath: string, input: { sessionId: string; cwd: string; text: string }): void {
  const rows = readTranscriptRows(transcriptPath);
  const parentUuid = rows.at(-1)?.uuid;

  appendTranscriptRow(
    transcriptPath,
    buildMessageRow({
      sessionId: input.sessionId,
      cwd: input.cwd,
      role: 'assistant',
      text: input.text,
      uuid: crypto.randomUUID(),
      parentUuid: typeof parentUuid === 'string' ? parentUuid : null,
      timestamp: new Date().toISOString(),
    }),
  );
}

/** Whether the observer has already logged `eventType` for this exact file. */
function sawObserverEvent(lines: CapturedLine[], filePath: string, eventType: string): boolean {
  return readObserverLines(lines).some((line) => line.eventType === eventType && line.text.includes(filePath));
}

/**
 * Returns once the observer's first walk of every watch root has finished.
 *
 * `initializeSessionsWatcher()` returns before that walk is over: `chokidar.watch()`
 * returns as soon as it has been called, and the walk it starts runs on afterwards.
 * A fixture armed inside that window is initial state as far as the observer is
 * concerned — the walk reaches it, `ignoreInitial` suppresses its `add`, and the
 * file ends up indexed, REST-addressable and completely unannounced. The service
 * publishes no readiness signal of its own, and waiting a guessed number of
 * milliseconds would be exactly the kind of sleep this file refuses everywhere
 * else, so this reads the walk instead of predicting it.
 *
 * A watcher of our own over the SAME roots, created strictly after the observer's
 * and started with the observer's own options except that it drops `ignored`: ours
 * therefore has strictly more tree to walk and cannot report `ready` first.
 */
async function waitForObserverWalk(): Promise<void> {
  const probes = resolveProviderWatchPaths().map(({ rootPath }) =>
    chokidar.watch(rootPath, {
      persistent: false,
      ignoreInitial: true,
      followSymlinks: false,
      depth: WATCH_DEPTH,
      usePolling: true,
      interval: POLL_INTERVAL_MS,
      binaryInterval: POLL_INTERVAL_MS,
    }),
  );

  try {
    await Promise.all(
      probes.map(
        (probe) =>
          new Promise<void>((resolve) => {
            probe.once('ready', () => resolve());
          }),
      ),
    );
  } finally {
    await Promise.all(probes.map((probe) => probe.close()));
  }
}

/**
 * Produces the load event, and returns only once the observer has logged its own
 * `add` line for it.
 *
 * Arming alone is not enough, which is a reading this criterion paid for:
 * `chokidar.watch()` returns before its first walk of the tree has finished, and a
 * file that walk finds IS initial state — `ignoreInitial` suppresses its `add` and
 * the observer says nothing at all. A fixture written inside that window is
 * indexed and REST-addressable and completely unannounced, so the drain below
 * would spend its whole timeout waiting for an upsert that was never coming, and
 * every reading after it would rest on a load event that did not happen.
 *
 * So the observer's own `add` line IS the readiness signal, and it is read rather
 * than predicted. An attempt the observer does not report within one polling
 * period is not waited on further: a fresh session is armed instead, which the
 * now-finished walk can only report as an `add`, and the attempt count is printed
 * either way.
 *
 * `waitForObserverWalk()` is what keeps the first attempt from being a casualty of
 * the window above: with the walk over before the fixture is armed, the new file
 * can only be reported, and the retry below stays the bound it is documented to be
 * rather than the normal path.
 */
async function armObservedFixture(): Promise<{ armed: ArmedDebugAgentScenario; attempts: LoadAttempt[] }> {
  const attempts: LoadAttempt[] = [];

  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
    const armed = await armDebugAgentScenario({
      projectPath: path.join(process.env[GATE_HOME_VAR] ?? '', 'workspace'),
      scenario: SCENARIO,
      synchronizeTranscript: indexTranscript,
    });

    const deadline = Date.now() + LOAD_ATTEMPT_MS;
    while (Date.now() < deadline && !sawObserverEvent(captured, armed.transcriptPath, 'add')) {
      await delay(100);
    }

    const addObserved = sawObserverEvent(captured, armed.transcriptPath, 'add');
    attempts.push({ attempt, transcriptPath: armed.transcriptPath, addObserved });

    if (addObserved) {
      return { armed, attempts };
    }
  }

  throw new Error(
    `the observer never logged an \`add\` for ${MAX_LOAD_ATTEMPTS} armed fixture(s), so there is no load event to drain: ${JSON.stringify(attempts)}`,
  );
}

/** The product's own file-level indexer, through the service the watcher uses. */
async function indexTranscript(filePath: string): Promise<string | null> {
  const result = await sessionSynchronizerService.synchronizeProviderFile(
    DEBUG_AGENT_PROVIDER_ID as LLMProvider,
    filePath,
  );
  return result.sessionId;
}

/**
 * Takes one arm's reading.
 *
 * The two modes share every step up to and including the drain, and differ in
 * exactly one place: what happens at the moment of the external write. In
 * `external-write` the observer is left running, so the write has to be noticed
 * by it; in `bypass` the observer is closed first and the row is indexed straight
 * into the database, which is the shape of an implementation that skips the
 * gateway — the file changes and the history gains the row, and nobody is told.
 */
async function readExternalWrite(mode: ChildMode): Promise<ExternalWriteReading> {
  captureConsole('log');
  captureConsole('warn');
  captureConsole('error');

  const gate = readDebugAgentGate();
  await initializeDatabase();

  const connection = new RecordingConnection();
  connectedClients.add(connection as never);

  const fixtureRoot = getDebugAgentProjectsRoot();
  const fixtureRootListed =
    fixtureRoot !== null &&
    resolveProviderWatchPaths().some(
      ({ provider, rootPath }) =>
        provider === (DEBUG_AGENT_PROVIDER_ID as LLMProvider) && path.resolve(rootPath) === path.resolve(fixtureRoot),
    );

  await initializeSessionsWatcher();
  await waitForObserverWalk();

  // The fixture is armed AFTER the observer is up, which is what makes the load
  // event a real one: a file that appears under a running observer is an `add`,
  // and removing it is what the drain below is for. It is armed until that `add`
  // is on the record — see `armObservedFixture` for why one attempt is not enough.
  const { armed, attempts } = await armObservedFixture();

  const drain = await drainObserver(connection.upserts);

  // ---- the external write ----
  const appendAt = Date.now();
  const upsertsBeforeAppend = connection.upserts.length;
  appendExternally(armed.transcriptPath, {
    sessionId: armed.providerSessionId,
    cwd: armed.projectPath,
    text: APPENDED_TEXT,
  });

  const observerClosed = mode === 'bypass';
  if (observerClosed) {
    // Bypassing the gateway: the observer leaves the loop entirely and the row is
    // indexed straight into the database. No file event, no flush, no broadcast —
    // only the file and the database move.
    await closeSessionsWatcher();
    await indexTranscript(armed.transcriptPath);
  }

  const windowMs = OBSERVATION_WINDOW_MS;
  const sinceAppend = connection.upserts.length;
  await waitForUpsertAfter(connection.upserts, sinceAppend, windowMs);

  const upsertsSinceAppend = connection.upserts.slice(sinceAppend);
  const firstNew = upsertsSinceAppend[0];
  const deliveryMs = firstNew ? firstNew.at - appendAt : null;

  const forThisFile = readObserverLines(captured).filter((line) => line.text.includes(armed.transcriptPath));

  // The REST re-fetch leg, driven the way the frontend drives it after a
  // `complete`: `GET /api/providers/sessions/:sessionId/messages` parses the
  // query, calls exactly this service method and wraps the result in an envelope.
  // The router itself is not reachable from this module — the providers barrel
  // does not export it, and reaching into its file would cross the module
  // boundary the backend standards draw — so the leg starts one hop below HTTP,
  // at the call the route handler makes. `limit: null` and `offset: 0` are what a
  // request with neither query parameter resolves to.
  const history = await sessionsService.fetchHistory(armed.sessionId, { limit: null, offset: 0 });
  const historyText = history.messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');

  // ---- AC3's false form ----
  // The same observation with a window far too small to hold the worst case:
  // each trial appends and then waits only SHORT_WINDOW_MS for an upsert. If this
  // came back green every time, the criterion would be measuring a fixture whose
  // phase is fixed rather than the observer.
  const windowFalsification = {
    windowMs: SHORT_WINDOW_MS,
    trials: [] as Array<{ delivered: boolean; elapsedMs: number }>,
  };
  for (let trial = 0; trial < SHORT_WINDOW_TRIALS; trial += 1) {
    appendExternally(armed.transcriptPath, {
      sessionId: armed.providerSessionId,
      cwd: armed.projectPath,
      text: `${APPENDED_TEXT} (short-window trial ${trial + 1})`,
    });

    const sinceTrial = connection.upserts.length;
    const outcome = await waitForUpsertAfter(connection.upserts, sinceTrial, SHORT_WINDOW_MS);
    windowFalsification.trials.push({ delivered: outcome.arrived, elapsedMs: outcome.elapsedMs });
  }

  await closeSessionsWatcher();
  connectedClients.delete(connection as never);

  return {
    gate,
    mode,
    fixture: {
      root: fixtureRoot,
      rootListed: fixtureRootListed,
      transcriptPath: armed.transcriptPath,
      projectPath: armed.projectPath,
    },
    session: {
      sessionId: armed.sessionId,
      providerSessionId: armed.providerSessionId,
      seedRows: armed.seedRows,
    },
    load: { attempts, observedOn: attempts.find((entry) => entry.addObserved)?.attempt ?? null },
    drain,
    append: {
      at: appendAt,
      text: APPENDED_TEXT,
      loadToAppendMs: drain.loadUpsertAt === null ? null : appendAt - drain.loadUpsertAt,
      observerClosed,
    },
    delivery: { windowMs, newUpserts: upsertsSinceAppend.length, deliveryMs, upsertsSinceAppend },
    positiveControl: {
      changeLinesForThisFile: forThisFile.filter((line) => line.eventType === 'change').length,
      changeLinesAfterAppend: forThisFile.filter((line) => line.eventType === 'change' && line.at >= appendAt).length,
      addLinesForThisFile: forThisFile.filter((line) => line.eventType === 'add').length,
      lines: forThisFile,
    },
    history: {
      count: history.messages.length,
      total: history.total,
      containsAppended: historyText.includes(APPENDED_TEXT),
      containsSeed: historyText.includes(SEED_USER_TEXT),
      ids: history.messages.map((message) => message.id).filter((id): id is string => typeof id === 'string'),
    },
    blind: { upsertsBeforeAppend, satisfiedBeforeAppend: upsertsBeforeAppend >= 1 },
    windowFalsification,
  };
}

// --------------------------- parent process ---------------------------

type ChildRun =
  | { ok: true; reading: ExternalWriteReading }
  | { ok: false; stdout: string; stderr: string; error: string };

/**
 * Runs one arm in a child. `HOME` is redirected into a scratch directory and
 * `DATABASE_PATH` points inside it, so no arm can reach the machine's real
 * `~/.claude` or its real database — including the arm that is supposed to do
 * work. The gate variables are cleared from the inherited environment before
 * being set, so a value the caller happened to export cannot decide an arm.
 */
function runChild(mode: ChildMode): Promise<ChildRun> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `debug-agent-external-write-${mode}-`));
  const home = path.join(scratch, 'home');
  const fixtureHome = path.join(scratch, 'fixture');
  mkdirSync(home, { recursive: true });

  const databasePath = path.join(scratch, 'external-write.db');
  writeFileSync(databasePath, '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DATABASE_PATH: databasePath,
    [PROBE_VAR]: '1',
    [MODE_VAR]: mode,
  };
  delete env[GATE_VAR];
  delete env[GATE_HOME_VAR];
  env[GATE_VAR] = 'on';
  env[GATE_HOME_VAR] = fixtureHome;

  return new Promise<ChildRun>((resolve) => {
    execFile(
      process.execPath,
      [TSX_CLI, '--tsconfig', 'server/tsconfig.json', SELF],
      { cwd: REPO_ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const err = typeof stderr === 'string' ? stderr : '';
        const line = out
          .split('\n')
          .filter((entry) => entry.startsWith(PROBE_MARKER))
          .pop();

        if (!line) {
          resolve({
            ok: false,
            stdout: out,
            stderr: err,
            error: error ? `${error.name}: ${error.message}` : 'the probe child printed no reading',
          });
          return;
        }

        resolve({ ok: true, reading: JSON.parse(line.slice(PROBE_MARKER.length)) as ExternalWriteReading });
      },
    );
  }).finally(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
}

/** The reading, or a red carrying the child's own output so a failure is readable. */
function requireReading(run: ChildRun, arm: string): ExternalWriteReading {
  if (!run.ok) {
    throw new Error(
      `${arm}: the probe child printed no reading (${run.error})\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
    );
  }

  return run.reading;
}

/**
 * The criterion, as one function so both arms are judged by the same code.
 *
 * `failures` is the three-step criterion the task mandates. `blindFailures` is
 * the criterion that "wait for one upsert" amounts to. The anti-fake arm below is
 * the reason the two must be reported separately: that arm is satisfied by both,
 * so the blind one distinguishes nothing.
 */
function evaluateCriterion(reading: ExternalWriteReading): {
  failures: string[];
  blindFailures: string[];
  steps: string[];
} {
  const failures: string[] = [];
  const steps: string[] = [];

  // (i) the drain
  if (reading.drain.upsertsObserved < 1) {
    failures.push(
      `(i) the drain never saw the load upsert (observed ${reading.drain.upsertsObserved}), so there was nothing to drain and the load could still be in flight`,
    );
  }
  if (reading.drain.silenceMs <= POLL_INTERVAL_MS) {
    failures.push(
      `(i) the drain stopped after ${reading.drain.silenceMs}ms of silence, which is not more than one polling period (${POLL_INTERVAL_MS}ms)`,
    );
  }
  steps.push(
    `(i) saw ${reading.drain.upsertsObserved} upsert(s), then waited out ${reading.drain.silenceMs}ms of silence (drain settled ${reading.drain.tookMs}ms after the observer started)`,
  );
  steps.push(
    `(i) the load event's own \`add\` was on the record at attempt ${reading.load.observedOn} of ${reading.load.attempts.length} (${reading.load.attempts.filter((entry) => !entry.addObserved).length} attempt(s) were taken as initial state and announced nothing)`,
  );

  // (ii) a NEW upsert after the external write
  if (reading.delivery.newUpserts < 1) {
    failures.push(`(ii) no NEW upsert arrived after the external write (0 in a ${reading.delivery.windowMs}ms window)`);
  } else if (reading.delivery.deliveryMs === null || reading.delivery.deliveryMs > reading.delivery.windowMs) {
    failures.push(
      `(ii) the new upsert arrived ${reading.delivery.deliveryMs}ms after the write, outside the ${reading.delivery.windowMs}ms window`,
    );
  }
  steps.push(
    `(ii) ${reading.delivery.newUpserts} new upsert(s) after the write; first at +${reading.delivery.deliveryMs}ms (window ${reading.delivery.windowMs}ms)`,
  );

  // (iii) the positive control
  if (reading.positiveControl.changeLinesAfterAppend < 1) {
    failures.push(
      `(iii) the observer logged no \`change\` event for this transcript after the write (${reading.positiveControl.changeLinesForThisFile} change line(s) for this file in total), so the upsert cannot be attributed to it`,
    );
  }
  steps.push(
    `(iii) observer logged ${reading.positiveControl.addLinesForThisFile} \`add\` and ${reading.positiveControl.changeLinesForThisFile} \`change\` line(s) for this file; ${reading.positiveControl.changeLinesAfterAppend} of the change line(s) follow the write`,
  );

  // (iv) the content reached the history, not only the wire
  if (!reading.history.containsAppended) {
    failures.push('(iv) the REST re-fetch does not contain the externally appended content');
  }
  steps.push(
    `(iv) REST re-fetch returned ${reading.history.count} message(s) (total ${reading.history.total}); contains the appended content: ${reading.history.containsAppended}; contains the seed: ${reading.history.containsSeed}`,
  );

  const blindFailures: string[] = [];
  if (reading.blind.upsertsBeforeAppend < 1) {
    blindFailures.push('blind: not one upsert was observed at all, before or after the write');
  }

  return { failures, blindFailures, steps };
}

function describe(reading: ExternalWriteReading): string {
  const { load, drain, append, delivery, positiveControl, history, windowFalsification, fixture } = reading;
  const verdict = evaluateCriterion(reading);

  return [
    `[gate] ${reading.gate.enabled ? 'OPEN' : 'CLOSED'} (${reading.gate.reason}); home=${reading.gate.home ?? '<none>'}`,
    `[mode] ${reading.mode}`,
    `[fixture] root=${fixture.root ?? '<none>'} listed=${fixture.rootListed}; transcript=${fixture.transcriptPath} (${reading.session.seedRows} seed row(s), session ${reading.session.sessionId})`,
    `[load] \`add\` observed on attempt ${load.observedOn} of ${load.attempts.length}; per attempt: ${load.attempts.map((entry) => `#${entry.attempt}=${entry.addObserved}`).join(' ')}`,
    `[drain (i)] ${drain.upsertsObserved} upsert(s) observed; silence ${drain.silenceMs}ms (> one polling period ${POLL_INTERVAL_MS}ms); settled after ${drain.tookMs}ms`,
    `[append] at +${append.loadToAppendMs}ms after the load upsert; observerClosed=${append.observerClosed}`,
    `[delivery (ii)] ${delivery.newUpserts} new upsert(s) in a ${delivery.windowMs}ms window; first at +${delivery.deliveryMs}ms`,
    `[control (iii)] add=${positiveControl.addLinesForThisFile} change=${positiveControl.changeLinesForThisFile} (after the write: ${positiveControl.changeLinesAfterAppend})`,
    `[history (iv)] ${history.count} message(s), total ${history.total}; appended content present: ${history.containsAppended}; seed present: ${history.containsSeed}`,
    `[false window] ${windowFalsification.windowMs}ms -> ${JSON.stringify(windowFalsification.trials)}`,
    ...verdict.steps,
    `[criterion] failures=${JSON.stringify(verdict.failures)}`,
    `[blind criterion] failures=${JSON.stringify(verdict.blindFailures)} (satisfied by an upsert that predates the write: ${reading.blind.satisfiedBeforeAppend})`,
  ].join('\n');
}

if (process.env[PROBE_VAR] === '1') {
  // Child mode: take the reading for this arm, print one line, exit.
  const mode = process.env[MODE_VAR];
  if (mode !== 'external-write' && mode !== 'bypass') {
    throw new Error(`unknown probe mode ${JSON.stringify(mode)}`);
  }

  const reading = await readExternalWrite(mode);
  emit(`${PROBE_MARKER}${JSON.stringify(reading)}`);
} else {
  // Both arms are started together. Each is almost entirely waiting on a 6s
  // polling clock, so running them concurrently costs the suite one arm's wall
  // clock instead of both, and they share nothing — separate scratch HOME,
  // separate database, separate observer.
  const runs = { externalWrite: runChild('external-write'), bypass: runChild('bypass') };
  registerCriteria(runs);
}

function registerCriteria(runs: { externalWrite: Promise<ChildRun>; bypass: Promise<ChildRun> }): void {
  test('an external write reaches the client through the file observer, and the criterion drains the load event first', async () => {
    const reading = requireReading(await runs.externalWrite, 'external-write');
    console.log(describe(reading));

    assert.equal(reading.gate.enabled, true, 'this arm needs the gate open');
    assert.equal(reading.mode, 'external-write', 'this arm must leave the observer in the loop');
    assert.equal(
      reading.fixture.rootListed,
      true,
      'the fixture root must be in the observation set, or nothing below is about the observer',
    );

    const verdict = evaluateCriterion(reading);

    // ---- (i) the drain is not a formality ----
    // The load event has to be on the record first, and by the observer's own
    // `add` rather than by the fixture merely existing: an unannounced load would
    // leave the drain waiting out a timeout and every reading after it resting on
    // an event that never happened.
    assert.notEqual(
      reading.load.observedOn,
      null,
      `the load event must have been announced by the observer: ${JSON.stringify(reading.load.attempts)}`,
    );
    assert.ok(
      reading.drain.upsertsObserved >= 1,
      `the load event must have been observed for the drain to mean anything (saw ${reading.drain.upsertsObserved})`,
    );
    assert.ok(
      reading.drain.silenceMs > POLL_INTERVAL_MS,
      `the drain must outlast one polling period: silence was ${reading.drain.silenceMs}ms, interval is ${POLL_INTERVAL_MS}ms`,
    );

    // The number AC4 asks for: how much room the load event left between itself
    // and the external write. If the drain were removed this is what would
    // collapse towards zero — which is exactly when a blind criterion lets the
    // load event through.
    assert.ok(
      reading.append.loadToAppendMs !== null && reading.append.loadToAppendMs > POLL_INTERVAL_MS,
      `the write must be separated from the load event by more than one polling period (got ${reading.append.loadToAppendMs}ms)`,
    );

    // ---- (ii) + (iii) + (iv), through the shared criterion ----
    assert.deepEqual(verdict.failures, [], `the criterion must be clean:\n${verdict.failures.join('\n')}`);
    assert.deepEqual(
      verdict.blindFailures,
      [],
      'the blind criterion is clean here too — the next arm is what shows what that is worth',
    );

    // The window is an upper bound: this run must never be read as "delivery
    // takes 8 seconds". The measured latency is printed, and asserted only to be
    // INSIDE the window — never to be at least anything.
    assert.ok(
      reading.delivery.deliveryMs !== null && reading.delivery.deliveryMs <= OBSERVATION_WINDOW_MS,
      `delivery must land inside the window (got ${reading.delivery.deliveryMs}ms of ${OBSERVATION_WINDOW_MS}ms)`,
    );
    assert.ok(
      OBSERVATION_WINDOW_MS >= POLL_INTERVAL_MS + 1_000,
      'the window must cover one polling period plus the flush debounce',
    );

    // ---- AC3's false form: the same observation with a window too small ----
    assert.equal(reading.windowFalsification.trials.length, SHORT_WINDOW_TRIALS, 'every short-window trial must have run');
    assert.ok(
      reading.windowFalsification.trials.some((trial) => !trial.delivered),
      `a ${SHORT_WINDOW_MS}ms window must not be green every time, or the criterion is measuring a fixed phase: ${JSON.stringify(reading.windowFalsification.trials)}`,
    );
  });

  test('the anti-fake arm bypasses the observer: (ii) and (iii) both fail while the blind criterion stays green', async () => {
    const reading = requireReading(await runs.bypass, 'bypass');
    console.log(describe(reading));

    const verdict = evaluateCriterion(reading);

    // The fake is a GOOD fake: the row really is on disk and really is in the
    // history the REST read returns. Nothing below would be a fair comparison
    // against a fake that simply failed to write.
    assert.equal(reading.append.observerClosed, true, 'this arm must take the observer out of the loop');
    assert.equal(
      reading.history.containsAppended,
      true,
      'the fake must actually write, or it proves nothing about the criterion',
    );

    // The blind criterion is green — and green for the wrong reason: the upsert
    // that satisfies it predates the external write entirely.
    assert.deepEqual(verdict.blindFailures, [], 'the blind criterion must stay green against this fake');
    assert.equal(
      reading.blind.satisfiedBeforeAppend,
      true,
      'and it must be satisfied by the load event, not by anything the write produced',
    );

    // The three-step criterion reds, on (ii) and (iii) at the same time. Both are
    // required: (ii) alone would be satisfied by any other producer, and (iii)
    // alone would not show that nothing reached the client.
    assert.ok(
      verdict.failures.some((failure) => failure.startsWith('(ii)')),
      `the criterion must fail on (ii) here; failures were ${JSON.stringify(verdict.failures)}`,
    );
    assert.ok(
      verdict.failures.some((failure) => failure.startsWith('(iii)')),
      `the criterion must fail on (iii) here; failures were ${JSON.stringify(verdict.failures)}`,
    );
    assert.equal(reading.delivery.newUpserts, 0, 'nothing may be announced through a closed observer');
    assert.equal(
      reading.positiveControl.changeLinesAfterAppend,
      0,
      'and the observer may not have logged the write it never saw',
    );
  });
}
