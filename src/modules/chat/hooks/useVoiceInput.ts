import { useCallback, useEffect, useRef, useState } from 'react';

import { voicePlayer } from '@/modules/chat/utils/voicePlayer';
import { transcribeVoice } from '@/shared/api';
import { identifierFidelity } from '@/shared/identifierFidelity';
import type { VoiceClip, VoiceInputState, VoicePlayState } from '@/shared/types';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

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
};


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
  const { scope = null, isActive = true } = options;
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
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size < 800) {
          setState('idle');
          onError?.('Recording too short');
          return;
        }
        // Before the upload, not after: a transcription that fails or times out is
        // exactly when the user most needs to hear what they actually said.
        adoptClip({
          url: URL.createObjectURL(blob),
          meta: { bytes: blob.size, mimeType: type, durationMs: Date.now() - clipStartedAtRef.current },
        });
        setState('transcribing');
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const res = await transcribeVoice(blob, `recording.${ext}`);
          if (!res.ok) throw new Error(`transcribe ${res.status}`);
          const data = await res.json();
          if (cancelledRef.current) return;
          const raw = String(data?.text || '');
          const text = raw.trim();
          if (text) {
            // S0 reading for the voice link (GOAL-005 / AC-114): how much of what the
            // recogniser returned survives — punctuation and case intact — into the text
            // handed back to the composer. Nothing sits between those two texts yet, so this
            // is the baseline reading, taken over the recogniser's identifiers and the
            // composer's; it is also the exact boundary the deterministic identifier repair
            // will be measured at, where a non-empty `missing` is a repair that rewrote a
            // name the transcript never carried. Console-only by design: it changes no
            // interaction and no request flow, and a reading that only exists on a debug
            // branch is not a reading the real path can be judged by.
            console.debug('[voice] identifier fidelity', identifierFidelity(raw, text));
            onTranscript(text, shouldSend);
          } else onError?.('No speech detected');
        } catch (e) {
          if (!cancelledRef.current) {
            onError?.(`Transcription failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } finally {
          if (!cancelledRef.current) setState('idle');
        }
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
  }, [onTranscript, onError]);

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

  return { state, toggle, stop, voiceClip, clipState, toggleClipPlayback };
}
