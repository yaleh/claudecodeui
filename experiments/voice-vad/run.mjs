#!/usr/bin/env node
/**
 * Freeze, and re-read, the baseline of the shipping VAD against exact truth.
 *
 * This runner answers one question with numbers: how far are `trimVoiceAudio`'s speech regions
 * from the place the sentences actually are, on real human speech laid out with known gaps. It
 * does not choose a parameter and it does not call a recogniser — it is the T1/T2 measuring tool
 * the streaming-VAD work will be read against.
 *
 * Two modes, and the difference matters:
 *
 *   · default   — read the corpus, synthesise the seed × noise × gap-family grid, run the
 *                 detector on every timeline, measure, and write `fixtures/baseline.json`.
 *                 This costs CPU and needs the corpus; it is the mode that *produces* truth.
 *   · --offline — load the frozen snapshot and recompute every reading from the truth and the
 *                 detector output stored in it. No corpus, no decoder, no network. This is the
 *                 mode the suite and any later reader use, so a reading is always reproducible
 *                 from a file that is in the repo.
 *
 * The coverage assertion lives in both modes: the grid must be complete (seeds × noise ×
 * families, no missing cell) and at least 2000 timelines. A snapshot with a hole in it is a
 * reading from a sample nobody can describe, so it fails rather than reports.
 *
 * Env: VAD_CORPUS  corpus root (default the LibriSpeech dev-clean tree named in the proposal)
 *      VAD_CORAAL  CORAAL `*_segments/` dir (default the interview segments); unset/absent => T2 skipped
 *      VAD_LONG    T3 fixed samples dir (default corpus/long, with its manifest.json); absent => T3 skipped
 *      VAD_SEEDS   number of seeds (default 100)
 *      NO_NETWORK  install a guard that throws on any fetch/http(s) call
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import https from 'node:https';

import { trimVoiceAudio } from '../../src/shared/voiceTrim.ts';
import {
  DEFAULT_RATE,
  GAP_FAMILY_NAMES,
  NOISE_MODES,
  buildCoraalTimeline,
  buildTimeline,
  loadCorpus,
  loadLongCorpus,
} from './timeline.mjs';
import { DEFAULT_MAX_SEGMENT_SEC, aggregateMetrics, computeMetrics, formatAggregate } from './metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, 'fixtures', 'baseline.json');
const DEFAULT_CORPUS = '/data/home/yale/work/tc-verify/corpus/public/LibriSpeech/dev-clean';
const DEFAULT_CORAAL = '/data/home/yale/work/tc-verify/corpus/spontaneous/DCA_se1_ag3_f_01_1_segments';
const DEFAULT_LONG = '/data/home/yale/work/tc-verify/corpus/long';
const MIN_TIMELINES = 2000;

const LIMITATIONS = [
  'noise is laid only in the gaps, so a sentence\'s samples are byte-exact: this reads false alarms on noise-only time, not detector behaviour on noisy speech',
  'LibriSpeech clips are read speech and much shorter than real dictation; the inter-sentence gaps are injected by the harness, not drawn from the corpus',
  'a sentence\'s own internal pauses are unannotated, so an "over-segmentation" is counted per sentence, not per word',
  'the current detector has no maximum segment length, so maxSegmentViolations is a reading about the detector we have, not a rule it enforces',
];

/** Throw on any network entry point. The harness never uses one; the guard makes that checkable. */
function installNoNetworkGuard() {
  const boom = () => {
    throw new Error('NO_NETWORK guard: the voice-vad harness attempted a network call');
  };
  const g = /** @type {any} */ (globalThis);
  g.fetch = boom;
  for (const mod of [/** @type {any} */ (http), /** @type {any} */ (https)]) {
    mod.request = boom;
    mod.get = boom;
  }
}

