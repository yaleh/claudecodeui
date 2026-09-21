#!/usr/bin/env node
/**
 * AC-113 — repair restores misspelled identifiers to real file names.
 *
 * Measured on transcript shapes that were actually observed coming back from
 * the recogniser, not on invented typos: `voice.service.ts` arriving as
 * `voice.seluis.ts`, `useVoiceInput` arriving as "Use voice input", and
 * `voice.module.ts` arriving as `voice.module.t`.
 *
 * Two readings matter and they are not the same reading:
 *
 *   survivalBefore -> survivalAfter   the repair has to actually help.
 *   misRepairs                        how often it helped by inventing a name
 *                                     the reference never contained. A repair
 *                                     that "improves" survival by writing a
 *                                     plausible-but-wrong file into the
 *                                     transcript is worse than no repair at
 *                                     all: that is the failure that sends an
 *                                     agent to edit the wrong file.
 *
 * Run from anywhere; the repository is located from this file's own path:
 *   node experiments/voice-identifiers/run-recovery.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { identifierFidelity, identifiers } from './identifierFidelity.mjs';
import { projectCandidates, repairIdentifiers } from './identifierRepair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const MIN_CANDIDATES = 1000;
const MIN_ENTRIES = 12;

const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'recovery.json'), 'utf8'));
const { candidates } = projectCandidates({ cwd: REPO_ROOT });

let before = 0;
let after = 0;
let total = 0;
let repairs = 0;
const misRepairs = [];
const rows = [];

for (const entry of fixture.entries) {
  const referenceIds = identifiers(entry.reference);
  const repaired = repairIdentifiers(entry.transcript, candidates);
  const b = identifierFidelity(entry.reference, entry.transcript);
  const a = identifierFidelity(entry.reference, repaired.text);

  for (const r of repaired.repairs) {
    if (!referenceIds.includes(r.to)) {
      misRepairs.push({ id: entry.id, ...r, referenceIds });
    }
  }

  before += b.survived;
  after += a.survived;
  total += b.total;
  repairs += repaired.repairs.length;
  rows.push({ id: entry.id, b, a, text: repaired.text, repairs: repaired.repairs });
}

const rate = (n) => (total ? n / total : 0);
const survivalBefore = rate(before);
const survivalAfter = rate(after);

// The readings the criterion pins, on the first line and in this order.
console.log(`survivalBefore=${survivalBefore.toFixed(4)} survivalAfter=${survivalAfter.toFixed(4)} misRepairs=${misRepairs.length}`);
console.log(`candidates=${candidates.length} entries=${fixture.entries.length} identifiers=${total} repairs=${repairs}`);
console.log(`survivalBeforeDetail=${before}/${total} survivalAfterDetail=${after}/${total}`);

for (const row of rows) {
  const mark = row.a.survived > row.b.survived ? 'FIXED' : row.a.survived < row.b.survived ? 'BROKE' : 'flat ';
  console.log(`  ${mark} ${row.id} ${row.b.survived}/${row.b.total} -> ${row.a.survived}/${row.a.total} repairs=${JSON.stringify(row.repairs)}`);
}
for (const m of misRepairs) {
  console.log(`  MISREPAIR ${m.id}: "${m.from}" -> "${m.to}" not among reference identifiers ${JSON.stringify(m.referenceIds)}`);
}

if (candidates.length < MIN_CANDIDATES) {
  console.error(`FAIL: only ${candidates.length} candidates from git ls-files, need >= ${MIN_CANDIDATES}`);
  process.exit(1);
}
if (fixture.entries.length < MIN_ENTRIES) {
  console.error(`FAIL: only ${fixture.entries.length} observed-shape entries, need >= ${MIN_ENTRIES}`);
  process.exit(1);
}
if (misRepairs.length) {
  console.error(`FAIL: ${misRepairs.length} repair(s) wrote a name the reference never contained`);
  process.exit(1);
}
// Strictly greater, not "greater by a margin": the invariant this pins is that
// repair helps, and the measurement is deterministic, so there is no noise for a
// margin to absorb.
if (!(survivalAfter > survivalBefore)) {
  console.error(`FAIL: survival did not improve (${survivalBefore.toFixed(4)} -> ${survivalAfter.toFixed(4)})`);
  process.exit(1);
}

console.log(`OK: identifier survival ${(survivalBefore * 100).toFixed(1)}% -> ${(survivalAfter * 100).toFixed(1)}% with zero mis-repairs`);
