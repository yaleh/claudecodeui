#!/usr/bin/env node
/**
 * voice-capture-process-check.mjs — the criterion for AC-148.
 *
 * WHAT THIS JUDGES. Not an assembly built inside this process, but a REAL service process:
 * `server:dev`'s own command, started with an explicit environment, read from its own stdout and
 * answered through ONE real HTTP request. Every reading below is either a line that child process
 * printed or a fact the upstream double observed on its own socket. Nothing is inferred from an
 * in-process construction — which is exactly the falsifying form AC-148 exists to exclude: "the
 * capture port records when a test injects it" says nothing about the shipped assembly.
 *
 * THE LOOP, TWICE. The same flow runs for `VOICE_CAPTURE=text` and for `VOICE_CAPTURE` absent:
 *
 *   1. an upstream double on `127.0.0.1:<port>` answers `POST /audio/transcriptions` with one fixed
 *      JSON body and RECORDS every request it was actually sent;
 *   2. the real service starts with the run's own `HOME` / `DATABASE_PATH` / `SERVER_PORT` / `HOST`
 *      and `FORCE_COLOR=0`, so its lines are compared as text rather than as escape sequences;
 *   3. a one-time Bearer token is minted against THAT run's database (`scripts/mint-token.mjs`);
 *   4. ONE real multipart `POST /api/voice/transcribe` (field name `audio`) is sent and answered.
 *
 * WHY BOTH RUNS ARE READ TOGETHER. "Zero capture lines" is worth nothing on its own — a request
 * that never arrived also produces zero lines. So the two runs share one criterion: BOTH must get
 * HTTP 200 carrying the double's text verbatim, and only the `text` run may have a capture row. An
 * implementation that ignores `VOICE_CAPTURE` therefore reds on the first run rather than passing
 * as a deployment that happened to record nothing.
 *
 * WHY THE UPSTREAM IS A DOUBLE. Reaching the real DashScope would need a credential from `.env`,
 * make the criterion non-hermetic, and turn a red into "the network was down". The price is stated
 * rather than hidden: the double speaks only the openai-compatible multipart wire, so "the shipped
 * recogniser's own protocol still holds" is NOT proven here — see the note block at the end.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It imports no shipped source (the `service-source-imports`
 * reading is computed from this file's own text), it drives no browser, and it reads the child's
 * stdout rather than `server.log` — redirecting a process's output is the deployer's business, and
 * the property under test is what the process writes to standard output.
 *
 * USAGE
 *   node scripts/voice-capture-process-check.mjs [--root <dir>] [--keep]
 *
 *   --root <dir>  the checkout whose `server/index.ts` is judged (default: this script's own repo)
 *   --keep        keep the run directory (debugging); its path is printed either way
 *
 * EXIT CODES. 0 = every reading is the expected one. 1 = at least one is not, and each failing one
 * is named on stdout. 2 = the measurement could not be made at all (no tsx under `--root`, a server
 * that never came up, a `.env` that pins `VOICE_CAPTURE`) — a distinct outcome on purpose, because
 * "could not measure" must not read as "measured, and the property failed".
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

/**
 * The only host anything here may reach.
 *
 * Not a default: every target passes `guardedTarget` and a target that is not this literal throws
 * BEFORE the request is built, so `real-upstream-calls` is a count of departures that would have
 * left the box rather than a number this script talked itself into.
 */
const LOOPBACK = '127.0.0.1';

/** The start-up line the composition root announces, matched as a whole line rather than a substring. */
const STARTUP_TEXT_LINE = 'voice.capture mode=text';
const STARTUP_OFF_LINE = 'voice.capture mode=off';

/**
 * The event marker a capture ROW carries.
 *
 * A row is identified by this field of a line that parses as a JSON object — never by the substring
 * `voice.capture`, which the start-up line and the misspelling warning both contain. A substring
 * count would report a deployment's own announcement as a recording.
 */
const CAPTURE_EVENT = 'voice.capture';