function parseArgs(argv) {
  const opts = { offline: false, seeds: Number(process.env.VAD_SEEDS ?? 100), out: SNAPSHOT_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--seeds') opts.seeds = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.seeds) || opts.seeds < 1) throw new Error(`--seeds must be a positive integer, got ${opts.seeds}`);
  return opts;
}

/**
 * The detector under measurement. Its segment list is the `(samples, sampleRate) => segments`
 * interface; `outputSec` is the module's own report of how long the trimmed upload would be,
 * which is the quantity the single-request ceiling is about.
 */
function currentDetector(samples, sampleRate) {
  const stats = trimVoiceAudio(samples, sampleRate).stats;
  return {
    segments: stats.vadSegments.map((s) => [s.startSec, s.endSec]),
    outputSec: Number(stats.outputSec.toFixed(6)),
  };
}

/** Metrics from raw interval lists, used by both modes so generate and --offline agree by code. */
function metricsFor(cell) {
  return computeMetrics({
    truth: cell.truth.map(([startSec, endSec]) => ({ startSec, endSec })),
    segments: cell.segments.map(([startSec, endSec]) => ({ startSec, endSec })),
    durationSec: cell.durationSec,
    silenceSec: cell.silenceSec,
    maxSegmentSec: cell.maxSegmentSec ?? DEFAULT_MAX_SEGMENT_SEC,
    outputSec: cell.outputSec ?? null,
  });
}

/** Turn one built timeline into the stored cell shape (rounding to 1 µs to keep the file small). */
function cellFromTimeline(tl, extra = {}) {
  const { segments, outputSec } = currentDetector(tl.samples, tl.sampleRate);
  const durationSec = tl.durationSec ?? tl.samples.length / tl.sampleRate;
  const speechSec = tl.truth.reduce((a, t) => a + (t.endSec - t.startSec), 0);
  return {
    ...extra,
    durationSec: Number(durationSec.toFixed(6)),
    silenceSec: Number((durationSec - speechSec).toFixed(6)),
    outputSec,
    maxSegmentSec: DEFAULT_MAX_SEGMENT_SEC,
    truth: tl.truth.map((t) => [Number(t.startSec.toFixed(6)), Number(t.endSec.toFixed(6))]),
    segments: segments.map((s) => [Number(s[0].toFixed(6)), Number(s[1].toFixed(6))]),
  };
}

/** Every seed × noise × family key, so a missing cell can be named rather than counted. */
function expectedKeys(seeds) {
  const keys = [];
  for (const seed of seeds) for (const noise of NOISE_MODES) for (const family of GAP_FAMILY_NAMES) keys.push(`${seed}|${noise}|${family}`);
  return keys;
}

/** Assert the grid is whole. Returns the missing keys so the caller can print them. */
function coverageGap(cells, seeds) {
  const present = new Set(cells.map((c) => `${c.seed}|${c.noise}|${c.family}`));
  return expectedKeys(seeds).filter((k) => !present.has(k));
}

function report(cells, seeds, label) {
  const byFamily = new Map();
  const byNoise = new Map();
  for (const cell of cells) {
    for (const [map, key] of [
      [byFamily, cell.family],
      [byNoise, cell.noise],
    ]) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ ...cell, metrics: metricsFor(cell) });
    }
  }
  const all = cells.map((c) => ({ ...c, metrics: metricsFor(c) }));
  console.log(`${label} — ${formatAggregate('all', aggregateMetrics(all.map((c) => c.metrics)))}`);
  for (const family of GAP_FAMILY_NAMES) {
    const rows = byFamily.get(family) ?? [];
    console.log(`  ${formatAggregate(`family=${family}`, aggregateMetrics(rows.map((c) => c.metrics)))}`);
  }
  for (const noise of NOISE_MODES) {
    const rows = byNoise.get(noise) ?? [];
    console.log(`  ${formatAggregate(`noise=${noise}`, aggregateMetrics(rows.map((c) => c.metrics)))}`);
  }
  const overlong = all.filter((c) => c.metrics.outputOverlong === true);
  if (overlong.length) {
    const worst = overlong.reduce((a, b) => (a.metrics.outputSec >= b.metrics.outputSec ? a : b));
    console.log(
      `  output > maxSegmentSec=${DEFAULT_MAX_SEGMENT_SEC}s (one overlong request): ${overlong.length} timeline(s); ` +
        `worst family=${worst.family} noise=${worst.noise} seed=${worst.seed} outputSec=${worst.metrics.outputSec.toFixed(1)}`,
    );
  }
  console.log(`  coverage: cells=${cells.length}/${seeds.length * NOISE_MODES.length * GAP_FAMILY_NAMES.length}`);
}

