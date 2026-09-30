#!/usr/bin/env node
/**
 * The controls for `scripts/voice-capture-process-check.mjs` (AC-148's criterion; AC5 of
 * `gap-voice-capture-real-process`).
 *
 * The criterion reports that a REAL server process, started from a real `server/index.ts` under a
 * real `VOICE_CAPTURE`, writes a start-up line and a capture row to its stdout. A criterion that
 * says so and nothing more is worth exactly as much as the fakes it can tell apart from that
 * outcome — and the fake this one exists to catch is named in the task's DoD: "the capture only
 * holds inside a unit test's injected port and was never wired into the real service's assembly".
 * A tree in which the seam is never handed to `createVoiceService` boots perfectly and transcribes
 * perfectly; only the capture-row reading notices.
 *
 * So each case here is a PAIR, in this order:
 *
 *   1. the criterion runs against an unmutated throwaway tree and must exit 0;
 *   2. the SAME tree, with ONE textual change in `server/modules/voice/voice.module.ts`, runs again
 *      and must exit 1 — with the change of exactly one named reading, and with the other case's
 *      reading still green.
 *
 * The first half is what makes the second mean anything: without it, "it went red" could just as
 * well be "this tree never ran". The second half is read off the criterion's own printed readings
 * and its own `check.failure:` lines, not off the exit code alone, which is why each case asserts
 * three things about the mutant: its status is 1 (not 2, which the criterion reserves for "the
 * measurement could not be made"), the named reading is wrong, and the reading the OTHER case
 * reds is still right. Two mutations that both took the whole criterion down would satisfy
 * "red" and fail this.
 *
 * WHAT THE TWO MUTATIONS ARE, AND WHY THEY ARE SHAPED THIS WAY.
 *
 *   `assembly-not-wired` deletes the one place that hands the capture port to the service —
 *   `capture: createVoiceCapture({ ... }),`, whose argument object the audio tier later grew (AC-145
 *   added the `audio` sink), so the anchor below is the whole multi-line property. The port is
 *   optional, so the service still transcribes and the start-up line is still printed; only
 *   `capture.lines` moves, 1 → 0.
 *
 *   `startup-line-missing` deletes the one call that announces the mode. It is NOT a bare
 *   deletion: `voiceCapture` is read again eight lines later, so removing the statement outright
 *   makes the module throw at load, the child never prints `CloudCLI Server - Ready`, and the
 *   criterion exits 2 with no readings at all — a red that names nothing, which is the failure
 *   shape this AC is written against. The mutation therefore deletes the announcing call and
 *   inlines the single field the rest of the file reads, which is the smallest single-site change
 *   that removes the announcement and nothing else. `startup.text.count` moves, 1 → 0; the capture
 *   row is still recorded.
 *
 * WHERE THE MUTATIONS ARE APPLIED. Never to this checkout. Each case builds its own tree by
 * HARD-LINKING the repo (`cp -al`, the mechanism AC5 names — the criterion boots a real server out
 * of it, and 1 700 hard links cost milliseconds where a byte copy costs a second), points the
 * criterion at it with `--root`, and removes it when the case ends. The one file a case mutates is
 * REPLACED rather than written in place: under `cp -al` that path shares its inode with the
 * checkout's file, so an in-place write would edit the checkout through the link. `mutate` asserts
 * the checkout's copy is byte-identical after the substitution, which is the reading that says the
 * hard link was not written through.
 *
 * `.git` IS REMOVED FROM THE COPY, and that is a safety measure rather than tidiness. In a worktree
 * `.git` is not a directory but an 88-byte pointer file holding the absolute path of the real git
 * directory; hard-linked into the copy it is a live wire into this checkout's git state, so any git
 * command run from the copy would write into the real worktree's administrative files. In the
 * PRIMARY checkout `.git` is a plain directory, so the removal must say `recursive: true`: a
 * `force`-only `rmSync` on a directory throws `ERR_FS_EISDIR`, which is exactly how this control was
 * red in the primary checkout (and it then leaked the copy). The criterion needs no git — it boots a
 * server, mints a token and makes one HTTP request — so the wire is cut, in either shape.
 *
 * ONE READING IS TAKEN OUT OF THE PICTURE. `DATABASE_PATH` is deleted from the criterion's
 * environment here, so its `real-db-untouched` reading is trivially true and the mutant's red is
 * attributable to the named reading and nothing else. That reading is about a file this control
 * does not own — the deployer's live database, which this repository's own running server writes to
 * — and a case that reds because the operator's traffic happened to land inside its window would be
 * reporting on the host rather than on its mutation. The criterion measures it, under the real
 * inherited value, on its own runs.
 *
 * THE CHECKOUT IS READ BEFORE AND AFTER. AC5 asks that the worktree's `git status --porcelain` be
 * empty once the copies are gone. Every case asserts the invariant that makes that meaningful — no
 * TRACKED file in the checkout was modified, and no entry anywhere in the status names a file this
 * control can reach — and the full status is printed before and after so a reader can see it.
 *
 * The tracked half is the assertion rather than literal emptiness because the rest of this suite
 * writes into the tree while the tests run: measured here, a sibling script test creates and removes
 * `scripts/.probe-mutant-<random>/` about 55 s into a `npm run test:scripts` run. The copy is the
 * only thing this control can write to, and a write through a hard link lands on a TRACKED file —
 * so tracked-modification is exactly the harm, and a control that reds on another test's scratch
 * directory would be measuring the suite rather than itself.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const CRITERION_REL = join('scripts', 'voice-capture-process-check.mjs');
const MODULE_REL = join('server', 'modules', 'voice', 'voice.module.ts');

/** The criterion's own wall-clock budget is 45 s; this is the outer bound on one invocation. */
const CRITERION_TIMEOUT_MS = 120_000;

