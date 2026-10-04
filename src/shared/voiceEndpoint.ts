/**
 * Source-independent voice-activity detection: the frame decision, the streaming state
 * machine, and the endpointing that turns a speech run into upload-sized segments.
 *
 * `voiceTrim.ts` ran this decision as a batch — decode the whole clip, take the 15th
 * percentile of *its* frame energies as the noise floor, and flag frames against it.
 * That is correct for a clip that is already in memory and wrong for capture that is
 * still arriving: a live stream has no "whole clip" to take a percentile of, and a
 * dictation that never stops talking has no silence for the batch floor to find. This
 * module is that decision extracted so both paths can share it — the thresholds are
 * defined exactly once, here, and `voiceTrim.ts` imports them; a second copy of
 * `0.8 * ENTER_FACTOR` is the drift this split exists to prevent.
 *
 * Two things are added over the batch decision, and only two:
 *
 *   · a sliding noise floor — the low percentile of the last few seconds of *candidate
 *     silence* frames, rather than of the whole input. Candidate silence is a frame the
 *     current floor already calls quiet, so a long unbroken speech run cannot push the
 *     floor up into the speech and silence the detector against itself.
 *
 *   · endpointing — a sentence ends after `endpointMs` of continuous silence, and a run
 *     that reaches `maxSegmentSec` without a pause is force-cut at its quietest frame so
 *     one upload cannot exceed a provider's inline-body limit. Consecutive segments
 *     overlap, so a word sitting on a cut appears in both halves for the text layer to
 *     deduplicate.
 *
 * Everything here is a pure function of its arguments — no DOM, no React, no clock, no
 * network, no sample buffer retained. It is streaming in the sense that matters for
 * capture: it holds one 20 ms frame and two per-frame arrays (energy, flag), never the
 * audio.
 */

/**
 * Frame length for the energy detector. 20 ms is the shortest span that still contains a
 * pitch period for a low voice (~50 Hz), so a frame's RMS tracks loudness rather than the
 * waveform's instantaneous phase.
 */
export const FRAME_MS = 20;

/**
 * VAD thresholds, relative to the measured noise floor. `ENTER` is above `EXIT`; that gap
 * is the hysteresis that stops the decision flapping on frames near the boundary.
 * `SPEECH_FRAMES_TO_START` (60 ms of speech before committing) rejects clicks, key taps and
 * breaths; `SILENCE_FRAMES_TO_END` (300 ms before committing to an end) is longer than a
 * stop closure inside a word, so a plosive does not split one utterance in two.
 *
 * These six constants are the single definition the batch path and the streaming path
 * share. `src/shared/tests/voiceEndpoint.test.ts` greps for that, and `voiceTrim.ts`
 * imports them from here rather than declaring its own.
 */
export const ENTER_FACTOR = 3.0;
export const EXIT_FACTOR = 1.8;
export const SPEECH_FRAMES_TO_START = 3;
export const SILENCE_FRAMES_TO_END = 15;

/**
 * Padding kept around each detected speech region, before and after. The first phoneme of
 * a word and the final consonant are quieter than the threshold, so cutting exactly at the
 * detected boundary reliably clips them. Pre-roll is shorter than post-roll because a stop
 * consonant at the end of a word is the quieter of the two.
 */
export const PRE_ROLL_MS = 120;
export const POST_ROLL_MS = 180;

/** The percentile of frame energies taken as the noise floor, on both paths. */
export const NOISE_PERCENTILE = 0.15;

/**
 * The floor the noise estimate is never allowed below. A frame of digital silence measures
 * exactly 0, and a threshold of `0 * ENTER_FACTOR` would call every non-zero frame speech;
 * this keeps the ratio meaningful. It is far below any real noise floor.
 */
export const MIN_FRAME_ENERGY = 1e-6;

/** Provisional endpoint from the proposal: a sentence ends after this much silence. */
const DEFAULT_ENDPOINT_MS = 800;

/** Provisional ceiling from the proposal: a run with no pause is cut at this length. */
const DEFAULT_MAX_SEGMENT_SEC = 30;

