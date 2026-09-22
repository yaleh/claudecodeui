/**
 * The control test for the transcription seam's invariant board.
 *
 * A board that passes on a healthy tree says almost nothing on its own — an inert implementation,
 * a board whose probes never ran, and a board whose comparisons never fire all pass on a healthy
 * tree. So this file drives the checker against MUTATED COPIES of the tree and requires the board
 * to red, in the specific group it broke and nowhere else.
 *
 * ONE MUTATION PER GROUP, which is the property that makes the five groups five groups: a board
 * that reds everywhere on any change is not measuring anything, so every case below also asserts
 * that the four untouched groups still PASS.
 *
 *   · `request-construction` — the AC1 variant, in both of its halves: the adapter forwards the
 *     prompt it declared it would not forward, AND it forwards an empty prompt as an empty part.
 *     The declared-unhonored case alone would not catch the second: "not sent" and "sent empty"
 *     reach the service as the same nothing.
 *   · `error-mapping` — every failure collapses onto `UPSTREAM_ERROR`. The rows that already
 *     expect that code must STAY GREEN, which is what shows the group distinguishes codes rather
 *     than reacting to any failure at all.
 *   · `size-layering` — the budget guard is removed, so a request past the declared maximum is
 *     sent instead of refused.
 *   · `redaction` — the adapter names the credential inside its own failure message, on its way
 *     out to the caller.
 *   · `mime-gate` — the container gate is removed, so an undeclared container is uploaded.
 *   · an empty registry — the reading that keeps a green board from meaning nothing: zero
 *     providers must exit non-zero with every group unmeasured, never print "the invariants hold".
 *
 * Each mutation is a copy of `shared/` in a throwaway directory plus one or more literal
 * replacements. Every replacement is asserted to match exactly once before it is applied: a
 * mutation that quietly did not apply would leave this file asserting nothing, which is the same
 * failure it exists to catch.
 *
 * The checker is TypeScript-importing, so it runs under tsx — resolved from THIS file, so the
 * driven tree needs no `node_modules` of its own.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'asr-contract-invariants-check.mjs');
const ADAPTER_RELATIVE = join('shared', 'asr', 'list', 'multimodal', 'multimodal.asr-provider.ts');
const REGISTRY_RELATIVE = join('shared', 'asr', 'asrRegistry.ts');

const ALL_GROUPS = ['request-construction', 'error-mapping', 'size-layering', 'redaction', 'mime-gate'];

/** @type {string[]} */
const temporaryRoots = [];

/** The tsx entry point, resolved from this file rather than from the driven tree. */
function tsxCliPath() {
  return createRequire(import.meta.url).resolve('tsx/cli');
}

/**
 * A copy of this repository's `shared/` in a throwaway directory, with one or more lines changed.
 *
 * @param {{ name: string, file: string, find: string, replace: string }[]} mutations
 */
function treeWithMutations(mutations) {
  const root = mkdtempSync(join(tmpdir(), 'asr-invariants-'));
  temporaryRoots.push(root);
  cpSync(join(REPO_ROOT, 'shared'), join(root, 'shared'), { recursive: true });

  for (const mutation of mutations) {
    const file = join(root, mutation.file);
    const source = readFileSync(file, 'utf8');
    const occurrences = source.split(mutation.find).length - 1;
    assert.equal(
      occurrences,
      1,
      `the mutation anchor for ${mutation.name} matched ${occurrences} times in ${mutation.file}, not once`,
    );
    writeFileSync(file, source.replace(mutation.find, mutation.replace));
  }
  return root;
}

/**
 * Runs the board and returns its exit status plus both streams.
 *
 * @param {string[]} args
 */
