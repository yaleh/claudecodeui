import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { test } from 'vitest';

import { repairIdentifiers } from '@/shared/identifierRepair';

// A slice of a project's file tree plus one symbol, which is what the caller
// has: real names, and the text a recogniser produced from speech.
const CANDIDATES = [
  'App.tsx',
  'README.md',
  'index.ts',
  'package.json',
  'useVoiceInput',
  'voiceConfig.ts',
  'voiceIdentifierRepair.ts',
];

test('a misheard file name is repaired to the name the project really has', () => {
  assert.equal(
    repairIdentifiers('open voiceConfg.ts and check', CANDIDATES),
    'open voiceConfig.ts and check',
  );
});

test('a sentence with no identifier in it comes back character for character', () => {
  // Every one of these tokens is a trap for a looser matcher: `ends.` and
  // `readme.` are one edit from a real extension, `3.14` looks like a dotted
  // name, and `e.g.` is a dotted token whose opening matches nothing.
  const prose = 'I looked at how the file ends. Then read the readme. 3.14 and e.g. matter.';

  assert.equal(repairIdentifiers(prose, CANDIDATES), prose);
});

test('a symbol the recogniser split into words is put back together', () => {
  assert.equal(
    repairIdentifiers('check use voice input before the change', CANDIDATES),
    'check useVoiceInput before the change',
  );
});

test('prose shaped exactly like the split symbol is left alone', () => {
  // "look at how" and "use voice input" are the same shape — three lowercase
  // words — so this is the case that rules out every threshold-based match on
  // the split half. Only the one that is the symbol may be rewritten.
  const prose = 'look at how it behaves';

  assert.equal(repairIdentifiers(prose, CANDIDATES), prose);
});

test('a token spelled without its extension is not matched to a name that has one', () => {
  // Without the dotted/dotless split this one is a single edit from `README.md`
  // with a similarity of 0.89: the two halves of the candidate list must never
  // see each other.
  const text = 'readmemd';

  assert.equal(repairIdentifiers(text, CANDIDATES), text);
});

test('names that do not open alike are never treated as each other', () => {
  // Two edits from `voiceConfig.ts` at a similarity of 0.86 — the opening is
  // the only thing that says this is a different name rather than a typo.
  const text = 'rename boiceConfg.ts';

  assert.equal(repairIdentifiers(text, CANDIDATES), text);
});

test('a name too short to be a typo of a candidate is not stretched into it', () => {
  // `voiceIdentifier.ts` shares the opening and is a plausible edit of
  // `voiceIdentifierRepair.ts`, but seven characters of difference is not a
  // mishearing. This is the case the length guard settles on its own: with the
  // guard degraded to a finite sentinel, the similarity of the surviving
  // characters reads as 0.88 and the name is stretched.
  const text = 'the voiceIdentifier.ts file';

  assert.equal(repairIdentifiers(text, CANDIDATES), text);
});

test('a name already spelled correctly is kept, in its own spelling', () => {
  assert.equal(
    repairIdentifiers('open voiceConfig.ts and use voice input', CANDIDATES),
    'open voiceConfig.ts and useVoiceInput',
  );
});

test('the answer does not depend on the order the candidates arrive in', () => {
  const text = 'open voiceConfg.ts';

  assert.equal(
    repairIdentifiers(text, CANDIDATES),
    repairIdentifiers(text, [...CANDIDATES].reverse()),
  );
});

test('the module is a pure string function sitting beside voiceConfig.ts', () => {
  // The `@` alias maps to `src`, so the import at the top of this file resolves
  // to this path. Reading it here is what pins the module to `src/shared`,
  // beside the voice config it is meant to sit next to instead of inside a
  // module folder, and the neighbour is checked first so the pair is real.
  const sharedDir = resolve(process.cwd(), 'src', 'shared');
  assert.equal(statSync(join(sharedDir, 'voiceConfig.ts')).isFile(), true);

  const source = readFileSync(join(sharedDir, 'identifierRepair.ts'), 'utf8');

  // Nothing may be pulled in except local code and node builtins: that is what
  // "no React dependency" means for a module that is meant to run anywhere.
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map(
    (match) => match[1],
  );
  for (const specifier of specifiers) {
    assert.match(specifier, /^(?:node:|@\/|\.)/, `unexpected dependency: ${specifier}`);
  }

  // And it may not reach for the DOM, which would make it unusable anywhere the
  // transcription itself runs.
  for (const global of ['document', 'window', 'HTMLElement', 'localStorage', 'navigator']) {
    assert.equal(
      new RegExp(`\\b${global}\\b`).test(source),
      false,
      `the module must not touch ${global}`,
    );
  }
});
