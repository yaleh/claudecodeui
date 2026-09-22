/**
 * The transcription seam's invariant board, as an operator command.
 *
 * It measures the SAME probes the suite does — `runAsrContractInvariants` from
 * `shared/asr/asrInvariants.ts`, loaded out of `--root` — and prints one line per group. It holds
 * no invariant of its own: a check written here and a check written in the suite would be two
 * implementations of one contract, which is the failure the seam exists to prevent.
 *
 *   · `--root <tree>` measures that tree's `shared/asr/` instead of this repository's. That is
 *     what makes a mutation measurable: copy `shared/` aside, break one decision inside it, and
 *     the board must red THAT group. `scripts/asr-contract-invariants-check.test.mjs` drives the
 *     two anti-fake variants that way.
 *   · `--groups a,b` narrows the board. A narrowed board is scored against the groups it ran and
 *     never against the ones it did not, so the two are not interchangeable: an empty selection
 *     is `empty`, not `pass`.
 *
 * THREE WAYS THIS EXITS NON-ZERO, and the third is the one worth stating out loud:
 *
 *   1. a group failed — at least one reading disagreed with its expectation;
 *   2. the board is empty — a group produced no readings at all. An unmeasurable board is not a
 *      green board, so a registry that registered nothing cannot print "the invariants hold";
 *   3. the platform fetch was reached. The trap installed below is what makes "this board needs
 *      no network" a reading of the run rather than a claim about it: every probe is driven
 *      through an injected implementation, and an adapter that reached `globalThis.fetch`
 *      directly would be caught here.
 *
 * RUN IT UNDER tsx, not bare `node`. The modules it measures are TypeScript and their internal
 * specifiers end in `.js` (the extension `server/tsconfig.json`'s NodeNext resolution demands),
 * which bare Node's type stripping does not map back onto the `.ts` files on disk. The control
 * test resolves tsx from its own file, so a driven tree needs no `node_modules` of its own.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the board's modules live inside a tree. */
const MODULE_DIR = join('shared', 'asr');

/** @param {string[]} argv */
function parseArgs(argv) {
  let root = REPO_ROOT;
  /** @type {string[] | null} */
  let groups = null;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      index += 1;
      if (argv[index] === undefined) throw new Error('--root needs a path');
      root = resolve(argv[index]);
    } else if (arg === '--groups') {
      index += 1;
      if (argv[index] === undefined) throw new Error('--groups needs a comma-separated list');
      groups = argv[index]
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    } else if (arg === '--verbose') {
      verbose = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { root, groups, verbose };
}

/**
 * Replaces the platform fetch with a trap, for the rest of the process.
 *
 * Installed before the module graph is loaded, so a module that reached for the network while
 * being imported is caught too — not only a call made while a probe ran.
 */
function installFetchTrap() {
  const state = { calls: 0 };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: () => {
      state.calls += 1;
      throw new Error('the invariant board reached the platform fetch');
    },
  });
  return state;
}

/** @param {string} root */
async function loadBoard(root) {
  /** @param {string} name */
  const modulePath = (name) => pathToFileURL(join(root, MODULE_DIR, name)).href;
  try {
    const invariants = await import(modulePath('asrInvariants.ts'));
    const registry = await import(modulePath('asrRegistry.ts'));
    return { invariants, registry };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${root} does not hold the transcription seam (${reason})`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const trap = installFetchTrap();
  const { invariants, registry } = await loadBoard(options.root);

  const known = invariants.INVARIANT_GROUP_IDS;
  if (options.groups !== null) {
    for (const group of options.groups) {
      if (!known.includes(group)) {
        throw new Error(`unknown group ${group} — known groups: ${known.join(', ')}`);
      }
    }
  }

  /** @type {Record<string, unknown>} */
  const runOptions = { providers: registry.listProviders() };
  if (options.groups !== null) runOptions.groups = options.groups;

  const report = await invariants.runAsrContractInvariants(runOptions);

  console.log(`asr-contract-invariants-check: root ${options.root}`);
  if (options.groups !== null) {
    console.log(`asr-contract-invariants-check: groups ${options.groups.join(',') || '(none)'}`);
  }

  for (const group of report.groups) {
    const label = group.verdict === 'unmeasured' ? 'UNMEASURED' : group.verdict.toUpperCase();
    console.log(`${label} ${group.group} ${group.readings} readings`);
    for (const reading of report.readings) {
      if (reading.group !== group.group) continue;
      if (reading.verdict === 'fail') {
        console.log(`  FAIL ${reading.id} observed=${reading.observed} — ${reading.detail}`);
      } else if (options.verbose) {
        console.log(`  ok   ${reading.id} observed=${reading.observed}`);
      }
    }
  }

  if (report.groups.length === 0) {
    console.log('UNMEASURED (no group was selected, so nothing was measured)');
  }

  const fetchCalls = trap.calls;
  console.log(
    `asr-contract-invariants: verdict=${report.verdict} groups=${report.groups.length} `
      + `readings=${report.readings.length} log-lines=${report.logs.length} `
      + `platform-fetch-calls=${fetchCalls}`,
  );

  if (fetchCalls > 0) {
    console.log('FAIL the board reached the platform fetch — every probe must run on an injected implementation');
  }

  process.exitCode = report.verdict === 'pass' && fetchCalls === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`asr-contract-invariants-check: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
