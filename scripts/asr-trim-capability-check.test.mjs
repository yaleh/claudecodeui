#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-trim-capability-check.mjs (AC-135).
 *
 * Each case below first runs the probe against an UNMUTATED fixture and requires green, then
 * applies exactly one mutation and requires red on the check whose name the case carries. Both
 * halves matter: only the second proves the probe notices the fake form, and only the first proves
 * the red came from the mutation rather than from a probe that is red for every input.
 *
 * The fixture is built at run time, in a temporary directory, OUT OF THE SHIPPING FILES — copied,
 * never re-typed. A hand-written stub would prove the probe reads the stub, and a fixture checked
 * into the repository would be a second declaration of the capability the uniqueness check is
 * looking for.
 *
 * The cases are the two fake forms the criterion names, one for each direction the composition can
 * break from:
 *
 *   · the decision stays in the client and the capability is never read (AC-135 AC3's fake) —
 *     `single-source`;
 *   · the client reads the capability, and answers 裁不裁 by hand beside the read point —
 *     `single-source` again, from the other end;
 *   · the default is changed to "do not trim" (AC-135 AC2's fake) — `default`;
 *   · the read point is gutted so the capability is read but changes nothing (AC-135 AC5's empty
 *     reading) — `read-point`;
 *   · a non-destructive declaration with no experiment to point at (AC-135 AC7) — `discipline`.
 *
 * Run with: node --test scripts/asr-trim-capability-check.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBE = path.join(SCRIPT_DIR, 'asr-trim-capability-check.mjs');

const DECLARING_MODULE = 'src/shared/voiceTrim.ts';
const CONSUMER = 'src/modules/chat/hooks/useVoiceInput.ts';
const SWITCH = 'src/shared/voiceDebug.ts';
const EVIDENCE = 'docs/experiments/2026-09-22-voice-provider-paired-quality.md';

/**
 * The shipping files a fixture needs: the declaring module, the file that reaches its read point,
 * the module the shipped switch's default is read from, and the experiment record the declaration
 * points at — which has to exist, or the discipline check reds before the case under test runs.
 */
const SHIPPING_FILES = [DECLARING_MODULE, CONSUMER, SWITCH, EVIDENCE];

/** The read point's own body in the declaring module; the mutations below rewrite it. */
const READ_POINT_BODY = "  return { pauseCues, trim: pauseCues === 'destructive' };";

/** The gate the consumer opens the trim with, and the three imports that gate needs. */
const CONSUMER_GATE = [
  '  const recogniser = pauseCuesFor(OPENAI_COMPATIBLE_PROVIDER);',
  '  if (!isVoiceTrimEnabled() || !trimDecisionFor(recogniser.pauseCues).trim) return recorded;',
].join('\n');
const CONSUMER_GATE_WITHOUT_CAPABILITY = '  if (!isVoiceTrimEnabled()) return recorded;';
const CONSUMER_IMPORT = [
  'import {',
  '  OPENAI_COMPATIBLE_PROVIDER,',
  '  pauseCuesFor,',
  '  trimDecisionFor,',
  '  trimVoiceAudio,',
  "} from '@/shared/voiceTrim';",
].join('\n');
const CONSUMER_IMPORT_WITHOUT_CAPABILITY = "import { trimVoiceAudio } from '@/shared/voiceTrim';";

/** The declaration table as it is written in the shipping module; the zero-row case empties it. */
const DECLARATION_TABLE = [
  'export const PAUSE_CUES_DECLARATIONS: readonly PauseCuesDeclaration[] = [',
  '  {',
  '    provider: OPENAI_COMPATIBLE_PROVIDER,',
  "    pauseCues: 'destructive',",
  `    evidence: '${EVIDENCE}',`,
  '  },',
  '];',
].join('\n');
const DECLARATION_TABLE_EMPTY = 'export const PAUSE_CUES_DECLARATIONS: readonly PauseCuesDeclaration[] = [];';

/** The declared row, as it is written in the shipping module. */
const DECLARED_ROW = [
  '  {',
  '    provider: OPENAI_COMPATIBLE_PROVIDER,',
  "    pauseCues: 'destructive',",
  `    evidence: '${EVIDENCE}',`,
  '  },',
].join('\n');

/**
 * @returns {string} a fixture tree copied from the shipping files
 */
function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-trim-capability-'));
  for (const relativePath of SHIPPING_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO_ROOT, relativePath), destination);
  }
  return root;
}

/**
 * @param {string} root
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runProbe(root) {
  const result = spawnSync(process.execPath, [PROBE, '--root', root], { encoding: 'utf8' });
  assert.equal(result.error, undefined, `the probe could not be started: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Replaces `from` with `to` in a fixture file, requiring exactly one occurrence — a mutation that
 * matched nothing (because the shipping source moved on) would leave the case asserting about an
 * unmutated tree.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} from
 * @param {string} to
 */
function patch(root, relativePath, from, to) {
  const file = path.join(root, relativePath);
  const source = readFileSync(file, 'utf8');
  const occurrences = source.split(from).length - 1;
  assert.equal(occurrences, 1, `the mutation does not match ${relativePath} exactly once (${occurrences})`);
  writeFileSync(file, source.replace(from, to));
}