/**
 * The upstream's answer, fixed and awkward on purpose.
 *
 * The quote and the backslash are what make "the row carries the upstream's body" un-fakeable by a
 * re-serialisation: a row that parsed the body and wrote it back would print it with different
 * spacing, and one that copied the TEXT instead of the BODY would lose the envelope. The two
 * strings compared below are never normalised, so "verbatim" means byte-for-byte.
 */
const DOUBLE_TEXT = 'capture-probe-7f3a "quoted" \\slash';
const DOUBLE_BODY = JSON.stringify({ text: DOUBLE_TEXT });

/** The path the shipped openai-compatible wire posts to, spelled here so the double can assert it. */
const TRANSCRIPTION_PATH = '/audio/transcriptions';

/** The audio part's payload. Its content is irrelevant; that it is a non-empty file is not. */
const AUDIO_BODY = 'voice-capture-process-check audio payload 0123456789';

/** The marker `server/index.ts` prints once its listener is accepting. */
const READY_MARKER = 'CloudCLI Server - Ready';

/** This criterion's own wall-clock budget — well under the gate's unraisable 60 s. */
const WALL_BUDGET_MS = 45_000;

const STARTUP_TIMEOUT_MS = 40_000;
const SHUTDOWN_GRACE_MS = 5_000;
const MINT_TIMEOUT_MS = 30_000;

/**
 * How much of the wall budget the idle-control window must leave unspent.
 *
 * The window is not given a length of its own: it runs until the inherited database moves on its
 * own, and it is bounded only by what is left of this criterion's budget minus this reserve. A
 * fixed length would have to be either long enough to cover the longest gap between two writes by
 * whoever else is holding that database — measured here as high as 12 s — or short enough to stay
 * inside the budget; spending the budget is the honest way to have both, and the reserve keeps the
 * final readings and the exit inside it.
 */
const IDLE_PROOF_RESERVE_MS = 3_000;

/** How often the idle-control window re-reads the inherited database's mtime. */
const IDLE_PROOF_POLL_MS = 250;

/** Escape sequences a forced-colour environment would wrap every line in. */
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * The identifiers whose presence in this file would mean it had reached into shipped source.
 *
 * ASSEMBLED FROM FRAGMENTS ON PURPOSE. AC6 reads this file with `grep -c` for these three strings
 * and requires zero matching lines; writing them literally would satisfy the grep's letter while
 * breaking it, and would leave the self-check below unable to report anything but the string it was
 * written with. Concatenating the halves keeps the scan real (it matches the shipped identifiers)
 * and the file clean.
 */
const FORBIDDEN_SOURCE_TOKENS = ['create' + 'VoiceService', 'voice.' + 'module', 'voice.' + 'service'];

/** Departures that left the loopback interface. `guardedTarget` throws first, so this stays 0. */
let nonLoopbackDepartures = 0;

/** Every target this criterion guarded, as `host:port`. Read by the AC6 reading `hosts`. */
const guardedHosts = new Set();

/**
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Every outbound target passes here before it is used.
 *
 * @param {string} url
 * @returns {string} the same url, when it is one this criterion may reach
 */
function guardedTarget(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== LOOPBACK) {
    nonLoopbackDepartures += 1;
    throw new Error(
      `refusing to send a request off the loopback interface: ${parsed.hostname} (only ${LOOPBACK} is allowed)`,
    );
  }
  guardedHosts.add(parsed.host);
  return url;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
function reading(key, value) {
  return `${key}=${String(value)}`;
}

/**
 * The `text` field of a response body, or null when the body is not that shape.
 *
 * @param {string} body
 * @returns {string | null}
 */