/** How much consecutive segments overlap, so a word on a cut appears in both. */
const DEFAULT_OVERLAP_SEC = 0.4;

/** How much recent candidate-silence the sliding noise floor is read over. */
const DEFAULT_NOISE_WINDOW_SEC = 2;

/**
 * Frames pushed into the noise window before the detector commits to any decision.
 *
 * Without this the very first frames would be judged against the floor's initial value, and
 * a stream that opens on room tone would be judged before its own floor is measurable. Half
 * a second of calibration is short enough that a sentence after a normal lead-in is not
 * delayed beyond it.
 */
const BOOTSTRAP_FRAMES = 25;

/** The trailing window a forced cut searches for its quietest frame. */
const FORCE_CUT_SEARCH_SEC = 2;

/** Backdating a transition by `SPEECH_FRAMES_TO_START`/`SILENCE_FRAMES_TO_END` frames. */
const MAX_BACKDATE_FRAMES = Math.max(SPEECH_FRAMES_TO_START, SILENCE_FRAMES_TO_END);

/** The VAD state: 0 is silence, 1 is speech. A number rather than a boolean to match the bit flags. */
export type VadState = 0 | 1;

/** A transition of the frame decision, backdated to the first frame of its evidence run. */
export type VadEvent = {
  type: 'speechStart' | 'speechEnd';
  /** Sample offset of the transition, from the start of the stream. */
  atSample: number;
};

/** One upload-sized speech region, in seconds from the start of the stream. */
export type VoiceSegment = {
  startSec: number;
  endSec: number;
  /**
   * True when this segment's end is a `maxSegmentSec` force-cut rather than an endpoint or
   * the end of the input. The text layer keys deduplication off these cuts, and the T1
   * metrics exclude them from the "cut inside a sentence" rate — a forced cut is a
   * deliberate ceiling, not a detector mistake.
   */
  forced: boolean;
};

/** The sliding noise estimate's mode. `fixed` exists only as a falsification control. */
export type NoiseFloorMode = 'sliding' | 'fixed';

export type StreamingVadOptions = {
  sampleRate: number;
  /** Silence this long ends a sentence. Provisional default 0.8 s. */
  endpointMs?: number;
  /** A segment longer than this is force-cut. Provisional default 30 s. */
  maxSegmentSec?: number;
  /** Seconds consecutive segments overlap. Default 0.4 s. */
  overlapSec?: number;
  /** Seconds of recent candidate-silence the sliding floor is read over. Default 2 s. */
  noiseWindowSec?: number;
  /**
   * Test/falsification knobs, defaulted to production behaviour. They exist so the T1
   * criteria can prove each rule is load-bearing: disabling the ceiling must red the
   * length bound, fixing the floor must red the room-tone false-alarm reading, and
   * shortening the endpoint must red the over/mid-cut readings.
   */
  maxSegmentEnabled?: boolean;
  noiseFloorMode?: NoiseFloorMode;
  /** The constant floor `noiseFloorMode: 'fixed'` uses. Defaults to `MIN_FRAME_ENERGY`. */
  fixedNoiseFloor?: number;
  /** Override the silence run that ends a sentence, in frames. Defaults to `endpointMs`. */
  endpointFramesOverride?: number;
};

/** One hysteresis step's outcome: the state it moved to, its run length, and the event it produced. */
export type FrameStep = {
  state: VadState;
  /** How many consecutive frames have disagreed with the previous state. */
  run: number;
  event: 'none' | 'speechStart' | 'speechEnd';
};

/**
 * The hysteresis thresholds for a measured noise floor.
 *
 * `exit` is floored at 60% of `enter` so a very low floor cannot collapse the hysteresis
 * band to nothing; that keeps a pair of thresholds even when the ratio is computed from a
 * near-zero floor.
 */
export function thresholdsFor(noise: number): { enter: number; exit: number } {
  const enter = noise * ENTER_FACTOR;
  const exit = Math.max(noise * EXIT_FACTOR, enter * 0.6);
  return { enter, exit };
}

/**
 * One frame of the hysteresis decision, as a pure function of the frame's energy and the
 * state that preceded it. This is the whole of the frame judgement; the batch path runs it
 * over computed flags in `frameFlags`, the streaming path runs it frame by frame.
 */
