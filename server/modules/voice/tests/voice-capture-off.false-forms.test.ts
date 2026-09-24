/**
 * The falsifying forms behind `voice-capture-off.test.ts`, plus the exit-code half of AC6.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that claim is not something a passing run can show
 * about itself. So each case here builds a BROKEN copy of a shipping module by a one-line text
 * mutation, runs the whole reading list against it, and requires the readings it predicts to fail.
 * The two mutations are the two cheap ways to satisfy this task's words while missing its subject:
 *
 *   · `gate-permanently-open` — record whenever a port exists. Every sentence about "the mode
 *     decides" is still literally implemented (there IS a mode, the port carries it, the audio write
 *     still checks for `audio`), and an `off` deployment records attempt rows. If this case passes,
 *     AC2's byte-equality readings are not measuring the gate.
 *   · `invalid-treated-as-text` — treat a value nobody defined as `text`. The resolver keeps its
 *     three named modes and its warning, and the fail-CLOSED decision is gone: a deployment that
 *     misspells the mode records the thing it meant to keep out of the log. If this case passes,
 *     AC4's start-up readings are not measuring which mode the process came up in.
 *
 * EACH CASE HAS THREE PARTS, and the first is what keeps the other two from being vacuous:
 *   1. the UNMUTATED copy must clear the whole list (a harness that is red for its own reasons
 *      proves nothing by going red on a mutant);
 *   2. the MUTATED copy must red at least one reading in the predicted family, and the red reading
 *      is printed by name so the failure is attributable;
 *   3. some reading OUTSIDE that family must still be green, so "the whole rig broke" is not what
 *      the red means.
 *
 * THE COPIES LIVE IN THE SAME TREE as the files they copy (`server/modules/voice/`), because a
 * module's imports are relative — `../../../shared/asr/asrRegistry.js` — and a copy in the OS temp
 * directory would not resolve them. Each copy gets its OWN path, because ESM caches a module by URL:
 * a mutant written over the base copy's path would import the already-evaluated base module and the
 * run would measure nothing. A copy of the SERVICE module still imports the SHIPPING capture module,
 * which is exactly what makes the two cases independent — each mutation is the only difference.
 *
 * WHY AC6'S EXIT CODES ARE HERE. AC6 asks for the exit code of four existing criteria plus
 * `npm run typecheck` and `npm run lint`, each printed rather than assumed. Those are SUBPROCESSES,
 * and AC1 requires the criterion file itself to start none inside a fifteen-second budget — one
 * `npm run typecheck` alone is most of that budget. This file is the task's other executable
 * artifact, it already starts `git`, and it is not the file the target-side gate runs. The in-process
 * half of AC6 (the `off` attempt line gains no field) is where the lines are, in the criterion file.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { collectReadings, SHIPPING_CAPTURE_MODULE, SHIPPING_SERVICE_MODULE } from './voice-capture-off.test.js';

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
 * Captured in the module body rather than in a hook, because what AC7 owes is that THIS RUN adds
 * nothing: a tree that a developer already had dirty should not be reported as this criterion's
 * leftovers, and a tree that was clean has to come back clean.
 */
const PRE_RUN_PORCELAIN = gitStatusPorcelain();

// ── the mutation cases ────────────────────────────────────────────────────────────────────────

type MutationCase = {
  /** The case's name, used in the reading names and the temp file names. */
  name: string;
  /** Which module the mutation is applied to; the other stays the shipping one. */
  slot: 'service' | 'capture';
  /** The exact shipping text to replace. Required to be unique in the file. */
  anchor: string;
  /** What it is replaced with. */
  replacement: string;
  /** The readings this mutation must break, as the criterion names them. */
  target: RegExp;
  /** Which AC's line the red must be on, printed as `whichLine=`. */
  family: 'AC2' | 'AC4';
  /** What the mutation is, in one sentence, for the reason printed with the reading. */
  why: string;
};

