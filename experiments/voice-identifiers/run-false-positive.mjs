#!/usr/bin/env node
/**
 * AC-112 — repair must leave identifier-free text alone.
 *
 * The candidate set is the repository's real file list (`git ls-files`), not a
 * toy vocabulary. That matters: with a real list the module is asked to choose
 * between ~2k names, so any threshold-only matcher has plenty of chances to
 * "repair" an ordinary word into a name that exists.
 *
 * The corpus is not a list of unrelated sentences — those cannot fail, because
 * nothing in them is close to a candidate. At least twelve of the entries carry
 * a phrase one edit distance from a real file name; those are the ones a
 * similarity-only implementation rewrites.
 *
 * Run from anywhere; the repository is located from this file's own path:
 *   node experiments/voice-identifiers/run-false-positive.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { editDistance, projectCandidates, repairIdentifiers, squash } from './identifierRepair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const MIN_CANDIDATES = 1000;
const MIN_NEAR_WORDS = 12;

const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'negative.json'), 'utf8'));
const { candidates } = projectCandidates({ cwd: REPO_ROOT });
const live = new Set(candidates);

const problems = [];
const falsePositives = [];
let nearWords = 0;

for (const entry of fixture.entries) {
  if (entry.near) {
    const { word, of } = entry.near;
    if (!live.has(of)) {
      problems.push(`${entry.id}: near.of "${of}" is not a candidate any more`);
    } else {
      const d = editDistance(squash(word), squash(of));
      if (d !== 1) problems.push(`${entry.id}: "${word}" is ${d} edits from "${of}", not 1`);
      else nearWords++;
    }
  }

  const { text, repairs } = repairIdentifiers(entry.text, candidates);
  if (text !== entry.text) falsePositives.push({ entry, text, repairs });
}

// The readings the criterion pins, on the first line and in this order.
console.log(`candidates=${candidates.length} negatives=${fixture.entries.length} falsePositives=${falsePositives.length}`);
console.log(`nearWords=${nearWords} minNearWords=${MIN_NEAR_WORDS} minCandidates=${MIN_CANDIDATES}`);

for (const { entry, text, repairs } of falsePositives) {
  console.log(`  FP ${entry.id} [${entry.lang}] ${JSON.stringify(entry.text)}`);
  console.log(`     -> ${JSON.stringify(text)}  repairs=${JSON.stringify(repairs)}`);
}
for (const p of problems) console.log(`  FIXTURE ${p}`);

if (candidates.length < MIN_CANDIDATES) {
  console.error(`FAIL: only ${candidates.length} candidates from git ls-files, need >= ${MIN_CANDIDATES}`);
  process.exit(1);
}
if (nearWords < MIN_NEAR_WORDS) {
  console.error(`FAIL: only ${nearWords} near-miss entries verified, need >= ${MIN_NEAR_WORDS}`);
  process.exit(1);
}
if (problems.length) {
  console.error(`FAIL: ${problems.length} fixture claim(s) no longer hold`);
  process.exit(1);
}
if (falsePositives.length) {
  console.error(`FAIL: ${falsePositives.length} of ${fixture.entries.length} identifier-free sentences were rewritten`);
  process.exit(1);
}

console.log(`OK: ${fixture.entries.length} identifier-free sentences unchanged over ${candidates.length} real candidates`);
