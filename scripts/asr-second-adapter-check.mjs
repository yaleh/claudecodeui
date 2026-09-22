#!/usr/bin/env node
/**
 * AC-132 — the second recogniser adapter, checked by RUNNING it rather than by reading it.
 *
 * WHY THIS PROBE EXECUTES THE TREE INSTEAD OF SCANNING IT. The sibling probe
 * (`asr-single-implementation-check.mjs`) answers a question about wiring — "how many copies of
 * this protocol exist" — and a scan is the right instrument for that. This task's three claims
 * are not about wiring at all: they are about what the adapter DOES with a request it cannot
 * afford, how it sizes that request, and what it leaves off the wire. None of those is visible in
 * a source file. So the probe loads the fixture's own modules — through `tsx/esm/api`'s loader, so
 * a bare `node` can import the tree's `.ts` (ADR-004 decision 2) — resolves the adapter out of
 * the fixture's own REGISTRY (not off a path this file hardcodes), and drives it with a stand-in
 * transport whose call count is the reading.
 *
 * THE THREE READINGS THAT CARRY THE TASK, one mechanical measurement each:
 *
 *   · an over-budget request is refused AND costs zero upstream calls — the second half is a
 *     stand-in counter, not an inference from the error code (AC1);
 *   · the budget is the WHOLE REQUEST: the same audio is accepted alone and refused once a long
 *     context joins it, so an implementation that sizes the audio alone goes red on the second
 *     half (AC2);
 *   · a hint the declaration does not acknowledge is NOT on the wire — checked as an absence of
 *     the text with a positive control that the acknowledged hint IS there, so a builder that
 *     sends nothing cannot pass by sending nothing (AC3).
 *
 * OFFLINE IS ENFORCED, NOT ASSERTED (AC7). Every case injects its own transport, and the probe
 * also REPLACES `globalThis.fetch` with a poison for the duration: an adapter that reaches for the
 * ambient fetch instead of the injected one is caught by the poison rather than merely discouraged.
 *
 * AN EMPTY READING IS A FAILURE (AC8). A case whose outcome cannot be read — the adapter was not
 * resolvable out of the registry, or `transcribe` produced nothing readable — prints
 * `EMPTY_READING` and exits non-zero. "No problems were found" must never be indistinguishable
 * from "nothing was looked at".
 *
 * Usage:
 *   node scripts/asr-second-adapter-check.mjs [--root <dir>]
 *
 *   --root <dir>   the tree to check (default: this script's repository root). The falsification
 *                  controls point it at a throwaway tree assembled from the shipping files, which
 *                  is what makes each fake form below an executable case rather than a paragraph.
 *
 * Exit codes: 0 = every reading above held; 1 = at least one verdict failed (each failing verdict
 * prints its own `FAIL <TOKEN>` line before the readings).
 */

import { globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

// Lets this bare-`node` entrypoint import the tree's `.ts` modules. Registered before any tree
// module is imported, because the very first thing the probe does is load the fixture's registry.
register();

/**
 * @typedef {{ ok: boolean, code: string|null, text: string|null }} Outcome a readable result
 * @typedef {{ token: string, detail: string }} Problem a failing verdict
 */

// ── the ledger ───────────────────────────────────────────────────────────────────────────────

/**
 * Readings are printed whether or not a verdict failed: a red run still has to show what was
 * measured, otherwise the failing token is the only thing a reader gets.
 */
class Ledger {
  constructor() {
    /** @type {string[]} */
    this.readings = [];
    /** @type {Problem[]} */
    this.problems = [];
    /** @type {Set<string>} */
    this.ran = new Set();
  }

  /**
   * @param {string} name
   * @param {unknown} value
   */
  record(name, value) {
    this.readings.push(`reading=${name} value=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  /**
   * @param {string} token
   * @param {string} detail
   */
  fail(token, detail) {
    this.problems.push({ token, detail });
  }

  /**
   * The structural half of AC8: every case this probe claims to run must have produced a reading.
   * A case that was skipped — because the adapter never resolved, or because the case above it
   * bailed out — is an empty reading, and an empty reading is not a pass.
   *
   * @param {string[]} expected
   */
  requireAll(expected) {
    for (const id of expected) {
      if (!this.ran.has(id)) {
        this.fail('EMPTY_READING', `case ${id} produced no reading at all — nothing about it was measured`);
      }
    }
  }
}

// ── arguments ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{ root: string }}
 */
function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root needs a directory');
      root = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/asr-second-adapter-check.mjs [--root <dir>]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root };
}

// ── the offline guard ────────────────────────────────────────────────────────────────────────

/**
 * Replaces the ambient transport with a recorder that refuses to answer.
 *
 * Injected transports make a real call unlikely; this makes it impossible. An adapter that uses
 * `fetch` instead of `invocation.fetchImpl` reaches this and is recorded, which is the reading
 * AC7 asks for — the property "every environment dependency is injected" is what keeps the probe
 * offline, and this is how that property is measured rather than trusted.
 *
 * @returns {{ calls: string[], restore: () => void }}
 */
function installFetchPoison() {
  const original = globalThis.fetch;
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const poison = async (input) => {
    calls.push(String(input));
    throw new Error('the ambient fetch was used; every environment dependency must be injected');
  };
  globalThis.fetch = poison;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── the stand-in transport ───────────────────────────────────────────────────────────────────

/**
 * @typedef {{ calls: { url: string, init: RequestInit|undefined }[], fetchImpl: typeof fetch,
 *             count: () => number }} StandIn
 */

/**
 * @param {string} responseBody
 * @param {{ status?: number }} [options]
 * @returns {StandIn}
 */
function makeStandIn(responseBody, options = {}) {
  /** @type {{ url: string, init: RequestInit|undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init: init ?? undefined });
    return new Response(responseBody, {
      status: options.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchImpl, count: () => calls.length };
}

/**
 * @param {StandIn} standIn
 * @returns {object} the injected invocation the adapter must use
 */
function invocationFor(standIn) {
  return {
    // `.invalid` is reserved and never resolves: even a defect that bypassed the stand-in could
    // not reach a real service from here.
    baseUrl: 'https://asr.invalid',
    apiKey: 'probe-key',
    model: 'probe-model',
    timeoutMs: 1000,
    fetchImpl: standIn.fetchImpl,
  };
}

// ── reading the tree ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} root
 * @param {string} pattern
 * @returns {string[]} repository-relative paths, `/`-separated, sorted
 */
function listFiles(root, pattern) {
  return globSync(pattern, { cwd: root })
    .map((entry) => entry.split(path.sep).join('/'))
    .sort();
}

/**
 * The registry is FOUND by its vocabulary, not by a path this file asserts: a hardcoded
 * `shared/asr/asrRegistry.ts` would keep "resolving" after the file moved, which is the one thing
 * a resolution check must not do.
 *
 * @param {string} root
 * @returns {string|null} repository-relative path of the module exporting `resolve`
 */
function findRegistry(root) {
  for (const relativePath of listFiles(root, 'shared/asr/*.ts')) {
    let source;
    try {
      source = readFileSync(path.join(root, relativePath), 'utf8');
    } catch {
      continue;
    }
    if (/export function resolve\s*\(/.test(source) && /export function listProviders\s*\(/.test(source)) {
      return relativePath;
    }
  }
  return null;
}

/**
 * Every provider module in the tree. The probe drives whichever ones it finds through the
 * REGISTRY — so a provider that exists on disk but is not registered is a failing resolution
 * reading, not a module this file quietly skips.
 *
 * @param {string} root
 * @returns {string[]} repository-relative paths
 */
function findProviderModules(root) {
  return listFiles(root, 'shared/asr/**/*.asr-provider.ts');
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {Promise<any>} the loaded module
 */
async function loadModule(root, relativePath) {
  return import(pathToFileURL(path.join(root, relativePath)).href);
}

// ── the budget arithmetic (the probe's own copy, for cross-checking) ─────────────────────────

/**
 * The probe recomputes the encoded length itself rather than importing the adapter's helper: a
 * size check that borrowed the implementation's own arithmetic could not disagree with it.
 *
 * @param {number} byteLength
 * @returns {number}
 */
function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

// ── outcomes ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} result
 * @returns {Outcome|null} null when nothing readable came back — an empty reading, not a pass
 */
function readOutcome(result) {
  if (typeof result !== 'object' || result === null) return null;
  const candidate = /** @type {{ ok?: unknown, code?: unknown, text?: unknown }} */ (result);
  if (typeof candidate.ok !== 'boolean') return null;
  return {
    ok: candidate.ok,
    code: typeof candidate.code === 'string' ? candidate.code : null,
    text: typeof candidate.text === 'string' ? candidate.text : null,
  };
}

/**
 * @param {any} adapter
 * @param {any} request
 * @param {any} invocation
 * @param {Ledger} ledger
 * @param {string} caseId
 * @returns {Promise<Outcome|null>}
 */
async function callAdapter(adapter, request, invocation, ledger, caseId) {
  let result;
  try {
    result = await adapter.transcribe(request, invocation);
  } catch (error) {
    ledger.fail('CASE_THREW', `${caseId}: transcribe threw ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const outcome = readOutcome(result);
  if (outcome === null) {
    ledger.fail(
      'EMPTY_READING',
      `${caseId}: transcribe returned nothing readable (${JSON.stringify(result) ?? 'undefined'}) — an unreadable outcome is not a pass`,
    );
    return null;
  }
  ledger.ran.add(caseId);
  return outcome;
}

// ── the cases ────────────────────────────────────────────────────────────────────────────────

const ENVELOPE_BODY = JSON.stringify({
  candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
});
const NON_ENVELOPE_JSON_BODY = JSON.stringify({ error: { code: 429, message: 'quota exceeded' } });
const NON_JSON_BODY = '<html><body>502 Bad Gateway</body></html>';

/** The two halves of the response-parse baseline: a non-envelope body is never a transcript. */
const RESPONSE_CASES = [
  { id: 'response-envelope', body: ENVELOPE_BODY, expectOk: true, expectText: 'hello world' },
  { id: 'response-non-envelope-json', body: NON_ENVELOPE_JSON_BODY, expectOk: false, expectText: null },
  { id: 'response-non-json', body: NON_JSON_BODY, expectOk: false, expectText: null },
];

/**
 * Every case this probe claims to run. The list is the probe's own inventory, not a claim about
 * the tree: a case on it that produced no reading is exactly the "empty reading" AC8 refuses to
 * read as green, and the inventory is what makes "it did not run" distinguishable from "it ran and
 * found nothing".
 */
const EXPECTED_CASES = [
  'oversize-refused',
  'budget-audio-alone',
  'budget-audio-plus-context',
  'hints-on-the-wire',
  ...RESPONSE_CASES.map((responseCase) => responseCase.id),
];

/**
 * The positive control for the hint rules: a text that IS acknowledged must reach the wire. It is
 * the same request as the prompt case with the one hint the declaration accepts, so "the prompt is
 * absent" cannot be satisfied by a builder that puts nothing anywhere.
 */
const CONTEXT_TEXT = 'quarterly revenue recognition policy';

/**
 * @param {any} adapter the adapter resolved out of the registry
 * @param {any} capabilities that adapter's declaration
 * @param {Ledger} ledger
 */
async function runCases(adapter, capabilities, ledger) {
  const budget = capabilities.maxInlineRequestBytes;
  ledger.record('budget-bytes', budget);

  // ── AC6: the declaration is a real one, with every field present and of the declared kind ──
  for (const field of ['acceptsMime', 'maxInlineRequestBytes', 'oversize', 'honors', 'billing', 'pauseCues', 'style', 'oneShot']) {
    ledger.record(`capabilities.${field}`, capabilities[field]);
    if (capabilities[field] === undefined) {
      ledger.fail('CAPABILITIES_MISSING_FIELD', `the resolved declaration has no '${field}'`);
    }
  }
  ledger.record('capabilities.acceptsMime.length', capabilities.acceptsMime?.length ?? 0);

  // ── AC5: oversize is a declared rejection, taken before anything leaves ───────────────────
  ledger.record('oversize-policy', capabilities.oversize);
  if (capabilities.oversize !== 'reject') {
    ledger.fail(
      'OVERSIZE_POLICY_NOT_REJECT',
      `the adapter declares oversize='${String(capabilities.oversize)}'; the first version only allows 'reject' — an over-budget request must be refused here, not handed to the service to refuse`,
    );
  }

  // ── AC1: over budget ⇒ OVERSIZE, and the stand-in's counter must read zero ────────────────
  const oversizeBytes = Math.ceil((budget + 1) / 4) * 3;
  ledger.record('oversize-audio-bytes', oversizeBytes);
  ledger.record('oversize-encoded-bytes', base64Length(oversizeBytes));
  if (base64Length(oversizeBytes) <= budget) {
    ledger.fail('CASE_INPUT_STALE', `the oversize input no longer exceeds the declared budget of ${budget} B`);
  }
  const oversizeStandIn = makeStandIn(ENVELOPE_BODY);
  const oversizeOutcome = await callAdapter(
    adapter,
    {
      audio: { bytes: new Uint8Array(oversizeBytes), mimeType: 'audio/webm;codecs=opus', fileName: 'oversize.webm' },
    },
    invocationFor(oversizeStandIn),
    ledger,
    'oversize-refused',
  );
  if (oversizeOutcome !== null) {
    ledger.record('oversize-code', oversizeOutcome.code);
    ledger.record('oversize-calls', oversizeStandIn.count());
    if (oversizeOutcome.ok || oversizeOutcome.code !== 'OVERSIZE') {
      ledger.fail(
        'OVERSIZE_NOT_REJECTED',
        `an over-budget request returned ${JSON.stringify(oversizeOutcome)} instead of a failure with code OVERSIZE`,
      );
    }
    if (oversizeStandIn.count() !== 0) {
      ledger.fail(
        'OVERSIZE_NOT_ZERO_REQUEST',
        `an over-budget request was refused but still cost ${oversizeStandIn.count()} upstream call(s) — the guard runs after the transport, so the bytes left`,
      );
    }
  }

  // ── AC2: the budget is the WHOLE REQUEST — the same audio passes alone and fails with a
  //        long context beside it. Sizes are derived from the declared budget rather than
  //        typed in, so a declaration that shrinks moves the control with it.
  const affordableBytes = Math.floor((budget * 0.75) / 4) * 3;
  const contextText = 'x'.repeat(budget);
  ledger.record('affordable-audio-bytes', affordableBytes);
  ledger.record('affordable-encoded-bytes', base64Length(affordableBytes));
  ledger.record('context-bytes', contextText.length);
  if (base64Length(affordableBytes) + 1024 > budget) {
    ledger.fail(
      'CASE_INPUT_STALE',
      `the 'affordable' input already fills the declared budget of ${budget} B, so the pair below would prove nothing`,
    );
  }

  const aloneStandIn = makeStandIn(ENVELOPE_BODY);
  const aloneOutcome = await callAdapter(
    adapter,
    { audio: { bytes: new Uint8Array(affordableBytes), mimeType: 'audio/webm;codecs=opus', fileName: 'alone.webm' } },
    invocationFor(aloneStandIn),
    ledger,
    'budget-audio-alone',
  );
  if (aloneOutcome !== null) {
    ledger.record('budget-audio-alone-ok', aloneOutcome.ok);
    ledger.record('budget-audio-alone-calls', aloneStandIn.count());
    if (!aloneOutcome.ok || aloneStandIn.count() !== 1) {
      ledger.fail(
        'AUDIO_ALONE_REFUSED',
        `an audio well inside the budget was not sent (${JSON.stringify(aloneOutcome)}, ${aloneStandIn.count()} call(s)) — the pair below can only show the budget is request-level if this half is accepted`,
      );
    }
  }

  const withContextStandIn = makeStandIn(ENVELOPE_BODY);
  const withContextOutcome = await callAdapter(
    adapter,
    {
      audio: { bytes: new Uint8Array(affordableBytes), mimeType: 'audio/webm;codecs=opus', fileName: 'with-context.webm' },
      hints: { context: contextText },
    },
    invocationFor(withContextStandIn),
    ledger,
    'budget-audio-plus-context',
  );
  if (withContextOutcome !== null) {
    ledger.record('budget-audio-plus-context-code', withContextOutcome.code);
    ledger.record('budget-audio-plus-context-calls', withContextStandIn.count());
    if (withContextOutcome.ok || withContextOutcome.code !== 'OVERSIZE') {
      ledger.fail(
        'BUDGET_IS_AUDIO_ONLY',
        `the same audio that was accepted alone returned ${JSON.stringify(withContextOutcome)} once ${contextText.length} B of context joined it — the budget is being measured on the audio instead of on the whole request`,
      );
    }
    if (withContextStandIn.count() !== 0) {
      ledger.fail(
        'OVERSIZE_NOT_ZERO_REQUEST',
        `the request that exceeded the budget after its context was added still cost ${withContextStandIn.count()} upstream call(s)`,
      );
    }
  }

  // ── AC3: a hint the declaration does not acknowledge is NOT on the wire ───────────────────
  const PROMPT_TEXT = 'biasing prompt for the probe';
  const hintsStandIn = makeStandIn(ENVELOPE_BODY);
  const hintsOutcome = await callAdapter(
    adapter,
    {
      audio: { bytes: new Uint8Array(2048), mimeType: 'audio/webm;codecs=opus', fileName: 'hints.webm' },
      hints: { prompt: PROMPT_TEXT, language: 'zh', context: CONTEXT_TEXT },
    },
    invocationFor(hintsStandIn),
    ledger,
    'hints-on-the-wire',
  );
  if (hintsOutcome !== null) {
    const call = hintsStandIn.calls[0];
    const rawBody = typeof call?.init?.body === 'string' ? call.init.body : '';
    ledger.record('hints-calls', hintsStandIn.count());
    ledger.record('hints-body-bytes', rawBody.length);
    if (typeof call?.init?.body !== 'string') {
      ledger.fail('CASE_INPUT_STALE', 'the stand-in received no string body, so the wire checks below cannot read one');
    } else {
      for (const hint of ['prompt', 'language']) {
        const honored = capabilities.honors?.[hint] === true;
        const present = rawBody.includes(hint === 'prompt' ? PROMPT_TEXT : 'zh');
        ledger.record(`hints.${hint}.honored`, honored);
        ledger.record(`hints.${hint}.text-present`, present);
        if (!honored && present) {
          ledger.fail(
            hint === 'prompt' ? 'PROMPT_SENT' : 'UNHONORED_HINT_SENT',
            `the declaration says honors.${hint}=false, but the value is in the request body — an unacknowledged hint must not be sent at all (not sent as an empty value either)`,
          );
        }
      }
      // The positive control: what IS acknowledged must be there, so an empty body cannot pass.
      const contextPresent = rawBody.includes(CONTEXT_TEXT);
      ledger.record('hints.context.honored', capabilities.honors?.context === true);
      ledger.record('hints.context.text-present', contextPresent);
      if (capabilities.honors?.context === true && !contextPresent) {
        ledger.fail(
          'ACKNOWLEDGED_HINT_ABSENT',
          'the declaration acknowledges context, but the context text is absent from the body — the absence of the prompt above would otherwise be satisfied by a builder that sends nothing',
        );
      }
    }
  }

  // ── AC4: the response-parse baseline, one case per body shape ─────────────────────────────
  for (const responseCase of RESPONSE_CASES) {
    const standIn = makeStandIn(responseCase.body);
    const outcome = await callAdapter(
      adapter,
      { audio: { bytes: new Uint8Array(1024), mimeType: 'audio/webm;codecs=opus', fileName: 'response.webm' } },
      invocationFor(standIn),
      ledger,
      responseCase.id,
    );
    if (outcome === null) continue;
    ledger.record(`${responseCase.id}-ok`, outcome.ok);
    ledger.record(`${responseCase.id}-text`, outcome.text ?? '<none>');
    if (responseCase.expectOk) {
      if (!outcome.ok || outcome.text !== responseCase.expectText) {
        ledger.fail(
          'ENVELOPE_NOT_READ',
          `${responseCase.id}: a well-formed answer read as ${JSON.stringify(outcome)} instead of '${String(responseCase.expectText)}'`,
        );
      }
    } else if (outcome.ok) {
      ledger.fail(
        'LOOSE_RESPONSE_PARSE',
        `${responseCase.id}: a body that is not the generation envelope was returned as a transcript (${JSON.stringify(outcome.text)}) — the whole response must never stand in for the text`,
      );
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<number>} the process exit code */
async function main() {
  /** @type {{ root: string }} */
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const root = options.root;
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    process.stdout.write(`root is not a directory: ${root}\n`);
    return 1;
  }

  const ledger = new Ledger();
  const poison = installFetchPoison();
  /** @type {string[]} */
  const header = [`asr-second-adapter-check root=${root}`];

  try {
    const registryPath = findRegistry(root);
    header.push(`registry=${registryPath ?? '<none>'}`);
    if (registryPath === null) {
      ledger.fail('REGISTRY_UNRESOLVED', `no module under shared/asr/ exports both listProviders and resolve`);
    }

    const providerPaths = findProviderModules(root);
    header.push(`provider-modules=${providerPaths.length}`);
    for (const providerPath of providerPaths) header.push(`  provider-module=${providerPath}`);
    if (providerPaths.length === 0) {
      ledger.fail('PROVIDER_MODULE_UNRESOLVED', 'no *.asr-provider.ts module exists under shared/asr/');
    }

    if (registryPath !== null) {
      const registry = await loadModule(root, registryPath);
      /** @type {any[]} */
      const registered = registry.listProviders();
      header.push(`registered=${registered.map((adapter) => adapter.id).join(',') || '<none>'}`);
      ledger.record('registered-count', registered.length);
      if (registered.length === 0) {
        ledger.fail('ADAPTER_UNRESOLVED', 'the registry hands out no adapter at all');
      }

      // AC6 — every provider module on disk must be resolvable out of the registry BY ID, and the
      // declaration the registry hands back must be the one the module exports, field for field.
      for (const providerPath of providerPaths) {
        const providerModule = await loadModule(root, providerPath);
        const providerId = providerModule.id;
        ledger.record(`provider-module.${providerPath}.id`, providerId);

        let resolved;
        try {
          resolved = registry.resolve(providerId);
        } catch (error) {
          ledger.fail(
            'ADAPTER_UNRESOLVED',
            `${providerPath} declares id '${String(providerId)}' but the registry does not resolve it: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        ledger.record(`resolve(${String(providerId)}).id`, resolved.id);
        if (resolved.id !== providerId) {
          ledger.fail('CAPABILITIES_MISMATCH', `resolve('${String(providerId)}') returned id '${String(resolved.id)}'`);
        }

        const declaredKeys = new Set([...Object.keys(providerModule.capabilities ?? {}), ...Object.keys(resolved.capabilities ?? {})]);
        for (const key of [...declaredKeys].sort()) {
          const fromModule = JSON.stringify(providerModule.capabilities?.[key]);
          const fromRegistry = JSON.stringify(resolved.capabilities?.[key]);
          ledger.record(`resolve(${String(providerId)}).capabilities.${key}`, fromRegistry ?? 'undefined');
          if (fromModule !== fromRegistry) {
            ledger.fail(
              'CAPABILITIES_MISMATCH',
              `resolve('${String(providerId)}').capabilities.${key} is ${String(fromRegistry)} but the module exports ${String(fromModule)}`,
            );
          }
        }

        if (resolved.capabilities?.maxInlineRequestBytes > 0) {
          await runCases(resolved, resolved.capabilities, ledger);
          ledger.requireAll(EXPECTED_CASES);
        } else {
          ledger.fail(
            'EMPTY_READING',
            `resolve('${String(providerId)}').capabilities.maxInlineRequestBytes is ${String(resolved.capabilities?.maxInlineRequestBytes)} — the budget cases below cannot be sized from it`,
          );
        }
      }
    }
  } catch (error) {
    ledger.fail('PROBE_THREW', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  } finally {
    poison.restore();
  }

  if (poison.calls.length > 0) {
    ledger.fail(
      'NETWORK_CALL',
      `the ambient fetch was reached ${poison.calls.length} time(s) (${poison.calls.join(', ')}) — every environment dependency must be injected for this probe to be offline`,
    );
  }
  ledger.record('ambient-fetch-calls', poison.calls.length);

  const failing = [...new Map(ledger.problems.map((problem) => [problem.token + problem.detail, problem])).values()];
  for (const problem of failing) process.stdout.write(`FAIL ${problem.token}: ${problem.detail}\n`);
  process.stdout.write(`${[...header, ...ledger.readings].join('\n')}\n`);
  return failing.length === 0 ? 0 : 1;
}

process.exitCode = await main();