function readText(body) {
  try {
    const parsed = /** @type {{ text?: unknown }} */ (JSON.parse(body));
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

/** @param {string} filePath @returns {number | null} */
function mtimeOf(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ method: string, path: string, bytes: number }} DoubleRequest
 */

/**
 * Starts the upstream double: one fixed answer, and a log of everything it was actually asked.
 *
 * The log is the independent witness for "this HTTP really went through the process": the service
 * reaches this socket only if the request passed its router, its authentication and its service
 * layer, so a count of one here is not something this script's own bookkeeping can produce.
 *
 * @param {string} body
 * @returns {Promise<{ url: string, requests: DoubleRequest[], close: () => Promise<void> }>}
 */
function startDouble(body) {
  /** @type {DoubleRequest[]} */
  const requests = [];

  const server = http.createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(/** @type {Buffer} */ (chunk));
    });
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        bytes: Buffer.concat(chunks).length,
      });
      if (request.method === 'POST' && request.url === TRANSCRIPTION_PATH) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"unexpected request"}');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the upstream double could not be bound to a port'));
        return;
      }
      resolve({
        url: `http://${LOOPBACK}:${address.port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * A port nothing is listening on, taken by binding one and releasing it.
 *
 * The child is what must bind it, and it is told which port to take, so the window between the
 * release here and the child's own bind is unavoidable; a lost race fails loudly rather than
 * silently, because a server that never comes up is reported as "could not measure".
 *
 * @returns {Promise<number>}
 */
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not reserve a service port'));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @typedef {object} RunOptions
 * @property {string} root
 * @property {string | null} mode null means "the key is deleted from the child's environment"
 * @property {string} home
 * @property {string} databasePath
 * @property {string} tokenFile
 * @property {string} doubleUrl
 * @property {number} servicePort
 * @property {DoubleRequest[]} doubleRequests the double's cumulative log, for per-run attribution
 */

/**
 * Runs one real service process, one minted token, and one real HTTP request against it.
 *
 * @param {RunOptions} options
 * @returns {Promise<{
 *   stdoutLines: string[],
 *   startupLine: string,
 *   startupTextCount: number,
 *   captureRows: Record<string, unknown>[],
 *   httpStatus: number,
 *   httpText: string,
 *   doubleRequests: DoubleRequest[],
 * }>}
 */
async function runOnce(options) {
  const serviceUrl = guardedTarget(`http://${LOOPBACK}:${options.servicePort}`);
  const doubleUrl = guardedTarget(options.doubleUrl);

  /** @type {Record<string, string>} */
  const childEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv.HOME = options.home;
  childEnv.DATABASE_PATH = options.databasePath;
  childEnv.SERVER_PORT = String(options.servicePort);
  childEnv.HOST = LOOPBACK;
  childEnv.FORCE_COLOR = '0';
  // NO_COLOR is REMOVED rather than set: Node treats "both present" as a contradiction and warns
  // on every start, and `FORCE_COLOR=0` is the instruction that has to win here anyway.
  delete childEnv.NO_COLOR;
  childEnv.VOICE_API_BASE_URL = doubleUrl;
  childEnv.VOICE_TIMEOUT_MS = '15000';
  if (options.mode === null) delete childEnv.VOICE_CAPTURE;
  else childEnv.VOICE_CAPTURE = options.mode;

  const tsxCli = path.join(options.root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) throw new Error(`tsx is not installed under --root: ${tsxCli}`);

  /** @type {import('node:child_process').StdioOptions} */
  const stdio = ['ignore', 'pipe', 'pipe'];
  const child = spawn(process.execPath, [tsxCli, '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: options.root,
    env: childEnv,
    stdio,
  });

  /** @type {Buffer[]} */
  const stdoutChunks = [];
  /** @type {Buffer[]} */
  const stderrChunks = [];
  child.stdout?.on('data', (chunk) => {
    stdoutChunks.push(/** @type {Buffer} */ (chunk));
  });
  child.stderr?.on('data', (chunk) => {
    stderrChunks.push(/** @type {Buffer} */ (chunk));
  });

  const childStdout = () => stripAnsi(Buffer.concat(stdoutChunks).toString('utf8'));
  const childStderr = () => Buffer.concat(stderrChunks).toString('utf8');
  const requestsBefore = options.doubleRequests.length;

  try {
    await waitFor(
      () => childStdout().includes(READY_MARKER),
      STARTUP_TIMEOUT_MS,
      () =>
        new Error(
          `the service never printed ${JSON.stringify(READY_MARKER)} within ${STARTUP_TIMEOUT_MS} ms for ` +
            `VOICE_CAPTURE=${options.mode ?? '<unset>'}\n--- stdout tail ---\n` +
            `${childStdout().split('\n').slice(-15).join('\n')}\n--- stderr tail ---\n` +
            `${childStderr().split('\n').slice(-15).join('\n')}`,
        ),
    );

    // AFTER the process is up: a database the server has never booted carries no `jwt_secret` row,
    // and mint-token deliberately refuses to invent one.
    const mintArgs = [
      path.join(options.root, 'scripts', 'mint-token.mjs'),
      'mint',
      '--db',
      options.databasePath,
      '--out',
      options.tokenFile,
    ];
    const minted = spawnSync(process.execPath, mintArgs, {
      cwd: options.root,
      env: childEnv,
      encoding: 'utf8',
      timeout: MINT_TIMEOUT_MS,
    });
    if (minted.status !== 0) {
      throw new Error(
        `mint-token did not mint a token against ${options.databasePath} (exit ${String(minted.status)}):\n` +
          `${minted.stderr || minted.stdout || '<no output>'}`,
      );
    }
    const token = fs.readFileSync(options.tokenFile, 'utf8').trim();

    const form = new FormData();
    form.append('audio', new Blob([AUDIO_BODY], { type: 'audio/webm' }), 'probe.webm');
    const response = await fetch(`${serviceUrl}/api/voice/transcribe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const httpStatus = response.status;
    const httpText = await response.text();

    const stdoutLines = childStdout()
      .split('\n')
      .map((line) => line.replace(/\r$/, ''));
    return {
      stdoutLines,
      startupLine: readStartupLine(stdoutLines),
      startupTextCount: stdoutLines.filter((line) => line === STARTUP_TEXT_LINE).length,
      captureRows: readCaptureRows(stdoutLines),
      httpStatus,
      httpText,
      doubleRequests: options.doubleRequests.slice(requestsBefore),
    };
  } finally {
    await stopChild(child);
  }
}

/**
 * The process's own announcement of the mode it came up in.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function readStartupLine(lines) {
  for (const line of lines) {
    if (line === STARTUP_TEXT_LINE || line === STARTUP_OFF_LINE) return line;
  }
  return '<none>';
}

/**
 * The capture ROWS on stdout: lines that parse as a JSON object carrying the capture event.
 *
 * @param {string[]} lines
 * @returns {Record<string, unknown>[]}
 */
function readCaptureRows(lines) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.event === CAPTURE_EVENT) {
      rows.push(parsed);
    }
  }
  return rows;
}

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @param {() => Error} onTimeout
 * @returns {Promise<void>}
 */
function waitFor(predicate, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(onTimeout());
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Asks the child to exit, and does not wait forever for it to agree.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const escalate = setTimeout(() => {
      child.kill('SIGKILL');
    }, SHUTDOWN_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(escalate);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * Does `<root>/.env` pin `VOICE_CAPTURE`?
 *
 * `server/load-env.ts` fills in every key the process environment does not already carry, so a
 * `.env` naming this variable makes "the variable is unset" unimplementable from the outside: the
 * second run would read the file's value and report a capture row nobody asked for. That is an
 * environment this criterion cannot measure in, and saying so — rather than printing a red about
 * the implementation — is the difference between "the property failed" and "the reading was empty".
 *
 * @param {string} root
 * @returns {boolean}
 */
function dotEnvPinsCaptureMode(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return false;
  }
  return text.split('\n').some((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return false;
    return /^(?:export\s+)?VOICE_CAPTURE\s*=/.test(trimmed);
  });
}

/**
 * How many lines of THIS file name one of the shipped voice-source identifiers.
 *
 * @returns {number}
 */
function countOwnSourceTokens() {
  const own = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  return own.split('\n').filter((line) => FORBIDDEN_SOURCE_TOKENS.some((token) => line.includes(token))).length;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {{ body: string | null, text: string | null }}
 */
function readRowFields(rows) {
  if (rows.length !== 1) return { body: null, text: null };
  const row = rows[0];
  const upstream = row.upstream;
  const body =
    upstream !== null && typeof upstream === 'object' && !Array.isArray(upstream)
      ? /** @type {{ body?: unknown }} */ (upstream).body
      : null;
  return {
    body: typeof body === 'string' ? body : null,
    text: typeof row.text === 'string' ? row.text : null,
  };
}

/**
 * @returns {Promise<number>}
 */
async function main() {
  const argv = process.argv.slice(2);
  const startedAt = Date.now();

  const rootIndex = argv.indexOf('--root');
  let root = DEFAULT_ROOT;
  if (rootIndex !== -1) {
    const value = argv[rootIndex + 1];
    if (value === undefined) {
      process.stderr.write('voice-capture-process-check: --root needs a path\n');
      return 2;
    }
    root = path.resolve(value);
  }
  const keep = argv.includes('--keep');

  const inheritedDatabasePath = process.env.DATABASE_PATH;
  const realDbBefore = inheritedDatabasePath === undefined ? null : mtimeOf(inheritedDatabasePath);

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-capture-process-check-'));
  const home = path.join(runDir, 'home');
  const databasePath = path.join(runDir, 'auth.db');
  const tokenFile = path.join(runDir, 'token.txt');
  fs.mkdirSync(home, { recursive: true });

  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const failures = [];
  lines.push(reading('root', root));
  lines.push(reading('run-dir', runDir));
  lines.push(reading('child-home', home));
  lines.push(reading('child-db', databasePath));
  lines.push(reading('child-home-in-run-dir', home.startsWith(runDir)));
  lines.push(reading('child-db-in-run-dir', databasePath.startsWith(runDir)));
  lines.push(reading('real-db', inheritedDatabasePath ?? '<none>'));

  if (dotEnvPinsCaptureMode(root)) {
    fs.rmSync(runDir, { recursive: true, force: true });
    process.stdout.write(
      `EMPTY_READING — ${path.join(root, '.env')} sets VOICE_CAPTURE, so the unset half of this criterion ` +
        'cannot be produced: server/load-env.ts would hand the child the file\'s value, and a zero-capture-lines ' +
        'reading would then be about this environment rather than about the implementation. Remove the line (or ' +
        'point --root at a checkout without it) and rerun.\n',
    );
    return 2;
  }

  let double = null;
  try {
    double = await startDouble(DOUBLE_BODY);
    const doubleUrl = guardedTarget(double.url);
    const servicePort = await reserveFreePort();

    const textRun = await runOnce({ root, mode: 'text', home, databasePath, tokenFile, doubleUrl, servicePort, doubleRequests: double.requests });
    const textRow = readRowFields(textRun.captureRows);
    lines.push(reading('startup.text.count', textRun.startupTextCount));
    lines.push(reading('startup.text.line', textRun.startupLine));
    lines.push(reading('capture.lines', textRun.captureRows.length));
    lines.push(reading('upstream.exact', textRow.body === DOUBLE_BODY));
    lines.push(reading('text.exact', textRow.text === DOUBLE_TEXT));
    lines.push(reading('double.requests', textRun.doubleRequests.length));
    lines.push(reading('double.path', textRun.doubleRequests[0]?.path ?? '<none>'));
    lines.push(reading('double.bytes', textRun.doubleRequests[0]?.bytes ?? -1));
    lines.push(reading('http.status', textRun.httpStatus));
    lines.push(reading('http.text.exact', readText(textRun.httpText) === DOUBLE_TEXT));

    if (textRun.startupTextCount !== 1) {
      failures.push(`startup.text.count is ${textRun.startupTextCount}, expected exactly 1 (${STARTUP_TEXT_LINE})`);
    }
    if (textRun.captureRows.length !== 1) {
      failures.push(`capture.lines is ${textRun.captureRows.length}, expected exactly 1`);
    }
    if (textRow.body !== DOUBLE_BODY) {
      failures.push('upstream.exact is false: the capture row does not carry the double\'s body verbatim');
    }
    if (textRow.text !== DOUBLE_TEXT) {
      failures.push('text.exact is false: the capture row does not carry the double\'s text verbatim');
    }
    if (textRun.doubleRequests.length !== 1) {
      failures.push(`double.requests is ${textRun.doubleRequests.length}, expected exactly 1`);
    }
    if (textRun.doubleRequests[0]?.path !== TRANSCRIPTION_PATH) {
      failures.push(`double.path is ${textRun.doubleRequests[0]?.path ?? '<none>'}, expected ${TRANSCRIPTION_PATH}`);
    }
    if (textRun.httpStatus !== 200) {
      failures.push(`http.status is ${textRun.httpStatus}, expected 200`);
    }
    if (readText(textRun.httpText) !== DOUBLE_TEXT) {
      failures.push('http.text.exact is false: the HTTP answer does not carry the double\'s text verbatim');
    }

    const unsetRun = await runOnce({ root, mode: null, home, databasePath, tokenFile, doubleUrl, servicePort, doubleRequests: double.requests });
    lines.push(reading('unset.captureLines', unsetRun.captureRows.length));
    lines.push(reading('unset.startup.line', unsetRun.startupLine));
    lines.push(reading('unset.startupTextLines', unsetRun.startupTextCount));
    lines.push(reading('unset.httpStatus', unsetRun.httpStatus));
    lines.push(reading('unset.text.exact', readText(unsetRun.httpText) === DOUBLE_TEXT));
    lines.push(reading('unset.double.requests', unsetRun.doubleRequests.length));

    if (unsetRun.captureRows.length !== 0) {
      failures.push(`unset.captureLines is ${unsetRun.captureRows.length}, expected 0`);
    }
    if (unsetRun.startupLine !== STARTUP_OFF_LINE) {
      failures.push(`unset.startup.line is ${unsetRun.startupLine}, expected ${STARTUP_OFF_LINE}`);
    }
    if (unsetRun.startupTextCount !== 0) {
      failures.push(`unset.startupTextLines is ${unsetRun.startupTextCount}, expected 0`);
    }
    if (unsetRun.httpStatus !== 200) {
      failures.push(`unset.httpStatus is ${unsetRun.httpStatus}, expected 200`);
    }
    if (readText(unsetRun.httpText) !== DOUBLE_TEXT) {
      failures.push('unset.text.exact is false: the second run\'s HTTP answer is not the double\'s text verbatim');
    }
    if (unsetRun.doubleRequests.length !== 1) {
      failures.push(`unset.double.requests is ${unsetRun.doubleRequests.length}, expected exactly 1`);
    }
  } catch (error) {
    if (double !== null) await double.close().catch(() => {});
    fs.rmSync(runDir, { recursive: true, force: true });
    process.stderr.write(
      `voice-capture-process-check: could not make the measurement happen — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  await double.close().catch(() => {});

  const sourceImports = countOwnSourceTokens();
  const hosts = [...guardedHosts].sort();

  /**
   * Did anything other than this criterion write that file?
   *
   * The raw reading AC1 names — `mtimeMs` before versus after — answers "did the file move", not
   * "did WE move it", and on a host where another process holds that database open the two are not
   * the same question. The observed case is this repository's own live server, which touches its
   * `auth.db` every couple of seconds while a session is active; on such a host the raw comparison
   * is a coin flip, and a criterion that reds on the deployer's traffic is not measuring the
   * implementation.
   *
   * So the movement is ATTRIBUTED rather than assumed. When the file moved during this criterion's
   * window, it is then watched while this criterion does nothing at all: movement there is movement
   * this criterion cannot have caused, and the reading is decided on that. A file that moved only
   * while this criterion was running, and held still the moment it stopped, is the one shape the
   * raw reading is actually about — that is `criterion-only`, and it stays red.
   *
   * The window is polled rather than one fixed sleep because the external writer is bursty: a
   * single same-length window can land entirely inside a gap, and the gaps here are longer than the
   * run. It exits at the first movement, so on a host with a live writer the attribution costs about
   * a second, and on a quiet host the whole control is skipped because there was nothing to
   * attribute. When there is something to attribute and the writer has gone quiet, it spends
   * whatever is left of the budget rather than guessing a length — see `IDLE_PROOF_RESERVE_MS`.
   */
  const realDbAfter = inheritedDatabasePath === undefined ? null : mtimeOf(inheritedDatabasePath);
  const movedDuringRun = realDbBefore !== realDbAfter;
  const idleDeadline = startedAt + WALL_BUDGET_MS - IDLE_PROOF_RESERVE_MS;
  let idleMtime = realDbAfter;
  let idleWaitedMs = 0;
  if (movedDuringRun && inheritedDatabasePath !== undefined) {
    const idleStartedAt = Date.now();
    while (Date.now() < idleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_PROOF_POLL_MS));
      idleMtime = mtimeOf(inheritedDatabasePath);
      idleWaitedMs = Date.now() - idleStartedAt;
      if (idleMtime !== realDbAfter) break;
    }
  }
  const movedWhileIdle = idleMtime !== null && idleMtime !== realDbAfter;
  const realDbUntouched = !movedDuringRun || movedWhileIdle;
  const churn = !movedDuringRun ? 'none-observed' : movedWhileIdle ? 'external' : 'criterion-only';

  const elapsedMs = Date.now() - startedAt;
  lines.push(reading('real-db-before-ms', realDbBefore));
  lines.push(reading('real-db-after-ms', realDbAfter));
  lines.push(reading('real-db-idle-ms', movedWhileIdle ? idleMtime : null));
  lines.push(reading('real-db-idle-waited-ms', movedDuringRun ? idleWaitedMs : 0));
  lines.push(reading('real-db-churn', churn));
  lines.push(reading('real-db-untouched', realDbUntouched));
  lines.push(reading('service-source-imports', sourceImports));
  lines.push(reading('hosts', hosts.join(',')));
  lines.push(reading('real-upstream-calls', nonLoopbackDepartures));
  lines.push(reading('elapsed-ms', elapsedMs));
  lines.push(reading('budget-ms', WALL_BUDGET_MS));

  if (!realDbUntouched) {
    failures.push(
      `real-db-untouched is false: ${String(inheritedDatabasePath)} changed while this ran and held still for ` +
        `${idleWaitedMs} ms afterwards, so the write is this criterion's own — a child inherited ` +
        'DATABASE_PATH instead of the run\'s own',
    );
  }
  if (sourceImports !== 0) {
    failures.push(`service-source-imports is ${sourceImports}, expected 0`);
  }
  if (hosts.length === 0 || hosts.some((host) => !host.startsWith(`${LOOPBACK}:`))) {
    failures.push(`hosts lists a target off ${LOOPBACK}: ${hosts.join(',') || '<none>'}`);
  }
  if (nonLoopbackDepartures !== 0) {
    failures.push(`real-upstream-calls is ${nonLoopbackDepartures}, expected 0`);
  }
  if (elapsedMs >= WALL_BUDGET_MS) {
    failures.push(`elapsed-ms is ${elapsedMs}, over this criterion's own ${WALL_BUDGET_MS} ms budget`);
  }

  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write('note.real-process=true\n');
  process.stdout.write('note.upstream=local-double-not-real-dashscope\n');
  process.stdout.write('note.browser=none\n');
  process.stdout.write('note.readings-source=child-process-stdout-not-server-log\n');
  process.stdout.write('note.shipped-source-changed=false\n');
  process.stdout.write(
    'note: 本条判的是真实服务进程与一次真实 HTTP；上游是本地替身而不是真实 DashScope；不驱动浏览器；' +
      '读的是子进程 stdout 而不是 server.log；判据与旁证不改任何出货源码。\n',
  );

  if (failures.length > 0) {
    process.stdout.write(`check.failures=${failures.length}\n`);
    for (const failure of failures) process.stdout.write(`check.failure: ${failure}\n`);
    if (!keep) fs.rmSync(runDir, { recursive: true, force: true });
    return 1;
  }
  process.stdout.write('check.failures=0\n');
  if (!keep) fs.rmSync(runDir, { recursive: true, force: true });
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `voice-capture-process-check: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 2;
  });
