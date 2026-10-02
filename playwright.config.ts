import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { defineConfig } from '@playwright/test';

import { fsAvailableBytes, resolveE2eDataDir } from './scripts/e2e-data-dir-selection.mjs';
import { reclaimDataDirs } from './scripts/e2e-data-dir-retention.mjs';
import {
  ASSEMBLY_TEMP_ROOT_ENV,
  PROBE_FILE_NAME,
  assemblyTempCandidates,
  planAssembly,
} from './scripts/e2e-assembly-budget.mjs';

/**
 * This config's own directory.
 *
 * The file is loaded as an ES module, where `__dirname` does not exist — referencing it throws before a single test
 * is collected, so the fallback path below has to be derived from the module's own URL instead. It is the same
 * directory Playwright itself resolves `testDir` against, which is why the fallback and the config agree.
 */
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * When this file started being evaluated — the first moment of the run that can be observed from here.
 *
 * The watchdog below reports its elapsed time against this, so the number it prints covers config evaluation
 * and seeding as well as everything Playwright does afterwards.
 */
const runStartedAt = Date.now();

/**
 * The same instant, published so a spec can print the wall clock of the run it is part of.
 *
 * A criterion's ceiling is on the whole `npx playwright test` invocation — config evaluation, seeding, server
 * boot, browser launch — while a spec can only see itself: a spec that timed its own body would report a number
 * whose shortfall against the ceiling is the part it could not observe. Workers re-evaluate this file, so the
 * guard matters: without it each worker would overwrite the owner's reading with its own start and the printed
 * number would again be "since this worker began". The value set here is the earliest this file has ever run.
 */
if (!process.env.QUAY_E2E_RUN_STARTED_AT) {
  process.env.QUAY_E2E_RUN_STARTED_AT = String(runStartedAt);
}

// Everything the servers persist lives under one throwaway directory so the run never touches real user data.
// Exported through the environment so worker processes (which re-evaluate this file) share the directory and the spec can put a project workspace inside it.
//
// Which directory that is — and whether there is room for it — is decided in `scripts/e2e-data-dir-selection.mjs`,
// not by an unconditional `mkdtempSync(path.join(os.tmpdir(), …))`. `os.tmpdir()` reads `TMPDIR`, the driver's
// environment does not set it, and so every run on this host used to land on the root filesystem whatever its
// remaining space was: when the run did not fit, it failed as `ENOSPC` / `net::ERR_INSUFFICIENT_RESOURCES` *inside*
// a case that was measuring something else entirely. The selection reads each candidate's filesystem at the moment
// it chooses, prints the three numbers it chose by, and refuses to start the run when nothing has room — see the
// module for the readings that fix its shape.
const dataDirSelection = resolveE2eDataDir();
const dataDir = dataDirSelection.dataDir;
/** True only in the process that created the directory: workers re-evaluate this file with it already set. */
const isDataDirOwner = !dataDirSelection.explicit;
process.env.QUAY_E2E_DATA_DIR = dataDir;
/**
 * ...and the same reading published, because the assignment above destroys the evidence for it: every worker
 * inherits `QUAY_E2E_DATA_DIR` set, so asking the question again inside a spec would answer "someone else owns
 * this directory" for a run that created it. Guarded for the same reason the run clock is — the owner's answer is
 * the first one, and the workers re-evaluate this file with it already in the environment.
 */
if (process.env.QUAY_E2E_DATA_DIR_OWNER === undefined) {
  process.env.QUAY_E2E_DATA_DIR_OWNER = String(isDataDirOwner);
}

/**
 * Reclaims the run directories earlier runs left behind, before this run starts writing.
 *
 * Every run creates a directory under the parent the selector chose and nothing used to remove it, so
 * the parent grew at the run rate forever. Measured on this host on 2026-09-28: `~/.cache/quay-e2e-tmp`
 * held 1794 directories / 103 GB, all created within 24 hours — and the pool is a *user quota*, not a
 * filesystem size, so `df` still reported 3.3 TB free while writes failed with `EDQUOT` (`errno -122`).
 * The failures landed before any test started (Playwright's own transform-cache `open`, a `copyfile` of
 * the auth database, an `mkdtemp` of the next run's directory), which is what made a green criterion
 * report as red for reasons none of its own assertions could name.
 *
 * Only the owner sweeps: a worker re-evaluates this file long after the run is under way, and its
 * `dataDir` is the directory being protected, not one to reclaim against. The directory this run just
 * created is excluded, so the sweep can never remove the run it is part of — and it is passed as an
 * absolute path, which the module reduces to the name it compares against.
 *
 * The work is bounded (2 s by default) and never fatal: the module reports what it could not read or
 * remove instead of throwing, because a run that died of its own housekeeping would be the defect this
 * closes arriving from the other side. The bound drains the pool over runs rather than all at once: at
 * the ~89 ms measured for a 3371-file directory it reclaims ~20 directories per run, against the one
 * directory a run creates. `scripts/e2e-data-dir-retention.mjs` is the module; `npm run e2e:reclaim`
 * is the same sweep as a manual entry, unbounded and with the byte count reported.
 */
if (isDataDirOwner) {
  reclaimDataDirs({
    parent: path.dirname(dataDir),
    exclude: [dataDir],
    log: (line) => console.log(line),
  });
}

/**
 * The dependency cache this run's Vite is told to use, under the run's own throwaway directory.
 *
 * Vite's default is `<cwd>/node_modules/.vite`, and that default is one mutable directory shared by every
 * checkout on the machine: `dispatch-worktree-setup.sh` links each task worktree's `node_modules` to the main
 * checkout's, so the symlink resolves to the same directory for all of them. Sharing alone would only be a
 * hazard; what makes it a defect is that Vite is *guaranteed* to rewrite it. Its staleness check compares a
 * `configHash` that includes `root`, `root` defaults to the process cwd, and a worktree's cwd is by
 * construction a different path from the main checkout's — so a run in a worktree finds the cache another root
 * wrote "stale because vite config has changed" and re-optimizes it. Re-optimizing swaps the `browserHash`
 * that is baked into every dependency URL, and a page another run already has in flight is holding the old
 * hash: each of its requests then answers `504 (Outdated Optimize Dep)`, the pre-bundled `react` chunk and its
 * siblings arrive from two different builds, React's dispatcher is null by the time a hook runs, and the app's
 * own error boundary replaces the chat interface. Pointing each run at a directory of its own removes the
 * shared mutable state rather than widening anyone's tolerances.
 */
const viteCacheDir = path.join(dataDir, 'vite-cache');

/**
 * Where this run's scratch space goes — and whether it can be prepared before the browser needs it.
 *
 * The data directory above was moved off `os.tmpdir()`; the rest of the run's scratch was not. Chromium's
 * user-data directory, `tsx`'s transform cache, Node's compile cache and Playwright's own transform cache are
 * all created under `os.tmpdir()`, which reads `TMPDIR`, which the driver's environment does not set — so
 * every run on this host writes them onto the root filesystem, shared with the whole fleet. The criterion this
 * config serves is bounded at 35 s for its whole leg, assembly included; when that shared filesystem is under
 * the load a fleet puts on it, the first page load does not finish inside that budget and the leg dies in
 * `expandProject()` with a bare `Test timeout of 35000ms exceeded` — the same failure a broken replay pair
 * would produce, and with none of the criterion's own wording to tell them apart. Measured on this host on
 * 2026-09-26: six concurrent runs of the criterion with `TMPDIR` unset failed 6/6 that way, and the same six
 * with each run's scratch on the 4 TB volume passed 6/6.
 *
 * So the run's scratch is pointed at a directory of its own, inside the directory that was already chosen for
 * having room, and the choice is made by `scripts/e2e-assembly-budget.mjs` under a budget so that a
 * preparation that cannot finish is refused *here* — before any server or browser starts, naming the target —
 * rather than surfacing later as a case that timed out for reasons it cannot see. `TMPDIR` itself is set
 * rather than passed to the children alone: this is the same variable the whole process tree reads, and the
 * browser is launched from it.
 *
 * Re-evaluation is free by construction: a worker inherits `TMPDIR` already pointed at the owner's directory,
 * and the probe file left by the owner's warm-up is what `isWarmed` reads, so the second evaluation prepares
 * nothing.
 */