/**
 * How many times a run that exits 2 is re-attempted before a case gives up.
 *
 * `2` is the criterion's own "the measurement could not be made" — a port taken between the
 * reservation and the bind, say. That is not a verdict about the tree, so it is not read as one;
 * a run that reaches this bound fails the case with the criterion's own stderr in the message.
 */
const COULD_NOT_MEASURE_RETRIES = 2;

/** A prefix unique to this process, so a concurrent run in another worktree is not read as litter. */
const COPY_PREFIX = `voice-capture-false-forms-${process.pid}-`;

/** The statement that resolves the mode AND announces it — the only announcement in the process. */
const ANNOUNCING_CALL =
  'const voiceCapture = announceVoiceCapture(process.env.VOICE_CAPTURE, voiceLog);';

/** What replaces it: the same resolution with the announcement gone, and nothing else changed. */
const NON_ANNOUNCING_MODE =
  "const voiceCapture = { mode: process.env.VOICE_CAPTURE === 'text' ? 'text' : 'off' };";

/**
 * The one place the capture port is handed to the service, newline included so the line goes too.
 *
 * The property is the whole multi-line value, not a single line: the audio tier (AC-145) grew the
 * argument object an `audio` sink, so an anchor naming the old single-line form matches nothing and
 * the mutation would silently leave the tree green while the case reported "red after mutation".
 * `substituteOnce` asserts the site count first, so a future reshape fails loudly here rather than
 * as an unattributable red.
 */
const CAPTURE_INJECTION =
  '  capture: createVoiceCapture({\n' +
  '    mode: voiceCapture.mode,\n' +
  '    log: voiceLog,\n' +
  '    audio: createVoiceCaptureAudioSink({ directory: voiceCaptureDirectory }),\n' +
  '  }),\n';

/**
 * @typedef {object} Mutation
 * @property {string} name            printed as `mutation=<name>`
 * @property {string} reds            the reading this mutation must turn wrong
 * @property {string} keeps           the reading the other case reds, which must stay right
 * @property {string} redsValue       what `reds` must read after the mutation
 * @property {string} keepsValue      what `keeps` must read after the mutation
 * @property {(source: string) => string} apply
 */

/** @type {Mutation[]} */
const MUTATIONS = [
  {
    name: 'assembly-not-wired',
    reds: 'capture.lines',
    keeps: 'startup.text.count',
    redsValue: '0',
    keepsValue: '1',
    apply: (source) => substituteOnce(source, CAPTURE_INJECTION, '', 'delete the capture injection'),
  },
  {
    name: 'startup-line-missing',
    reds: 'startup.text.count',
    keeps: 'capture.lines',
    redsValue: '0',
    keepsValue: '1',
    apply: (source) => substituteOnce(source, ANNOUNCING_CALL, NON_ANNOUNCING_MODE, 'delete the announcement'),
  },
];

/**
 * Applies a one-site substitution, asserting the site count first.
 *
 * The count is not decoration: a mutation that matched nothing would leave the tree green while
 * the case reported "red after mutation", and a mutation that matched twice would be two changes
 * wearing one name. Both are read here rather than discovered as a confusing red later.
 *
 * @param {string} source
 * @param {string} needle
 * @param {string} replacement
 * @param {string} what
 * @returns {string}
 */
