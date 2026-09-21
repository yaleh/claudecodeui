/**
 * Turning a recording into samples, and samples back into something a recogniser accepts.
 *
 * The voice path records with `MediaRecorder` — a container it did not build and cannot read — and
 * the trim module `src/shared/voiceTrim.ts` works on a `Float32Array`. This file is the seam: it is
 * the only place in the frontend that touches WebAudio, so the "decode, trim, re-encode" step is
 * one call the hook makes rather than a codec conversation the hook has to have.
 *
 * Used by `src/modules/chat/hooks/useVoiceInput.ts`.
 */

/** A recording, decoded: mono samples and the rate they are at. */
export type DecodedVoice = {
  samples: Float32Array;
  sampleRate: number;
};

/**
 * The rate the decoded copy is asked for.
 *
 * `decodeAudioData` resamples to the context's rate, and a browser capture is 48 kHz, so asking for
 * it means the common case decodes without a resample — the samples that reach the trim module are
 * the ones the encoder produced. It is a request, not a requirement: a browser that refuses the
 * option gets a default context and the buffer's own rate is used, which the WAV header then
 * carries, so the duration is exact either way.
 */
const DECODE_SAMPLE_RATE = 48_000;

/** Bytes of a canonical 44-byte PCM WAV header: RIFF/WAVE/fmt/data, no extra chunks. */
const WAV_HEADER_BYTES = 44;

/**
 * The largest 16-bit sample value. A float sample is clamped to [-1, 1] before scaling, so the
 * negative end is -PCM_MAX — the asymmetry of the two's-complement range is inside the clamp.
 */
const PCM_MAX = 32_767;

/** The browser's audio decoder, or null where there is none (a non-browser context, an old engine). */
function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const scope = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * A single mono channel out of the decoded buffer.
 *
 * Multi-channel audio is averaged rather than taking channel 0: a recogniser is given one channel
 * either way, and dropping a channel that happens to hold the voice would be a silent quality
 * loss. `slice()` copies, so the result does not alias a buffer the decoder still owns.
 */
function downmix(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels <= 1) return buffer.getChannelData(0).slice();

  const mixed = new Float32Array(buffer.length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mixed.length; i += 1) mixed[i] += data[i] / channels;
  }
  return mixed;
}

/**
 * Decodes `blob` into mono samples, or returns null when this browser cannot read the container.
 *
 * Null is the fallback signal, not an error: the caller uploads what it recorded. A recording the
 * app cannot decode is still a recording the recogniser may be able to, so refusing to send it
 * would turn a failed optimisation into a lost dictation.
 */
export async function decodeVoiceBlob(blob: Blob): Promise<DecodedVoice | null> {
  const AudioContextCtor = audioContextCtor();
  if (!AudioContextCtor || blob.size === 0) return null;

  let context: AudioContext;
  try {
    context = new AudioContextCtor({ sampleRate: DECODE_SAMPLE_RATE });
  } catch {
    try {
      context = new AudioContextCtor();
    } catch {
      return null;
    }
  }

  try {
    // `decodeAudioData` detaches the buffer it is handed, so each call gets its own copy.
    const bytes = await blob.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    return { samples: downmix(buffer), sampleRate: buffer.sampleRate };
  } catch {
    return null;
  } finally {
    // Not awaited: the samples are already out, and a context left open holds an audio device.
    void context.close();
  }
}

/**
 * Encodes `samples` as a 16-bit PCM WAV.
 *
 * WAV rather than webm/opus on purpose. The trimmed audio is shorter than what was recorded, and
 * re-encoding it through a lossy codec would spend a second generation of quality on a clip that is
 * about to be transcribed; PCM costs bytes, which is the one thing the trim just saved, and is
 * decodable by every recogniser endpoint. The header carries the rate the samples are really at, so
 * the duration a reader derives from it is the duration of what was sent.
 */
export function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size: PCM
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(clamped * PCM_MAX), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
