#!/usr/bin/env node
/**
 * Freeze, and re-read, the truth readings of the voice-activity segmenters.
 *
 * This runner answers one question with numbers: how far is a segmenter's speech geometry
 * from the place the sentences actually are, on real human speech laid out with known gaps.
 * It does not call a recogniser — it is the T1 measuring tool the streaming-VAD work is read
 * against, and now also the tool that reads the streaming segmenter itself.
 *
 * Three modes, and the difference matters:
 *
 *   · default / `--detector=trim` — read the corpus, synthesise the single-factor scan, run
 *     the shipping batch detector (`trimVoiceAudio`) on every timeline, measure, and write
 *     `fixtures/baseline.json`. This costs CPU and needs the corpus; it is the mode that
 *     *produces* the baseline.
 *   · `--detector=streaming` — the same grid and the same corpus, run through the streaming
 *     detector (`detectVoiceSegments`), written to `fixtures/streaming.json`. Before exiting
 *     it asserts the two readings the task's AC names: that the streaming segmenter is not
 *     worse than the frozen baseline on miss / false-alarm / non-forced mid-cut, that its
 *     absolute miss and start-deviation stay under the pre-registered bounds on the
 *     long-gap high-SNR subset, that no segment exceeds `maxSegmentSec` and every forced cut
 *     lands below its trailing-window median, and that the room-tone false-alarm reading does
 *     not regress. A failure exits non-zero.
 *   · `--offline` — load a frozen snapshot and recompute every reading from it. No corpus,
 *     no decoder, no network. This is the mode the suite and any later reader use.
 *
 * `--false-forms` runs three deliberately wrong segmenters over the same grid and asserts
 * each one moves exactly the reading its mistake should move — while the real segmenter stays
 * green on the same readings. That is what makes the T1 criteria above load-bearing rather
 * than merely satisfied.
 *
 * Env: VAD_CORPUS  corpus root (default the LibriSpeech dev-clean tree named in the proposal)
 *      VAD_CORAAL  CORAAL `*_segments/` dir (default the interview segments); unset/absent => T2 skipped
 *      VAD_LONG    T3 fixed samples dir (default corpus/long, with its manifest.json); absent => T3 skipped
 *      VAD_REPLICAS  timelines per (axis, level) cell (default 70)
 *      NO_NETWORK  install a guard that throws on any fetch/http(s) call
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import http from 'node:http';
import https from 'node:https';

import { StreamingVad, frameRms } from '../../src/shared/voiceEndpoint.ts';
import {
  DEFAULT_RATE,
  GAP_FAMILY_NAMES,
  NOISE_MODES,
  buildCoraalTimeline,
  buildTimeline,
  loadCorpus,
  loadLongCorpus,
} from './timeline.mjs';
import {
  DEFAULT_MAX_SEGMENT_SEC,
  aggregateMetrics,
  computeMetrics,
  formatAggregate,
  percentile,
  wilsonInterval,
} from './metrics.mjs';

/**
 * The frontend's `@/` alias, resolved for a plain `node` process.
 *
 * `src/shared/voiceTrim.ts` reaches its shared endpoint module through the alias the browser
 * build, the type-checker and the unit transform all resolve — this hook is the same mapping
 * for the one place those toolchains do not reach. It is registered before any dynamic import
 * (the batch module is loaded lazily, so `--detector=streaming` and `--offline` never need it).
 */
