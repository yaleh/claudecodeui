/**
 * The falsifying forms behind `voice-error-contract.test.ts`, plus the exit-code half of AC6.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that claim is not something a passing run can show about
 * itself. So each case here builds a BROKEN copy of a shipping module by a one-line text mutation,
 * runs the whole reading list against it, and requires the readings it predicts to fail. The two
 * mutations are the two cheap ways to satisfy this task's words while missing its subject:
 *
 *   · `upstream-failure-without-code` — the service's provider-failure return drops `code`, which is
 *     exactly the shape the tree had before this task. Every sentence about "the envelope carries the
 *     code" is still literally implemented at the route (`sendFailure` still republishes whatever the
 *     service gave it), and the client is back to a status number it cannot tell two remedies apart
 *     by. If this case passes, AC2's per-arm readings are not measuring the service.
 *   · `raw-body-copied-through` — the value that rides in `upstreamCode` is the upstream's answer
 *     text instead of the code string extracted from it. The field exists, it is non-empty on every
 *     upstream arm, and the page now receives an upstream's prose — which is what "read the code off
 *     the answer" must not become. If this case passes, AC3's shape/length/substring readings and
 *     AC4's leak readings are not measuring what they say they measure.
 *
 * EACH CASE HAS THREE PARTS, and the first is what keeps the other two from being vacuous:
 *   1. the UNMUTATED copy must clear the whole list (a harness that is red for its own reasons proves
 *      nothing by going red on a mutant);
 *   2. the MUTATED copy must red at least one reading in the predicted family, and the red reading is
 *      printed by name so the failure is attributable;
 *   3. some reading OUTSIDE that family must still be green, so "the whole rig broke" is not what the
 *      red means.
 *
 * THE COPIES LIVE IN THE SAME TREE as the files they copy (`server/modules/voice/`), because a
 * module's imports are relative — `../../../shared/asr/asrRegistry.js` — and a copy in the OS temp
 * directory would not resolve them. Each copy gets its OWN path, because ESM caches a module by URL:
 * a mutant written over the base copy's path would import the already-evaluated base module and the
 * run would measure nothing. A copy of the SERVICE module still imports the SHIPPING routes module,
 * which is exactly what makes the two cases independent of each other — each mutation is the only
 * difference between its mutant and its base.
 *
 * WHY AC6'S EXIT CODES ARE HERE. AC6 asks for the exit code of seven existing criteria plus
 * `npm run typecheck` and `npm run lint`, each printed rather than assumed. Those are SUBPROCESSES,
 * and AC1 requires the criterion file itself to start none inside a fifteen-second budget — one
 * `npm run typecheck` alone is most of that budget. This file is the task's other executable
 * artifact, it already starts `git`, and it is not the file the target-side gate runs. The in-process
 * half of AC6 (the `voiceTranscribeGaps` reading this task re-pinned) is where that line is, in the
 * criterion file's own subject matter — the other criteria are read here, by exit code.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  collectReadings,
  SHIPPING_ROUTES_MODULE,
  SHIPPING_SERVICE_MODULE,
} from './voice-error-contract.test.js';

/** Where the mutated copies go: beside the modules, so their relative imports still resolve. */
const VOICE_DIR = path.dirname(SHIPPING_SERVICE_MODULE);
const REPO_ROOT = path.resolve(VOICE_DIR, '../../..');

/** The prefix every temp copy carries, so "nothing was left behind" is a pattern rather than a guess. */
const TEMP_PREFIX = '__criterion-falsify-';