const probePath = (target: string) => path.join(target, PROBE_FILE_NAME);
const assemblyPlan = planAssembly({
  candidates: assemblyTempCandidates({ env: process.env, dataDir }),
  availableBytes: fsAvailableBytes,
  isWarmed: (target) => fs.existsSync(probePath(target)),
  warm: (target) => {
    fs.mkdirSync(target, { recursive: true });
    // The probe is written, not merely the directory created: a directory that exists is equally what
    // someone else's run, or a run that died, leaves behind — "prepared" has to be about this run's own
    // writing for a worker's re-evaluation to be able to trust it.
    fs.writeFileSync(probePath(target), `${new Date().toISOString()} ${process.pid}\n`);
  },
});
if (!assemblyPlan.ok) {
  // Ending the run here, synchronously, for the reason the data-directory refusal gives above: on a pipe
  // `console.error` hands the line off asynchronously, and the refusal text is the whole product of the path.
  fs.writeSync(2, `${assemblyPlan.reason}\n`);
  process.exit(1);
}
const [assemblyTarget] = assemblyPlan.targets.length > 0 ? assemblyPlan.targets : assemblyPlan.prepared;
const assemblyReading = 'warmed' in assemblyPlan ? assemblyPlan.warmed[0] : undefined;
process.env.TMPDIR = assemblyTarget;
process.env[ASSEMBLY_TEMP_ROOT_ENV] = assemblyTarget;
console.log(
  `[e2e] assembly-scratch=${assemblyTarget} prepared=${assemblyPlan.skipped ? 'already' : 'now'}`
    + ` elapsed-ms=${assemblyPlan.elapsedMs}`
    + ` available-bytes=${assemblyReading?.availableBytes ?? 'n/a'}`,
);

/**
 * Asks the kernel for two free TCP ports, held at the same time so it cannot hand back the same one twice,
 * and releases them on the way out.
 *
 * The ports cannot be literals. A port is a machine-wide resource, not a checkout-wide one: with two fixed
 * numbers, any second e2e run — another spec in a sibling worktree, another agent, the fleet's own re-runs —
 * races this one for the same pair, and the loser dies during server boot with "is already used" instead of
 * reporting anything about the code under test. One kernel-assigned pair per run gives each run its own.
 *
 * `listen(0)` is asynchronous and Playwright evaluates this file synchronously, so the lookup runs in a
 * short-lived child process. Closing before the webServer binds leaves a window that is small and, without
 * handing Playwright a listening socket it cannot accept, unavoidable.
 */
const freePortPair = (): [number, number] => {
  const stdout = execFileSync(
    process.execPath,
    [
      '-e',
      `const net = require('node:net');
const listen = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
(async () => {
  const first = await listen();
  const second = await listen();
  process.stdout.write([first.address().port, second.address().port].join(' '));
  await Promise.all([first, second].map((server) => new Promise((done) => server.close(done))));
})().catch((error) => { console.error(error.message); process.exit(1); });`,
    ],
    // Bounded: this call blocks the event loop, so a child that never exits would also stop the watchdog
    // below from firing — a config lookup with no deadline is the same defect this file keeps closing.
    { encoding: 'utf8', timeout: 10_000 },
  );
  const [serverPort, clientPort] = stdout.trim().split(/\s+/).map(Number);
  return [serverPort, clientPort];
};

/**
 * Workers re-evaluate this file, and `baseURL` is read there — so the pair has to travel through the
 * environment like `dataDir` does, or a worker would address a server nobody started. Only the process that
 * allocated publishes it, and only that process announces it.
 */
const chosePorts = process.env.QUAY_E2E_SERVER_PORT === undefined;
const [serverPort, clientPort] = chosePorts
  ? freePortPair()
  : [Number(process.env.QUAY_E2E_SERVER_PORT), Number(process.env.QUAY_E2E_CLIENT_PORT)];
process.env.QUAY_E2E_SERVER_PORT = String(serverPort);
process.env.QUAY_E2E_CLIENT_PORT = String(clientPort);
if (chosePorts) {
  // On stdout rather than in a log file: it lands in the run's own captured output, so a red recorded from
  // this run can be read back as "which pair did it hold", which the stderr-head excerpt cannot answer.
  console.log(`[e2e] server=${serverPort} client=${clientPort}`);
}

/**
 * Reports which of `ports` cannot be bound right now. Runs in a child process for the same reason
 * `freePortPair` does: `listen` is asynchronous and this file is evaluated synchronously.
 */
const findTakenPorts = (ports: number[]): number[] => {
  const stdout = execFileSync(
    process.execPath,
    [
      '-e',
      `const net = require('node:net');
const probe = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(port));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(0)));
});
(async () => {
  const taken = (await Promise.all([${ports.join(', ')}].map(probe))).filter(Boolean);
  process.stdout.write(taken.join(' '));
})().catch((error) => { console.error(error.message); process.exit(1); });`,
    ],
    // Bounded for the same reason `freePortPair`'s is: this is a synchronous block, and the watchdog cannot
    // fire while the event loop is held.
    { encoding: 'utf8', timeout: 10_000 },
  );
  return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
};

/**
 * Refuses to hand Playwright ports this run cannot bind, before it is given them.
 *
 * Playwright asks each webServer URL whether something is already serving it *before* it spawns the command,
 * and that probe has no deadline and no timeout of its own: a listener that accepts the connection but never
 * answers makes the check wait forever. The run then never reaches `webServer.timeout` below, never exits, and
 * the goal gate that caps the criterion at 60s kills it as an unattributable timeout — leaving the servers it
 * did start holding their ports into the next run. Binding each port once here turns the same condition into an
 * immediate failure that names the port, which is what a red run has to say to be actionable.
 *
 * This check is a *snapshot*, taken here, and Playwright's probe happens after it: a port that gets taken in
 * between is let through by this check and still hangs the probe. That window is closed by the watchdog below,
 * which is the run's own ceiling and names whatever stage it finds the run stuck in.
 *
 * Only the process that is about to start the servers probes. Workers re-evaluate this file long after both
 * are listening, so a probe there would report the run's own servers as the conflict; the flag rides the same
 * environment channel as `dataDir` and the port pair, which workers are already known to inherit.
 */
if (process.env.QUAY_E2E_PORTS_VERIFIED === undefined) {
  const taken = findTakenPorts([serverPort, clientPort]);
  if (taken.length > 0) {
    throw new Error(
      `e2e port(s) ${taken.join(', ')} are already in use by another process, so this run's servers cannot bind them. `
        + 'Failing now, naming the port, rather than waiting on a health check that has no deadline.',
    );
  }
  process.env.QUAY_E2E_PORTS_VERIFIED = '1';
}

/**
 * The url each webServer is told to serve, declared once so the watchdog probes exactly what Playwright was
 * given rather than a second copy of the same two strings that could drift away from it.
 */
const SERVER_HEALTH_URL = `http://127.0.0.1:${serverPort}/health`;
const CLIENT_URL = `http://127.0.0.1:${clientPort}`;
const RUN_SERVERS = [
  { name: 'server', url: SERVER_HEALTH_URL },
  { name: 'client', url: CLIENT_URL },
];

/**
 * What one spec's own run is allowed to take, and what the run's ceiling is assembled from: the specs this
 * invocation was actually asked to run, each carrying its own budget.
 *
 * The gate's 60s kill is what `SINGLE_SPEC_CEILING_MS` is derived against — see the block below — and it binds a
 * *criterion*, which is one file. A full-tree `npx playwright test` is not that invocation: it is every spec in
 * the directory, one after another, and the eleven that shipped before this task measured ~5 minutes on this
 * host. A ceiling derived for one file applied to that run kills it mid-tree, which reads exactly like a hang —
 * the failure mode this whole watchdog exists to make legible, arriving from the watchdog itself. So the bound is
 * per-file and summed over the selection, and the shipped single-file value becomes the *default* every spec
 * keeps unless it declares otherwise. Every existing invocation — one file, often narrowed further with `-g` —
 * computes `SINGLE_SPEC_CEILING_MS` and is bounded exactly as before.
 *
 * The budgets are declarations, not guesses, and the reason they are a table rather than a formula is that
 * runtime is a property of the file: a quiet spec costs a handful of seconds and one that records audio twice
 * per viewport costs minutes. `mobile-workspace-composer-layout.spec.ts` is the only declared entry, and its
 * budget clears its measured run with the same margin the single-file value clears voice-trim's.
 */