/**
 * A fixture whose probe run is green — the precondition every mutation case starts from.
 * @param {import('node:test').TestContext} t
 * @returns {string} the fixture root
 */
function greenFixture(t) {
  const root = buildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = runProbe(root);
  assert.equal(
    baseline.status,
    0,
    `the unmutated fixture must pass, otherwise the mutation below proves nothing:\n${baseline.stdout}`,
  );
  return root;
}

/**
 * Runs the mutated fixture and requires the named check to be the one that failed — not merely
 * that the probe exited non-zero, which a fixture that was already broken would also satisfy.
 * @param {string} root
 * @param {string} checkName
 * @returns {string} the probe's stdout, so a case can go on to assert the cause it printed
 */
function expectCheckFails(root, checkName) {
  const result = runProbe(root);
  assert.equal(result.status, 1, `the probe must red this fake form:\n${result.stdout}`);
  assert.match(
    result.stdout,
    new RegExp(`^check ${checkName}: FAIL `, 'm'),
    `${checkName} is not the check that failed:\n${result.stdout}`,
  );
  return result.stdout;
}

test('the shipped tree decides 裁不裁 from the recogniser declaration', () => {
  const result = runProbe(REPO_ROOT);
  assert.equal(result.status, 0, `the shipping tree reds its own criterion:\n${result.stdout}`);
  for (const checkName of ['declaration', 'read-point', 'single-source', 'decision', 'default', 'discipline']) {
    assert.match(result.stdout, new RegExp(`^check ${checkName}: ok `, 'm'), `no reading for ${checkName}`);
  }
  // The read point's symbol name is printed, which is what AC3 asks the probe to show.
  assert.match(result.stdout, /^check read-point: ok .*trimDecisionFor/m);
});

test('green fixture — the falsifiers below start from a passing tree', (t) => {
  const root = greenFixture(t);
  const result = runProbe(root);
  assert.equal(result.status, 0, result.stdout);
});

test('a consumer that keeps deciding 裁不裁 for itself reds single-source (AC3 fake: the capability is never read)', (t) => {
  const root = greenFixture(t);
  patch(root, CONSUMER, CONSUMER_GATE, CONSUMER_GATE_WITHOUT_CAPABILITY);
  patch(root, CONSUMER, CONSUMER_IMPORT, CONSUMER_IMPORT_WITHOUT_CAPABILITY);
  expectCheckFails(root, 'single-source');
});

test('a consumer that answers 裁不裁 by hand beside the read point reds single-source (AC3 fake: a second read point)', (t) => {
  const root = greenFixture(t);
  patch(
    root,
    CONSUMER,
    CONSUMER_GATE,
    `${CONSUMER_GATE}\n  const byHand = recogniser.pauseCues === 'destructive';`,
  );
  expectCheckFails(root, 'single-source');
});

test('changing the declared default to "do not trim" reds default (AC2 fake: the shipped pairing must red)', (t) => {
  const root = greenFixture(t);
  // The experiment record stays in place: what this case changes is the value, so the red has to
  // come from the decision and not from the discipline check beside it.
  patch(root, DECLARING_MODULE, DECLARED_ROW, DECLARED_ROW.replace("'destructive'", "'useful'"));
  expectCheckFails(root, 'default');
});

test('a read point that answers the same thing for both capabilities reds read-point (AC5 fake: the empty reading)', (t) => {
  const root = greenFixture(t);
  patch(root, DECLARING_MODULE, READ_POINT_BODY, '  return { pauseCues, trim: true };');
  expectCheckFails(root, 'read-point');
});

test('a non-destructive declaration with no experiment to point at reds discipline (AC7)', (t) => {
  const root = greenFixture(t);
  patch(root, DECLARING_MODULE, DECLARED_ROW, DECLARED_ROW.replace("'destructive'", "'useful'").replace(`\n    evidence: '${EVIDENCE}',`, ''));
  expectCheckFails(root, 'discipline');
});

test('a fixture whose declaring module is deleted reds declaration rather than passing on an empty scan', (t) => {
  const root = greenFixture(t);
  rmSync(path.join(root, DECLARING_MODULE));
  expectCheckFails(root, 'declaration');
});

/**
 * AC5's zero-row arm. Distinct from the deletion above: there the table is gone, here it is present
 * and empty — and an empty table is exactly the shape that would otherwise read as "no capability
 * contradicts the trim", with the check finding nothing to contradict instead of nothing to read.
 * The printed cause is asserted too: "declared nowhere" would be a different observation, and a
 * reader chasing this failure deserves the one that actually happened.
 */
test('a declaration table with no rows reds declaration with the zero-row cause (AC5)', (t) => {
  const root = greenFixture(t);
  patch(root, DECLARING_MODULE, DECLARATION_TABLE, DECLARATION_TABLE_EMPTY);
  const stdout = expectCheckFails(root, 'declaration');
  assert.match(stdout, /has a row — a table with 0 rows is a zero-row reading/, stdout);
});
