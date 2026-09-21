import { useCallback, useEffect, useRef, useState } from 'react';

import { decodeVoiceBlob, encodeWavBlob } from '@/modules/chat/utils/audioDecode';
import { voicePlayer } from '@/modules/chat/utils/voicePlayer';
import { transcribeVoice } from '@/shared/api';
import { identifierFidelity } from '@/shared/identifierFidelity';
import { repairIdentifiers } from '@/shared/identifierRepair';
import type { VoiceClip, VoiceInputState, VoicePlayState } from '@/shared/types';
import { isVoiceDebugEnabled, isVoiceTrimEnabled } from '@/shared/voiceDebug';
import { trimVoiceAudio } from '@/shared/voiceTrim';

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
 * What the chain did with one capture, as a reading.
 *
 * The two entries share one chain, so the only thing that tells their readings apart is `source`;
 * everything else is a measurement of the audio itself, taken where the audio is still in hand.
 *
 * `fallback` is the one field that is not a measurement: true means the bytes uploaded were the input
 * untouched — the trim is off, the browser could not decode the container, or one of the trim's own
 * guards fired. A duration the chain never measured is `null` rather than 0, so "nothing was measured"
 * cannot be read as "nothing was there".
 */
export type VoiceCaptureReading = {
  source: VoiceSource;
  inputSec: number | null;
  outputSec: number | null;
  savedSec: number | null;
  savedRatio: number | null;
  vadSegments: number | null;
  speechKeptRatio: number | null;
  fallback: boolean;
};