const SINGLE_SPEC_CEILING_MS = 55_000;
/** Per-spec budgets that differ from `SINGLE_SPEC_CEILING_MS`. Keyed by basename so the rule holds from any cwd. */
const SPEC_BUDGET_MS: Record<string, number> = {
  'mobile-workspace-composer-layout.spec.ts': 240_000,
};

/**
 * The flags whose value is the token *after* them, so a value can never be mistaken for a spec path. Short of
 * listing them, `-g e2e/foo.spec.ts` would read its own grep pattern as a second file to run.
 */
const VALUE_TAKING_FLAGS = new Set([
  '-g',
  '--grep',
  '--grep-invert',
  '-c',
  '--config',
  '--reporter',
  '--project',
  '--workers',
  '-j',
  '--timeout',
  '--global-timeout',
  '--output',
  '--retries',
  '--repeat-each',
  '--max-failures',
  '-x',
  '--shard',
  '--last-failed',
]);

/** The `*.spec.ts` files inside a directory, or `[]` when it is not one. Empty rather than throwing: a ceiling is not a reason for a run to die. */
const specFilesIn = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).filter((entry) => entry.endsWith('.spec.ts'));
  } catch {
    return [];
  }
};

/**
 * The spec files this invocation names on the command line, or every spec in `testDir` when it names none.
 *
 * Playwright's own selection language is wider than this (globs, `--project`, `--last-failed`); the two shapes
 * that exist in this checkout are "one file, maybe with `-g`" — what every goal criterion runs — and the bare
 * full-tree invocation. Anything else lands in the full-tree branch, which is the generous reading.
 */
const selectedSpecFiles = (): string[] => {
  const named = process.argv
    .slice(1)
    .filter((token, index, all) => !token.startsWith('-') && !VALUE_TAKING_FLAGS.has(all[index - 1] ?? ''))
    .filter((token) => token.endsWith('.spec.ts'));
  const resolved = named.flatMap((token) => {
    const target = path.resolve(process.cwd(), token);
    return fs.existsSync(target) && fs.statSync(target).isDirectory() ? specFilesIn(target) : [path.basename(target)];
  });
  return resolved.length > 0 ? resolved : specFilesIn(path.join(CONFIG_DIR, 'e2e'));
};

const RUN_CEILING_MS = selectedSpecFiles().reduce(
  (total, file) => total + (SPEC_BUDGET_MS[file] ?? SINGLE_SPEC_CEILING_MS),
  0,
);

/**
 * The run's own ceilings — the bounds above which nothing else in this file bounds anything.
 *
 * The gate that runs this criterion kills it at 60s and records the kill as `verdict: fail`, the same shape a
 * real failure has, so a run that crosses 60s is a red nobody can read. Two ceilings already exist under these
 * and neither covers the whole run: `webServer[].timeout` bounds only the wait *after* a server is spawned, and
 * the filter spec's own `test.describe.configure({ timeout: 120_000 })` raises the per-test budget to twice the
 * gate's cap. What is left over is everything outside both — most sharply Playwright's *pre-spawn* availability
 * probe (the note above), which asks each webServer url once with no deadline of its own, so a listener that
 * completes the TCP handshake and then never writes a byte makes it wait forever.
 *
 * The unboundedness is not spread evenly, so neither is the bound. Before both webServers answer, a run is on
 * the path nothing bounds, and `BOOT_CEILING_MS` bounds it there. Once both answer, the run is inside browser
 * launch and the cases, where the spec's own per-test timeout is the bound that already exists — so that stage
 * gets `RUN_CEILING_MS` instead, the largest value that still beats the gate's kill. A watchdog that used the
 * tight value for both stages would kill a perfectly healthy run of any spec in this checkout that load had
 * merely slowed past it — a bound lower than a sibling spec's own runtime turns a load artifact into a lost
 * run, and one already did: `e2e/voice-trim.spec.ts` runs 41.1-41.3s here and was killed mid-case at 45s.
 *
 * Both fire by *explaining themselves*: each reads back which stage the run is stuck in, writes one line naming
 * that stage and the milliseconds elapsed, ends any server process this run left behind, and exits non-zero. A
 * watchdog that only said "too slow" would leave the next reader exactly where the 60s kill does.
 *
 * The values are derived rather than guessed. A quiet run's stages measure ~0.6s config evaluation and seeding,
 * ~2.9s server boot, ~0.9s vite, ~8s browser launch plus `beforeAll`, and ~12s across the five cases — ~24s in
 * total, and a run under six concurrent sibling specs measured 23.6s. `BOOT_CEILING_MS` must clear every boot
 * that is already bounded (2 × 30s webServer waits, but serially — the first expiry ends the run, so ~31s), and
 * it is 9× the quiet boot. `SINGLE_SPEC_CEILING_MS` must clear the longest healthy run in this checkout
 * (voice-trim, ~42s) and still land its line before the gate's kill: 55s + the 2s diagnosis probe + ~0.6s of
 * process start-up puts the line on stdout at ~57.6s, ~2.4s inside 60s.
 *
 * The run ceiling itself is the sum of the selected specs' budgets, computed above; for the one-file invocation
 * the gate makes, that sum is `SINGLE_SPEC_CEILING_MS` and nothing about it changed.
 */
const BOOT_CEILING_MS = 40_000;
/** How long the watchdog waits for an answer before it calls a bound port silent. Deliberately short: this is a reading, not a wait. */
const WATCHDOG_PROBE_MS = 2_000;

/**
 * Asks one of the run's ports a single HTTP request, with a deadline, and reports which of three states it is
 * in: `answered` (something served it), `silent` (the port is bound and nothing came back), or `closed`
 * (nothing is listening).
 *
 * This is the one reading the watchdog needs and the reading Playwright's own probe cannot give: it waits on
 * the same socket with no deadline, which is what the run is stuck on in the first place. So this one hangs up
 * rather than waits — it must be impossible for the thing that explains a hang to hang.
 */
const probePort = (target: string): Promise<'answered' | 'silent' | 'closed'> =>
  new Promise((resolve) => {
    const url = new URL(target);
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    let settled = false;
    const settle = (state: 'answered' | 'silent' | 'closed') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(WATCHDOG_PROBE_MS);
    socket.on('connect', () => socket.write(`GET ${url.pathname} HTTP/1.0\r\nHost: ${url.host}\r\n\r\n`));
    socket.on('data', () => settle('answered'));
    socket.on('timeout', () => settle('silent'));
    socket.on('error', () => settle('closed'));
  });

/**
 * Which stage the run is in, read back from the ports at the moment a ceiling is crossed.
 *
 * The stage is returned as data and not only as prose because it decides what happens next: a run still in
 * `webServer-start` is on the unbounded path and ends here, while a run past it is merely slow and is handed
 * the looser ceiling instead. Reading it back out of the message would make the message load-bearing.
 *
 * A port that is bound but silent is the sharpest reading of the three: it is the listener whose handshake
 * succeeds and whose answer never comes, which is precisely the condition Playwright's pre-spawn probe cannot
 * survive. Naming it turns "the run timed out" into "this process is holding this port and not answering".
 */
type Stall = { readonly stage: 'webServer-start' | 'browser-launch-or-cases'; readonly detail: string };

const describeStall = async (): Promise<Stall> => {
  const readings = await Promise.all(
    RUN_SERVERS.map(async (server) => ({ ...server, state: await probePort(server.url), port: new URL(server.url).port })),
  );
  const silent = readings.filter((reading) => reading.state === 'silent');
  if (silent.length > 0) {
    const named = silent.map((reading) => `port ${reading.port} (${reading.name}) accepts TCP but never answers an HTTP request`).join(', ');
    return {
      stage: 'webServer-start',
      detail: `${named} — Playwright's pre-spawn availability probe for ${silent[0].url} has no deadline, so it cannot return`,
    };
  }
  const closed = readings.filter((reading) => reading.state === 'closed');
  if (closed.length > 0) {
    const named = closed.map((reading) => `port ${reading.port} (${reading.name}) is not listening`).join(', ');
    return { stage: 'webServer-start', detail: named };
  }
  return {
    stage: 'browser-launch-or-cases',
    detail: 'both webServers answered, so this run is past boot and inside browser launch or a test case',
  };
};

/**
 * The direct children of this process, read from `/proc`.
 *
 * Playwright spawns every webServer `detached`, so each direct child leads its own process group and
 * `process.kill(-pid, ...)` reaches the whole `sh -c` -> `npx` -> `tsx` -> server chain. Signalling the leader
 * alone would leave its children reparented and still holding the ports — the orphan this run must not leave.
 */