const CASES: readonly MutationCase[] = [
  {
    name: 'gate-permanently-open',
    slot: 'service',
    anchor: [
      '  const recording: VoiceCapturePort | null =',
      "    dependencies.capture !== undefined && dependencies.capture.mode !== 'off'",
      '      ? dependencies.capture',
      '      : null;',
    ].join('\n'),
    replacement: '  const recording: VoiceCapturePort | null = dependencies.capture ?? null;',
    target: /^AC2 /,
    family: 'AC2',
    why: 'the gate is short-circuited, so any injected port records whether or not the deployment is off',
  },
  {
    name: 'invalid-treated-as-text',
    slot: 'capture',
    anchor: [
      "  if (value === 'text' || value === 'audio') {",
      '    return { mode: value, warning: null };',
      '  }',
      '',
      "  return { mode: 'off', warning: voiceCaptureWarningLine(value) };",
    ].join('\n'),
    replacement: [
      "  if (value === 'text' || value === 'audio') {",
      '    return { mode: value, warning: null };',
      '  }',
      '',
      "  return { mode: 'text', warning: voiceCaptureWarningLine(value) };",
    ].join('\n'),
    target: /^AC4 /,
    family: 'AC4',
    why: 'an unrecognised value is recorded as text, so the fail-closed decision is gone',
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
function modulesFor(mutation: MutationCase, modulePath: string): { service?: string; capture?: string } {
  return mutation.slot === 'service' ? { service: modulePath } : { capture: modulePath };
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
  test(`AC7/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
    const source = mutation.slot === 'service' ? SHIPPING_SERVICE_MODULE : SHIPPING_CAPTURE_MODULE;
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
          `mutantRed=${inTargetFamily.length > 0} whichLine=${mutation.family} red=${mutant.red.length} ` +
          `[${mutant.red.join(' ')}] in-target=[${inTargetFamily.join(' ')}] ` +
          `red-reason=${mutant.firstRedReason} outsider-still-green=${mutant.outsiderGreen} ` +
          `why=${mutation.why}\n`,
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

/** The four existing criteria AC6 names, by path so the printed line says which one answered. */
const EXISTING_CRITERIA = [
  'server/modules/voice/tests/voice.service.test.ts',
  'server/modules/voice/tests/voiceHealth.test.ts',
  'server/modules/voice/tests/voice-config.routes.test.ts',
  'server/modules/voice/tests/voiceTranscribeGaps.test.ts',
];

type CommandOutcome = {
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
function runCommand(command: string, args: readonly string[], tally: boolean): CommandOutcome {
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
  return { command: `${command} ${args.join(' ')}`, exitCode, cases: match === null ? null : Number(match[1]) };
}

test('AC6 the existing criteria and the repository gates still exit 0', () => {
  const outcomes: CommandOutcome[] = [
    ...EXISTING_CRITERIA.map((file) =>
      runCommand('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', '--test', file], true),
    ),
    runCommand('npm', ['run', 'typecheck'], false),
    runCommand('npm', ['run', 'lint'], false),
  ];

  for (const outcome of outcomes) {
    const tally =
      outcome.cases === null
        ? 'cases=n/a'
        : `cases=${outcome.cases}${outcome.cases > 0 ? '' : ' (NOTHING RAN)'}`;
    process.stdout.write(`AC6 exit=${outcome.exitCode} ${tally} :: ${outcome.command}\n`);
  }

  assert.deepEqual(
    outcomes.filter((outcome) => outcome.exitCode !== 0).map((outcome) => outcome.command),
    [],
    'a surface this task must not have moved is red',
  );
  assert.deepEqual(
    outcomes.filter((outcome) => outcome.cases !== null && outcome.cases === 0).map((outcome) => outcome.command),
    [],
    'a criterion that exits 0 having run no cases is a vacuous pass, not a green one',
  );
});

test('AC7: the temp copies are gone and git status --porcelain gained nothing', () => {
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
  // naming it. This is asserted before the readings below, because it is the property the cases are
  // responsible for and it is the one that holds whether or not the tree was clean.
  assert.equal(leftovers, '', `the run left temp copies behind: ${leftovers}`);

  // AC7's own words: `git status --porcelain` is empty once the run is over. That is exactly true
  // when the run starts from a committed tree — which is how the gate runs it — and the criterion
  // says which reading it took rather than assuming it. In a tree that was ALREADY dirty (a
  // developer iterating on the module), the property this case owns is that the run ADDED nothing,
  // so the comparison is against the state this file started in rather than against an ideal.
  assert.equal(unchanged, true, `this run changed the worktree's git status: ${firstLine(porcelain)}`);
  if (clean) {
    process.stdout.write('falsify/git-status-clean=true (the run started from a committed tree)\n');
  } else {
    process.stdout.write(
      `falsify/git-status-clean=false (tree was already dirty before this run): ${firstLine(porcelain)}\n`,
    );
  }
});