export function stepFrame(energy: number, state: VadState, run: number, noise: number): FrameStep {
  const { enter, exit } = thresholdsFor(noise);
  const threshold = state ? exit : enter;
  const above = energy >= threshold;
  if (above === Boolean(state)) return { state, run: 0, event: 'none' };

  const nextRun = run + 1;
  const need = state ? SILENCE_FRAMES_TO_END : SPEECH_FRAMES_TO_START;
  if (nextRun < need) return { state, run: nextRun, event: 'none' };

  const nextState: VadState = state ? 0 : 1;
  return { state: nextState, run: 0, event: nextState ? 'speechStart' : 'speechEnd' };
}

/**
 * Frame-level speech/silence decisions, with hysteresis, over a whole buffer.
 *
 * The transition is *backdated* by the number of frames the decision needed: the state only
 * becomes trustworthy after `need` agreeing frames, but the boundary belongs where the
 * evidence started, not where the counter ran out. Without that, every region would begin
 * `need` frames late and the run-up to each word would be trimmed away.
 *
 * This is the batch path's decision, kept here so both paths read the same thresholds and
 * the same backdating rule. `voiceTrim.ts` imports it.
 */
export function frameFlags(energies: Float64Array, noise: number): Uint8Array {
  const { enter, exit } = thresholdsFor(noise);

  const flags = new Uint8Array(energies.length);
  let state: VadState = 0;
  let run = 0;

  for (let i = 0; i < energies.length; i++) {
    const above = energies[i] >= (state ? exit : enter);
    if (above !== Boolean(state)) {
      run++;
      const need = state ? SILENCE_FRAMES_TO_END : SPEECH_FRAMES_TO_START;
      if (run >= need) {
        state = state ? 0 : 1;
        run = 0;
        for (let k = Math.max(0, i - need + 1); k <= i; k++) flags[k] = state;
      }
    } else {
      run = 0;
    }
    flags[i] = state;
  }

  return flags;
}

/** Root-mean-square of `frame` samples starting at `from`. */
export function frameRms(samples: Float32Array, from: number, frame: number): number {
  let acc = 0;
  for (let i = 0; i < frame; i++) {
    const v = samples[from + i];
    acc += v * v;
  }
  return Math.sqrt(acc / frame);
}

/** The value at `p` of an ascending-sorted array, by nearest-rank. */
function sortedPercentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * A streaming VAD over 20 ms frames.
 *
 * `push` takes audio as it arrives, in whatever chunk sizes the caller has, and returns the
 * events those samples produced. `flush` ends the stream and returns the segments. The
 * frame grid is fixed by `sampleRate`, so a chunk boundary can never move a frame: the same
 * samples pushed as 1, 160, 320 or 4800 at a time produce the same frames, the same events
 * and the same segments.
 */
export class StreamingVad {
  private readonly sampleRate: number;
  private readonly frame: number;
  private readonly endpointFrames: number;
  private readonly maxSegmentFrames: number;
  private readonly overlapFrames: number;
  private readonly preFrames: number;
  private readonly postFrames: number;
  private readonly noiseWindowFrames: number;
  private readonly forceCutSearchFrames: number;
  private readonly maxSegmentEnabled: boolean;
  private readonly noiseFloorMode: NoiseFloorMode;
  private readonly fixedNoiseFloor: number;
  private readonly maxSegmentSec: number;

  /** Buffered samples that do not yet make a frame. */
  private pending: Float32Array;
  private pendingCount = 0;

  /** The sliding floor's candidates, kept ascending so its percentile is one index read. */
  private readonly noiseWindow: number[] = [];
  private noise: number;

  private state: VadState = 0;
  private run = 0;
  private frameIndex = 0;

  /** One entry per processed frame. Kept for the whole stream: 1 byte + 8 bytes per 20 ms. */
  private readonly energies: number[] = [];
  private readonly flags: number[] = [];