const childPids = (): number[] => {
  const pids: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // `pid (comm) state ppid ...`, and `comm` may itself contain spaces and parentheses, so the fields are
      // read from after its closing one.
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === process.pid) pids.push(Number(entry));
    } catch {
      // Exited between the directory listing and the read: not a child left to clean up.
    }
  }
  return pids;
};

/**
 * Where this run records whether its watchdog was armed, and whether it ever fired.
 *
 * The `[e2e] watchdog:` line is written to *this* process's stdout, which a criterion that runs the suite from
 * outside cannot read — and "no watchdog line in the output" is exactly what the voice-error criterion has to
 * assert. A spec observing only that the line is absent would accept a run whose watchdog was never armed at
 * all, so the two facts the line encodes are also written here, in the run's own data directory, where the spec
 * can read them: `armed:true` is the positive control that the ceiling really existed, and `fired:true` is what
 * a run that crossed one leaves behind. Both readings are joined by the file's absence meaning "no run wrote
 * here", which is why the spec fails on a missing file rather than treating it as a quiet watchdog.
 */
const WATCHDOG_STATE_FILE = path.join(dataDir, 'watchdog-state.json');
const writeWatchdogState = (state: { armed: boolean; fired: boolean; ceilingMs: number; detail: string }): void => {
  try {
    fs.writeFileSync(WATCHDOG_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // The reading is what is lost here; the watchdog's own behaviour never depends on this file.
  }
};

/**
 * Ends the run with a line explaining it, and takes this run's server processes with it.
 *
 * Only the process that allocated the data directory arms these. Workers re-evaluate this file, and a worker's
 * own lifetime is short and already bounded by the runner — a ceiling armed there would fire on the runner's
 * run, not on the worker's, and report the wrong elapsed time.
 */
if (isDataDirOwner) {
  const endRun = (label: string, ceiling: number, crossedAt: number, stall: Stall): void => {
    const elapsed = Date.now() - runStartedAt;
    // Recorded before anything can exit this process, and before the line below, so a run killed from outside
    // still leaves the evidence that its watchdog had fired.
    writeWatchdogState({ armed: true, fired: true, ceilingMs: ceiling, detail: `${label} crossed at ${crossedAt}ms` });
    // `fs.writeSync` rather than `console.log`: on POSIX a pipe is written asynchronously, so a line handed to
    // `process.stdout` is not flushed before `process.exit` — and the one line that explains the red would be
    // the one lost. The fallback covers a pipe that will not take the write right now; a lost line is bad but
    // not as bad as an exception on the way out swallowing the cleanup below.
    const line = `[e2e] watchdog: this run crossed its own ${ceiling}ms ${label} at ${crossedAt}ms and is ending here with exit 1 at ${elapsed}ms — stuck at stage "${stall.stage}": ${stall.detail}.\n`;
    try {
      fs.writeSync(1, line);
    } catch {
      try {
        fs.writeSync(2, line);
      } catch {
        // Neither stream is taking writes; the non-zero exit below is all that is left to report.
      }
    }
    for (const pid of childPids()) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone, or not a group leader; either way there is nothing here to signal.
      }
    }
    process.exit(1);
  };

  /**
   * Arms one ceiling, and at the boot one hands a run that turns out to be past boot to the run ceiling instead
   * of firing. The reading costs the probe below; the run receiving it is still starting up, so the two
   * ceilings stay two independent readings rather than one budget split between them — and a healthy run that
   * load has slowed down is never the one a boot bound ends.
   */
  const arm = (ceiling: number, label: string, mayReArm: boolean): void => {
    const watchdog = setTimeout(() => {
      // Read before the probe below, so the moment the ceiling was crossed is reported as itself and the probe's
      // own cost is not folded into it — otherwise the line would name a 55s ceiling and an elapsed of 57s.
      const crossedAt = Date.now() - runStartedAt;
      describeStall()
        .catch(
          (): Stall => ({ stage: 'webServer-start', detail: 'the port probe itself failed, so the stage could not be read' }),
        )
        .then((stall) => {
          if (mayReArm && stall.stage === 'browser-launch-or-cases') {
            arm(RUN_CEILING_MS, 'ceiling', false);
            return;
          }
          endRun(label, ceiling, crossedAt, stall);
        });
      // Measured from the run's own start rather than from this call, so the second arming lands on the run
      // ceiling itself and not on the boot ceiling plus it.
    }, Math.max(0, runStartedAt + ceiling - Date.now()));
    // Not referenced: a run that finishes on its own must not be held open by this timer. It can only fire while
    // something else is genuinely keeping the event loop alive — which is exactly the condition it exists for.
    watchdog.unref();
  };

  arm(BOOT_CEILING_MS, 'boot ceiling', true);
  // Written after the arming calls rather than inside `arm`, so the record describes the run's watchdog as a
  // whole — the boot ceiling and the run ceiling it hands over to — instead of whichever arming happened last.
  writeWatchdogState({
    armed: true,
    fired: false,
    ceilingMs: RUN_CEILING_MS,
    detail: `boot ${BOOT_CEILING_MS}ms, re-armed to ${RUN_CEILING_MS}ms once past boot`,
  });
}

/** Workspace e2e/session-filter.spec.ts creates its project in; its own directory so no other spec picks these sessions up. */
const SESSION_FILTER_WORKSPACE = path.join(dataDir, 'session-filter-workspace');
/** Names the filter spec's rule is written against — it re-declares them, and failing to see all of them is how a drift shows up. */
const SESSION_FILTER_SESSIONS = [
  'role-1-task-worker',
  'role-2-selector',
  'role-3-fix-worker',
  'role-4-task-worker',
  'human-alpha',
  'human-beta',
  'human-gamma',
];

/**
 * Seeds the transcripts e2e/session-filter.spec.ts filters on, here rather than from the spec itself.
 *
 * The backend scans ~/.claude/projects at boot and only then starts its file watcher with `ignoreInitial`.
 * Transcripts written while the test runs are therefore picked up by the watcher instead, which broadcasts a
 * session_upserted per file; each one lands on a session the browser is not viewing, which the sidebar
 * correctly reads as "needs attention" — and an attention-flagged session is deliberately kept visible under a
 * name filter. Writing them before the server boots means the boot scan indexes them and the watcher never
 * sees them at all, so the only session that earns an attention flag during the run is the one the spec flags
 * on purpose.
 *
 * Seeding must not happen in a worker: workers re-evaluate this file, so writing again there would land the
 * files on disk long after boot and hand the watcher exactly the storm this is avoiding.
 */
const seedSessionFilterTranscripts = () => {
  fs.mkdirSync(SESSION_FILTER_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'session-filter-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  for (const name of SESSION_FILTER_SESSIONS) {
    const sessionId = `e2e-${name}`;
    // The synchronizer reads sessionId and cwd from the first record it can parse and the display name from
    // the last custom-title event, so one transcript has to carry both.
    const records = [
      {
        type: 'user',
        sessionId,
        cwd: SESSION_FILTER_WORKSPACE,
        timestamp,
        message: { role: 'user', content: [{ type: 'text', text: `prompt for ${name}` }] },
      },
      { type: 'custom-title', sessionId, cwd: SESSION_FILTER_WORKSPACE, timestamp, customTitle: name },
    ];
    fs.writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
  }
};

/** Workspace e2e/transcript-follow.spec.ts opens; its own directory so no other spec picks this session up. */
const TRANSCRIPT_FOLLOW_WORKSPACE = path.join(dataDir, 'transcript-follow-workspace');
/** Session id that spec addresses, and the display name it looks its sidebar row up by. */
const TRANSCRIPT_FOLLOW_SESSION_ID = 'e2e-transcript-follow';
const TRANSCRIPT_FOLLOW_SESSION_NAME = 'transcript-follow';
/**
 * Turns the seeded transcript carries. Long enough to be many screens tall — the spec scrolls it for real in
 * both directions — and within ChatMessagesPane's 30-row initial-mount band, so every row starts with its
 * real height instead of a placeholder estimate and the geometry does not settle underneath the test.
 */
const TRANSCRIPT_FOLLOW_TURNS = 24;

/**
 * Seeds the transcript e2e/transcript-follow.spec.ts measures, here rather than from the spec itself.
 *
 * Same reason as the filter spec's: the backend scans ~/.claude/projects at boot and only then starts its
 * file watcher with `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher
 * and broadcast as a session_upserted instead.
 *
 * The bodies are plain paragraphs on purpose — no code blocks, no images, nothing that highlights or loads
 * asynchronously — because that spec asserts on pixel geometry, and a late reflow would move it.
 */