function runChecker(args) {
  const result = spawnSync(process.execPath, [tsxCliPath(), CHECKER, ...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/**
 * @param {string} stdout
 * @param {string} verdict
 * @param {string} group
 */
function assertGroupVerdict(stdout, verdict, group) {
  const line = `${verdict} ${group} `;
  assert.ok(stdout.includes(line), `expected a "${line}" line in:\n${stdout}`);
}

/**
 * @param {string} stdout
 * @param {string} redGroup
 */
function assertOtherGroupsPass(stdout, redGroup) {
  for (const group of ALL_GROUPS.filter((entry) => entry !== redGroup)) {
    assertGroupVerdict(stdout, 'PASS', group);
  }
}

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe('asr-contract-invariants-check', () => {
  it('passes on the pristine tree with every group measured and no platform fetch', () => {
    const { status, stdout } = runChecker([]);
    assert.equal(status, 0, stdout);
    for (const group of ALL_GROUPS) assertGroupVerdict(stdout, 'PASS', group);
    assert.ok(stdout.includes('verdict=pass'), stdout);
    assert.ok(stdout.includes('platform-fetch-calls=0'), stdout);
  });

  it('reds request construction on the variant that sends a prompt it declared it does not honor', () => {
    const root = treeWithMutations([
      {
        name: 'prompt-not-declared',
        file: ADAPTER_RELATIVE,
        find: "  if (capabilities.honors.prompt && hints.prompt !== undefined) honored.prompt = hints.prompt;",
        replace: "  honored.prompt = hints.prompt === undefined ? '' : hints.prompt;",
      },
      {
        name: 'empty-prompt-part',
        file: ADAPTER_RELATIVE,
        find: "  if (hints.prompt !== undefined && hints.prompt !== '') {",
        replace: '  if (hints.prompt !== undefined) {',
      },
    ]);
    const { status, stdout } = runChecker(['--root', root]);

    assert.notEqual(status, 0, `the board stayed green on a mutated tree:\n${stdout}`);
    assertGroupVerdict(stdout, 'FAIL', 'request-construction');
    // The declared-unhonored half: a prompt reaches the wire where the declaration says it cannot.
    assert.ok(
      stdout.includes('FAIL request.prompt.unsupported-omitted[multimodal] observed=prompt-part-present'),
      stdout,
    );
    // The empty half: the same mutation also puts an EMPTY part on the wire for an empty hint, and
    // its observed value is the one that says so rather than one that merely says "a part exists".
    assert.ok(
      stdout.includes('FAIL request.prompt.empty-hint-omitted[multimodal] observed=empty-prompt-part'),
      stdout,
    );
    assert.ok(stdout.includes('FAIL request.body.golden[multimodal]'), stdout);
    assertOtherGroupsPass(stdout, 'request-construction');
  });

  it('reds error mapping on the variant that collapses every failure onto one code', () => {
    const root = treeWithMutations([
      {
        name: 'no-unauthorized',
        file: ADAPTER_RELATIVE,
        find: "  if (status === 401 || status === 403) return 'UNAUTHORIZED';",
        replace: "  if (false) return 'UNAUTHORIZED';",
      },
      {
        name: 'no-rate-limited',
        file: ADAPTER_RELATIVE,
        find: "  if (status === 429) return 'RATE_LIMITED';",
        replace: "  if (false) return 'RATE_LIMITED';",
      },
      {
        name: 'abort-is-upstream',
        file: ADAPTER_RELATIVE,
        find: "      code: isAbortError(error) ? 'TIMEOUT' : 'UNREACHABLE',",
        replace: "      code: 'UPSTREAM_ERROR',",
      },
    ]);
    const { status, stdout } = runChecker(['--root', root]);

    assert.notEqual(status, 0, `the board stayed green on a mutated tree:\n${stdout}`);
    assertGroupVerdict(stdout, 'FAIL', 'error-mapping');
    assert.ok(stdout.includes('FAIL error.status-401[multimodal] observed=UPSTREAM_ERROR'), stdout);
    assert.ok(stdout.includes('FAIL error.status-403[multimodal] observed=UPSTREAM_ERROR'), stdout);
    assert.ok(stdout.includes('FAIL error.status-429[multimodal] observed=UPSTREAM_ERROR'), stdout);
    assert.ok(stdout.includes('FAIL error.timeout[multimodal] observed=UPSTREAM_ERROR'), stdout);
    assert.ok(stdout.includes('FAIL error.transport[multimodal] observed=UPSTREAM_ERROR'), stdout);
    // The other half of the same mutation: the rows that ARE `UPSTREAM_ERROR` — and the one row
    // that never touches the status mapper — must not red. A group that reds on every row would
    // pass this test while measuring nothing about the mapping.
    assert.ok(!stdout.includes('FAIL error.status-500'), stdout);
    assert.ok(!stdout.includes('FAIL error.status-503'), stdout);
    assert.ok(!stdout.includes('FAIL error.status-400'), stdout);
    assert.ok(!stdout.includes('FAIL error.body-not-json'), stdout);
    assert.ok(!stdout.includes('FAIL error.envelope-without-text'), stdout);
    assert.ok(!stdout.includes('FAIL error.transcript-arrives'), stdout);
    assertOtherGroupsPass(stdout, 'error-mapping');
  });

  it('reds size layering on the variant that removes the whole-request budget guard', () => {
    const root = treeWithMutations([
      {
        name: 'no-budget-guard',
        file: ADAPTER_RELATIVE,
        find: '  if (requestBytes > capabilities.maxInlineRequestBytes) {',
        replace: '  if (false) {',
      },
    ]);
    const { status, stdout } = runChecker(['--root', root]);

    assert.notEqual(status, 0, `the board stayed green on a mutated tree:\n${stdout}`);
    assertGroupVerdict(stdout, 'FAIL', 'size-layering');
    // The audio that is past the budget is now SENT — the reading that says the guard is a refusal
    // before the wire, not a hope that the service refuses it.
    assert.ok(stdout.includes('FAIL size.audio-alone-over-limit[multimodal] observed=ok:'), stdout);
    assert.ok(!stdout.includes('FAIL size.audio-alone-over-limit[multimodal] observed=OVERSIZE'), stdout);
    // The same audio with a long context: the reading that says the budget covers the whole
    // request rather than the audio alone. An audio-only guard would leave this one green.
    assert.ok(stdout.includes('FAIL size.context-pushes-over-limit[multimodal] observed=ok:'), stdout);
    assert.ok(!stdout.includes('FAIL size.audio-alone-affordable'), stdout);
    assert.ok(!stdout.includes('FAIL size.oversize-declared'), stdout);
    assertOtherGroupsPass(stdout, 'size-layering');
  });

  it('reds redaction on the variant that names the credential in a failure message', () => {
    const root = treeWithMutations([
      {
        name: 'credential-in-message',
        file: ADAPTER_RELATIVE,
        find: "      message: `provider '${id}' answered ${response.status}`,",
        replace: "      message: `provider '${id}' answered ${response.status} for key ${invocation.apiKey}`,",
      },
    ]);
    const { status, stdout } = runChecker(['--root', root]);

    assert.notEqual(status, 0, `the board stayed green on a mutated tree:\n${stdout}`);
    assertGroupVerdict(stdout, 'FAIL', 'redaction');
    // The surface the credential escaped onto, named without quoting it back.
    assert.ok(stdout.includes('FAIL redaction.credential.absent-from-message[multimodal] observed=leaked('), stdout);
    assert.ok(stdout.includes('FAIL redaction.credential.absent-from-result[multimodal] observed=leaked('), stdout);
    // And the reading that makes those two mean something: the credential WAS on the request, so
    // "not in the answer" is a discrimination rather than a statement about an unused key.
    assert.ok(!stdout.includes('FAIL redaction.credential.reaches-the-wire'), stdout);
    assert.ok(!stdout.includes('FAIL redaction.scan.detects-planted-credential'), stdout);
    assert.ok(!stdout.includes('FAIL redaction.payload.absent-from-result'), stdout);
    assertOtherGroupsPass(stdout, 'redaction');
  });

  it('reds the mime gate on the variant that stops refusing undeclared containers', () => {
    const root = treeWithMutations([
      {
        name: 'no-mime-gate',
        file: ADAPTER_RELATIVE,
        find: '  if (!acceptsMime(request.audio.mimeType)) {',
        replace: '  if (false) {',
      },
    ]);
    const { status, stdout } = runChecker(['--root', root]);

    assert.notEqual(status, 0, `the board stayed green on a mutated tree:\n${stdout}`);
    assertGroupVerdict(stdout, 'FAIL', 'mime-gate');
    assert.ok(stdout.includes('FAIL mime.reject.outside-declaration[multimodal] observed=ok:'), stdout);
    assert.ok(stdout.includes('FAIL mime.reject.unset-container[multimodal] observed=ok:'), stdout);
    // The accepting half of the same group stays green, so the reds above are about the declaration
    // being enforced and not about the group failing whenever it runs.
    assert.ok(!stdout.includes('FAIL mime.accept.'), stdout);
    assert.ok(!stdout.includes('FAIL mime.declared-set-holds-base-types'), stdout);
    assertOtherGroupsPass(stdout, 'mime-gate');
  });

  it('reports an empty registry as an unmeasured board rather than a green one', () => {
    const root = treeWithMutations([
      {
        name: 'empty-registry',
        file: REGISTRY_RELATIVE,
        find: 'const REGISTERED: readonly AsrAdapter[] = [\n  { id: multimodalId, capabilities: multimodalCapabilities, transcribe: multimodalTranscribe },\n];',
        replace: 'const REGISTERED: readonly AsrAdapter[] = [];',
      },
    ]);
    const { status, stdout } = runChecker(['--root', root]);

    assert.notEqual(status, 0, `a board with no providers printed green:\n${stdout}`);
    for (const group of ALL_GROUPS) assertGroupVerdict(stdout, 'UNMEASURED', group);
    assert.ok(stdout.includes('verdict=empty'), stdout);
    assert.ok(stdout.includes('readings=0'), stdout);
  });

  it('reports a selection that named no group as unmeasured', () => {
    const { status, stdout } = runChecker(['--groups', '']);
    assert.notEqual(status, 0, stdout);
    assert.ok(stdout.includes('verdict=empty'), stdout);
    assert.ok(stdout.includes('UNMEASURED (no group was selected, so nothing was measured)'), stdout);
  });

  it('refuses a group it does not know instead of measuring nothing', () => {
    const { status, stderr } = runChecker(['--groups', 'not-a-group']);
    assert.notEqual(status, 0);
    assert.ok(stderr.includes('unknown group not-a-group'), stderr);
  });
});