/** Recompute and print every reading from a frozen snapshot. No corpus or decoder is consulted. */
function runOffline(outPath) {
  if (!existsSync(outPath)) {
    console.error(`voice-vad-harness: snapshot not found: ${outPath}`);
    process.exit(1);
  }
  const snap = JSON.parse(readFileSync(outPath, 'utf8'));
  const seeds = snap.grid.seeds;
  const missing = coverageGap(snap.cells, seeds);
  report(snap.cells, seeds, `voice-vad --offline (detector=${snap.detector}, snapshot=${outPath})`);
  if (snap.t2) console.log(`  ${formatAggregate('t2=coraal', aggregateMetrics([metricsFor(snap.t2)]))}`);
  for (const row of snap.t3 ?? []) {
    console.log(`  ${formatAggregate(`t3=${row.id}`, aggregateMetrics([metricsFor(row)]))}`);
  }
  if (missing.length) {
    console.error(`voice-vad-harness: ${missing.length} missing grid cell(s), first: ${missing[0]}`);
    process.exit(1);
  }
  if (snap.cells.length < MIN_TIMELINES) {
    console.error(`voice-vad-harness: snapshot covers ${snap.cells.length} timelines < ${MIN_TIMELINES}`);
    process.exit(1);
  }
  console.log(`voice-vad-harness: OK — recomputed ${snap.cells.length} timelines from ${outPath}`);
}

/** Read the corpus, synthesise the grid, run the detector, and freeze the snapshot. */
function runGenerate(opts) {
  const corpusRoot = process.env.VAD_CORPUS ?? DEFAULT_CORPUS;
  let corpus;
  try {
    corpus = loadCorpus(corpusRoot, { pool: 200, rate: DEFAULT_RATE });
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(1);
  }
  console.log(`corpus: ${corpus.root} (files=${corpus.totalFiles}, decoded pool=${corpus.pool})`);

  const seeds = Array.from({ length: opts.seeds }, (_, i) => i);
  const cells = [];
  for (const seed of seeds) {
    for (const noise of NOISE_MODES) {
      for (const family of GAP_FAMILY_NAMES) {
        const tl = buildTimeline({ sources: corpus.sources, seed, family, noise, sampleRate: DEFAULT_RATE });
        cells.push(cellFromTimeline(tl, { seed, noise, family }));
      }
    }
  }

  let t2 = null;
  const coraalDir = process.env.VAD_CORAAL ?? DEFAULT_CORAAL;
  if (existsSync(coraalDir)) {
    const tl = buildCoraalTimeline(coraalDir, DEFAULT_RATE);
    t2 = { dir: coraalDir, ...cellFromTimeline(tl) };
    console.log(`t2: ${coraalDir} (${tl.truth.length} annotated segments, ${tl.durationSec.toFixed(1)}s)`);
  } else {
    console.log(`t2: skipped (CORAAL segments dir not found: ${coraalDir})`);
  }

  const t3 = [];
  const longDir = process.env.VAD_LONG ?? DEFAULT_LONG;
  if (existsSync(longDir)) {
    for (const tl of loadLongCorpus(longDir)) t3.push({ id: tl.id, ...cellFromTimeline(tl) });
    console.log(`t3: ${longDir} (${t3.length} fixed samples)`);
  } else {
    console.log(`t3: skipped (long corpus dir not found: ${longDir})`);
  }

  const snapshot = {
    schema: 1,
    detector: 'trimVoiceAudio@src/shared/voiceTrim.ts',
    sampleRate: DEFAULT_RATE,
    maxSegmentSec: DEFAULT_MAX_SEGMENT_SEC,
    grid: { seeds, noise: NOISE_MODES, families: GAP_FAMILY_NAMES },
    corpus: { root: corpus.root, totalFiles: corpus.totalFiles, pool: corpus.pool },
    limitations: LIMITATIONS,
    cells,
    t2,
    t3,
  };
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(snapshot)}\n`);

  report(cells, seeds, `voice-vad baseline (detector=${snapshot.detector})`);
  if (t2) console.log(`  ${formatAggregate('t2=coraal', aggregateMetrics([metricsFor(t2)]))}`);
  for (const row of t3) {
    console.log(`  ${formatAggregate(`t3=${row.id}`, aggregateMetrics([metricsFor(row)]))}`);
  }
  console.log(`snapshot written: ${opts.out} (${cells.length} cells)`);

  const missing = coverageGap(cells, seeds);
  if (missing.length) {
    console.error(`voice-vad-harness: ${missing.length} missing grid cell(s), first: ${missing[0]}`);
    process.exit(1);
  }
  if (cells.length < MIN_TIMELINES) {
    console.error(`voice-vad-harness: ${cells.length} timelines < ${MIN_TIMELINES}`);
    process.exit(1);
  }
}

function main() {
  if (process.env.NO_NETWORK) installNoNetworkGuard();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(2);
  }
  if (opts.offline) runOffline(opts.out);
  else runGenerate(opts);
}

main();