const seedTranscriptFollowTranscript = () => {
  fs.mkdirSync(TRANSCRIPT_FOLLOW_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'transcript-follow-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  const records: Record<string, unknown>[] = [];
  let parentUuid: string | null = null;
  for (let turn = 0; turn < TRANSCRIPT_FOLLOW_TURNS; turn += 1) {
    // Even counts of turns, so the last message row is an assistant row.
    const role = turn % 2 === 0 ? 'user' : 'assistant';
    const uuid = `e2e-transcript-follow-turn-${turn}`;
    records.push({
      type: role,
      uuid,
      parentUuid,
      sessionId: TRANSCRIPT_FOLLOW_SESSION_ID,
      cwd: TRANSCRIPT_FOLLOW_WORKSPACE,
      timestamp: new Date(startedAt + turn * 60_000).toISOString(),
      message: {
        role,
        content: [{
          type: 'text',
          text: `Turn ${turn}. ${'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt. '.repeat(8)}`,
        }],
      },
    });
    parentUuid = uuid;
  }
  records.push({
    type: 'custom-title',
    sessionId: TRANSCRIPT_FOLLOW_SESSION_ID,
    cwd: TRANSCRIPT_FOLLOW_WORKSPACE,
    timestamp: new Date(startedAt + TRANSCRIPT_FOLLOW_TURNS * 60_000).toISOString(),
    customTitle: TRANSCRIPT_FOLLOW_SESSION_NAME,
  });

  fs.writeFileSync(
    path.join(transcriptDir, `${TRANSCRIPT_FOLLOW_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/voice-identifier-repair.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_IDENTIFIER_WORKSPACE = path.join(dataDir, 'voice-identifier-workspace');
/** Session id that spec opens the composer in, and the display name it looks its sidebar row up by. */
const VOICE_IDENTIFIER_SESSION_ID = 'e2e-voice-identifier';
const VOICE_IDENTIFIER_SESSION_NAME = 'voice-identifier';
/**
 * The project file the utterance names, written into the seeded workspace.
 *
 * The spec does not carry this name as a literal: it lists the workspace and takes the name it finds there, so
 * the identifier it asserts on is one the project really has. A `## Touches`-level constant on both sides
 * would agree with itself whether or not the file exists.
 */
const VOICE_IDENTIFIER_FILE = 'voice.routes.ts';
/**
 * How the recogniser hears that name.
 *
 * The fixture has to arrive before the repair, not after it. With the file name spelled correctly here, the
 * claim "the composer holds the project's real file name" is true whether or not anything repairs it — the
 * criterion is then green in the world where no repair exists, which is the world it is meant to catch.
 *
 * `voice.rouse.ts` is an observed shape, not an invented one: AC-113's recovery corpus records the recogniser
 * answering `voice.rouse.ts` for `voice.routes.ts` (zh-d02).
 */
const VOICE_SPOKEN_IDENTIFIER = 'voice.rouse.ts';
/** What the fake microphone is saying. The recogniser stand-in the spec points the voice settings at answers with this same string. */
const VOICE_UTTERANCE = `please open ${VOICE_SPOKEN_IDENTIFIER} and fix the proxy`;
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name the file.
 * Written below, in the config, because Chromium opens it at browser launch — a spec that wrote it in
 * `beforeAll` would be writing it after the browser that is meant to play it already exists.
 */
const VOICE_AUDIO_FILE = path.join(dataDir, 'voice-utterance.wav');
process.env.QUAY_E2E_VOICE_UTTERANCE = VOICE_UTTERANCE;
process.env.QUAY_E2E_VOICE_SPOKEN_IDENTIFIER = VOICE_SPOKEN_IDENTIFIER;
process.env.QUAY_E2E_VOICE_AUDIO = VOICE_AUDIO_FILE;

/**
 * Writes the audio the fake microphone plays as a 16-bit PCM WAV.
 *
 * There is no offline speech-to-text in this checkout, so the utterance cannot be a recording of a person
 * saying the identifier; what can be real is the *path*. Chromium decodes this file and hands the samples to
 * `getUserMedia`, the app's own `MediaRecorder` encodes what it hears, and the browser uploads those bytes —
 * so the recording the recogniser stand-in receives is produced by the real capture chain, not by the test.
 *
 * The waveform is derived character by character from the text it stands for, so the spoken fixture and the
 * answer the stand-in gives are two encodings of one utterance rather than two unrelated constants. It is
 * deliberately not a single tone: `MediaRecorder` has to produce a container whose bytes are worth uploading,
 * and a file whose audio is one unbroken sine is the one signal a broken capture chain also produces.
 */
const writeVoiceUtterance = (filePath: string, text: string): void => {
  const sampleRate = 48_000;
  const samples: number[] = [];

  const silence = (ms: number) => {
    samples.push(...new Array<number>(Math.round((ms / 1000) * sampleRate)).fill(0));
  };
  const burst = (frequency: number, ms: number) => {
    const count = Math.round((ms / 1000) * sampleRate);
    for (let index = 0; index < count; index += 1) {
      // A raised-sine envelope at both ends: a burst that starts and stops at full amplitude clicks, and a
      // click is broadband noise the encoder has to spend bytes on.
      const envelope = Math.sin((Math.PI * index) / count);
      samples.push(Math.round(0.4 * envelope * Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 32767));
    }
  };

  for (const character of text) {
    if (character === ' ') {
      silence(70);
      continue;
    }
    // A per-character pitch, so the file's spectrum really depends on the utterance it stands for.
    burst(200 + ((character.codePointAt(0) ?? 0) % 18) * 24, 55);
    silence(6);
  }
  silence(200);

  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }

  fs.writeFileSync(filePath, buffer);
};

/**
 * Seeds the workspace e2e/voice-identifier-repair.spec.ts records in.
 *
 * Same reason as the two above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher and
 * broadcast as a session_upserted instead — which the sidebar correctly reads as "needs attention".
 *
 * It also writes the file the utterance names. That is what makes "the project's real file name" checkable:
 * the spec reads the name back off the disk rather than restating it, so a fixture that stopped writing this
 * file would fail the criterion instead of quietly agreeing with it.
 *
 * The WAV is written here too, and for the same class of reason: it has to exist before the browser that
 * plays it is launched, and this function runs once, in the process that owns the data directory, before
 * `webServer` starts anything.
 */
const seedVoiceIdentifierWorkspace = () => {
  fs.mkdirSync(VOICE_IDENTIFIER_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_IDENTIFIER_WORKSPACE, VOICE_IDENTIFIER_FILE),
    '// Seeded by playwright.config.ts so the voice spec has a real project file to assert against.\n',
    'utf8',
  );
  writeVoiceUtterance(VOICE_AUDIO_FILE, VOICE_UTTERANCE);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-identifier-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_IDENTIFIER_SESSION_ID,
      cwd: VOICE_IDENTIFIER_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the voice check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_IDENTIFIER_SESSION_ID,
      cwd: VOICE_IDENTIFIER_WORKSPACE,
      timestamp,
      customTitle: VOICE_IDENTIFIER_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_IDENTIFIER_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/voice-trim.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_TRIM_WORKSPACE = path.join(dataDir, 'voice-trim-workspace');
/** Session id that spec opens the composer in, and the display name it looks its sidebar row up by. */
const VOICE_TRIM_SESSION_ID = 'e2e-voice-trim';
const VOICE_TRIM_SESSION_NAME = 'voice-trim';
/** The rate the fixture is written at; the capture device plays it whether or not the browser runs at this rate. */
const VOICE_TRIM_SAMPLE_RATE = 48_000;

/**
 * The fixture's timeline: a wait for the mic, one phrase, the pause while the talker thinks, a
 * second phrase.
 *
 * The 1.6 s pause is the fixture's whole point. The shipped pause table keeps 0.18 s of a gap that
 * long, so a recording of this file has roughly 40 % of its duration removed by the trim — a
 * saving far too large for the spec's "the trimmed upload is shorter" assertion to be met by
 * jitter. The phrases are pitched differently so the two are distinguishable in the waveform, not
 * that anything here depends on it.
 */
const VOICE_TRIM_TIMELINE: readonly { readonly silenceMs: number; readonly phraseMs: number; readonly baseHz: number }[] = [
  { silenceMs: 300, phraseMs: 300, baseHz: 180 },
  { silenceMs: 1600, phraseMs: 300, baseHz: 240 },
];
/** Silence after the last phrase, before the file loops. */
const VOICE_TRIM_TAIL_MS = 100;

/**
 * The samples of that timeline, as a 48 kHz mono waveform.
 *
 * Each phrase is a stack of harmonics under a raised-sine envelope rather than one sine: a single
 * unbroken tone is the signal a broken capture chain also produces, and the energy detector the
 * trim runs needs something with a loudness envelope to measure.
 */
const voiceTrimFixture = (): Float32Array => {
  const samples: number[] = [];
  const pushSilence = (ms: number) => {
    samples.push(...new Array<number>(Math.round((ms / 1000) * VOICE_TRIM_SAMPLE_RATE)).fill(0));
  };
  const pushPhrase = (ms: number, baseHz: number) => {
    const count = Math.round((ms / 1000) * VOICE_TRIM_SAMPLE_RATE);
    for (let index = 0; index < count; index += 1) {
      const envelope = Math.sin((Math.PI * index) / count);
      const wave =
        0.5 * Math.sin((2 * Math.PI * baseHz * index) / VOICE_TRIM_SAMPLE_RATE)
        + 0.3 * Math.sin((2 * Math.PI * baseHz * 2.7 * index) / VOICE_TRIM_SAMPLE_RATE)
        + 0.2 * Math.sin((2 * Math.PI * baseHz * 5.1 * index) / VOICE_TRIM_SAMPLE_RATE);
      samples.push(0.4 * envelope * wave);
    }
  };

  for (const segment of VOICE_TRIM_TIMELINE) {
    pushSilence(segment.silenceMs);
    pushPhrase(segment.phraseMs, segment.baseHz);
  }
  pushSilence(VOICE_TRIM_TAIL_MS);
  return Float32Array.from(samples);
};

/** The fixture itself, built here because its length IS the duration the spec compares against. */
const VOICE_TRIM_SAMPLES = voiceTrimFixture();
/**
 * How long a recording of that fixture is when it is played once.
 *
 * Derived from the samples rather than declared beside them: the spec records for exactly this long
 * and then asserts the untrimmed upload is this long, so a number written down twice is a number
 * that can disagree with the audio it is supposed to describe.
 */
const VOICE_TRIM_FIXTURE_SEC = VOICE_TRIM_SAMPLES.length / VOICE_TRIM_SAMPLE_RATE;
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name it.
 * Written below, before `webServer` starts, because Chromium opens it at browser launch.
 */
const VOICE_TRIM_AUDIO_FILE = path.join(dataDir, 'voice-trim-utterance.wav');
process.env.QUAY_E2E_VOICE_TRIM_AUDIO = VOICE_TRIM_AUDIO_FILE;
process.env.QUAY_E2E_VOICE_TRIM_FIXTURE_SEC = String(VOICE_TRIM_FIXTURE_SEC);

/** Writes `samples` as a 16-bit PCM WAV. Same header the fixture generator in the voice identifier spec writes. */
const writeVoiceTrimFixture = (filePath: string, samples: Float32Array): void => {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(VOICE_TRIM_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(VOICE_TRIM_SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.round(samples[index] * 32767), 44 + index * 2);
  }
  fs.writeFileSync(filePath, buffer);
};

/** The project file the seeded workspace holds, so the project is a directory the app has really seen. */
const VOICE_TRIM_FILE = 'dictation.notes.md';

/**
 * Seeds the workspace e2e/voice-trim.spec.ts records in.
 *
 * Same reason as the three above: the backend scans ~/.claude/projects at boot and only then starts
 * its file watcher with `ignoreInitial`, so a transcript written while the test runs would be
 * picked up by the watcher and broadcast as a session_upserted — which the sidebar correctly reads
 * as "needs attention".
 *
 * The workspace holds one plain-prose file and nothing else. The spec's utterances are ordinary
 * sentences with no identifier in them, so the repair has nothing to rewrite them against; leaving
 * the workspace empty would also do, but a project the app has never seen a file in is not the
 * shape a real one has.
 */
const seedVoiceTrimWorkspace = () => {
  fs.mkdirSync(VOICE_TRIM_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_TRIM_WORKSPACE, VOICE_TRIM_FILE),
    'Notes kept in the workspace the voice trim spec records in.\nNothing here is named by the spoken fixture.\n',
    'utf8',
  );
  writeVoiceTrimFixture(VOICE_TRIM_AUDIO_FILE, VOICE_TRIM_SAMPLES);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-trim-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one
  // transcript has to carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_TRIM_SESSION_ID,
      cwd: VOICE_TRIM_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the trim check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_TRIM_SESSION_ID,
      cwd: VOICE_TRIM_WORKSPACE,
      timestamp,
      customTitle: VOICE_TRIM_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_TRIM_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/voice-dashscope-written.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_DASHSCOPE_WORKSPACE = path.join(dataDir, 'voice-dashscope-workspace');
/** Session id that spec opens the composer in, and the display name it looks its sidebar row up by. */
const VOICE_DASHSCOPE_SESSION_ID = 'e2e-voice-dashscope';
const VOICE_DASHSCOPE_SESSION_NAME = 'voice-dashscope';
/** The project file the seeded workspace holds, so the project is a directory the app has really seen. */
const VOICE_DASHSCOPE_FILE = 'recognition.notes.md';
/**
 * What the fake microphone is saying.
 *
 * An ordinary sentence with no identifier in it: the recogniser this spec points the settings at is a stand-in
 * under the test's own control, and what it answers is what lands in the composer — so the spoken fixture only
 * has to be *something* the capture chain can encode, not the text under assertion. It is spelled out rather
 * than borrowed from another spec's fixture because the two specs assert on different answers, and one file
 * serving both would make a change to either look like a change to both.
 */
const VOICE_DASHSCOPE_UTTERANCE = 'the workspace recogniser writes down the sentence it hears';
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name the file.
 * Written below, before `webServer` starts, because Chromium opens it at browser launch.
 */
const VOICE_DASHSCOPE_AUDIO_FILE = path.join(dataDir, 'voice-dashscope-utterance.wav');
process.env.QUAY_E2E_VOICE_DASHSCOPE_AUDIO = VOICE_DASHSCOPE_AUDIO_FILE;

/**
 * Seeds the workspace e2e/voice-dashscope-written.spec.ts records in.
 *
 * Same reason as the seeds above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while the test runs would be picked up by the watcher
 * and broadcast as a session_upserted — which the sidebar correctly reads as "needs attention".
 *
 * The WAV is written here for the same class of reason as the identifier seed's: it has to exist before the
 * browser that plays it is launched, and this function runs once, in the process that owns the data directory,
 * before `webServer` starts anything.
 */
const seedVoiceDashscopeWorkspace = () => {
  fs.mkdirSync(VOICE_DASHSCOPE_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_DASHSCOPE_WORKSPACE, VOICE_DASHSCOPE_FILE),
    'Notes kept in the workspace the voice provider spec records in.\nNothing here is named by the spoken fixture.\n',
    'utf8',
  );
  writeVoiceUtterance(VOICE_DASHSCOPE_AUDIO_FILE, VOICE_DASHSCOPE_UTTERANCE);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-dashscope-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_DASHSCOPE_SESSION_ID,
      cwd: VOICE_DASHSCOPE_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the provider check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_DASHSCOPE_SESSION_ID,
      cwd: VOICE_DASHSCOPE_WORKSPACE,
      timestamp,
      customTitle: VOICE_DASHSCOPE_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_DASHSCOPE_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/voice-error-messages.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_ERROR_WORKSPACE = path.join(dataDir, 'voice-error-messages-workspace');
/** Session id that spec opens the composer in, and the display name it anchors its sidebar row and its locators to. */
const VOICE_ERROR_SESSION_ID = 'e2e-voice-error-messages';
const VOICE_ERROR_SESSION_NAME = 'voice-error-messages';
/** The project file the seeded workspace holds, so the project is a directory the app has really seen. */
const VOICE_ERROR_FILE = 'failure.notes.md';
/**
 * What the fake microphone is saying.
 *
 * The same shape as the dashscope seed's fixture and for the same reason: the recogniser this spec points the
 * settings at is a stand-in under the test's own control, and every answer it gives on this spec's legs is a
 * failure envelope, so the spoken fixture only has to be something the capture chain can really encode. Spelled
 * out rather than borrowed from the seed above because the two specs assert on different answers, and one file
 * serving both would make a change to either look like a change to both.
 */
const VOICE_ERROR_UTTERANCE = 'the recogniser answers this recording with a failure about the request';
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name the file.
 * Written below, before `webServer` starts, because Chromium opens it at browser launch.
 */
const VOICE_ERROR_AUDIO_FILE = path.join(dataDir, 'voice-error-messages-utterance.wav');
process.env.QUAY_E2E_VOICE_ERROR_AUDIO = VOICE_ERROR_AUDIO_FILE;

/**
 * Seeds the workspace e2e/voice-error-messages.spec.ts records in.
 *
 * Same reason as the seeds above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while the test runs would be picked up by the watcher
 * and broadcast as a session_upserted instead — which the sidebar correctly reads as "needs attention". That
 * matters more for this spec than for its neighbours, because its own session row has to be told apart from the
 * rows every other seed in this file put in the same sidebar.
 *
 * The WAV is written here for the same class of reason as the identifier seed's: it has to exist before the
 * browser that plays it is launched, and this function runs once, in the process that owns the data directory,
 * before `webServer` starts anything.
 */
const seedVoiceErrorMessageWorkspace = () => {
  fs.mkdirSync(VOICE_ERROR_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_ERROR_WORKSPACE, VOICE_ERROR_FILE),
    'Notes kept in the workspace the voice failure-message spec records in.\nNothing here is named by the spoken fixture.\n',
    'utf8',
  );
  writeVoiceUtterance(VOICE_ERROR_AUDIO_FILE, VOICE_ERROR_UTTERANCE);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-error-messages-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_ERROR_SESSION_ID,
      cwd: VOICE_ERROR_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the failure-message check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_ERROR_SESSION_ID,
      cwd: VOICE_ERROR_WORKSPACE,
      timestamp,
      customTitle: VOICE_ERROR_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_ERROR_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/mobile-composer-send-key.spec.ts opens its composer in. */
const MOBILE_SEND_KEY_WORKSPACE = path.join(dataDir, 'mobile-send-key-workspace');
/** Session id that spec's project is registered by, and the display name it looks the row up by. */
const MOBILE_SEND_KEY_SESSION_ID = 'e2e-mobile-send-key';
const MOBILE_SEND_KEY_SESSION_NAME = 'mobile-send-key';

/**
 * Seeds the workspace e2e/mobile-composer-send-key.spec.ts drives the composer in.
 *
 * The spec needs a project to select, not a session to read, and indexing a session is what registers its
 * project — so one plain turn is enough. Same reason as the four above for placing it here rather than in
 * the spec: the backend scans ~/.claude/projects at boot and only then starts its file watcher with
 * `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher and broadcast as
 * a session_upserted, which the sidebar correctly reads as "needs attention".
 */
const seedMobileSendKeyWorkspace = () => {
  fs.mkdirSync(MOBILE_SEND_KEY_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'mobile-send-key-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: MOBILE_SEND_KEY_SESSION_ID,
      cwd: MOBILE_SEND_KEY_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the send-key check' }] },
    },
    {
      type: 'custom-title',
      sessionId: MOBILE_SEND_KEY_SESSION_ID,
      cwd: MOBILE_SEND_KEY_WORKSPACE,
      timestamp,
      customTitle: MOBILE_SEND_KEY_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${MOBILE_SEND_KEY_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** Workspace e2e/mobile-workspace-composer-layout.spec.ts reads its mobile cells in. */
const MOBILE_LAYOUT_WORKSPACE = path.join(dataDir, 'mobile-layout-workspace');
/** Session id that file navigates to, and the display name its header has to hold. */
const MOBILE_LAYOUT_SESSION_ID = 'e2e-mobile-layout';
/**
 * The name is deliberately long.
 *
 * The matrix asserts that the workspace header is a single row below the breakpoint, and the row it has to hold
 * holds this name next to the selector that replaced the tablist. A short name — every other seeded session in
 * this file has one — would fit whether or not the header had been collapsed, so the cell that reads the header
 * would pass against the layout it exists to rule out.
 */
const MOBILE_LAYOUT_SESSION_NAME = 'mobile workspace and composer layout session with a name long enough to truncate';

/**
 * Seeds the long-title session the viewport matrix's mobile cells read, in a workspace of its own.
 *
 * A workspace of its own for the same reason the four specs above have one: the header's dialog lists the
 * workspaces a run has, and a session added to one already in use is a new row in lists that other specs read
 * with unscoped locators. Placed here rather than in the spec for the reason the note above gives — the backend
 * starts its watcher with `ignoreInitial` only after the boot scan, so a transcript written mid-run is broadcast
 * as a session_upserted and read as "needs attention".
 */
const seedMobileLayoutWorkspace = () => {
  fs.mkdirSync(MOBILE_LAYOUT_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'mobile-layout-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const records = [
    {
      type: 'user',
      sessionId: MOBILE_LAYOUT_SESSION_ID,
      cwd: MOBILE_LAYOUT_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the layout matrix' }] },
    },
    {
      type: 'custom-title',
      sessionId: MOBILE_LAYOUT_SESSION_ID,
      cwd: MOBILE_LAYOUT_WORKSPACE,
      timestamp,
      customTitle: MOBILE_LAYOUT_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${MOBILE_LAYOUT_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/**
 * Fills this run's own dependency cache with a copy of the shared one, so `viteCacheDir` starts hot.
 *
 * Isolation is about who may *write* the cache, not about paying for a pre-bundle. Seeding by copy keeps the
 * run's start-up where it was: measured on this checkout, a cold pre-bundle adds ~1.2 s to the criterion, so
 * the copy is cheap insurance and every failure below simply degrades to that cold path rather than failing
 * the run. That is also why the copy is not verified beyond what is written here — a run that silently
 * optimizes from scratch is correct, only slower.
 *
 * The copy has to be repaired on the way in, but only in one of its two path fields. Vite stores both as
 * paths *relative to the deps directory that wrote them* (`stringifyDepsOptimizerMetadata`) and resolves them
 * back against whichever directory it reads them from (`parseDepsOptimizerMetadata`) — so both have to be
 * right for the directory they now live in, and the two need opposite treatment:
 *
 *   `file` is the optimized chunk itself, which sits *inside* the deps directory (`getOptimizedDepPath`
 *   builds it from that directory), so it is stored as a bare name like `react.js` and the copy brought it
 *   along. Left alone it is already correct, and it must be: resolving it against the directory it came from
 *   would point this run's chunk requests back into the shared directory, so the run would read chunk bytes
 *   from the very thing it is supposed to be isolated from — a sibling's re-optimization could then rename
 *   them away mid-run and the 504s would be back.
 *
 *   `src` is the module in `node_modules` the chunk was built from, which the copy did *not* bring along
 *   (`../../react/index.js`, reaching out of the deps directory into the checkout). Relocated verbatim it
 *   would resolve against this run's throwaway directory instead — naming nothing, and making a nested
 *   dependency (`react-dom > scheduler`) unmatchable in `tryOptimizedResolve`, the one place a cached `src`
 *   is genuinely consulted. Recomputing it for the new directory is what makes the seeded metadata say
 *   exactly what Vite would have written had it optimized into this directory itself.
 *
 * This is not a rare path: the seed is only usable at all when the shared cache was written by *this* root
 * (`configHash` includes the root), and that is precisely the case where Vite trusts these fields.
 *
 * Ownership matters: workers re-evaluate this file, and the cache in their `dataDir` is the one the run's own
 * server is serving from — so the caller runs this once, before the servers start, and never again.
 */
const seedViteCache = (destination: string): void => {
  const destinationDeps = path.join(destination, 'deps');
  fs.mkdirSync(destination, { recursive: true });
  try {
    // Resolved the way Vite resolves its own default, so this names the directory the run would otherwise
    // have shared. `node_modules` is this checkout's, which in a worktree is the symlink to the main one.
    const sharedDeps = path.resolve('node_modules', '.vite', 'deps');
    fs.cpSync(sharedDeps, destinationDeps, { recursive: true });

    const metadataPath = path.join(destinationDeps, '_metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      optimized?: Record<string, Record<string, unknown>>;
    };
    for (const entry of Object.values(metadata.optimized ?? {})) {
      // `file` is deliberately not touched — see above: it names a chunk the copy carried with it.
      const value = entry.src;
      if (typeof value === 'string') {
        entry.src = path.relative(destinationDeps, path.resolve(sharedDeps, value));
      }
    }
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  } catch {
    // A shared cache being rewritten by a sibling run right now (the very race this closes) can hand back a
    // torn or unreadable copy. Keeping it would leave Vite a cache whose entries no longer describe the files
    // beside them, so the copy is discarded and Vite optimizes into the private directory from scratch.
    fs.rmSync(destinationDeps, { recursive: true, force: true });
  }
};

if (isDataDirOwner) {
  seedViteCache(viteCacheDir);
  seedSessionFilterTranscripts();
  seedTranscriptFollowTranscript();
  seedVoiceIdentifierWorkspace();
  seedVoiceTrimWorkspace();
  seedVoiceDashscopeWorkspace();
  seedVoiceErrorMessageWorkspace();
  seedMobileSendKeyWorkspace();
  seedMobileLayoutWorkspace();
}

/**
 * The specs that drive the debug agent, and the fixture home the server gets when one of them is selected.
 *
 * The debug agent's provider is not a product provider: `provider.registry.ts` writes its key only while the gate
 * is open (`DEBUG_AGENT` + `DEBUG_AGENT_HOME`), so a server booted without those variables cannot arm a scenario,
 * cannot resolve provider `debug`, and mounts no control plane. Turning the gate on for every run would put a
 * fixture-writing provider and its HTTP face in front of every other spec's server — the face is authenticated but
 * it is still a surface nothing else asked for. `selectedSpecFiles()` is the seam that keeps that from happening:
 * the selection is this invocation's own command line, so the gate opens for exactly the runs that name one of the specs
 * below and the env object is byte-identical to what it was for every other selection.
 *
 * The home is a directory of its own under `dataDir`, and NOT `dataDir` itself, which it used to be. The reason is
 * a collision rather than a preference. `getDebugAgentProjectsRoot()` answers `<home>/.claude/projects`, and the
 * server's `HOME` is `dataDir` — so `home = dataDir` put the fixture transcripts inside `<HOME>/.claude/projects`,
 * which is exactly the tree the *claude* provider scans and watches. Both indexers then claimed every armed
 * transcript and the claude one, running from the watcher after the arming call, won: the row ended up stored
 * under provider `claude` while carrying the `resident` mode the debug seam had written, and `POST
 * /api/session-hosts/:sessionId/start` resolved the claude host driver for it — a driver that refuses to open a
 * resident host on demand, because for claude a resident host is born in the driver's run entry. The criterion
 * could not start the process it had armed.
 *
 * A home of its own keeps the two readers apart, and nothing is lost by it: arming indexes the transcript itself
 * (`synchronizeFile`) rather than waiting for a disk scan, so the session row, its project link and its stored
 * mode all exist regardless of where the file sits. The old comment's worry — "a home anywhere else would write
 * transcripts no listing could see" — describes a reader that no longer exists.
 */
// A list rather than one name: the fixture home is a *directory* under `dataDir`, so specs that ask for the
// gate share it, and each derives its own workspace beneath it. Splitting the home per spec would buy nothing —
// the collision the block above describes is between the fixture tree and the *claude* provider's scan root, not
// between two fixture users — and the specs never run in one invocation, since a selection names one file.
const DEBUG_AGENT_SPEC_FILES: readonly string[] = [
  // The status bar's own criterion.
  'resident-status-bar.spec.ts',
  // The busy-send criterion: same provider, same control plane, same fixture home — a second
  // entry here rather than a second gate, so a run that selects only one of them boots one server.
  'resident-busy-send.spec.ts',
  // The running-view criterion: same provider and control plane again, so the same argument holds.
  'resident-running-view.spec.ts',
  // The layout criterion: same provider, same control plane and fixture home as the three above. It
  // arms two sessions off the same clock (one stored resident, one per-run) to read both the status
  // bar's geometry and the composer switch's presence and absence in one run, so it needs that plane.
  'resident-ui-layout.spec.ts',
  // The activity-dock truthfulness criterion: same provider and control plane again, and it needs one
  // extra thing from this selection — a server whose heartbeat beat and silence threshold are short
  // enough to watch a degrade inside the 60s gate. That override is applied to the server env below,
  // for this selection only; every other selection keeps the shipped 5000/15000.
  'activity-dock-truthful.spec.ts',
];
const debugAgentFixtureHome = selectedSpecFiles().some((file) => DEBUG_AGENT_SPEC_FILES.includes(file))
  ? path.join(dataDir, 'debug-agent-home')
  : null;
// The criterion that watches the dock degrade needs to see the server's beat and its silence budget
// inside one gate. Only this selection shortens them, and only on the *server*: the client reads the
// numbers the server announces in its hello, so the spec itself carries no threshold literal.
const shortenActivityHeartbeat = selectedSpecFiles().includes('activity-dock-truthful.spec.ts');
// Published to the workers because the spec has to place its fixture project *inside* this directory:
// the control plane refuses a `projectPath` outside the fixture home, and the spec process does not
// inherit the server's own `DEBUG_AGENT_HOME`. Empty — not absent — for every other selection, which
// is also the value that tells the spec there is no fixture home to write under.
process.env.QUAY_E2E_DEBUG_AGENT_HOME = debugAgentFixtureHome ?? '';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  // Traces and failure contexts are written here. Under this run's own throwaway directory rather than the
  // shared `test-results/`, so two runs in one checkout stop overwriting each other's evidence (the loser of
  // that race used to fail at teardown on a directory the winner had already replaced).
  outputDir: path.join(dataDir, 'test-results'),
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  // Both ceilings are deliberately under the 60s a criterion may take: the goal gate that runs this command
  // kills it at 60s, and a run killed from outside reports nothing about why. A server that is spawned but
  // never answers therefore has to be given up on here, where the failure is still this run's to explain.
  // Boot costs ~8s on a loaded machine, so 30s is ~3x the observed worst case rather than a tight fit.
  webServer: [
    {
      command: 'npx tsx --tsconfig server/tsconfig.json server/index.ts',
      url: SERVER_HEALTH_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        SERVER_PORT: String(serverPort),
        HOST: '127.0.0.1',
        DATABASE_PATH: path.join(dataDir, 'auth.db'),
        HOME: dataDir,
        // The start-up sweep stops every orphaned session scope on the host, not only this run's; a
        // throwaway e2e server has no business reaping the operator's.
        CLAUDE_SESSION_SCOPE_SWEEP: 'off',
        // Absent — not empty — for every selection that names neither debug agent spec, so the gate stays
        // closed exactly as it does today. See `debugAgentFixtureHome` above.
        ...(debugAgentFixtureHome
          ? { DEBUG_AGENT: '1', DEBUG_AGENT_HOME: debugAgentFixtureHome }
          : {}),
        // Sub-second beat and threshold, for the activity-dock criterion's selection only. The
        // shipped defaults (5000/15000) are the product's and are untouched everywhere else.
        ...(shortenActivityHeartbeat
          ? { ACTIVITY_HEARTBEAT_INTERVAL_MS: '300', ACTIVITY_UNREACHABLE_AFTER_MS: '900' }
          : {}),
      },
    },
    {
      // `--strictPort`: without it vite treats a taken port as a hint and silently serves on the next free one,
      // so the url checked below — the port the browser is sent to — would never answer and the run would sit
      // here until the ceiling instead of reporting the port. Strict, it fails at once and says which port.
      command: 'npx vite --host 127.0.0.1 --strictPort',
      url: CLIENT_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        SERVER_PORT: String(serverPort),
        VITE_PORT: String(clientPort),
        HOST: '127.0.0.1',
        // Read by vite.config.js as its `cacheDir`. Without it every run on this machine pre-bundles into the
        // one `node_modules/.vite` the worktree symlinks share, and a re-optimization there 504s whatever
        // another run already has in flight — the failure this whole file's comment above describes.
        VITE_CACHE_DIR: viteCacheDir,
        // The client's send deadline, shortened for the dock criterion's selection only. The spec fails a send
        // while the server is silent and reads the failure inside its own 5s budget, so the shipped 5s deadline
        // would sit exactly on that budget's edge; the criterion carries no deadline literal of its own, it
        // reads what the client was built with here. Every other selection keeps the shipped 5000ms.
        ...(shortenActivityHeartbeat ? { VITE_SEND_DELIVERY_TIMEOUT_MS: '600' } : {}),
      },
    },
  ],
});
