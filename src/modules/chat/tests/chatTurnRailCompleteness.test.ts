import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The turn-navigation rail is chat chrome, so every language bundle has to carry
 * its three keys. react-i18next renders a missing key verbatim, which would ship
 * a rail whose accessible names read `turnRail.jumpToTurn` instead of a label.
 * This walks the whole `locales/<lang>/chat.json` glob rather than a hardcoded
 * list, so a locale added (or dropped) without the keys cannot pass by going
 * stale, and it does not settle for checking `en` alone.
 *
 * Resolved from the vitest process cwd (the repo root), the way the other
 * filesystem-reading tests in this repo do it: under vitest's jsdom environment
 * `import.meta.url` is not a file: URL, so `fileURLToPath` rejects it.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** The shape this test reads back out of a locale bundle — deliberately loose. */
type ChatBundle = { turnRail?: Record<string, unknown> };

/** Keys the rail reads, and the reason a bundle fails the contract (empty array means it passes). */
const TURN_RAIL_KEYS = ['label', 'jumpToTurn', 'turn'] as const;

function turnRailProblems(bundle: ChatBundle): string[] {
  const problems: string[] = [];
  for (const key of TURN_RAIL_KEYS) {
    const value = bundle.turnRail?.[key];
    if (typeof value !== 'string') {
      problems.push(`turnRail.${key} is missing or not a string`);
    } else if (value.trim().length === 0) {
      problems.push(`turnRail.${key} is an empty string`);
    } else if (value === `turnRail.${key}`) {
      problems.push(`turnRail.${key} is the raw key name, not a label`);
    }
  }
  return problems;
}

describe('every locale carries the turnRail labels', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const bundleFiles = globSync('*/chat.json', { cwd: LOCALES_DIR }).sort();

  it('covers every language directory on disk (the 12-locale glob, not a sampled subset)', () => {
    // Two independent enumerations agreeing: readdir for the directories, glob for
    // the bundles. A dropped directory or a truncated glob breaks this equality.
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/chat.json`));
    expect(localeDirs.length, `locale directories found: ${JSON.stringify(localeDirs)}`).toBeGreaterThanOrEqual(12);
  });

  it('gives every locale a non-empty turnRail label, jumpToTurn and turn', () => {
    const offenders: string[] = [];

    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as ChatBundle;
      for (const problem of turnRailProblems(bundle)) {
        offenders.push(`${file}: ${problem}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // Positive control: the same checker must reject a bundle that lacks a key (or
  // carries a blank / copy-pasted value). If it could not, the case above would
  // be a green that cannot go red.
  it('rejects a bundle with a missing, blank or key-copied label (positive control)', () => {
    expect(turnRailProblems({ turnRail: {} })).toEqual([
      'turnRail.label is missing or not a string',
      'turnRail.jumpToTurn is missing or not a string',
      'turnRail.turn is missing or not a string',
    ]);
    expect(turnRailProblems({ turnRail: { label: '', jumpToTurn: 'x', turn: 'y' } }))
      .toEqual(['turnRail.label is an empty string']);
    expect(turnRailProblems({ turnRail: { label: 'turnRail.label', jumpToTurn: 'x', turn: 'y' } }))
      .toEqual(['turnRail.label is the raw key name, not a label']);
    expect(turnRailProblems({ turnRail: { label: 'Turns', jumpToTurn: 'Go {{n}}', turn: 'Turn {{n}}' } }))
      .toEqual([]);
  });
});