function substituteOnce(source, needle, replacement, what) {
  const sites = source.split(needle).length - 1;
  assert.equal(
    sites,
    1,
    `${what}: the mutation site occurs ${sites} times in ${MODULE_REL}, expected exactly 1 — ` +
      'the shipped assembly changed shape under this control',
  );
  return source.split(needle).join(replacement);
}

/**
 * The checkout's porcelain status.
 *
 * `trackedOnly` drops the untracked entries, which is what a case uses: see the header — the suite
 * itself creates scratch directories in the tree while these tests run.
 *
 * @param {boolean} [trackedOnly]
 * @returns {string} the status, trimmed — '' when there is nothing to report.
 */
function gitStatus(trackedOnly = false) {
  const args = ['-C', REPO_ROOT, 'status', '--porcelain'];
  if (trackedOnly) args.push('--untracked-files=no');
  const result = spawnSync('git', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `git status failed in ${REPO_ROOT}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * The status entries a write from this control would have produced: a modified assembly, or anything
 * under a copy this control made. Empty is the reading.
 *
 * @param {string} status
 * @returns {string[]}
 */
function attributableEntries(status) {
  return status
    .split('\n')
    .filter((line) => line.includes(MODULE_REL) || line.includes(COPY_PREFIX));
}

/**
 * Hard-links the checkout into a throwaway tree and cuts the `.git` wire. See the header.
 *
 * `recursive: true` is the whole point: in the primary checkout `.git` is a directory, and
 * `rmSync` without it throws `ERR_FS_EISDIR` before the case has run (leaking the copy). In a
 * worktree `.git` is a pointer file, which the same call removes just as well.
 *
 * @returns {string} the copy's root
 */
function buildCopy() {
  const copyRoot = mkdtempSync(join(tmpdir(), COPY_PREFIX));
  const copied = spawnSync('cp', ['-al', `${REPO_ROOT}/.`, copyRoot], { encoding: 'utf8' });
  assert.equal(copied.status, 0, `cp -al ${REPO_ROOT} failed: ${copied.stderr}`);
  rmSync(join(copyRoot, '.git'), { force: true, recursive: true });
  return copyRoot;
}

/**
 * Rewrites the assembly in the copy, replacing the file rather than editing it.
 *
 * @param {string} copyRoot
 * @param {Mutation} mutation
 */
function mutate(copyRoot, mutation) {
  const target = join(copyRoot, MODULE_REL);
  const pristine = readFileSync(target, 'utf8');
  const mutated = mutation.apply(pristine);
  assert.notEqual(mutated, pristine, `${mutation.name}: the mutation changed nothing`);

  // Replace, never edit in place: `cp -al` gave this path the checkout file's inode.
  rmSync(target);
  writeFileSync(target, mutated);

  assert.equal(
    readFileSync(join(REPO_ROOT, MODULE_REL), 'utf8'),
    pristine,
    `${mutation.name}: the mutation reached the checkout through the hard link`,
  );
}

/**
 * Runs the criterion against a copy, re-attempting only the "could not measure" exit.
 *
 * @param {string} copyRoot
 * @returns {{ status: number | null, stdout: string, stderr: string, attempts: number }}
 */
function runCriterion(copyRoot) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.FORCE_COLOR = '0';
  // See the header: the inherited database is not this control's to measure, and leaving it in
  // would let the deployer's traffic decide whether a mutation looks red.
  delete env.DATABASE_PATH;
  // Node treats a set NO_COLOR beside FORCE_COLOR as a contradiction and warns on every start;
  // FORCE_COLOR=0 is the instruction that has to win here, so the other one is removed.
  delete env.NO_COLOR;
  // The runner sets this for processes it starts; the criterion drives real servers of its own.
  delete env.NODE_TEST_CONTEXT;

  let attempts = 0;
  /** @type {import('node:child_process').SpawnSyncReturns<string> | undefined} */
  let result;
  for (;;) {
    attempts += 1;
    result = spawnSync(process.execPath, [join(copyRoot, CRITERION_REL), '--root', copyRoot], {
      cwd: copyRoot,
      env,
      encoding: 'utf8',
      timeout: CRITERION_TIMEOUT_MS,
    });
    if (result.status !== 2 || attempts > COULD_NOT_MEASURE_RETRIES) break;
  }

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    attempts,
  };
}

/**
 * @param {string} stdout
 * @returns {Map<string, string>} every `key=value` line the criterion printed
 */
function readReadings(stdout) {
  const readings = new Map();
  for (const line of stdout.split('\n')) {
    const match = /^([a-z][a-z0-9.-]*)=(.*)$/.exec(line);
    if (match) readings.set(match[1], match[2]);
  }
  return readings;
}

/** @param {string} stdout @returns {string[]} the reasons, with the criterion's prefix stripped. */
function readFailures(stdout) {
  const prefix = 'check.failure: ';
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** @param {string} failure @param {string} key @returns {boolean} */
function namesReading(failure, key) {
  return failure.startsWith(`${key} `) || failure.startsWith(`${key}=`);
}

/** Read once, at load, so each case can compare against how the run found the checkout. */
const REPO_TRACKED_STATUS_AT_START = gitStatus(true);

for (const mutation of MUTATIONS) {
  test(`AC5 ${mutation.name}: green before the mutation, red on ${mutation.reds} after`, async () => {
    const copyRoot = buildCopy();
    try {
      const base = runCriterion(copyRoot);
      assert.equal(
        base.status,
        0,
        `${mutation.name}: the UNMUTATED copy exited ${base.status} (attempts=${base.attempts}) — ` +
          `without this half the mutant's red would prove nothing\nstdout:\n${base.stdout}\nstderr:\n${base.stderr}`,
      );

      mutate(copyRoot, mutation);
      const mutant = runCriterion(copyRoot);
      const readings = readReadings(mutant.stdout);
      const failures = readFailures(mutant.stdout);

      assert.equal(
        mutant.status,
        1,
        `${mutation.name}: the mutated copy exited ${mutant.status} (attempts=${mutant.attempts}), expected 1 — ` +
          `2 is the criterion's own "could not measure" and proves nothing about the mutation\n` +
          `stdout:\n${mutant.stdout}\nstderr:\n${mutant.stderr}`,
      );
      assert.equal(
        readings.get(mutation.reds),
        mutation.redsValue,
        `${mutation.name}: ${mutation.reds} reads ${String(readings.get(mutation.reds))}, expected ${mutation.redsValue}`,
      );
      assert.equal(
        readings.get(mutation.keeps),
        mutation.keepsValue,
        `${mutation.name}: ${mutation.keeps} reads ${String(readings.get(mutation.keeps))}, expected ` +
          `${mutation.keepsValue} — the two mutations must not mask each other`,
      );
      assert.ok(
        failures.some((failure) => namesReading(failure, mutation.reds)),
        `${mutation.name}: no check.failure names ${mutation.reds}; the criterion red for some other reason: ` +
          `${JSON.stringify(failures)}`,
      );
      assert.ok(
        !failures.some((failure) => namesReading(failure, mutation.keeps)),
        `${mutation.name}: ${mutation.keeps} was reported as wrong too, so the red is not attributable: ` +
          `${JSON.stringify(failures)}`,
      );

      process.stdout.write(
        `mutation=${mutation.name} baseExit=${base.status} mutantRed=${mutant.status === 1} ` +
          `whichReading=${mutation.reds}\n`,
      );
    } finally {
      rmSync(copyRoot, { recursive: true, force: true });
    }

    assert.equal(existsSync(copyRoot), false, `${mutation.name}: the throwaway copy survived the case`);
    assert.equal(
      gitStatus(true),
      REPO_TRACKED_STATUS_AT_START,
      `${mutation.name}: a tracked file in the checkout changed — the mutation was written through the hard link`,
    );
  });
}

test('AC5 the controls leave the checkout exactly as they found it', () => {
  const trackedNow = gitStatus(true);
  const statusNow = gitStatus();
  process.stdout.write(
    `repo-tracked-status=${trackedNow.replace(/\n/g, ' | ') || '<clean>'}\n` +
      `repo-status=${statusNow.replace(/\n/g, ' | ') || '<clean>'}\n`,
  );

  assert.equal(trackedNow, REPO_TRACKED_STATUS_AT_START, 'these controls modified a tracked file in the checkout');
  assert.deepEqual(
    attributableEntries(statusNow),
    [],
    'the checkout reports an entry this control could have produced',
  );

  const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith(COPY_PREFIX));
  assert.deepEqual(leftovers, [], 'a throwaway copy survived the run');
});
