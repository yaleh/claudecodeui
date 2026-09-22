import { useCallback, useEffect, useRef, useState } from 'react';

import { decodeVoiceBlob, encodeWavBlob } from '@/modules/chat/utils/audioDecode';
import { voicePlayer } from '@/modules/chat/utils/voicePlayer';
import { transcribeVoice } from '@/shared/api';
import { identifierFidelity } from '@/shared/identifierFidelity';
import { repairIdentifiers } from '@/shared/identifierRepair';
import type {
  VoiceClipPlayState,
  VoiceClipSlot,
  VoiceClipTrack,
  VoiceInputState,
} from '@/shared/types';
import { isVoiceDebugEnabled, isVoiceTrimEnabled } from '@/shared/voiceDebug';
import {
  OPENAI_COMPATIBLE_PROVIDER,
  pauseCuesFor,
  trimDecisionFor,
  trimVoiceAudio,
} from '@/shared/voiceTrim';
// The recogniser's answer is read by the same module that built the request — the
// repository-root shared tree the server and the CLI compile.
import { parseTranscriptionResponse } from '@shared/asr/transcriptionWire';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

/** Below this, the bytes are a container with nothing in it. */
const MIN_CAPTURE_BYTES = 800;

function pickMime(): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on some iOS versions */
    }
  }
  return '';
}