  constructor(options: StreamingVadOptions) {
    const sampleRate = options.sampleRate;
    const frame = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
    this.sampleRate = sampleRate;
    this.frame = frame;
    this.maxSegmentSec = options.maxSegmentSec ?? DEFAULT_MAX_SEGMENT_SEC;
    this.endpointFrames =
      options.endpointFramesOverride ??
      Math.max(1, Math.round(((options.endpointMs ?? DEFAULT_ENDPOINT_MS) / 1000) * sampleRate / frame));
    this.maxSegmentFrames = Math.max(1, Math.round((this.maxSegmentSec * sampleRate) / frame));
    this.overlapFrames = Math.max(0, Math.round(((options.overlapSec ?? DEFAULT_OVERLAP_SEC) * sampleRate) / frame));
    this.preFrames = Math.max(0, Math.round(PRE_ROLL_MS / FRAME_MS));
    this.postFrames = Math.max(0, Math.round(POST_ROLL_MS / FRAME_MS));
    this.noiseWindowFrames = Math.max(
      BOOTSTRAP_FRAMES,
      Math.round(((options.noiseWindowSec ?? DEFAULT_NOISE_WINDOW_SEC) * sampleRate) / frame),
    );
    this.forceCutSearchFrames = Math.max(1, Math.round((FORCE_CUT_SEARCH_SEC * sampleRate) / frame));
    this.maxSegmentEnabled = options.maxSegmentEnabled ?? true;
    this.noiseFloorMode = options.noiseFloorMode ?? 'sliding';
    this.fixedNoiseFloor = options.fixedNoiseFloor ?? MIN_FRAME_ENERGY;
    this.noise = this.noiseFloorMode === 'fixed' ? this.fixedNoiseFloor : MIN_FRAME_ENERGY;
    this.pending = new Float32Array(frame);
  }

  /** Feeds `chunk` into the detector and returns the events it completed. */
  push(chunk: Float32Array): VadEvent[] {
    const events: VadEvent[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const room = this.frame - this.pendingCount;
      const take = Math.min(room, chunk.length - offset);
      this.pending.set(chunk.subarray(offset, offset + take), this.pendingCount);
      this.pendingCount += take;
      offset += take;
      if (this.pendingCount === this.frame) {
        this.pendingCount = 0;
        const energy = frameRms(this.pending, 0, this.frame);
        this.processFrame(energy, events);
      }
    }
    return events;
  }

  /** Ends the stream and returns its segments, ordered, in seconds. */
  flush(): VoiceSegment[] {
    return this.buildSegments();
  }

  /** The noise floor the detector currently holds. Read by the T1 criterion's readings. */
  get noiseFloor(): number {
    return this.noise;
  }

  /**
   * One frame's decision plus the floor update.
   *
   * The floor is updated *after* the decision, so a frame is judged against the floor that
   * preceded it and the update can never change that frame's own verdict. During the
   * bootstrap the detector records candidate silence but commits to nothing — the state
   * stays 0 — so the first decisions are made against a measured floor rather than the
   * initial constant.
   */
  private processFrame(energy: number, events: VadEvent[]): void {
    const { exit } = thresholdsFor(this.noise);
    const bootstrapping = this.noiseWindow.length < BOOTSTRAP_FRAMES;

    if (!bootstrapping) {
      const step = stepFrame(energy, this.state, this.run, this.noise);
      this.state = step.state;
      this.run = step.run;
      if (step.event !== 'none') {
        const need = step.event === 'speechStart' ? SPEECH_FRAMES_TO_START : SILENCE_FRAMES_TO_END;
        const backdateFrom = Math.max(0, this.frameIndex - need + 1);
        for (let k = backdateFrom; k < this.frameIndex; k++) this.flags[k] = this.state;
        events.push({
          type: step.event,
          atSample: backdateFrom * this.frame,
        });
      }
    } else {
      this.state = 0;
      this.run = 0;
    }

    this.energies.push(energy);
    this.flags.push(this.state);
    this.frameIndex++;

    if (this.noiseFloorMode === 'fixed') return;
    const isCandidateSilence = bootstrapping || energy <= exit;
    if (!isCandidateSilence) return;
    this.insertNoiseSample(energy);
  }

