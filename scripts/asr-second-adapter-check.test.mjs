#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-second-adapter-check.mjs (AC-132).
 *
 * Each case below first runs the probe against an UNMUTATED fixture and requires green, then
 * applies exactly one mutation and requires red. Both halves matter: only the second proves the
 * probe notices the fake form, and only the first proves the red came from the mutation rather
 * than from a probe that is red for every input.
 *
 * The fixture is built at run time, in a temporary directory, OUT OF THE SHIPPING FILES — copied,
 * never re-typed. A hand-written stub would only prove the probe reads the stub; a copy of the
 * real modules is what makes these cases evidence about this repository's adapter rather than
 * about a paragraph describing it.
 *
 * The mutations are the fake forms the criteria name, one apiece:
 *
 *   · AC1 — the guard is removed, so the over-budget audio is handed to the transport anyway. The
 *     "zero requests" half is the thing that has to notice, and it is a counter, not an inference.
 *   · AC2 — the budget is measured on the audio's own bytes, which is exactly the reading the
 *     request-level name exists to forbid: the same audio passes alone and then passes again with
 *     a long context beside it.
 *   · AC3 — the honors declaration stops being applied, so a hint the provider does not
 *     acknowledge is put on the wire.
 *   · AC4 — the response parse goes lenient, returning the whole body as the transcript.
 *   · AC5 — the declaration claims it can fall back to a files API, a policy the first version
 *     does not allow.
 *   · AC6 — the registry hands back a declaration that is not the one the module exports.
 *   · AC7 — the adapter reaches for the ambient fetch instead of the injected one.
 *   · AC8 — the adapter is not resolvable out of the registry, and separately produces no readable
 *     outcome at all. Neither is allowed to read as green.
 *
 * Run with: node --test scripts/asr-second-adapter-check.test.mjs
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
const PROBE = path.join(SCRIPT_DIR, 'asr-second-adapter-check.mjs');

/**
 * The shipping files a fixture needs: the registry, the adapter it registers, and the two files
 * that say how the tree is compiled and loaded. `package.json` is not decoration — its
 * `"type": "module"` is what makes the loader treat a `.ts` module as ESM, and without it the
 * fixture's own imports are resolved as CommonJS and the probe cannot load the registry at all
 * (measured: `ERR_REQUIRE_CYCLE_MODULE`). Copying it keeps the fixture loaded exactly the way the
 * repository is loaded instead of under a hand-written approximation of it.
 */
const SHIPPING_FILES = [
  'package.json',
  'tsconfig.json',
  'shared/asr/asrRegistry.ts',
  'shared/asr/transcriptionWire.ts',
  'shared/asr/list/multimodal/multimodal.asr-provider.ts',
  'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts',
];

/** The adapter every mutation below is applied to: the SECOND one, whose claims this file pins. */
const ADAPTER = 'shared/asr/list/multimodal/multimodal.asr-provider.ts';
const REGISTRY = 'shared/asr/asrRegistry.ts';

/**
 * The registered row the two registry mutations below rewrite. It is the second adapter's entry,
 * and it is matched as the multi-line literal the registry writes: the fixture ships BOTH
 * adapters (the probe drives every provider module it finds through the registry), so an anchor
 * that matched a row by its id alone would also have to be unique — this one is, because only the
 * multimodal row names `multimodalId`.
 */
const REGISTRATION_ENTRY = [
  '  {',
  '    id: multimodalId,',
  '    capabilities: multimodalCapabilities,',
  "    wire: 'inline-json',",
  '    transcribe: multimodalTranscribe,',
  '  },',
].join('\n');

/**
 * @returns {string} the fixture root
 */
function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-second-adapter-'));
  for (const relativePath of SHIPPING_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO_ROOT, relativePath), destination);
  }
  return root;
}

/**
 * @param {string} root
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runProbe(root) {
  const result = spawnSync(process.execPath, [PROBE, '--root', root], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(result.error, undefined, `the probe could not be started: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
 * Replaces `from` with `to`, refusing to silently no-op on a fixture that has drifted.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} from
 * @param {string} to
 */
