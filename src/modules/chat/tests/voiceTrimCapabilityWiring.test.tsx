import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { PauseCuesDeclaration } from '@shared/asr/asrRegistry';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import type * as SharedApi from '@/shared/api';

/**
 * Whether a recording is trimmed is the *recogniser's* declaration, not this hook's opinion.
 *
 * The unit of this file is the last thing the chain does before it uploads: which bytes reach
 * `transcribeVoice`. Everything the trim needs to run is doubled below — the decoder, the encoder,
 * the switch, the endpoint — because jsdom has no audio stack and because the question here is not
 * what the DSP does (`src/shared/tests/voiceTrim.test.ts` owns that) but **who decides whether it
 * runs**. So the readings are the two containers the chain can upload: the recording as it arrived,
 * or the re-encoded WAV the trim produced.
 *
 * THE DECLARATION IS DRIVEN WHERE THE HOOK ASKS FOR IT: `effectivePauseCuesDeclaration()` in the
 * shared API module, which is the same accessor the shipping hook calls and which reads the
 * provider id off the health reading's published profile. Nothing here re-declares a capability or
 * re-implements the mapping — the real `trimDecisionFor` runs in every case below, and the third
 * case is the positive control for it: with the switch on, the decoder working and the trim ready
 * to run, a recogniser whose pauses are worth keeping still gets its recording uploaded untouched.
 */

const { transcribeVoice } = vi.hoisted(() => ({ transcribeVoice: vi.fn() }));

/**
 * The recogniser's declaration, as the cases drive it: `null` is the "no declaration to read"
 * state — the health reading has not landed, or names an id the registry does not claim — which
 * must leave the recording alone rather than fall back to a shipped row.
 */
const { voiceProfile } = vi.hoisted(() => ({
  voiceProfile: { declaration: null as null | PauseCuesDeclaration },
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    transcribeVoice,
    voiceConfigSignature: () => 'test-signature',
    // No I/O, and it is the same parse the shipping hook performs — a second copy here would be a
    // second copy of the thing under test.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
    // The one seam the capability arrives through, and the shipping accessor is what answers when
    // a case leaves it alone.
    effectivePauseCuesDeclaration: () => voiceProfile.declaration,
  };
});

/**
 * The switch, as this file wants it: named per case, because "the user turned the trim off" and
 * "the recogniser says the pauses are worth keeping" are two different reasons for the same upload
 * and a case that cannot tell them apart measures neither.
 */
const { voiceFlags } = vi.hoisted(() => ({ voiceFlags: { trim: true } }));

vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => voiceFlags.trim,
}));

/**
 * A second of 16 kHz audio with one burst of speech in the middle: what the trim needs in order to
 * have anything to do, and the smallest buffer that gives it.
 *
 * Not silence, and not a stub of the trim's output: the real `trimVoiceAudio` runs in every case
 * below (it is these cases' subject only in that it must *not* run), and a buffer it detected no
 * speech in would come back as a fallback — the recording, uploaded as it arrived — which is the
 * same observation as "the capability declined the trim" made for the wrong reason.
 */
const decodableSamples = () => {
  const samples = new Float32Array(16_000);
  for (let i = 6_000; i < 10_000; i++) samples[i] = 0.5 * Math.sin((i / 16_000) * 2 * Math.PI * 220);
  return samples;
};

/**
 * The decoder and the encoder, doubled because jsdom has neither; the trim between them is the
 * shipping module.
 */
vi.mock('@/modules/chat/utils/audioDecode', () => ({
  decodeVoiceBlob: async () => ({ samples: decodableSamples(), sampleRate: 16_000 }),
  encodeWavBlob: () => new Blob([new Uint8Array(2048)], { type: 'audio/wav' }),
}));

/** The recording as the chain receives it: a real container, and well over the 800-byte floor. */
const RECORDING_BYTES = 4000;

const recording = () =>
  new File([new Uint8Array(RECORDING_BYTES)], 'take.webm', { type: 'audio/webm' });

/** What the chain uploaded, in the shape the recogniser sees it. */
const uploaded = () => {
  const call = transcribeVoice.mock.calls[0];
  assert.ok(call, 'nothing reached the recogniser');
  return { body: call[0] as Blob, filename: call[1] as string };
};

/** One capture: a file through the chain a recording travels, drained to the end of the upload. */
const uploadAFile = async () => {
  const view = renderHook(() => useVoiceInput(vi.fn(), vi.fn()));
  await act(async () => {
    view.result.current.transcribeFile(recording());
  });
  // `transcribeFile` returns before the upload settles; drain that tail so the call is observable.
  await act(async () => {});
  return view;
};

/** A declaration, built where the vocabulary lives — this file never spells the capability's key. */
const declaring = (capability: PauseCuesDeclaration['capability']): PauseCuesDeclaration => ({
  provider: 'fixture-recogniser',
  capability,
});

beforeEach(() => {
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) });
  voiceProfile.declaration = declaring('destructive');
  voiceFlags.trim = true;
});

test('the declared recogniser trims: the upload is the clip the trim produced, not the recording', async () => {
  await uploadAFile();

  const { body, filename } = uploaded();
  assert.equal(body.type, 'audio/wav', 'the recording was uploaded instead of the trimmed clip');
  assert.equal(filename, 'take.wav');
  assert.notEqual(body.size, RECORDING_BYTES);
});

test('the switch alone still decides: off, the recording goes as it arrived', async () => {
  voiceFlags.trim = false;

  await uploadAFile();

  const { body, filename } = uploaded();
  assert.equal(body.type, 'audio/webm', 'the trim ran with the switch off');
  assert.equal(filename, 'take.webm');
  assert.equal(body.size, RECORDING_BYTES);
});

test('the capability alone decides: a recogniser whose pauses are worth keeping is not trimmed', async () => {
  // The capability's own other value, and nothing else changed — the switch is on, the decoder
  // works, the trim would run. This is the positive control for the two cases above: if it were
  // the switch or the decoder deciding, this upload would still be a WAV.
  voiceProfile.declaration = declaring('useful');

  await uploadAFile();

  const { body, filename } = uploaded();
  assert.equal(body.type, 'audio/webm', 'the trim ran against the recogniser\'s own declaration');
  assert.equal(filename, 'take.webm');
  assert.equal(body.size, RECORDING_BYTES);
});

test('a recogniser with no readable declaration is not trimmed: an unknown service gets the audio as recorded', async () => {
  // The fail-closed arm. The trim changes the audio, so a provider this build cannot name — an
  // unregistered id, or a health reading that never landed — must not authorise it, and must not
  // be answered from a shipped row kept here for the purpose.
  voiceProfile.declaration = null;

  await uploadAFile();

  const { body, filename } = uploaded();
  assert.equal(body.type, 'audio/webm', 'an unnameable recogniser was trimmed anyway');
  assert.equal(filename, 'take.webm');
  assert.equal(body.size, RECORDING_BYTES);
});
