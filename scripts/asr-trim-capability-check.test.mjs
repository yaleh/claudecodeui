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
 * The record the OTHER registered provider's row names. The discipline check reads every row, not
 * just the effective one, so a fixture carrying the registry without this file reds the `discipline`
 * check before any case under test runs — and the two records are deliberately different files,
 * because decision 1 is a per-provider obligation.
 */
const SECOND_EVIDENCE = 'docs/experiments/2026-09-23-gemini.md';
/** Where the declarations live now: the adapter module of the recogniser registered FIRST. */
const FIRST_ADAPTER = 'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts';
const REGISTRY = 'shared/asr/asrRegistry.ts';

/**
 * The shipping files a fixture needs: the declaring module (the vocabulary and the read point),
 * the file that reaches the read point, the module the shipped switch's default is read from, the
 * experiment record the declaration points at — which has to exist, or the discipline check reds
 * before the case under test runs — and the registry side the declarations are read through.
 */
const SHIPPING_FILES = [
  DECLARING_MODULE,
  CONSUMER,
  SWITCH,
  EVIDENCE,
  SECOND_EVIDENCE,
  REGISTRY,
  FIRST_ADAPTER,
  'shared/asr/list/multimodal/multimodal.asr-provider.ts',
];

/** The read point's own body in the declaring module; the mutations below rewrite it. */
const READ_POINT_BODY = "  return { capability, trim: capability === 'destructive' };";

/** The gate the consumer opens the trim with, and the import that gate needs. */
const CONSUMER_GATE = [
  '  const recogniser = effectivePauseCuesDeclaration();',
  '  if (!isVoiceTrimEnabled() || recogniser === null || !trimDecisionFor(recogniser.capability).trim) {',
  '    return recorded;',
  '  }',
].join('\n');
const CONSUMER_GATE_WITHOUT_CAPABILITY = [
  '  if (!isVoiceTrimEnabled()) {',
  '    return recorded;',
  '  }',
].join('\n');
const CONSUMER_IMPORT = "import { trimDecisionFor, trimVoiceAudio } from '@/shared/voiceTrim';";
const CONSUMER_IMPORT_WITHOUT_CAPABILITY = "import { trimVoiceAudio } from '@/shared/voiceTrim';";

/**
 * The first registered recogniser's own declaration, as its adapter module writes it. This is what
 * a non-destructive value — or a missing experiment — is declared ON now: the client has no table
 * left to mutate, which is the point of the seam.
 */
const FIRST_ADAPTER_CAPABILITY = "  pauseCues: 'destructive',";
/** The registry's row naming that recogniser's paired experiment. */
const FIRST_ADAPTER_EVIDENCE_ROW =
  "  [openaiCompatibleId]: 'docs/experiments/2026-09-22-voice-provider-paired-quality.md',";

/** The registration table's body, as the registry writes it; the zero-row case empties it. */
const REGISTRATION_ROWS = [
  '  {',
  '    id: openaiCompatibleId,',
  '    capabilities: openaiCompatibleCapabilities,',
  "    wire: 'multipart',",
  '    transcribe: openaiCompatibleTranscribe,',
  '  },',
  '  {',
  '    id: multimodalId,',
  '    capabilities: multimodalCapabilities,',
  "    wire: 'inline-json',",
  '    transcribe: multimodalTranscribe,',
  '  },',
].join('\n');
const REGISTRATION_ROWS_EMPTY = '';

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
    `${CONSUMER_GATE}\n  const byHand = recogniser.capability === 'destructive';`,
  );
  expectCheckFails(root, 'single-source');
});

test('changing the declared default to "do not trim" reds default (AC2 fake: the shipped pairing must red)', (t) => {
  const root = greenFixture(t);
  // The declaration the shipped configuration resolves to is the FIRST registered adapter's, and
  // the experiment record stays in place: what this case changes is the value, so the red has to
  // come from the decision and not from the discipline check beside it.
  patch(root, FIRST_ADAPTER, FIRST_ADAPTER_CAPABILITY, "  pauseCues: 'useful',");
  expectCheckFails(root, 'default');
});

test('reordering the registry so a non-trimming recogniser is first also reds default (AC2 fake: the order is the default)', (t) => {
  const root = greenFixture(t);
  // The other way to flip the shipped default: leave every declaration alone and register the
  // multimodal recogniser first, which is the shape the defect actually arrived in.
  patch(
    root,
    REGISTRY,
    REGISTRATION_ROWS,
    [
      '  {',
      '    id: multimodalId,',
      '    capabilities: multimodalCapabilities,',
      "    wire: 'inline-json',",
      '    transcribe: multimodalTranscribe,',
      '  },',
      '  {',
      '    id: openaiCompatibleId,',
      '    capabilities: openaiCompatibleCapabilities,',
      "    wire: 'multipart',",
      '    transcribe: openaiCompatibleTranscribe,',
      '  },',
    ].join('\n'),
  );
  expectCheckFails(root, 'default');
});

test('a read point that answers the same thing for both capabilities reds read-point (AC5 fake: the empty reading)', (t) => {
  const root = greenFixture(t);
  patch(root, DECLARING_MODULE, READ_POINT_BODY, '  return { capability, trim: true };');
  expectCheckFails(root, 'read-point');
});

test('a non-destructive declaration with no experiment to point at reds discipline (AC7)', (t) => {
  const root = greenFixture(t);
  patch(root, FIRST_ADAPTER, FIRST_ADAPTER_CAPABILITY, "  pauseCues: 'useful',");
  patch(root, REGISTRY, FIRST_ADAPTER_EVIDENCE_ROW, '');
  expectCheckFails(root, 'discipline');
});

test('a fixture whose declaring module is deleted reds declaration rather than passing on an empty scan', (t) => {
  const root = greenFixture(t);
  rmSync(path.join(root, DECLARING_MODULE));
  expectCheckFails(root, 'declaration');
});

/**
 * AC5's zero-row arm. Distinct from the deletion above: there the module the vocabulary lives in
 * is gone, here the registration table is present and empty — and an empty registry is exactly the
 * shape that would otherwise read as "no capability contradicts the trim", with the check finding
 * nothing to contradict instead of nothing to read. The printed cause is asserted too: "the
 * registry could not be followed" would be a different observation, and a reader chasing this
 * failure deserves the one that actually happened.
 */
test('a registry with no rows reds declaration with the zero-row cause (AC5)', (t) => {
  const root = greenFixture(t);
  patch(root, REGISTRY, REGISTRATION_ROWS, REGISTRATION_ROWS_EMPTY);
  const stdout = expectCheckFails(root, 'declaration');
  assert.match(stdout, /nothing is registered — a registry that cannot be followed is not a pass/, stdout);
});