function patchFixtureFile(root, relativePath, from, to) {
  const filePath = path.join(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  assert.ok(source.includes(from), `${relativePath} no longer contains ${from}; this case needs updating`);
  writeFileSync(filePath, source.replace(from, to));
}

/**
 * One control: the unmutated tree is green first, then exactly one edit is applied and the named
 * verdict must be the one that fires. The token — not merely the exit code — is asserted, because
 * a probe that went red for an unrelated reason would otherwise count as evidence.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ name: string, file: string, from: string, to: string, token: string }} control
 */
function control(t, { name, file, from, to, token }) {
  const root = greenFixture(t);
  patchFixtureFile(root, file, from, to);
  const result = runProbe(root);
  assert.notEqual(result.status, 0, `${name} must not pass:\n${result.stdout}`);
  assert.match(
    result.stdout,
    new RegExp(`^FAIL ${token}:`, 'm'),
    `${name} must be caught by ${token}:\n${result.stdout}`,
  );
}

// ── AC1 ──────────────────────────────────────────────────────────────────────────────────────

test('AC1: an over-budget request that is still sent is caught by the call counter', (t) => {
  control(t, {
    name: 'a guard that is declared but never fires, so the oversize audio leaves anyway',
    file: ADAPTER,
    from: '  if (requestBytes > capabilities.maxInlineRequestBytes) {',
    to: '  if (false) {',
    token: 'OVERSIZE_NOT_ZERO_REQUEST',
  });
});

// ── AC2 ──────────────────────────────────────────────────────────────────────────────────────

test('AC2: a budget measured on the audio alone is caught by the audio-plus-context case', (t) => {
  control(t, {
    name: 'a budget sized by the audio bytes instead of by the whole request',
    file: ADAPTER,
    from: '  const requestBytes = measureInlineRequestBytes(request, hints, invocation.model);',
    to: '  const requestBytes = request.audio.bytes.length;',
    token: 'BUDGET_IS_AUDIO_ONLY',
  });
});

// ── AC3 ──────────────────────────────────────────────────────────────────────────────────────

test('AC3: a hint the declaration does not acknowledge is caught on the wire', (t) => {
  control(t, {
    name: 'an honors declaration that is no longer applied, so the prompt is sent anyway',
    file: ADAPTER,
    from: '  if (capabilities.honors.prompt && hints.prompt !== undefined) honored.prompt = hints.prompt;',
    to: '  if (hints.prompt !== undefined) honored.prompt = hints.prompt;',
    token: 'PROMPT_SENT',
  });
});

// ── AC4 ──────────────────────────────────────────────────────────────────────────────────────

test('AC4: a lenient response parse that returns the whole body is caught', (t) => {
  control(t, {
    name: 'a parse that falls back to returning the raw response as the transcript',
    file: ADAPTER,
    from: [
      '  const parsed = JSON.parse(responseText) as MultimodalResponse;',
      '  const parts = parsed?.candidates?.[0]?.content?.parts;',
      "  if (!Array.isArray(parts)) return '';",
    ].join('\n'),
    to: [
      '  let parts: unknown;',
      '  try {',
      '    parts = (JSON.parse(responseText) as MultimodalResponse)?.candidates?.[0]?.content?.parts;',
      '  } catch {',
      '    return responseText;',
      '  }',
      '  if (!Array.isArray(parts)) return responseText;',
    ].join('\n'),
    token: 'LOOSE_RESPONSE_PARSE',
  });
});

// ── AC5 ──────────────────────────────────────────────────────────────────────────────────────

test('AC5: a declaration that allows an oversize fallback is caught', (t) => {
  control(t, {
    name: "an oversize policy of 'files-api' instead of an explicit rejection",
    file: ADAPTER,
    from: "  oversize: 'reject',",
    to: "  oversize: 'files-api',",
    token: 'OVERSIZE_POLICY_NOT_REJECT',
  });
});

// ── AC6 ──────────────────────────────────────────────────────────────────────────────────────

test('AC6: a registry that hands back a different declaration than the module exports is caught', (t) => {
  control(t, {
    name: 'a registration whose capabilities are not the module’s own constant',
    file: REGISTRY,
    from: REGISTRATION_ENTRY,
    // The value has to DIFFER from the module's own declaration, or the spread is a no-op and the
    // case goes green. It is 'written' for that reason: the module declares 'verbatim'.
    to: '  { id: multimodalId, capabilities: { ...multimodalCapabilities, style: \'written\' }, transcribe: multimodalTranscribe },',
    token: 'CAPABILITIES_MISMATCH',
  });
});

// ── AC7 ──────────────────────────────────────────────────────────────────────────────────────

test('AC7: reaching for the ambient fetch instead of the injected one is caught by the poison', (t) => {
  control(t, {
    name: 'an adapter that uses the ambient fetch rather than the injected transport',
    file: ADAPTER,
    from: '    response = await invocation.fetchImpl(endpoint, {',
    to: '    response = await fetch(endpoint, {',
    token: 'NETWORK_CALL',
  });
});

// ── AC8 ──────────────────────────────────────────────────────────────────────────────────────

test('AC8: an adapter the registry does not hand out is a failure, not an empty pass', (t) => {
  control(t, {
    name: 'a registry with no registered adapter in it',
    file: REGISTRY,
    from: REGISTRATION_ENTRY,
    to: '',
    token: 'ADAPTER_UNRESOLVED',
  });
});

test('AC8: an unreadable outcome is a failure, not a reading of zero', (t) => {
  control(t, {
    name: 'a transcribe that returns nothing at all',
    file: ADAPTER,
    from: 'export async function transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult> {',
    to: 'export async function transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult> {\n  return undefined as unknown as AsrResult;',
    token: 'EMPTY_READING',
  });
});

// ── real-wire AC1 ────────────────────────────────────────────────────────────────────────────
//
// The cases above carry AC-132's numbers. These carry the numbers of the task that corrected this
// wire against the live service (`gap-asr-multimodal-adapter-real-gemini-wire`) — a different set
// of claims, so a bare number would make two statements answer to one label.

test('real-wire AC1: a key announced in a header the wire does not declare is caught', (t) => {
  control(t, {
    // The live defect, restored: this adapter shipped `Authorization: Bearer <key>` and the service
    // answered 401 `Expected OAuth 2 access token`. The mutation keeps the credential on the request
    // — a one-sided "is a header present" check would stay green — and only moves it to the header
    // this wire does not read.
    name: 'the credential announced under Authorization instead of the header this wire declares',
    file: ADAPTER,
    from: "        ...(invocation.apiKey ? { 'x-goog-api-key': invocation.apiKey } : {}),",
    to: '        ...(invocation.apiKey ? { authorization: invocation.apiKey } : {}),',
    token: 'CREDENTIAL_NOT_ON_WIRE',
  });
});