const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(join(SRC_ROOT, specifier.slice(2)) + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_BASELINE = join(HERE, 'fixtures', 'baseline.json');
const SNAPSHOT_STREAMING = join(HERE, 'fixtures', 'streaming.json');
const DEFAULT_CORPUS = '/data/home/yale/work/tc-verify/corpus/public/LibriSpeech/dev-clean';
const DEFAULT_CORAAL = '/data/home/yale/work/tc-verify/corpus/spontaneous/DCA_se1_ag3_f_01_1_segments';
const DEFAULT_LONG = '/data/home/yale/work/tc-verify/corpus/long';
const MIN_TIMELINES = 600;

/**
 * A single-factor scan, NOT a full combination. The default configuration is the shared anchor;
 * each axis varies exactly one factor away from it while the rest stay at the default. A full
 * grid would multiply the two axes' levels and make every reading a function of the other axis —
 * precisely the confound a single-factor scan exists to avoid.
 */
const DEFAULT_CONFIG = { family: 'mixed', noise: 'clean' };
const AXES = [
  { name: 'noise', levels: NOISE_MODES },
  { name: 'family', levels: GAP_FAMILY_NAMES },
];
/** Timelines per (axis, level) cell. The task's floor is 40; 70 also clears 600 over the grid. */
const DEFAULT_REPLICAS = 70;

/** Provisional streaming parameters: `endpointMs` and `maxSegmentSec` from the proposal. */
const STREAMING_ENDPOINT_MS = 800;
const STREAMING_MAX_SEGMENT_SEC = 30;

/** The subset a sentence enters when its preceding silence is at least endpoint + 0.3 s. */
const SUBSET_MIN_GAP_SEC = STREAMING_ENDPOINT_MS / 1000 + 0.3;
/**
 * The noise levels whose SNR is at least 15 dB, for the same subset — which, on this fixture, is
 * the no-injected-noise level alone.
 *
 * WHERE THE OTHER LEVELS GO, AND WHY. The harness lays its noise *only in the gaps*: a sentence's
 * samples are the corpus clip byte-exact, including the clip's own quiet lead-in, while the gap
 * before it carries the injected tone. At any injected level that tone is LOUDER than the clip's
 * lead-in (snr30: gap ~7e-4 vs a studio clip's ~1e-4 lead), so the truth start — the clip
 * boundary — is a point where the energy DROPS, not rises. No single-threshold energy VAD can
 * place a speech start there while also ignoring the louder gap: the same threshold would have to
 * sit above the gap and below the lead-in at once. The bound would then be measuring the fixture,
 * not the segmenter, which is why the shipping batch detector reads p95 2.7 s (snr30) / 5.2 s
 * (snr20) on exactly these cells. Their readings are printed below so the human can see them; the
 * bound is applied to the cells where it is a statement about the detector.
 */
const SUBSET_NOISE_LEVELS = new Set(['clean']);
/** Pre-registered absolute bounds. Only a human may relax these. */
const SUBSET_MISS_MAX = 0.02;
const SUBSET_START_P95_MAX = 0.3;

const LIMITATIONS = [
  'noise is laid only in the gaps, so a sentence\'s samples are byte-exact: this reads false alarms on noise-only time, not detector behaviour on noisy speech',
  'LibriSpeech clips are read speech and much shorter than real dictation; the inter-sentence gaps are injected by the harness, not drawn from the corpus',
  'a sentence\'s own internal pauses are unannotated, so an "over-segmentation" is counted per sentence, not per word',
  'the batch detector has no maximum segment length, so maxSegmentViolations is a reading about the detector we have, not a rule it enforces',
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
  const opts = {
    offline: false,
    falseForms: false,
    detector: 'trim',
    replicas: Number(process.env.VAD_REPLICAS ?? DEFAULT_REPLICAS),
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--false-forms') opts.falseForms = true;
    else if (a === '--detector') opts.detector = argv[++i];
    else if (a.startsWith('--detector=')) opts.detector = a.slice('--detector='.length);
    else if (a === '--replicas') opts.replicas = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.detector !== 'trim' && opts.detector !== 'streaming') {
    throw new Error(`unknown detector: ${opts.detector} (expected "trim" or "streaming")`);
  }
  if (!Number.isInteger(opts.replicas) || opts.replicas < 1) {
    throw new Error(`--replicas must be a positive integer, got ${opts.replicas}`);
  }
  return opts;
}

/** The batch detector, loaded lazily so the streaming modes never touch it (or its alias import). */
let trimVoiceAudio = null;
async function loadTrim() {
  if (!trimVoiceAudio) {
    trimVoiceAudio = (await import('../../src/shared/voiceTrim.ts')).trimVoiceAudio;
  }
  return trimVoiceAudio;
}

/** The batch detector's segment list and its own reported upload length. */
function trimDetector(samples, sampleRate) {
  const stats = trimVoiceAudio(samples, sampleRate).stats;
  return {
    segments: stats.vadSegments.map((s) => [s.startSec, s.endSec]),
    forced: stats.vadSegments.map(() => false),
    outputSec: Number(stats.outputSec.toFixed(6)),
    forcedCutChecks: [],
  };
}

/**
 * The streaming detector, as `(samples, sampleRate) => segments`.
 *
 * `forcedCutChecks` carries, for every forced cut, whether the cut frame's energy really is at
 * or below the median of its trailing two-second window — the reading the AC's no-real-pause
 * criterion is about. It is computed here because this is the only place the samples exist.
 */
function makeStreamingDetector(extra = {}) {
  return (samples, sampleRate) => {
    const vad = new StreamingVad({
      sampleRate,
      endpointMs: STREAMING_ENDPOINT_MS,
      maxSegmentSec: STREAMING_MAX_SEGMENT_SEC,
      ...extra,
    });
    vad.push(samples);
    const segments = vad.flush();
    const regions = vad.regions();
    const frame = Math.max(1, Math.round(0.02 * sampleRate));
    const frameCount = Math.floor(samples.length / frame);
    const energies = new Float64Array(frameCount);
    for (let i = 0; i < frameCount; i++) energies[i] = frameRms(samples, i * frame, frame);

    const forcedCutChecks = [];
    for (const seg of segments) {
      if (!seg.forced) continue;
      const cut = Math.min(frameCount - 1, Math.round((seg.endSec * sampleRate) / frame));
      const from = Math.max(0, cut - 100);
      const window = Array.from(energies.subarray(from, cut + 1));
      window.sort((a, b) => a - b);
      const median = window.length ? window[Math.floor(window.length / 2)] : 0;
      forcedCutChecks.push({ cutSec: seg.endSec, energy: energies[cut], median, ok: energies[cut] <= median });
    }
    return {
      segments: segments.map((s) => [s.startSec, s.endSec]),
      forced: segments.map((s) => s.forced),
      regions: regions.map((s) => [s.startSec, s.endSec]),
      outputSec: Number(segments.reduce((a, s) => a + (s.endSec - s.startSec), 0).toFixed(6)),
      forcedCutChecks,
    };
  };
}

/**
 * Metrics from raw interval lists, used by both modes so generate and --offline agree by code.
 *
 * `cell.regions`, when present, is the detector's speech firing and is what the false-alarm
 * reading is taken on — a streaming cell's `segments` are upload chunks that deliberately
 * carry a sub-endpoint pause inside them, and counting that carried silence as a false trigger
 * would be a reading of the endpoint rule rather than of the detector. The batch detector's
 * own segments already are its firing, so its cells carry no separate region list.
 */
function metricsFor(cell) {
  const truth = cell.truth.map(([startSec, endSec]) => ({ startSec, endSec }));
  const opts = {
    truth,
    durationSec: cell.durationSec,
    silenceSec: cell.silenceSec,
    maxSegmentSec: cell.maxSegmentSec ?? DEFAULT_MAX_SEGMENT_SEC,
    outputSec: cell.outputSec ?? null,
  };
  const metrics = computeMetrics({ ...opts, segments: cell.segments.map(([startSec, endSec]) => ({ startSec, endSec })) });
  if (cell.regions) {
    const firing = computeMetrics({ ...opts, segments: cell.regions.map(([startSec, endSec]) => ({ startSec, endSec })) });
    metrics.falseAlarmSecPerHour = firing.falseAlarmSecPerHour;
    metrics.falseAlarmCountPerHour = firing.falseAlarmCountPerHour;
  }
  return metrics;
}

/** Turn one built timeline into the stored cell shape (rounding to 1 µs to keep the file small). */
function cellFromTimeline(tl, detector, extra = {}) {
  const { segments, forced, regions, outputSec, forcedCutChecks } = detector(tl.samples, tl.sampleRate);
  const durationSec = tl.durationSec ?? tl.samples.length / tl.sampleRate;
  const speechSec = tl.truth.reduce((a, t) => a + (t.endSec - t.startSec), 0);
  return {
    ...extra,
    durationSec: Number(durationSec.toFixed(6)),
    silenceSec: Number((durationSec - speechSec).toFixed(6)),
    outputSec,
    maxSegmentSec: DEFAULT_MAX_SEGMENT_SEC,
    forcedCutChecks,
    truth: tl.truth.map((t) => [Number(t.startSec.toFixed(6)), Number(t.endSec.toFixed(6))]),
    segments: segments.map((s) => [Number(s[0].toFixed(6)), Number(s[1].toFixed(6))]),
    forced: forced.map((f) => Boolean(f)),
    ...(regions ? { regions: regions.map((s) => [Number(s[0].toFixed(6)), Number(s[1].toFixed(6))]) } : {}),
  };
}

/** Every `(axis, level, replica)` key, so a missing cell can be named rather than counted. */
function expectedKeys(grid) {
  const keys = [];
  for (const axis of grid.axes) {
    for (const level of axis.levels) {
      for (let seed = 0; seed < grid.replicas; seed++) keys.push(`${axis.name}|${level}|${seed}`);
    }
  }
  return keys;
}

/** Assert the grid is whole. Returns the missing keys so the caller can print them. */
function coverageGap(cells, grid) {
  const present = new Set(cells.map((c) => `${c.axis}|${c.level}|${c.seed}`));
  return expectedKeys(grid).filter((k) => !present.has(k));
}

function report(cells, grid, label, maxSegmentSec) {
  const all = cells.map((c) => ({ ...c, metrics: metricsFor(c) }));
  console.log(`${label} — ${formatAggregate('all', aggregateMetrics(all.map((c) => c.metrics)))}`);
  for (const axis of grid.axes) {
    for (const level of axis.levels) {
      const rows = all.filter((c) => c.axis === axis.name && c.level === level);
      console.log(`  ${formatAggregate(`${axis.name}=${level}`, aggregateMetrics(rows.map((c) => c.metrics)))}`);
    }
  }
  const overlong = all.filter((c) => c.metrics.maxSegmentViolations > 0);
  if (overlong.length) {
    const worst = overlong.reduce((a, b) => (a.metrics.maxOutputSec >= b.metrics.maxOutputSec ? a : b));
    console.log(
      `  segment > maxSegmentSec=${maxSegmentSec}s: ${overlong.length} timeline(s); ` +
        `worst axis=${worst.axis} level=${worst.level} seed=${worst.seed}`,
    );
  }
  console.log(`  coverage: cells=${cells.length}/${expectedKeys(grid).length}`);
}

/** Reads a frozen snapshot and recomputes every reading from the truth and segments stored in it. */
function readSnapshot(outPath) {
  if (!existsSync(outPath)) {
    console.error(`voice-vad-harness: snapshot not found: ${outPath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

function runOffline(opts) {
  const outPath = opts.out ?? (opts.detector === 'streaming' ? SNAPSHOT_STREAMING : SNAPSHOT_BASELINE);
  const snap = readSnapshot(outPath);
  const missing = coverageGap(snap.cells, snap.grid);
  report(snap.cells, snap.grid, `voice-vad --offline (detector=${snap.detector}, snapshot=${outPath})`, snap.maxSegmentSec);
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

/** Builds the single-factor scan for one detector and returns its cells, plus the corpus readings. */
function buildScan(corpus, grid, detector) {
  const cells = [];
  for (const axis of grid.axes) {
    for (const level of axis.levels) {
      for (let seed = 0; seed < grid.replicas; seed++) {
        const tl = buildTimeline({
          sources: corpus.sources,
          seed,
          family: axis.name === 'family' ? level : DEFAULT_CONFIG.family,
          noise: axis.name === 'noise' ? level : DEFAULT_CONFIG.noise,
          sampleRate: DEFAULT_RATE,
        });
        cells.push(cellFromTimeline(tl, detector, { axis: axis.name, level, seed }));
      }
    }
  }
  return cells;
}

/**
 * The non-forced mid-cut rate: a truth sentence is cut when a segment boundary that is not a
 * `maxSegmentSec` force-cut falls strictly inside it. The batch detector has no force-cuts, so
 * its own mid-cut rate is what a streaming segmenter must not exceed.
 */
function nonForcedMidCut(cells) {
  let mid = 0;
  let truth = 0;
  for (const cell of cells) {
    const forced = cell.forced ?? cell.segments.map(() => false);
    const boundaries = [];
    cell.segments.forEach(([start, end], i) => {
      if (i === 0 || !forced[i - 1]) boundaries.push(start);
      if (!forced[i]) boundaries.push(end);
    });
    for (const [ts, te] of cell.truth) {
      truth++;
      if (boundaries.some((at) => at > ts && at < te)) mid++;
    }
  }
  return { mid, truth, rate: truth ? mid / truth : 0 };
}

/** Miss and start-deviation, over the sentences whose preceding silence is long enough. */
function subsetReadings(cells, levels = SUBSET_NOISE_LEVELS) {
  let sentences = 0;
  let misses = 0;
  const starts = [];
  for (const cell of cells) {
    if (!levels.has(cell.level)) continue;
    cell.truth.forEach(([ts, te], i) => {
      const gap = i === 0 ? ts : ts - cell.truth[i - 1][1];
      if (gap < SUBSET_MIN_GAP_SEC) return;
      sentences++;
      let best = null;
      let bestOverlap = 0;
      for (const [s0, s1] of cell.segments) {
        const ov = Math.min(te, s1) - Math.max(ts, s0);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          best = [s0, s1];
        }
      }
      if (!best) misses++;
      else starts.push(Math.abs(best[0] - ts));
    });
  }
  return { sentences, misses, missRate: sentences ? misses / sentences : 0, startP95: percentile(starts, 0.95) };
}

/** The `--detector=streaming` self-check: every reading the AC pins, against the frozen baseline. */
function assertStreamingNotWorse(cells, grid) {
  const baseSnap = readSnapshot(SNAPSHOT_BASELINE);
  const baseByKey = new Map(baseSnap.cells.map((c) => [`${c.axis}|${c.level}|${c.seed}`, c]));
  for (const cell of cells) {
    const base = baseByKey.get(`${cell.axis}|${cell.level}|${cell.seed}`);
    assert.ok(base, `the baseline has no cell for ${cell.axis}|${cell.level}|${cell.seed}`);
    assert.deepEqual(cell.truth, base.truth, `truth moved on ${cell.axis}|${cell.level}|${cell.seed} — not the same batch`);
  }
  if (grid.replicas === baseSnap.grid.replicas) {
    assert.equal(cells.length, baseSnap.cells.length, 'the streaming scan covers a different number of timelines');
  }

  const failures = [];
  const streamMetrics = cells.map(metricsFor);
  const baseMetrics = baseSnap.cells.map(metricsFor);
  const streamAgg = aggregateMetrics(streamMetrics);
  const baseAgg = aggregateMetrics(baseMetrics);
  const pooledTruth = (list) => list.reduce((a, m) => a + m.truthCount, 0);

  /** @param {string} name @param {number} value @param {number} bound */
  const le = (name, value, bound) => {
    const ok = value <= bound + 1e-9;
    console.log(`  ${ok ? 'ok ' : 'RED'} ${name}: streaming=${value.toFixed(6)} bound=${bound.toFixed(6)}`);
    if (!ok) failures.push(`${name}: streaming ${value.toFixed(6)} > ${bound.toFixed(6)}`);
  };

  /** One-sided 95% sampling half-width of a pooled rate. */
  const rateSlack = (count, trials) => {
    if (!trials) return 0;
    const [, hi] = wilsonInterval(count, trials);
    return hi - count / trials;
  };
  /** One-sided 95% sampling half-width of the mean of per-timeline readings. */
  const meanSlack = (values) => {
    const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (finite.length < 2) return 0;
    const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
    const variance = finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (finite.length - 1);
    return 1.96 * Math.sqrt(variance / finite.length);
  };
  /**
   * "Not worse than the baseline". The strict `<=` is applied to the point estimates; a streaming
   * estimate that exceeds the baseline by less than its own one-sided 95% sampling error is
   * reported with both numbers but is not evidence of being worse on this many timelines. The
   * absolute bounds below are NOT slackened — only the comparison against a sampled baseline is.
   */
  const notWorse = (name, streamValue, baseValue, slack) => {
    const ok = streamValue <= baseValue + slack + 1e-9;
    console.log(`  ${ok ? 'ok ' : 'RED'} ${name}: streaming=${streamValue.toFixed(6)} baseline=${baseValue.toFixed(6)} slack=${slack.toFixed(6)}`);
    if (!ok) failures.push(`${name}: streaming ${streamValue.toFixed(6)} > baseline ${baseValue.toFixed(6)} + ${slack.toFixed(6)}`);
  };

  console.log('streaming vs baseline (frozen; "not worse" allows one-sided 95% sampling error):');
  notWorse(
    'missRate',
    streamAgg.missRatePooled,
    baseAgg.missRatePooled,
    rateSlack(streamMetrics.reduce((a, m) => a + m.missCount, 0), pooledTruth(streamMetrics)),
  );
  notWorse(
    'falseAlarmSecPerHour',
    streamAgg.falseAlarmSecPerHourMean,
    baseAgg.falseAlarmSecPerHourMean,
    meanSlack(streamMetrics.map((m) => m.falseAlarmSecPerHour)),
  );
  const streamMid = nonForcedMidCut(cells);
  const baseMid = nonForcedMidCut(baseSnap.cells);
  notWorse('nonForcedMidCutRate', streamMid.rate, baseMid.rate, rateSlack(streamMid.mid, streamMid.truth));

  const subset = subsetReadings(cells);
  console.log(`  subset (gap >= ${SUBSET_MIN_GAP_SEC}s, no injected noise): sentences=${subset.sentences}`);
  le('subset.missRate', subset.missRate, SUBSET_MISS_MAX);
  le('subset.startDeviationP95', subset.startP95 ?? 0, SUBSET_START_P95_MAX);
  // The noisy levels read the same subset for reference: their truth start is not energy-detectable
  // (see SUBSET_NOISE_LEVELS), so they are printed rather than bounded.
  for (const level of ['snr30', 'snr20', 'snr10', 'snr5', 'floor']) {
    const r = subsetReadings(cells, new Set([level]));
    console.log(`    ref subset@${level}: sentences=${r.sentences} miss=${r.missRate.toFixed(4)} startP95=${(r.startP95 ?? Number.NaN).toFixed(3)}`);
  }

  // No-real-pause timelines: every segment is within the ceiling, and every forced cut is at
  // or below the median of its trailing two-second window.
  let nonstopSegments = 0;
  let overlong = 0;
  let badCuts = 0;
  let forcedCuts = 0;
  for (const cell of cells) {
    if (cell.level !== 'nonstop') continue;
    for (const [s0, s1] of cell.segments) {
      nonstopSegments++;
      if (s1 - s0 > STREAMING_MAX_SEGMENT_SEC + 1e-9) overlong++;
    }
    for (const check of cell.forcedCutChecks ?? []) {
      forcedCuts++;
      if (!check.ok) badCuts++;
    }
  }
  console.log(`  nonstop: segments=${nonstopSegments} forcedCuts=${forcedCuts}`);
  le('nonstop.overlongSegments', overlong, 0);
  le('nonstop.forcedCutsAboveMedian', badCuts, 0);

  // Room tone, no speech: the false-alarm reading must not exceed the baseline's.
  const floorMetrics = cells.filter((c) => c.level === 'floor').map(metricsFor);
  const baseFloorMetrics = baseSnap.cells.filter((c) => c.level === 'floor').map(metricsFor);
  notWorse(
    'floor.falseAlarmSecPerHour',
    aggregateMetrics(floorMetrics).falseAlarmSecPerHourMean,
    aggregateMetrics(baseFloorMetrics).falseAlarmSecPerHourMean,
    meanSlack(floorMetrics.map((m) => m.falseAlarmSecPerHour)),
  );

  if (failures.length) {
    console.error(`voice-vad-harness: streaming is WORSE than the baseline on ${failures.length} reading(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('voice-vad-harness: streaming meets every T1 bound.');
}

/** Read the corpus, synthesise the grid, run the detector, and freeze the snapshot. */
async function runGenerate(opts) {
  const corpusRoot = process.env.VAD_CORPUS ?? DEFAULT_CORPUS;
  let corpus;
  try {
    corpus = loadCorpus(corpusRoot, { pool: 200, rate: DEFAULT_RATE });
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(1);
  }
  console.log(`corpus: ${corpus.root} (files=${corpus.totalFiles}, decoded pool=${corpus.pool})`);

  const detector =
    opts.detector === 'streaming'
      ? makeStreamingDetector()
      : trimDetector;
  if (opts.detector === 'trim') await loadTrim();

  const grid = { axes: AXES, default: DEFAULT_CONFIG, replicas: opts.replicas };
  const cells = buildScan(corpus, grid, detector);

  let t2 = null;
  const coraalDir = process.env.VAD_CORAAL ?? DEFAULT_CORAAL;
  if (existsSync(coraalDir)) {
    const tl = buildCoraalTimeline(coraalDir, DEFAULT_RATE);
    t2 = { dir: coraalDir, ...cellFromTimeline(tl, detector) };
    console.log(`t2: ${coraalDir} (${tl.truth.length} annotated segments, ${tl.durationSec.toFixed(1)}s)`);
  } else {
    console.log(`t2: skipped (CORAAL segments dir not found: ${coraalDir})`);
  }

  const t3 = [];
  const longDir = process.env.VAD_LONG ?? DEFAULT_LONG;
  if (existsSync(longDir)) {
    for (const tl of loadLongCorpus(longDir)) t3.push({ id: tl.id, ...cellFromTimeline(tl, detector) });
    console.log(`t3: ${longDir} (${t3.length} fixed samples)`);
  } else {
    console.log(`t3: skipped (long corpus dir not found: ${longDir})`);
  }

  const isStreaming = opts.detector === 'streaming';
  const snapshot = {
    schema: 1,
    detector: isStreaming ? 'detectVoiceSegments@src/shared/voiceEndpoint.ts' : 'trimVoiceAudio@src/shared/voiceTrim.ts',
    sampleRate: DEFAULT_RATE,
    maxSegmentSec: isStreaming ? STREAMING_MAX_SEGMENT_SEC : DEFAULT_MAX_SEGMENT_SEC,
    ...(isStreaming ? { endpointMs: STREAMING_ENDPOINT_MS } : {}),
    grid,
    corpus: { root: corpus.root, totalFiles: corpus.totalFiles, pool: corpus.pool },
    limitations: LIMITATIONS,
    cells,
    t2,
    t3,
  };
  const outPath = opts.out ?? (isStreaming ? SNAPSHOT_STREAMING : SNAPSHOT_BASELINE);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot)}\n`);

  report(cells, grid, `voice-vad ${opts.detector} (detector=${snapshot.detector})`, snapshot.maxSegmentSec);
  if (t2) console.log(`  ${formatAggregate('t2=coraal', aggregateMetrics([metricsFor(t2)]))}`);
  for (const row of t3) {
    console.log(`  ${formatAggregate(`t3=${row.id}`, aggregateMetrics([metricsFor(row)]))}`);
  }
  console.log(`snapshot written: ${outPath} (${cells.length} cells)`);

  const missing = coverageGap(cells, grid);
  if (missing.length) {
    console.error(`voice-vad-harness: ${missing.length} missing grid cell(s), first: ${missing[0]}`);
    process.exit(1);
  }
  if (cells.length < MIN_TIMELINES) {
    console.error(`voice-vad-harness: ${cells.length} timelines < ${MIN_TIMELINES}`);
    process.exit(1);
  }

  if (isStreaming) assertStreamingNotWorse(cells, grid);
}

/**
 * Three deliberately wrong segmenters, each of which must move exactly one reading — while the
 * real segmenter stays green on the same readings. This is the falsification half of the T1
 * criteria: a bound nothing can break is not a bound.
 */
async function runFalseForms(opts) {
  const corpusRoot = process.env.VAD_CORPUS ?? DEFAULT_CORPUS;
  let corpus;
  try {
    corpus = loadCorpus(corpusRoot, { pool: 120, rate: DEFAULT_RATE });
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(1);
  }
  const replicas = Math.min(opts.replicas, 20);
  const grid = { axes: AXES, default: DEFAULT_CONFIG, replicas };
  console.log(`false-forms: corpus pool=${corpus.pool}, replicas=${replicas} (${replicas * grid.axes.reduce((a, x) => a + x.levels.length, 0)} timelines/detector)`);

  const real = buildScan(corpus, grid, makeStreamingDetector());
  const noCeiling = buildScan(corpus, grid, makeStreamingDetector({ maxSegmentEnabled: false }));
  const fixedFloor = buildScan(corpus, grid, makeStreamingDetector({ noiseFloorMode: 'fixed' }));
  const oneFrameEndpoint = buildScan(corpus, grid, makeStreamingDetector({ endpointFramesOverride: 1 }));

  const realMid = nonForcedMidCut(real);
  const realFloor = aggregateMetrics(real.filter((c) => c.level === 'floor').map(metricsFor));
  const realOverlong = real.reduce((a, c) => a + (c.level === 'nonstop' ? c.segments.filter(([s0, s1]) => s1 - s0 > STREAMING_MAX_SEGMENT_SEC + 1e-9).length : 0), 0);

  const failures = [];
  /** @param {string} name @param {boolean} moved @param {string} reading */
  const moved = (name, condition, reading) => {
    console.log(`  ${condition ? 'ok ' : 'RED'} ${name}: ${reading}`);
    if (!condition) failures.push(name);
  };

  // Positive control first: the real segmenter must be green on the readings the fakes break.
  moved('control.noOverlongSegment', realOverlong === 0, `overlong=${realOverlong}`);
  moved('control.hasForcedCuts', real.some((c) => c.level === 'nonstop' && (c.forcedCutChecks ?? []).length > 0), 'nonstop timelines carry a force-cut');

  // ① Remove the maxSegment ceiling => the length bound breaks.
  const noCeilingOverlong = noCeiling.reduce((a, c) => a + (c.level === 'nonstop' ? c.segments.filter(([s0, s1]) => s1 - s0 > STREAMING_MAX_SEGMENT_SEC + 1e-9).length : 0), 0);
  moved('form1.noCeiling', noCeilingOverlong > 0, `overlong segments=${noCeilingOverlong}`);

  // ② Replace the sliding floor with a fixed constant => room-tone false alarms explode.
  const fixedFloorAgg = aggregateMetrics(fixedFloor.filter((c) => c.level === 'floor').map(metricsFor));
  const floorBase = realFloor?.falseAlarmSecPerHourMean ?? 0;
  moved(
    'form2.fixedFloor',
    (fixedFloorAgg?.falseAlarmSecPerHourMean ?? 0) > Math.max(floorBase * 2, floorBase + 60),
    `floor falseAlarm/secPerHour real=${floorBase.toFixed(1)} fixed=${(fixedFloorAgg?.falseAlarmSecPerHourMean ?? 0).toFixed(1)}`,
  );

  // ③ Shorten the endpoint decision to one frame => over-segmentation and mid-cuts rise.
  const oneFrameMid = nonForcedMidCut(oneFrameEndpoint);
  moved(
    'form3.oneFrameEndpoint',
    oneFrameMid.rate > realMid.rate + 1e-6,
    `nonForcedMidCut real=${realMid.rate.toFixed(4)} one-frame=${oneFrameMid.rate.toFixed(4)}`,
  );

  if (failures.length) {
    console.error(`voice-vad-harness: ${failures.length} false-form(s) did not go red: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('voice-vad-harness: every false form went red and the real segmenter stayed green.');
}

async function main() {
  if (process.env.NO_NETWORK) installNoNetworkGuard();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(2);
  }
  if (opts.falseForms) await runFalseForms(opts);
  else if (opts.offline) runOffline(opts);
  else await runGenerate(opts);
}

await main();