/** `git status --porcelain` for the worktree, as one string. */
function gitStatusPorcelain(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** The first line of a string, for printing something bounded. */
function firstLine(value: string): string {
  return value.split('\n').find((line) => line !== '') ?? '(empty)';
}

/**
 * `git status --porcelain` BEFORE anything here runs.
 *
 * Captured in the module body rather than in a hook, because what AC5 owes is that THIS RUN adds
 * nothing: a tree that a developer already had dirty should not be reported as this criterion's
 * leftovers, and a tree that was clean has to come back clean.
 */
const PRE_RUN_PORCELAIN = gitStatusPorcelain();

// ── the mutation cases ────────────────────────────────────────────────────────────────────────

type MutationCase = {
  /** The case's name, used in the reading names and the temp file names. */
  name: string;
  /** Which module the mutation is applied to; the other stays the shipping one. */
  slot: 'service' | 'routes';
  /** The exact shipping text to replace. Required to be unique in the file. */
  anchor: string;
  /** What it is replaced with. */
  replacement: string;
  /** The readings this mutation must break, as the criterion names them. */
  target: RegExp;
  /** Which AC's line the red must be on, printed as `whichLine=`. */
  family: 'AC2' | 'AC3';
  /** What the mutation is, in one sentence, for the reason printed with the reading. */
  why: string;
};

const CASES: readonly MutationCase[] = [
  {
    name: 'upstream-failure-without-code',
    slot: 'service',
    // The pre-task shape of this line, restored verbatim: the service answers a provider failure with
    // a status and a message and lets the route publish whatever it was handed.
    anchor:
      '          return { ok: false, status, code: result.code, upstreamCode, error: result.message };',
    replacement: '          return { ok: false, status, upstreamCode, error: result.message };',
    target: /^AC2 arm\/upstream/,
    family: 'AC2',
    why: 'the provider failure carries no code, so the envelope is back to status-plus-message',
  },
  {
    name: 'raw-body-copied-through',
    slot: 'service',
    // "Read the code off the answer" turned into "hand the answer over": the field is still populated
    // on exactly the same arms, and what populates it is the upstream's own text.
    anchor: '  return answer === null ? undefined : extractUpstreamCode(answer.body);',
    replacement: '  return answer === null ? undefined : answer.body;',
    target: /^AC3 |^AC4 /,
    family: 'AC3',
    why: 'the upstream answer text rides in `upstreamCode`, so the shape, length, substring and leak readings must all notice',
  },
];

/** One arm's measurement, as the reading list reports it. */
type ArmOutcome = {
  /** The reading names that failed, in the order the list ran them. */
  red: string[];
  /** The number of readings the list ran, so a shortened list is visible. */
  total: number;
  /** The value of the first red reading, which is what a reader needs to attribute the failure. */
  firstRedReason: string;
  /** Whether a reading outside the target family stayed green. */
  outsiderGreen: string;
};

/** The module paths one arm drives: the mutated copy in its slot, the shipping module in the other. */
function modulesFor(
  mutation: MutationCase,
  modulePath: string,
): { service?: string; routes?: string } {
  return mutation.slot === 'service' ? { service: modulePath } : { routes: modulePath };
}

async function measureArm(mutation: MutationCase, modulePath: string): Promise<ArmOutcome> {
  const outcomes = await collectReadings(modulesFor(mutation, modulePath));
  const red = outcomes.filter((outcome) => !outcome.ok);
  const outsider = outcomes.find((outcome) => outcome.ok && !mutation.target.test(outcome.name));
  return {
    red: red.map((outcome) => outcome.name),
    total: outcomes.length,
    firstRedReason: red[0] === undefined ? '(none)' : `${red[0].name} measured ${red[0].value}`,
    outsiderGreen: outsider?.name ?? '(none)',
  };
}

for (const mutation of CASES) {
  test(`AC5/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
    const source = mutation.slot === 'service' ? SHIPPING_SERVICE_MODULE : SHIPPING_ROUTES_MODULE;
    const basePath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-base-${process.pid}.ts`);
    const mutantPath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-mut-${process.pid}.ts`);

    try {
      await copyFile(source, basePath);

      // ── arm one: the same text, unmutated. A harness that reds here cannot say anything about the
      // mutant, so this arm is a precondition rather than a second experiment.
      const base = await measureArm(mutation, basePath);
      const baseExit = base.red.length === 0 ? 0 : 1;
      process.stdout.write(
        `falsify/${mutation.name} base: mutation=${mutation.name} baseExit=${baseExit} ` +
          `readings=${base.total} red=${base.red.length}` +
          `${base.red.length === 0 ? '' : ` [${base.red.join(' ')}]`}\n`,
      );
      assert.deepEqual(
        base.red,
        [],
        `the unmutated copy must clear the whole list before the mutation means anything; it red at ${base.red.join(', ')}`,
      );

      // ── the mutation itself. The anchor has to be unique: a text that occurs twice would be
      // rewritten in both places, and the case would then be about two edits rather than one.
      const shippingText = await readFile(source, 'utf8');
      const anchorCount = shippingText.split(mutation.anchor).length - 1;
      assert.equal(
        anchorCount,
        1,
        `the anchor for ${mutation.name} occurs ${anchorCount} times in the shipping module; a mutation ` +
          'case has to name exactly one site, or it is not this case that the red would be about',
      );

      const mutated = shippingText.replace(mutation.anchor, mutation.replacement);
      assert.notEqual(mutated, shippingText, `the ${mutation.name} replacement did not change the text`);
      await writeFile(mutantPath, mutated, 'utf8');

      // ── arm two: the mutant, at a NEW path, because ESM caches by URL and a mutant that reused
      // the base copy's path would import the base module and measure nothing at all.
      const mutant = await measureArm(mutation, mutantPath);
      const inTargetFamily = mutant.red.filter((name) => mutation.target.test(name));
      process.stdout.write(
        `falsify/${mutation.name} mutant: mutation=${mutation.name} baseExit=0 ` +
          `mutantRed=${inTargetFamily.length > 0} whichLine=${mutation.family} ` +
          `whichReading=${inTargetFamily[0] ?? '(none)'} red=${mutant.red.length} ` +
          `[${mutant.red.join(' ')}] in-target=[${inTargetFamily.join(' ')}] ` +
          `red-reason=${mutant.firstRedReason} ` +
          `outsideFamilyGreen=${String(mutant.outsiderGreen !== '(none)')} ` +
          `outsider=${mutant.outsiderGreen} why=${mutation.why}\n`,
      );

      assert.ok(
        inTargetFamily.length > 0,
        `the ${mutation.name} mutation (${mutation.why}) must red a reading matching ${mutation.target}; ` +
          `the mutant was graded as: ${mutant.red.length === 0 ? 'all green' : mutant.red.join(', ')}`,
      );

      // ── arm three: something outside the family is still green, so the red is attributable to the
      // mutation rather than to a rig that fell over as a whole.
      assert.notEqual(
        mutant.outsiderGreen,
        '(none)',
        `every reading red under ${mutation.name}, which reads as a broken rig rather than as this mutation`,
      );
    } finally {
      await rm(basePath, { force: true });
      await rm(mutantPath, { force: true });
    }
  });
}

// ── AC6's exit codes: the surfaces this task must not have moved ───────────────────────────────

/**
 * The seven criteria AC6 names, as `[name, path]` so the printed line says which one answered.
 *
 * The first is the criterion this task had to re-pin (the router's non-ceiling parser failure now
 * carries a code); the next two are AC-139's, which this task may add to but not relax; the rest read
 * faces this task never touched. All seven are read here rather than trusted, because "I did not touch
 * it" is exactly the assumption a shared type change can falsify.
 */
const EXISTING_CRITERIA: readonly (readonly [string, string])[] = [
  ['voiceTranscribeGaps', 'server/modules/voice/tests/voiceTranscribeGaps.test.ts'],
  ['voice-provider-dispatch', 'server/modules/voice/tests/voice-provider-dispatch.test.ts'],
  [
    'voice-provider-dispatch-falsify',
    'server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts',
  ],
  ['voice-config.routes', 'server/modules/voice/tests/voice-config.routes.test.ts'],
  ['voice-capture-text', 'server/modules/voice/tests/voice-capture-text.test.ts'],
  ['voiceHealth', 'server/modules/voice/tests/voiceHealth.test.ts'],
  ['voice.service', 'server/modules/voice/tests/voice.service.test.ts'],
];

type CommandOutcome = {
  name: string;
  command: string;
  exitCode: number;
  /** The case tally the runner printed, or `null` for a command that prints no tally. */
  cases: number | null;
};

/**
 * Runs one command and reports its exit code plus, for a test runner, how many cases it ran.
 *
 * `NODE_TEST_CONTEXT` IS DELETED FROM THE CHILD'S ENVIRONMENT, and that is what makes "exit 0" mean
 * something: a `node --test` child that inherits it runs in the parent's context and exits 0 having
 * run NOTHING, which is the exact false green this reading exists to catch. The tally is asserted
 * non-zero for the same reason, one level down.
 */
function runCommand(name: string, command: string, args: readonly string[], tally: boolean): CommandOutcome {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const options = {
    cwd: REPO_ROOT,
    encoding: 'utf8' as const,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  };

  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(command, [...args], options);
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    exitCode = typeof failure.status === 'number' ? failure.status : 1;
    output = typeof failure.stdout === 'string' ? failure.stdout : '';
  }

  const match = tally ? /pass (\d+)/.exec(output) : null;
  return {
    name,
    command: `${command} ${args.join(' ')}`,
    exitCode,
    cases: match === null ? null : Number(match[1]),
  };
}

test('AC6 the existing criteria and the repository gates still exit 0', () => {
  const outcomes: CommandOutcome[] = [
    ...EXISTING_CRITERIA.map(([name, file]) =>
      runCommand(name, 'npx', ['tsx', '--tsconfig', 'server/tsconfig.json', '--test', file], true),
    ),
    runCommand('typecheck', 'npm', ['run', 'typecheck'], false),
    runCommand('lint', 'npm', ['run', 'lint'], false),
  ];

  for (const outcome of outcomes) {
    const tally =
      outcome.cases === null
        ? 'cases=n/a'
        : `cases=${outcome.cases}${outcome.cases > 0 ? '' : ' (NOTHING RAN)'}`;
    process.stdout.write(`AC6 exit=${outcome.exitCode} name=${outcome.name} ${tally} :: ${outcome.command}\n`);
  }

  assert.deepEqual(
    outcomes.filter((outcome) => outcome.exitCode !== 0).map((outcome) => outcome.name),
    [],
    'a surface this task must not have moved is red',
  );
  assert.deepEqual(
    outcomes
      .filter((outcome) => outcome.cases !== null && outcome.cases === 0)
      .map((outcome) => outcome.name),
    [],
    'a criterion that exits 0 having run no cases is a vacuous pass, not a green one',
  );
});

test('AC5: the temp copies are gone and git status --porcelain gained nothing', () => {
  const porcelain = gitStatusPorcelain();
  const leftovers = porcelain
    .split('\n')
    .filter((line) => line.includes(TEMP_PREFIX))
    .join(' ');
  const clean = porcelain.trim() === '';
  const unchanged = porcelain === PRE_RUN_PORCELAIN;

  process.stdout.write(
    `falsify/leftovers: git.status-clean=${String(clean)} unchanged=${String(unchanged)} ` +
      `temp-copies=${leftovers === '' ? 'none' : leftovers}\n`,
  );

  // The copies are UNTRACKED files, so a run that failed to delete one shows up as a `??` line
  // naming it. This is asserted before the comparison below, because it is the property the cases are
  // responsible for and it is the one that holds whether or not the tree was clean.
  assert.equal(leftovers, '', `the run left temp copies behind: ${leftovers}`);

  // AC5's own words: `git status --porcelain` is identical to the state this file started in. In the
  // tree the gate runs, that state is empty; in a tree a developer was already iterating on, the
  // property this case owns is that the run ADDED nothing, so the comparison is against the state
  // this file started in rather than against an ideal it was never handed.
  assert.equal(unchanged, true, `this run changed the worktree's git status: ${firstLine(porcelain)}`);
  if (clean) {
    process.stdout.write('falsify/git-status-clean=true (the run started from a committed tree)\n');
  } else {
    process.stdout.write(
      `falsify/git-status-clean=false (tree was already dirty before this run): ${firstLine(porcelain)}\n`,
    );
  }
});
