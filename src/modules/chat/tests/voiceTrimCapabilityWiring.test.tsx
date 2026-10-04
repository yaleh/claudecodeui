import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import type * as AudioDecode from '@/modules/chat/utils/audioDecode';
import type * as SharedApi from '@/shared/api';

/**
 * The audio-file entry travels the ONE capture path, and what it uploads is a WAV segment.
 *
 * WHAT THIS FILE USED TO MEASURE, AND WHY IT NO LONGER CAN. It pinned the batch trim's wiring:
 * whether the recogniser's `pauseCues` declaration decided that a chosen file was trimmed and
 * re-encoded before upload. That whole decision is gone — the continuous-capture path cuts the
 * audio with the shared VAD and uploads each segment as 16 kHz PCM WAV, with no trim and no second
 * container — so the capability has no say in the container any more. What survives as a reading is
 * the positive half: the file entry is not a second batch path, it is the same cutter and the same
 * uploader, and it emits `audio/wav` segments named by their ordinal.
 *
 * Everything the chain needs is doubled below (the decoder; the recogniser) because jsdom has no
 * audio stack and no offline recogniser. The segmenter and the VAD between them are the shipping
 * modules — this file does not re-implement the cut, it observes the container that leaves it.
 */

const { transcribeVoice } = vi.hoisted(() => ({ transcribeVoice: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    transcribeVoice,
    voiceConfigSignature: () => 'test-signature',
    // The same parse the shipping hook performs.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
  };
});

/**
 * One second of 16 kHz audio with a burst of speech in the middle.
 *
 * Not silence: the VAD only starts a segment on speech, so a buffer it found no speech in would
 * produce no upload at all — the absence this file asserts against would hold for the wrong reason.
 */
const speechSamples = (): Float32Array => {
  const samples = new Float32Array(16_000);
  for (let i = 3_000; i < 9_000; i++) samples[i] = 0.5 * Math.sin((i / 16_000) * 2 * Math.PI * 220);
  return samples;
};

/** The decoder, doubled because jsdom has none; the segmenter above it is the shipping module. */
vi.mock('@/modules/chat/utils/audioDecode', async (importOriginal) => ({
  ...(await importOriginal<typeof AudioDecode>()),
  decodeVoiceBlob: async () => ({ samples: speechSamples(), sampleRate: 16_000 }),
}));

const recording = () => new File([new Uint8Array(4000)], 'take.webm', { type: 'audio/webm' });

const uploaded = () => {
  const call = transcribeVoice.mock.calls[0];
  assert.ok(call, 'nothing reached the recogniser');
  return { body: call[0] as Blob, filename: call[1] as string };
};

beforeEach(() => {
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) });
});

test('a chosen audio file is cut and uploaded as a WAV segment, not as the file it arrived as', async () => {
  const view = renderHook(() => useVoiceInput(vi.fn(), vi.fn()));
  await act(async () => {
    view.result.current.transcribeFile(recording());
  });
  // `transcribeFile` returns before the upload settles; drain that tail so the call is observable.
  await act(async () => {});

  const { body, filename } = uploaded();
  assert.equal(body.type, 'audio/wav', 'the file entry uploaded its input instead of a segment');
  assert.equal(filename, 'segment-1.wav');
  assert.equal(view.result.current.state, 'idle', 'the file run must return to idle when it settles');
});