/** The extension the recogniser is told the audio has, derived from the container it really has. */
function extensionFor(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

/** Which entry the audio came in through. */
export type VoiceSource = 'mic' | 'file';

/**
 * The half of a capture's reading that is about the audio, taken where the audio is still in hand.
 *
 * The two entries share one chain, so the only thing that tells their readings apart is `source`;
 * everything else here is a measurement of the bytes the chain was handed.
 *
 * `fallback` is the one field that is not a measurement: true means the bytes uploaded were the input
 * untouched — the trim is off, the browser could not decode the container, or one of the trim's own
 * guards fired. A duration the chain never measured is `null` rather than 0, so "nothing was measured"
 * cannot be read as "nothing was there".
 */
type AudioReading = {
  source: VoiceSource;
  inputSec: number | null;
  outputSec: number | null;
  savedSec: number | null;
  savedRatio: number | null;
  vadSegments: number | null;
  speechKeptRatio: number | null;
  fallback: boolean;
};

/**
 * The half of a capture's reading that is about the text, measured on the three texts the chain holds:
 * `raw` is what the recogniser answered, `text` what the chain kept of that answer, and `repaired` what
 * the deterministic repair made of it.
 *
 * The two rates are the identifier metric's own reading (`src/shared/identifierFidelity.ts`) on each
 * side of the repair, which is what makes them a pair rather than two measurements: `before` is what
 * the chain alone kept, `after` is what it keeps once the repair has run, and the gap between them is
 * the repair's own effect. `null` is the metric's reading for "this text carried no identifier at all",
 * so it is also what a capture that produced no text reports.
 *
 * `repairHits` counts the identifier spans `repaired` carries that `text` did not — what the repair put
 * back, read through the same metric rather than through a counter the repair would have to maintain.
 * Zero and "no text at all" agree here on purpose: neither is a repair.
 */
type IdentifierReading = {
  identifiers: {
    before: { rate: number | null };
    after: { rate: number | null };
  };
  repairHits: number;
};

/**
 * What the chain did with one capture, as a reading: one object, so a caller reads the audio's half and
 * the text's half together and cannot be handed one without the other.
 */
export type VoiceCaptureReading = AudioReading & IdentifierReading;

/** The reading for a capture whose audio was never measured: the input was uploaded as it arrived. */
const unmeasured = (source: VoiceSource): AudioReading => ({
  source,
  inputSec: null,
  outputSec: null,
  savedSec: null,
  savedRatio: null,
  vadSegments: null,
  speechKeptRatio: null,
  fallback: true,
});

/**
 * The identifier half of a reading, from the recogniser's answer and the repair's output.
 *
 * `text` is derived here rather than passed in because it is the chain's own only transformation of
 * `raw` — `raw.trim()`, one line below in `submitCapture` — and a second caller computing it
 * separately is a second chance to disagree about what the chain kept.
 *
 * Both empty strings is the capture that never got an answer. It is asked of the metric rather than
 * special-cased beside it: `identifierFidelity` reports a `null` rate for a reference that carried no
 * identifier, so "nothing was said" reads the same way here as it does anywhere else.
 */
const readIdentifiers = (raw: string, repaired: string): IdentifierReading => {
  const text = raw.trim();
  const before = identifierFidelity(raw, text);
  const after = identifierFidelity(raw, repaired);
  return {
    identifiers: { before: { rate: before.rate }, after: { rate: after.rate } },
    repairHits: identifierFidelity(repaired, text).missing.length,
  };
};

/**
 * Prints one capture's reading, under its own prefix.
 *
 * `[voice:trim]` and not `[voice]`: the identifier-fidelity reading below is deliberately
 * unconditional — it is the evidence chain of GOAL-005 / AC-114, and a reading that only exists on a
 * debug branch is not a reading the real path can be judged by — so the two must be separable by
 * prefix. Everything about this one is behind the switch.
 *
 * The switch is read here, at the moment of printing, rather than by the caller: the whole reading is
 * one object assembled at one site, and a call site that decided for itself whether to build it is a
 * second place for the field list to drift.
 */
function reportCapture(measured: AudioReading, raw: string, repaired: string): void {
  if (!isVoiceDebugEnabled()) return;
  const reading: VoiceCaptureReading = { ...measured, ...readIdentifiers(raw, repaired) };
  console.debug('[voice:trim]', reading);
}

/**
 * What the chain will upload for one capture, and the second replay track that comes with it.
 *
 * `trimmed` is non-null exactly when the body is not the recording: it carries the re-encoded bytes
 * and the length they measured at, which is what the control beside the recording's own shows. Null
 * on every fallback, so the caller has one thing to test rather than the reading's several fields.
 */
type PreparedUpload = {
  body: Blob;
  filename: string;
  reading: AudioReading;
  trimmed: { blob: Blob; durationSec: number } | null;
};

/**
 * The bytes to upload for a capture, which is the capture itself unless the trim applies.
 *
 * A dictation clip is mostly silence — the wait for the mic, the breaths between sentences, the
 * pause before the button is released — and all of it is paid for twice, in upload bytes and in
 * recognition latency. So the audio is decoded, its silence removed, and the result re-encoded.
 *
 * Every path that does not trim returns the audio untouched: the recogniser's own declaration says
 * its pauses are worth keeping, the switch is off, the browser cannot decode the container, or
 * `trimVoiceAudio` reported one of its guards. Re-encoding a clip that did not get shorter would
 * spend a generation of quality on nothing, which is why the fallback is the original bytes rather
 * than a round-tripped copy of them.
 *
 * The reading is returned rather than printed: this function is where the audio is measured, and the
 * caller is where the decision to print belongs. What it returns is the audio's half of the reading —
 * the text's half is not knowable until the recogniser has answered.
 */
async function prepareUpload(
  blob: Blob,
  source: VoiceSource,
  baseName: string,
): Promise<PreparedUpload> {
  const asRecorded = { filename: `${baseName}.${extensionFor(blob.type)}` };
  const recorded = { ...asRecorded, body: blob, reading: unmeasured(source), trimmed: null };
  // Whether this recogniser's silence is worth removing is the recogniser's own declaration
  // (ADR-004 decision 1), read at its one read point; the switch is the user's and only ever turns
  // a trim off. Both have to say yes. That is what makes "裁不裁" a property of the service rather
  // than of this hook — and it is also why the shipped default is unchanged: the recogniser this
  // build talks to declares its pauses destructive.
  const recogniser = pauseCuesFor(OPENAI_COMPATIBLE_PROVIDER);
  if (!isVoiceTrimEnabled() || !trimDecisionFor(recogniser.pauseCues).trim) return recorded;

  const decoded = await decodeVoiceBlob(blob);
  if (!decoded) return recorded;

  const { samples, stats } = trimVoiceAudio(decoded.samples, decoded.sampleRate);
  const reading: AudioReading = {
    source,
    inputSec: stats.inputSec,
    outputSec: stats.outputSec,
    savedSec: stats.inputSec - stats.outputSec,
    savedRatio: stats.savedRatio,
    vadSegments: stats.vadSegments.length,
    speechKeptRatio: stats.speechKeptRatio,
    fallback: stats.fallback,
  };
  // A guard that fired still leaves a reading worth having: the audio was measured, and what it says
  // about the capture is what tells a trim that found nothing to do from one that never ran.
  if (stats.fallback) return { ...asRecorded, body: blob, reading, trimmed: null };

  const trimmedBody = encodeWavBlob(samples, decoded.sampleRate);
  return {
    body: trimmedBody,
    filename: `${baseName}.wav`,
    reading,
    trimmed: { blob: trimmedBody, durationSec: stats.outputSec },
  };
}

/** A file's name without its extension: the upload derives one from the container it really sends. */
function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** How the mic's uploads are named; a file's uploads keep the name the file arrived with. */
const RECORDING_BASE_NAME = 'recording';

/** The slot's two replays, in the order the composer renders them. */
const CLIP_TRACKS: readonly VoiceClipTrack[] = ['original', 'trimmed'];

/** Both tracks silent. Written once, so "nothing is playing" has a single value to compare against. */
const NOTHING_PLAYING: VoiceClipPlayState = { original: 'idle', trimmed: 'idle' };

/**
 * The state that starts `track`: that one loads, and the other is stopped by the same write.
 *
 * Every start goes through here, which is what makes "at most one track sounds" a property of the
 * shape rather than of the caller remembering to clear the other entry.
 */
const startingPlay = (track: VoiceClipTrack): VoiceClipPlayState => ({
  original: track === 'original' ? 'loading' : 'idle',
  trimmed: track === 'trimmed' ? 'loading' : 'idle',
});

type UseVoiceInputOptions = {
  /**
   * Draft scope of the composer this hook renders in (the open session, or the project
   * before a chat has a session). A change means a different chat, and the clip belongs
   * to the conversation it was recorded in, so it is dropped rather than carried over.
   */
  scope?: string | null;
  /**
   * Whether the composer is on screen. `false` covers the other workspace tabs and the
   * AskUserQuestion panel replacing the footer; both hide the replay pill, so a playing
   * clip would have no visible control to stop it.
   */
  isActive?: boolean;
  /**
   * Names the open project really has, for the deterministic repair of the transcript
   * (see `src/shared/projectIdentifiers.ts`). Passed in rather than resolved here: the
   * hook does not know which project it is in, and a candidate list it fetched itself
   * could not be driven by a test.
   *
   * An empty list is the "nothing to repair with" case and the hook keeps its previous
   * behaviour exactly — `repairIdentifiers` returns its input untouched for it.
   */
  candidates?: readonly string[];
};

/** Stable identity for the absent-candidate case, so the default does not re-create the callback each render. */
const NO_CANDIDATES: readonly string[] = [];


/**
 * Push-to-talk dictation. Records the mic, uploads to /api/voice/transcribe
 * (an OpenAI-compatible speech-to-text backend via the Express proxy), and
 * returns the transcript through onTranscript.
 *
 * It also keeps the last recording as a single slot (`clipSlot`) so the composer can
 * replay what was just said — and, once the trim has run, replay what was actually sent
 * beside it. The recording is taken before the upload, so a failed or timed-out
 * transcription still leaves something to listen back to.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
  options: UseVoiceInputOptions = {},
) {
  const { scope = null, isActive = true, candidates = NO_CANDIDATES } = options;
  const [state, setState] = useState<VoiceInputState>('idle');
  // The last recording, and the upload derived from it. State rather than a ref because the
  // controls render only while a clip exists, and a ref would not re-render on the write.
  const [clipSlot, setClipSlot] = useState<VoiceClipSlot | null>(null);
  // Which of the slot's two tracks is sounding. One object rather than two pieces of state, so
  // "the other one stops" is decided and written in the same update as "this one starts".
  const [clipPlayState, setClipPlayState] = useState<VoiceClipPlayState>(NOTHING_PLAYING);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);
  // Mirrors the clip slot for callbacks that must not be re-created on every clip
  // change, and owns the object URLs that still have to be revoked.
  const clipSlotRef = useRef<VoiceClipSlot | null>(null);
  // The clip's own elements, one per track. Deliberately not `voicePlayer`'s: that one is a TTS
  // player whose cache key is a synthesis content key, which a recording has no analogue of.
  const clipAudioRef = useRef<Record<VoiceClipTrack, HTMLAudioElement | null>>({
    original: null,
    trimmed: null,
  });
  // Which track's `play()` has not settled yet. A start the user has since replaced — by pressing
  // the other control — leaves a promise that rejects with the pause that stopped it, and that
  // rejection is this hook's own doing rather than a playback failure to report.
  const clipStartingRef = useRef<VoiceClipTrack | null>(null);
  // Wall clock at `rec.start()`. The recorder's container usually does carry a finite
  // duration, but reading it means waiting for the element to load metadata, and the
  // pill only shows M:SS — under a second of difference is invisible either way.
  const clipStartedAtRef = useRef(0);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const ensureClipAudio = (track: VoiceClipTrack) => {
    const existing = clipAudioRef.current[track];
    if (existing) return existing;
    const audio = new Audio();
    audio.addEventListener('ended', () => {
      setClipPlayState((previous) => ({ ...previous, [track]: 'idle' }));
    });
    clipAudioRef.current[track] = audio;
    return audio;
  };

  // Stop the sound and leave the slot alone: the controls stay for a retry.
  const pauseClip = () => {
    for (const track of CLIP_TRACKS) clipAudioRef.current[track]?.pause();
    clipStartingRef.current = null;
    setClipPlayState(NOTHING_PLAYING);
  };

  /** Frees every object URL a slot holds — one per track, and the second only when there is one. */
  const revokeSlot = (slot: VoiceClipSlot) => {
    URL.revokeObjectURL(slot.original.url);
    if (slot.trimmed) URL.revokeObjectURL(slot.trimmed.url);
  };

  // Drop the clip entirely. The revoke lives here rather than inside the setState
  // updater because updaters have to stay pure — StrictMode calls them twice, and the
  // second call would revoke a URL the first had already handed to the audio element.
  const discardClip = () => {
    pauseClip();
    const previous = clipSlotRef.current;
    clipSlotRef.current = null;
    setClipSlot(null);
    if (previous) revokeSlot(previous);
  };

  // Single slot: adopting a new recording evicts the previous one, URLs and all. The slot is
  // returned because the capture that just opened it is the only caller that may add to it.
  const adoptClip = (slot: VoiceClipSlot): VoiceClipSlot => {
    const previous = clipSlotRef.current;
    clipSlotRef.current = slot;
    setClipSlot(slot);
    if (previous) revokeSlot(previous);
    return slot;
  };

  /**
   * Hangs the upload's own bytes on the slot the capture opened, as the second track.
   *
   * A new slot object rather than a mutation in place: `clipSlotRef` is what every async callback
   * compares against, and an object edited under it would leave "the slot this capture opened" and
   * "the slot that is current" indistinguishable to a caller holding only the first.
   */
  const adoptTrimmedClip = (slot: VoiceClipSlot, trimmed: { blob: Blob; durationSec: number }) => {
    const next: VoiceClipSlot = {
      ...slot,
      trimmed: {
        url: URL.createObjectURL(trimmed.blob),
        meta: {
          bytes: trimmed.blob.size,
          mimeType: trimmed.blob.type,
          // The trimmed audio's own length, which the trim measured — the wall clock of the press
          // is the recording's duration, and after a trim the two are no longer the same clip.
          durationMs: Math.round(trimmed.durationSec * 1000),
        },
      },
    };
    clipSlotRef.current = next;
    setClipSlot(next);
  };

  // A different scope is a different chat. The composer is never unmounted on a session
  // switch (WorkspaceMain passes the session as a prop, with no `key`), so nothing else
  // would keep one session's recording out of another's composer.
  useEffect(() => {
    discardClip();
  }, [scope]);

  // Off screen — another workspace tab, or the question panel covering the footer —
  // nothing visible can stop the audio, so stop it. The clip is kept: the user is
  // coming back to this same chat and should still be able to replay it.
  useEffect(() => {
    if (!isActive) pauseClip();
  }, [isActive]);

  // Read-aloud and a clip must not sound at once. Read-aloud wins because it was asked
  // for from a message, but the clip is only paused, so the pill survives the collision.
  useEffect(() => voicePlayer.subscribe(() => {
    if (voicePlayer.isBusy()) pauseClip();
  }), []);

  // Stop the mic if the component unmounts mid-recording.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      startingRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      for (const track of CLIP_TRACKS) {
        clipAudioRef.current[track]?.pause();
        clipAudioRef.current[track] = null;
      }
      const slot = clipSlotRef.current;
      clipSlotRef.current = null;
      if (slot) revokeSlot(slot);
    };
  }, []);

  /**
   * One capture's whole journey: bytes, decoded and trimmed, uploaded to the recogniser, repaired
   * against the open project's names, and handed to the composer.
   *
   * Both entries into the voice path meet here — the microphone and the upload button — and that is
   * deliberate rather than convenient. Everything that can be got wrong about this chain (the trim,
   * the container, the endpoint, the repair) is only true of the path a recording takes if the path an
   * uploaded file takes is the same one; a second chain beside it would be free to drift, and the
   * readings taken on one would stop meaning anything about the other.
   *
   * The clip slot is the one place the two are told apart. It exists so the user can hear back the
   * thing they just said, and a file they chose is already theirs to play; capturing it there would
   * also put an upload in the way of the recording the slot is holding.
   *
   * The recording's own bytes open the slot before the upload, because the slot's first track is
   * what survives a transcription that never answers. The second track is added later, and only by
   * the capture that opened the slot: the identity check below is what keeps a slow trim from
   * hanging this chat's audio on the control of whichever chat is open when it finishes.
   */
  const submitCapture = useCallback(async (
    blob: Blob,
    source: VoiceSource,
    { send, baseName }: { send: boolean; baseName: string },
  ) => {
    if (blob.size < MIN_CAPTURE_BYTES) {
      setState('idle');
      onError?.(source === 'mic' ? 'Recording too short' : 'Audio file too small');
      return;
    }
    // Before the upload, not after: a transcription that fails or times out is
    // exactly when the user most needs to hear what they actually said.
    const adopted = source === 'mic'
      ? adoptClip({
        original: {
          url: URL.createObjectURL(blob),
          meta: { bytes: blob.size, mimeType: blob.type, durationMs: Date.now() - clipStartedAtRef.current },
        },
        trimmed: null,
      })
      : null;
    setState('transcribing');
    // The audio's half of this capture's reading, filled in as soon as the chain has measured it and
    // null while it has not. Held out here so the one reading below can be printed on every way out
    // of this block — including the ways that never get an answer, which is exactly when a reading of
    // what was sent is worth having.
    let measured: AudioReading | null = null;
    // The recogniser's answer and what the repair made of it. Empty when there was neither, which is
    // the reading's own way of saying so rather than a case handled beside it.
    let raw = '';
    let repaired = '';
    try {
      const prepared = await prepareUpload(blob, source, baseName);
      measured = prepared.reading;
      // The slot gains its second track here, where the chain has just decided that what it uploads
      // is not the recording. Held off the reading rather than off `source === 'mic'` so the one
      // thing that says a trim happened is the trim's own output: a `fallback` leaves `trimmed`
      // null and the composer renders a single control, which is the honest face of a capture that
      // was uploaded as it was recorded.
      if (adopted && prepared.trimmed && clipSlotRef.current === adopted) {
        adoptTrimmedClip(adopted, prepared.trimmed);
      }
      const res = await transcribeVoice(prepared.body, prepared.filename);
      if (!res.ok) throw new Error(`transcribe ${res.status}`);
      // Parsed before the cancellation check, exactly as the inline `res.json()` was: a body that
      // is not JSON still has to reach the catch below even when this capture was cancelled.
      // `strict` is this path's own tolerance, named at the call site rather than implied by
      // living in this file — the proxy path reads the same answer leniently.
      raw = await parseTranscriptionResponse(res, 'strict');
      if (cancelledRef.current) return;
      const text = raw.trim();
      if (text) {
        // The one point between the recogniser and the composer where the transcript is
        // still ours to change: `raw -> text` is the trim, `text -> repaired` is the
        // deterministic repair against the project's own names. Nothing else in the
        // chain touches the text, so this is where both readings belong.
        repaired = repairIdentifiers(text, candidates);
        // The voice link's own telemetry (GOAL-005 / AC-114): how much of what the
        // recogniser returned survives — punctuation and case intact — into the text
        // handed back to the composer, read on both sides of the repair. The pair is
        // what makes it the repair's reading rather than a bystander's: `before` is
        // what the chain alone kept, `after` is what it keeps once the repair has run,
        // and the names the second one reports missing are exactly the names the repair
        // rewrote. A repair that fires on a name the transcript never carried therefore
        // shows up here as a drop, which is the failure AC-113 measures as misRepairs.
        // Console-only by design: it changes no interaction and no request flow, and a
        // reading that only exists on a debug branch is not a reading the real path can
        // be judged by.
        console.debug('[voice] identifier fidelity', {
          before: identifierFidelity(raw, text),
          after: identifierFidelity(raw, repaired),
        });
        onTranscript(repaired, send);
      } else onError?.('No speech detected');
    } catch (e) {
      if (!cancelledRef.current) {
        onError?.(`Transcription failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      // One reading per capture that reached the chain, from one site, so it cannot be printed twice
      // or forgotten on any of the exits above. The half that needs the recogniser is filled in only
      // if there was one; a capture that failed still gets the half that was measured.
      //
      // Printed after `onTranscript`, which hands the composer its text through a React update: that
      // update is committed in a later task than this call, so by the time a caller can see the
      // transcript this reading is already on the console. That ordering is what lets "the switch is
      // off" be asserted as an absence — a leg waits for the text and then counts readings, and a
      // reading printed any later would arrive after the count.
      if (measured !== null && !cancelledRef.current) reportCapture(measured, raw, repaired);
      if (!cancelledRef.current) setState('idle');
    }
  }, [onTranscript, onError, candidates]);

  const start = useCallback(async () => {
    if (startingRef.current || (recorderRef.current && recorderRef.current.state !== 'inactive')) return;
    // A new recording is about to replace the slot; stop the old one from sounding.
    pauseClip();
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        stopTracks();
        if (cancelledRef.current) return;
        // Capture and clear the send intent for this stop before any async work.
        const shouldSend = sendRef.current;
        sendRef.current = false;
        const type = rec.mimeType || 'audio/webm';
        await submitCapture(
          new Blob(chunksRef.current, { type }),
          'mic',
          { send: shouldSend, baseName: RECORDING_BASE_NAME },
        );
      };

      clipStartedAtRef.current = Date.now();
      rec.start();
      setState('recording');
    } catch (e) {
      recorderRef.current = null;
      stopTracks();
      if (cancelledRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `Mic error: ${err?.message || e}`;
      if (err?.name === 'NotAllowedError') msg = 'Microphone access denied.';
      else if (err?.name === 'NotFoundError') msg = 'No microphone found.';
      onError?.(msg);
      setState('idle');
    } finally {
      startingRef.current = false;
    }
  }, [submitCapture, onError]);

  /**
   * Feeds a chosen audio file through the chain a recording travels.
   *
   * The other half of `submitCapture`, and deliberately nothing more than a call into it: an uploaded
   * file is not a second kind of audio, it is the same audio arriving by a different door. What it is
   * not is a send — a file is chosen to see the chain work, and a turn nobody asked to spend is not
   * what choosing one means.
   */
  const transcribeFile = useCallback((file: File) => {
    void submitCapture(file, 'file', { send: false, baseName: withoutExtension(file.name) });
  }, [submitCapture]);

  // Stop recording. Pass { send: true } to auto-send the transcript once it's ready.
  // Guard on the recorder's own state (not React state) so a double tap, or the mic
  // and Send buttons both firing, can't call stop() on an already-inactive recorder.
  const stop = useCallback((opts?: { send?: boolean }) => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      sendRef.current = opts?.send ?? false;
      rec.stop();
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  }, [state, start, stop]);

  /**
   * Plays one of the slot's tracks, or stops it when it is the one already sounding.
   *
   * Starting a track stops the other: the two are the same speaker said twice, and hearing them
   * together is the one thing the pair cannot be compared by. The stop is written with the start
   * (see `startingPlay`) rather than after it, so there is no window in which both read as playing.
   */
  const toggleClipPlayback = useCallback((track: VoiceClipTrack) => {
    const clip = clipSlotRef.current?.[track];
    if (!clip) return;
    const audio = ensureClipAudio(track);
    if (clipPlayState[track] !== 'idle') {
      audio.pause();
      clipStartingRef.current = null;
      setClipPlayState((previous) => ({ ...previous, [track]: 'idle' }));
      return;
    }
    for (const other of CLIP_TRACKS) {
      if (other !== track) clipAudioRef.current[other]?.pause();
    }
    // Yield the speakers to the clip; `voicePlayer` would keep synthesizing otherwise.
    voicePlayer.stop();
    audio.src = clip.url;
    clipStartingRef.current = track;
    setClipPlayState(startingPlay(track));
    // Not awaited: iOS only grants playback to a `play()` issued inside the gesture's
    // stack, and awaiting would move it out of that stack. Handling the rejection
    // instead is what keeps the control from sitting in `loading` forever.
    const started: Promise<void> | undefined = audio.play();
    if (started && typeof started.then === 'function') {
      started.then(
        () => {
          if (clipStartingRef.current !== track) return;
          clipStartingRef.current = null;
          if (clipSlotRef.current?.[track] !== clip) return;
          setClipPlayState((previous) => ({ ...previous, [track]: 'playing' }));
        },
        (e: unknown) => {
          // The other track's control took the speakers, so this `play()` was stopped by this hook
          // and not by anything the user needs to hear about.
          if (clipStartingRef.current !== track) return;
          clipStartingRef.current = null;
          if (clipSlotRef.current?.[track] !== clip) return;
          setClipPlayState((previous) => ({ ...previous, [track]: 'idle' }));
          // A DOMException is not an `Error`; the template has to cover both shapes.
          onError?.(`Playback failed: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    } else {
      clipStartingRef.current = null;
      setClipPlayState((previous) => ({ ...previous, [track]: 'playing' }));
    }
  }, [clipPlayState, onError]);

  return { state, toggle, stop, transcribeFile, clipSlot, clipPlayState, toggleClipPlayback };
}