  /** Inserts `energy` into the ascending window, keeping it at most `noiseWindowFrames` long. */
  private insertNoiseSample(energy: number): void {
    const window = this.noiseWindow;
    let lo = 0;
    let hi = window.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (window[mid] <= energy) lo = mid + 1;
      else hi = mid;
    }
    window.splice(lo, 0, energy);
    if (window.length > this.noiseWindowFrames) window.shift();
    this.noise = Math.max(MIN_FRAME_ENERGY, sortedPercentile(window, NOISE_PERCENTILE));
  }

  /**
   * Turns the frame flags into segments.
   *
   * Speech runs separated by less than the endpoint gap are one sentence; a longer gap ends
   * it. Each utterance is then cut into pieces no longer than `maxSegmentSec`, each forced
   * cut landing on the quietest frame of the trailing search window so it damages as little
   * speech as possible. Pre/post roll are applied to the outer edges, later pieces overlap
   * their predecessor, and a final clamp guarantees no segment exceeds the ceiling.
   */
  private buildSegments(): VoiceSegment[] {
    const frame = this.frame;
    const total = this.flags.length;
    if (!total) return [];

    const runs: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= total; i++) {
      const on = i < total && this.flags[i] === 1;
      if (on && start < 0) start = i;
      else if (!on && start >= 0) {
        runs.push([start, i]);
        start = -1;
      }
    }

    const utterances: [number, number][] = [];
    for (const [a, b] of runs) {
      const last = utterances[utterances.length - 1];
      if (last && a - last[1] < this.endpointFrames) last[1] = b;
      else utterances.push([a, b]);
    }

    const pieces: { start: number; end: number; forced: boolean }[] = [];
    for (const [uStart, uEnd] of utterances) {
      let pos = uStart;
      while (this.maxSegmentEnabled && uEnd - pos > this.maxSegmentFrames) {
        const target = pos + this.maxSegmentFrames;
        const from = Math.max(pos + 1, target - this.forceCutSearchFrames);
        const to = Math.min(uEnd - 1, target);
        let cut = target;
        let best = Infinity;
        for (let f = from; f <= to; f++) {
          if (this.energies[f] < best) {
            best = this.energies[f];
            cut = f;
          }
        }
        pieces.push({ start: pos, end: cut, forced: true });
        pos = cut;
      }
      pieces.push({ start: pos, end: uEnd, forced: false });
    }

    const segments: VoiceSegment[] = [];
    for (let i = 0; i < pieces.length; i++) {
      let startFrame = pieces[i].start;
      let endFrame = pieces[i].end;
      if (i === 0) startFrame -= this.preFrames;
      else startFrame -= this.overlapFrames;
      if (i === pieces.length - 1) endFrame += this.postFrames;
      startFrame = Math.max(0, Math.min(total, startFrame));
      endFrame = Math.max(0, Math.min(total, endFrame));
      if (endFrame <= startFrame) continue;

      let startSec = (startFrame * frame) / this.sampleRate;
      const endSec = (endFrame * frame) / this.sampleRate;
      // The ceiling is the criterion; the rolls and the overlap are not allowed to break it,
      // so the last word is the start being pulled forward rather than the end falling back.
      if (endSec - startSec > this.maxSegmentSec) startSec = endSec - this.maxSegmentSec;
      segments.push({ startSec, endSec, forced: pieces[i].forced });
    }

    return segments;
  }
}

/**
 * The `(samples, sampleRate) => segments` interface the T1 truth harness measures.
 *
 * It is the streaming detector run over a whole buffer at once — the same code the
 * AudioWorklet path drives frame by frame — so a reading taken here is a reading of the
 * implementation that ships, not of a batch approximation of it.
 */
export function detectVoiceSegments(
  samples: Float32Array,
  sampleRate: number,
  options: Omit<StreamingVadOptions, 'sampleRate'> = {},
): VoiceSegment[] {
  const vad = new StreamingVad({ sampleRate, ...options });
  vad.push(samples);
  return vad.flush();
}

/** Re-exported so callers that only need the backdating bound do not restate it. */
export const VAD_BACKDATE_FRAMES = MAX_BACKDATE_FRAMES;