/** The reading for a capture whose audio was never measured: the input was uploaded as it arrived. */
const unmeasured = (source: VoiceSource): VoiceCaptureReading => ({
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
 * The bytes to upload for a capture, which is the capture itself unless the trim applies.
 *
 * A dictation clip is mostly silence — the wait for the mic, the breaths between sentences, the
 * pause before the button is released — and all of it is paid for twice, in upload bytes and in
 * recognition latency. So the audio is decoded, its silence removed, and the result re-encoded.
 *
 * Every path that does not trim returns the audio untouched: the switch is off, the browser
 * cannot decode the container, or `trimVoiceAudio` reported one of its guards. Re-encoding a clip
 * that did not get shorter would spend a generation of quality on nothing, which is why the
 * fallback is the original bytes rather than a round-tripped copy of them.
 *
 * The reading is returned rather than printed: this function is where the audio is measured, and the
 * caller is where the decision to print belongs.
 */
async function prepareUpload(
  blob: Blob,
  source: VoiceSource,
  baseName: string,
): Promise<{ body: Blob; filename: string; reading: VoiceCaptureReading }> {
  const asRecorded = { filename: `${baseName}.${extensionFor(blob.type)}` };
  const recorded = { ...asRecorded, body: blob, reading: unmeasured(source) };
  if (!isVoiceTrimEnabled()) return recorded;

  const decoded = await decodeVoiceBlob(blob);
  if (!decoded) return recorded;

  const { samples, stats } = trimVoiceAudio(decoded.samples, decoded.sampleRate);
  const reading: VoiceCaptureReading = {
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
  if (stats.fallback) return { ...asRecorded, body: blob, reading };

  return { body: encodeWavBlob(samples, decoded.sampleRate), filename: `${baseName}.wav`, reading };
}

/** A file's name without its extension: the upload derives one from the container it really sends. */
function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** How the mic's uploads are named; a file's uploads keep the name the file arrived with. */
const RECORDING_BASE_NAME = 'recording';

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
 * It also keeps the last recording as a single slot (`voiceClip`) so the composer
 * can replay what was just said. The clip is captured before the upload, so a
 * failed or timed-out transcription still leaves something to listen back to.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
  options: UseVoiceInputOptions = {},
) {
  const { scope = null, isActive = true, candidates = NO_CANDIDATES } = options;
  const [state, setState] = useState<VoiceInputState>('idle');
  // The last recording. State rather than a ref because the pill renders only while a
  // clip exists, and a ref would not re-render on the write.
  const [voiceClip, setVoiceClip] = useState<VoiceClip | null>(null);
  const [clipState, setClipState] = useState<VoicePlayState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);
  // Mirrors the clip slot for callbacks that must not be re-created on every clip
  // change, and owns the object URL that still has to be revoked.
  const clipRef = useRef<VoiceClip | null>(null);
  // The clip's own element. Deliberately not `voicePlayer`'s: that one is a TTS player
  // whose cache key is a synthesis content key, which a recording has no analogue of.
  const clipAudioRef = useRef<HTMLAudioElement | null>(null);
  // Wall clock at `rec.start()`. The recorder's container usually does carry a finite
  // duration, but reading it means waiting for the element to load metadata, and the
  // pill only shows M:SS — under a second of difference is invisible either way.
  const clipStartedAtRef = useRef(0);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const ensureClipAudio = () => {
    if (!clipAudioRef.current) {
      const audio = new Audio();
      audio.addEventListener('ended', () => setClipState('idle'));
      clipAudioRef.current = audio;
    }
    return clipAudioRef.current;
  };

  // Stop the sound and leave the slot alone: the pill stays for a retry.
  const pauseClip = () => {
    clipAudioRef.current?.pause();
    setClipState('idle');
  };

  // Drop the clip entirely. The revoke lives here rather than inside the setState
  // updater because updaters have to stay pure — StrictMode calls them twice, and the
  // second call would revoke a URL the first had already handed to the audio element.
  const discardClip = () => {
    pauseClip();
    const previous = clipRef.current;
    clipRef.current = null;
    setVoiceClip(null);
    if (previous) URL.revokeObjectURL(previous.url);
  };

  // Single slot: adopting a new recording evicts the previous one, URL and all.
  const adoptClip = (clip: VoiceClip) => {
    const previous = clipRef.current;
    clipRef.current = clip;
    setVoiceClip(clip);
    if (previous) URL.revokeObjectURL(previous.url);
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
      clipAudioRef.current?.pause();
      clipAudioRef.current = null;
      const clip = clipRef.current;
      clipRef.current = null;
      if (clip) URL.revokeObjectURL(clip.url);
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
    if (source === 'mic') {
      adoptClip({
        url: URL.createObjectURL(blob),
        meta: { bytes: blob.size, mimeType: blob.type, durationMs: Date.now() - clipStartedAtRef.current },
      });
    }
    setState('transcribing');
    try {
      const { body, filename, reading } = await prepareUpload(blob, source, baseName);
      // Printed before the upload rather than after it: this is the reading of what was sent, and it
      // has to exist even when the recogniser never answers.
      if (isVoiceDebugEnabled()) console.debug('[voice:trim]', reading);
      const res = await transcribeVoice(body, filename);
      if (!res.ok) throw new Error(`transcribe ${res.status}`);
      const data = await res.json();
      if (cancelledRef.current) return;
      const raw = String(data?.text || '');
      const text = raw.trim();
      if (text) {
        // The one point between the recogniser and the composer where the transcript is
        // still ours to change: `raw -> text` is the trim, `text -> repaired` is the
        // deterministic repair against the project's own names. Nothing else in the
        // chain touches the text, so this is where both readings belong.
        const repaired = repairIdentifiers(text, candidates);
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

  const toggleClipPlayback = useCallback(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const audio = ensureClipAudio();
    if (clipState !== 'idle') {
      audio.pause();
      setClipState('idle');
      return;
    }
    // Yield the speakers to the clip; `voicePlayer` would keep synthesizing otherwise.
    voicePlayer.stop();
    audio.src = clip.url;
    setClipState('loading');
    // Not awaited: iOS only grants playback to a `play()` issued inside the gesture's
    // stack, and awaiting would move it out of that stack. Handling the rejection
    // instead is what keeps the control from sitting in `loading` forever.
    const started: Promise<void> | undefined = audio.play();
    if (started && typeof started.then === 'function') {
      started.then(
        () => {
          if (clipRef.current === clip) setClipState('playing');
        },
        (e: unknown) => {
          if (clipRef.current !== clip) return;
          setClipState('idle');
          // A DOMException is not an `Error`; the template has to cover both shapes.
          onError?.(`Playback failed: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    } else {
      setClipState('playing');
    }
  }, [clipState, onError]);

  return { state, toggle, stop, transcribeFile, voiceClip, clipState, toggleClipPlayback };
}
