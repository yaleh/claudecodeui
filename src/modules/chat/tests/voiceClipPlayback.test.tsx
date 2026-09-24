import assert from 'node:assert/strict';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { PauseCuesDeclaration } from '@shared/asr/asrRegistry';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { voicePlayer } from '@/modules/chat/utils/voicePlayer';
import enChat from '@/modules/i18n/locales/en/chat.json';
// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';
import type * as VoiceTrim from '@/shared/voiceTrim';

/**
 * The composer keeps the last recording as a single slot so it can be replayed — and, once the
 * trim has run, keeps the upload made of it beside it so the two can be compared.
 *
 * Everything the recording path touches is faked below — `MediaRecorder`,
 * `getUserMedia`, the clip's `Audio` elements, the two `URL` object-URL calls, the
 * switches, and the decode/trim/encode half — because jsdom has none of them and
 * because the point is the *policy*: when a clip is captured, when it is dropped, what
 * the controls over it say, and which of the two is sounding.
 *
 * The lifecycle half is the part a unit test can actually own. The composer is never
 * unmounted on a session switch (WorkspaceMain passes the session as a prop with no
 * `key`), so nothing here is exercised by a remount: the hook has to drop the clip
 * from the scope signal alone, and only stop — not drop — it when it goes off screen.
 */

const { transcribeVoice } = vi.hoisted(() => ({ transcribeVoice: vi.fn() }));

/**
 * The declaration a case records under, when it records under one at all. `null` is "nothing
 * authorises a trim" — the shipping answer for a recording whose voice profile has not been
 * published — and it is what every case here records in unless it turns the trim on and says whose
 * recogniser is asking for it.
 */
const { voiceProfile } = vi.hoisted(() => ({
  voiceProfile: { declaration: null as null | PauseCuesDeclaration },
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    transcribeVoice,
    synthesizeVoice: vi.fn(),
    voiceConfigSignature: () => 'test-signature',
    // The hook reads the recogniser's answer through this named export. It does no I/O, so it is
    // driven for real rather than doubled — the double exists to cut the speech endpoint, and a
    // second copy of the parse here would be a second copy of the thing under test.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
    // The other thing the capture path asks the shared module for: the declaration that authorises
    // the trim, read by the id the upload routes on. Taken from the real accessor for the same
    // reason as the parse above, so a case that leaves it alone reads the shipping decision rather
    // than a second copy of it kept here; a case that wants the pair of tracks names its recogniser.
    effectivePauseCuesDeclaration: () =>
      voiceProfile.declaration ?? actual.effectivePauseCuesDeclaration(),
  };
});

// The real hook asks the backend whether a voice provider is configured; the clip
// pill is not gated on that, but the mic button is, and the composer test drives one.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

/**
 * The voice path's switches, as this file wants them: unnamed, so `useVoiceDebugEnabled` is off —
 * which is what a plain install is — and the trim off unless a test turns it on. The trim's real
 * default belongs to the browser-level e2e, where a real recorder, a real decoder and the shipping
 * trim are in play; a second copy of that here would be asserting against a stub of itself.
 */
const { voiceFlags } = vi.hoisted(() => ({ voiceFlags: { trim: false } }));

vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => voiceFlags.trim,
}));

/** What the next trim will report: how long its output is, and whether a guard refused to trim. */
const { stubbedTrim } = vi.hoisted(() => ({
  stubbedTrim: { outputSec: 1, fallback: false, decodable: true },
}));

/**
 * The decode/trim/encode half of the chain, stubbed.
 *
 * What the slot needs from it is exactly two things — bytes that are not the recording, and a
 * reading that says how long they are — and neither is what the real half is for: the trim's own
 * behaviour is covered where it lives (`src/shared/tests/voiceTrim.test.ts`), and the browser's
 * decoder cannot be driven from jsdom at all.
 */
vi.mock('@/modules/chat/utils/audioDecode', () => ({
  decodeVoiceBlob: async () =>
    (stubbedTrim.decodable ? { samples: new Float32Array(16_000), sampleRate: 16_000 } : null),
  encodeWavBlob: (samples: Float32Array) =>
    new Blob([new Uint8Array(samples.length * 2)], { type: 'audio/wav' }),
}));

/**
 * The trim itself is stubbed, but the rest of the module is not: `trimDecisionFor` — the mapping
 * from a declared capability to 裁不裁 — is the shipping one, so a case that names a declaration
 * still exercises the real decision. What is stubbed is the DSP, which jsdom cannot drive at all.
 *
 * WHOSE CAPABILITY IS DECIDED ELSEWHERE, and deliberately: the value arrives through the accessor
 * doubled in the `@/shared/api` mock above, and what this file records in by default is the
 * shipping answer — no declaration to read, so the recording travels exactly as it was recorded.
 * The one adapter this build registers declares its pauses worth keeping, which is the same
 * upload, and `voiceTrimCapabilityWiring.test.tsx` owns that reading. A case here that wants the
 * pair of tracks therefore has to name a recogniser that asks for the trim: the pair cannot exist
 * without one, and inventing an answer inside this file would hide who decides it.
 */
vi.mock('@/shared/voiceTrim', async (importOriginal) => ({
  ...(await importOriginal<typeof VoiceTrim>()),
  trimVoiceAudio: (samples: Float32Array) => ({
    samples,
    stats: {
      inputSec: samples.length / 16_000,
      outputSec: stubbedTrim.outputSec,
      savedRatio: 1 - stubbedTrim.outputSec / (samples.length / 16_000),
      vadSegments: [{ startSec: 0, endSec: stubbedTrim.outputSec }],
      speechKeptRatio: 1,
      fallback: stubbedTrim.fallback,
      fallbackReason: stubbedTrim.fallback ? 'noSpeech' : null,
      frames: 50,
      noiseFloor: 0,
    },
  }),
}));

/**
 * A recogniser that asks for its pauses to be trimmed: the declaration a case turns on when it
 * wants the pair of tracks. `destructive` because nothing else can put a second track in the slot —
 * and named as a fixture rather than as any real service, because the only adapter this build
 * registers declares the opposite. That is the point: the pair is reachable by declaration alone,
 * so "who decides" is what these cases can vary.
 */
const TRIMS_PAUSES: PauseCuesDeclaration = {
  provider: 'fixture-recogniser',
  capability: 'destructive',
};

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/* ─── Fakes ────────────────────────────────────────────────────────── */

type MediaRecorderOptions = { mimeType?: string };

/** Chunks the next `start()` will emit through `ondataavailable`. */
let recorderChunks: Blob[] = [];

/** What the clip element's next `play()` resolves to. */
let nextPlayResult: Promise<void> = Promise.resolve();

class FakeMediaRecorder {
  static isTypeSupported = () => true;

  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  private chunks: Blob[] = [];

  constructor(_stream: unknown, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
  }

  start() {
    this.state = 'recording';
    this.chunks = recorderChunks;
  }

  stop() {
    this.state = 'inactive';
    for (const chunk of this.chunks) this.ondataavailable?.({ data: chunk });
    this.onstop?.();
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];

  src = '';
  playCalls = 0;
  pauseCalls = 0;
  /** What `play()` returns; a test swaps `nextPlayResult` to drive the rejection path. */
  playResult: Promise<void> = nextPlayResult;
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  play(): Promise<void> {
    this.playCalls += 1;
    return this.playResult;
  }

  pause() {
    this.pauseCalls += 1;
  }

  dispatch(type: string) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

const fakeStream = { getTracks: () => [{ stop: () => undefined }] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('Audio', FakeAudio);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => fakeStream },
  });
  let counter = 0;
  createObjectURL.mockReset();
  createObjectURL.mockImplementation(() => `blob:clip-${++counter}`);
  revokeObjectURL.mockReset();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) });
  FakeAudio.instances = [];
  recorderChunks = [];
  nextPlayResult = Promise.resolve();
  voiceFlags.trim = false;
  voiceProfile.declaration = null;
  stubbedTrim.outputSec = 1;
  stubbedTrim.fallback = false;
  stubbedTrim.decodable = true;
});

// The two object-URL stubs stay installed between tests on purpose: jsdom does not
// implement them at all, and testing-library's auto-cleanup unmounts the hook *after*
// this file's hooks run — restoring them here would make the unmount cleanup throw.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // The tier is global window state, so a case that pinned it must not leave it pinned for the
  // next one: jsdom's own default (1024, the wide layout) is what a case that says nothing gets.
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
});

/* ─── Hook harness ─────────────────────────────────────────────────── */

type HookProps = { scope: string | null; isActive: boolean };

const renderVoice = () => {
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const view = renderHook(
    ({ scope, isActive }: HookProps) => useVoiceInput(onTranscript, onError, { scope, isActive }),
    { initialProps: { scope: 'session-a', isActive: true } as HookProps },
  );
  return { view, onTranscript, onError };
};

/** Drives one full mic press: start, hold for `heldMs` of wall clock, stop. */
const record = async (
  view: { result: { current: ReturnType<typeof useVoiceInput> } },
  bytes: number,
  heldMs: number,
) => {
  recorderChunks = [new Blob([new Uint8Array(bytes)])];
  await act(async () => {
    view.result.current.toggle();
  });
  act(() => {
    vi.advanceTimersByTime(heldMs);
  });
  await act(async () => {
    view.result.current.stop();
  });
  // `onstop` uploads before it settles; drain that tail so the state is observable.
  await act(async () => {});
};

const lastAudio = () => FakeAudio.instances[FakeAudio.instances.length - 1];

/* ─── Capture ──────────────────────────────────────────────────────── */

test('a finished recording lands in the clip slot', async () => {
  const { view, onTranscript } = renderVoice();
  const beforeRecording = view.result.current.clipSlot;
  assert.equal(beforeRecording, null, 'nothing to replay before a recording');

  await record(view, 2000, 1000);

  const slot = view.result.current.clipSlot;
  assert.ok(slot, 'a recording the mic accepted has to be replayable');
  assert.equal(slot.original.meta.bytes, 2000);
  assert.equal(slot.original.url, 'blob:clip-1');
  assert.equal(slot.trimmed, null, 'the trim is off here, so the recording is all there is to replay');
  assert.equal(onTranscript.mock.calls.length, 1, 'the transcript still reaches the composer');
});

test('a recording below the size floor produces no clip', async () => {
  const { view, onError } = renderVoice();

  await record(view, 100, 1000);

  assert.equal(view.result.current.clipSlot, null, 'a too-short press must not leave a pill behind');
  assert.deepEqual(onError.mock.calls, [['Recording too short']]);
});

test('a failed transcription still leaves the clip replayable', async () => {
  const { view, onError } = renderVoice();
  transcribeVoice.mockResolvedValue({ ok: false, status: 500 });

  await record(view, 2000, 1000);

  assert.ok(
    view.result.current.clipSlot,
    'a transcription that failed is exactly when the user needs to hear what they said',
  );
  assert.equal(onError.mock.calls.length, 1, 'the failure is still reported');
});

test('a second recording evicts the first and revokes its object URL', async () => {
  const { view } = renderVoice();

  await record(view, 2000, 1000);
  await record(view, 3000, 1000);

  assert.equal(view.result.current.clipSlot?.original.url, 'blob:clip-2');
  assert.deepEqual(
    revokeObjectURL.mock.calls,
    [['blob:clip-1']],
    'the evicted clip leaks its blob unless its URL is revoked',
  );
});

test('unmounting revokes the clip object URL', async () => {
  const { view } = renderVoice();

  await record(view, 2000, 1000);
  view.unmount();

  assert.deepEqual(revokeObjectURL.mock.calls, [['blob:clip-1']]);
});

test('starting a new recording stops a clip that is still playing', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);

  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });
  const audio = lastAudio();
  assert.equal(view.result.current.clipPlayState.original, 'playing');

  recorderChunks = [new Blob([new Uint8Array(2000)])];
  await act(async () => {
    view.result.current.toggle();
  });

  assert.ok(audio.pauseCalls > 0, 'the previous clip must not keep sounding under the new recording');
  assert.equal(view.result.current.clipPlayState.original, 'idle');
});

/* ─── Lifecycle ────────────────────────────────────────────────────── */

test('a scope change drops the clip', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  assert.ok(view.result.current.clipSlot);

  await act(async () => {
    view.rerender({ scope: 'session-b', isActive: true });
  });

  assert.equal(
    view.result.current.clipSlot,
    null,
    'the clip describes a chat that is no longer open',
  );
  assert.deepEqual(revokeObjectURL.mock.calls, [['blob:clip-1']]);
});

test('going inactive stops the sound but keeps the clip', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });
  const audio = lastAudio();

  await act(async () => {
    view.rerender({ scope: 'session-a', isActive: false });
  });

  assert.equal(view.result.current.clipPlayState.original, 'idle', 'the pill is off screen; nothing can stop it');
  assert.ok(audio.pauseCalls > 0);
  assert.ok(view.result.current.clipSlot, 'the clip is not dropped — the user is coming back to it');

  await act(async () => {
    view.rerender({ scope: 'session-a', isActive: true });
  });
  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });

  assert.equal(
    view.result.current.clipPlayState.original,
    'playing',
    'a clip kept across the hidden state must still be replayable',
  );
});

/* ─── The uploaded copy, as a second track ─────────────────────────── */

test('the trimmed upload lands beside the recording, as its own track', async () => {
  voiceFlags.trim = true;
  // Both have to say yes: the user's switch above, and the recogniser's own declaration here.
  voiceProfile.declaration = TRIMS_PAUSES;
  const { view } = renderVoice();

  // A press longer than the trimmed audio the stub reports, so "the shorter one" is a comparison
  // this run can actually make rather than two numbers that happen to agree.
  await record(view, 2000, 3000);

  const slot = view.result.current.clipSlot;
  assert.ok(slot?.trimmed, 'a capture that was trimmed has two things to replay, not one');
  assert.notEqual(slot.trimmed.url, slot.original.url, 'the two controls must not point at the same audio');
  assert.equal(slot.trimmed.meta.mimeType, 'audio/wav', 'the upload is the re-encode, not the recording');
  assert.equal(slot.trimmed.meta.bytes, 32_000, 'its size is the encoded body the chain built');
  // The trimmed length is the trim's own reading of what it produced — not the press's wall clock,
  // which measures the recording and is the only duration the original track has.
  assert.equal(slot.trimmed.meta.durationMs, 1000);
  assert.ok(
    slot.trimmed.meta.durationMs < slot.original.meta.durationMs,
    `the trimmed track has to be the shorter one (trimmed ${slot.trimmed.meta.durationMs}ms, original ${slot.original.meta.durationMs}ms)`,
  );
});

test('a recogniser that asks for nothing keeps the recording: the switch alone authorises nothing', async () => {
  // Everything the trim needs is in place — the switch is on and the decoder works — except a
  // recogniser saying its pauses are worth removing, which is the state the shipping build records
  // in: nothing has published a voice profile, and the one adapter it registers keeps its pauses.
  // Both halves are required, so the switch being on has to be readable as *not* enough.
  voiceFlags.trim = true;
  const { view } = renderVoice();

  await record(view, 2000, 3000);

  const slot = view.result.current.clipSlot;
  assert.ok(slot, 'the recording is still replayable');
  assert.equal(
    slot.trimmed,
    null,
    'the trim ran with no recogniser asking for it, so the switch was read as the decision',
  );
  assert.equal(slot.original.meta.bytes, 2000, 'and what is replayable is the recording itself');
});

test('a capture that was uploaded untrimmed gets one track, not a second copy of the first', async () => {
  voiceFlags.trim = true;
  // Both have to say yes: the user's switch above, and the recogniser's own declaration here.
  voiceProfile.declaration = TRIMS_PAUSES;
  stubbedTrim.fallback = true;
  const { view } = renderVoice();

  await record(view, 2000, 1000);

  const slot = view.result.current.clipSlot;
  assert.ok(slot, 'the recording is still replayable');
  assert.equal(
    slot.trimmed,
    null,
    'a trim that refused to cut anything leaves no trimmed audio, and inventing one would claim a trim that never happened',
  );
});

test('the two tracks never sound at once', async () => {
  voiceFlags.trim = true;
  // Both have to say yes: the user's switch above, and the recogniser's own declaration here.
  voiceProfile.declaration = TRIMS_PAUSES;
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  assert.ok(view.result.current.clipSlot?.trimmed, 'this test is about the pair');

  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });
  // Each track gets its element on first use, so the one just started is the newest.
  const originalAudio = lastAudio();
  assert.ok(originalAudio, 'starting a track puts an element behind it');
  assert.equal(view.result.current.clipPlayState.original, 'playing');

  await act(async () => {
    view.result.current.toggleClipPlayback('trimmed');
  });

  const trimmedAudio = lastAudio();
  assert.notEqual(
    trimmedAudio,
    originalAudio,
    'the trimmed track sounds through an element of its own, not the recording’s',
  );
  assert.equal(view.result.current.clipPlayState.trimmed, 'playing', 'the second track starts');
  assert.equal(
    view.result.current.clipPlayState.original,
    'idle',
    'and the first one stops — two speakers is what the pair exists to avoid',
  );
  assert.ok(originalAudio.pauseCalls > 0, 'stopping the first track is not just a state change');
  assert.equal(trimmedAudio.pauseCalls, 0, 'the track that is sounding was not paused by its own start');
});

/* ─── Read-aloud is mutually exclusive ─────────────────────────────── */

test('playing a clip stops read-aloud first', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  const stopReadAloud = vi.spyOn(voicePlayer, 'stop');

  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });

  assert.equal(stopReadAloud.mock.calls.length, 1, 'two audio sources at once is noise');
});

test('read-aloud taking over pauses the clip', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });
  const audio = lastAudio();
  const pausesBefore = audio.pauseCalls;
  // `stop()` is the observable way to make the singleton announce its state.
  vi.spyOn(voicePlayer, 'isBusy').mockReturnValue(true);

  await act(async () => {
    voicePlayer.stop();
  });

  assert.ok(audio.pauseCalls > pausesBefore, 'the clip has to yield the speakers');
  assert.equal(view.result.current.clipPlayState.original, 'idle');
});

/* ─── Failure path ─────────────────────────────────────────────────── */

test('a rejected play() returns the pill to idle and reports the error once', async () => {
  const { view, onError } = renderVoice();
  await record(view, 2000, 1000);
  // Deferred, so the loading state is observable before the rejection lands.
  let rejectPlay: (reason: unknown) => void = () => undefined;
  nextPlayResult = new Promise<void>((_resolve, reject) => {
    rejectPlay = reject;
  });

  act(() => {
    view.result.current.toggleClipPlayback('original');
  });
  assert.equal(view.result.current.clipPlayState.original, 'loading', 'the control shows it is working');

  await act(async () => {
    rejectPlay(new DOMException('Playback blocked', 'NotAllowedError'));
  });

  assert.equal(
    view.result.current.clipPlayState.original,
    'idle',
    'a rejected play() must not strand the pill in loading',
  );
  assert.equal(onError.mock.calls.length, 1, 'the user is told once, through the existing bubble');
  assert.match(String(onError.mock.calls[0]?.[0]), /Playback blocked/);
});

/* ─── Duration reading ─────────────────────────────────────────────── */

test('the clip reports the wall-clock time the mic was held', async () => {
  const { view } = renderVoice();

  // Two holds of different lengths, so a constant (or a container duration read once)
  // cannot satisfy both readings.
  const readings: Array<{ held: number; measured: number }> = [];
  for (const held of [3000, 7000]) {
    await record(view, 2000, held);
    const measured = view.result.current.clipSlot?.original.meta.durationMs ?? -1;
    readings.push({ held, measured });
    assert.ok(
      Math.abs(measured - held) <= held * 0.2,
      `expected ~${held}ms of wall clock, measured ${measured}ms (readings: ${JSON.stringify(readings)})`,
    );
  }
});

/* ─── Render face ──────────────────────────────────────────────────── */

/**
 * The tier the composer reads, as it reads it: `window.innerWidth` against `md` (768), taken by
 * `useDeviceSettings` in a state initialiser. A component that switched on some other signal would
 * render the other tier here and these cases would fail rather than pass against a second copy of
 * the rule. Set before the render, for the same reason the hook takes it before the render.
 */
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

/** The narrow tier (any width below `md`), and the wide one the composer has always had. */
const MOBILE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;

/** The composer's own slots, so a case reads the structure the CSS then lays out. */
const CLIP_ROW_SELECTOR = '[data-slot="prompt-input-clip-row"]';
const FOOTER_SELECTOR = '[data-slot="prompt-input-footer"]';
const TOOLS_SELECTOR = '[data-slot="prompt-input-tools"]';
const TEXTAREA_SELECTOR = '[data-slot="prompt-input-textarea"]';

/** Where the replay controls really are, for a failure message that can be acted on. */
const describePlacement = (root: HTMLElement, control: HTMLElement | null) => {
  if (!control) return 'no replay control rendered';
  const slots: string[] = [];
  for (let node = control.parentElement; node && node !== root; node = node.parentElement) {
    const slot = node.getAttribute('data-slot');
    if (slot) slots.push(slot);
  }
  return slots.length > 0 ? slots.join(' < ') : 'in no labelled slot';
};

const renderComposer = (onVoiceTranscript: (text: string, send?: boolean) => void) =>
  render(
    React.createElement(ChatComposer, {
      pendingPermissionRequests: [],
      handlePermissionDecision: () => undefined,
      handleGrantToolPermission: () => ({ success: true }),
      activity: null,
      isLoading: false,
      onAbortSession: () => undefined,
      permissionMode: 'default',
      availablePermissionModes: ['default'],
      onSelectPermissionMode: () => undefined,
      providerLabel: 'Claude',
      effort: 'medium',
      availableEffortOptions: [],
      onSelectEffort: () => undefined,
      model: 'test-model',
      availableModelOptions: [],
      onSelectModel: () => undefined,
      modelsLoading: false,
      tokenBudget: null,
      onShowTokenUsage: () => undefined,
      slashCommandsCount: 0,
      onToggleCommandMenu: () => undefined,
      hasInput: false,
      onClearInput: () => undefined,
      onSubmit: () => undefined,
      isDragActive: false,
      queuedDraft: null,
      isEditingSentMessage: false,
      onCancelEditMessage: () => undefined,
      scheduledMessages: [],
      onScheduleMessage: () => undefined,
      onCancelScheduledMessage: () => undefined,
      onEditQueuedDraft: () => undefined,
      onDeleteQueuedDraft: () => undefined,
      attachedFiles: [],
      onRemoveAttachment: () => undefined,
      fileErrors: new Map<string, string>(),
      showFileDropdown: false,
      filteredFiles: [],
      selectedFileIndex: 0,
      onSelectFile: () => undefined,
      filteredCommands: [],
      selectedCommandIndex: 0,
      onCommandSelect: () => undefined,
      onCloseCommandMenu: () => undefined,
      isCommandMenuOpen: false,
      frequentCommands: [],
      getRootProps: () => ({}),
      getInputProps: () => ({}),
      openAttachmentPicker: () => undefined,
      inputHighlightRef: { current: null },
      renderInputWithMentions: () => null,
      textareaRef: { current: null },
      input: '',
      onVoiceTranscript,
      scope: 'session-a',
      isActive: true,
      onInputChange: () => undefined,
      onTextareaClick: () => undefined,
      onTextareaKeyDown: () => undefined,
      onTextareaPaste: () => undefined,
      onTextareaScrollSync: () => undefined,
      onTextareaInput: () => undefined,
      placeholder: 'Ask anything',
      isTextareaExpanded: false,
    } as unknown as React.ComponentProps<typeof ChatComposer>),
  );

/** Records one press through the composer's own buttons — the path a user takes, not the hook's API. */
const recordThroughComposer = async (view: ReturnType<typeof render>) => {
  recorderChunks = [new Blob([new Uint8Array(2000)])];
  await act(async () => {
    view.getByRole('button', { name: 'Voice input' }).click();
  });
  await act(async () => {
    view.getByRole('button', { name: 'Stop recording' }).click();
  });
  await act(async () => {});
};

/** Turns the trim on for the pair of tracks: the switch above, and the recogniser's own declaration. */
const withTrimmedPair = () => {
  voiceFlags.trim = true;
  voiceProfile.declaration = TRIMS_PAUSES;
};

/*
 * The replay pair's two homes. Below `md` it has a row of its own between the box and the footer —
 * the narrow footer is exactly the six controls that send a message and may not wrap, so the pair
 * cannot live there; from `md` up it stays in the left tool group where it has always been. The
 * cases below read each tier's placement out of the DOM the composer built, including the order the
 * slots appear in, because that order is the whole of "the row is between the box and the footer".
 */

test('(a) mobile: the pair lands in its own row between the box and the footer, one control per track', async () => {
  withTrimmedPair();
  setViewportWidth(MOBILE_WIDTH);
  const view = renderComposer(() => undefined);
  const { container, getByRole } = view;

  await recordThroughComposer(view);

  const row = container.querySelector<HTMLElement>(CLIP_ROW_SELECTOR);
  assert.ok(
    row,
    `a recording at ${MOBILE_WIDTH}px must give the replay pair a row of its own; the controls read: ${describePlacement(container, container.querySelector('button[aria-label="Replay original"]'))}`,
  );
  const textarea = container.querySelector<HTMLElement>(TEXTAREA_SELECTOR);
  const footer = container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  assert.ok(textarea && footer, 'the composer must render its box and its footer');
  assert.ok(
    textarea.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the clip row has to come after the textarea',
  );
  assert.ok(
    row.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the clip row has to come before the footer',
  );
  assert.equal(
    footer.contains(row),
    false,
    'the clip row is the footer\'s replacement for a wrapped row, not a row inside it',
  );

  const replayOriginal = getByRole('button', { name: 'Replay original' });
  const replayTrimmed = getByRole('button', { name: 'Replay trimmed' });
  assert.ok(
    row.contains(replayOriginal) && row.contains(replayTrimmed),
    `both controls belong to the clip row; they read: ${describePlacement(container, replayOriginal)}`,
  );
  assert.notEqual(
    replayOriginal.getAttribute('data-clip-url'),
    replayTrimmed.getAttribute('data-clip-url'),
    'the two controls have to be over two different audio sources',
  );

  // Clickable, and the whole point of the pair: pressing one offers to stop *that* audio.
  await act(async () => {
    replayOriginal.click();
  });
  assert.ok(
    getByRole('button', { name: 'Stop original playback' }),
    'while the clip sounds the control has to announce that pressing it stops',
  );
});

test('(b) desktop: the pair stays in the left tool group inside the footer, right of the mic', async () => {
  withTrimmedPair();
  setViewportWidth(DESKTOP_WIDTH);
  const view = renderComposer(() => undefined);
  const { container, getByRole } = view;

  await recordThroughComposer(view);

  assert.equal(
    container.querySelector(CLIP_ROW_SELECTOR),
    null,
    'the clip row is the narrow layout\'s; the wide layout keeps the controls where they were',
  );

  const tools = container.querySelector<HTMLElement>(TOOLS_SELECTOR);
  const footer = container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  assert.ok(tools && footer, 'the composer must render its tool group and its footer');

  const replayOriginal = getByRole('button', { name: 'Replay original' });
  const replayTrimmed = getByRole('button', { name: 'Replay trimmed' });
  assert.ok(
    footer.contains(replayOriginal) && footer.contains(replayTrimmed),
    `the wide layout keeps the pair in the footer; they read: ${describePlacement(container, replayOriginal)}`,
  );
  assert.ok(
    tools.contains(replayOriginal) && tools.contains(replayTrimmed),
    `and in the left tool group, not the right-hand cluster; they read: ${describePlacement(container, replayOriginal)}`,
  );

  const mic = getByRole('button', { name: 'Voice input' });
  assert.ok(
    mic.compareDocumentPosition(replayOriginal) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the pair sits right of the microphone it was recorded from',
  );
});

test('(c) mobile: with nothing recorded the clip row does not exist at all, not empty', () => {
  withTrimmedPair();
  setViewportWidth(MOBILE_WIDTH);
  const view = renderComposer(() => undefined);
  const { container, queryByRole } = view;

  assert.equal(
    queryByRole('button', { name: 'Replay original' }),
    null,
    'a composer with nothing recorded must not show a replay control',
  );
  assert.equal(
    container.querySelector(CLIP_ROW_SELECTOR),
    null,
    'the row is conditional on the clip, so its container must be absent rather than rendered empty',
  );
  // The positive control: the box and footer are really there, so the two absences above are the
  // clip's doing rather than a composer that never painted.
  assert.ok(container.querySelector(TEXTAREA_SELECTOR), 'the composer must have rendered its box');
  assert.ok(container.querySelector(FOOTER_SELECTOR), 'the composer must have rendered its footer');
});

test('(d) one track at a time: starting the trimmed replay stops the original, and the names follow', async () => {
  withTrimmedPair();
  setViewportWidth(MOBILE_WIDTH);
  const view = renderComposer(() => undefined);
  const { queryByRole, getByRole } = view;

  await recordThroughComposer(view);

  await act(async () => {
    getByRole('button', { name: 'Replay original' }).click();
  });
  assert.equal(
    queryByRole('button', { name: 'Replay original' }),
    null,
    'the two states must be distinguishable by name alone',
  );
  assert.ok(
    getByRole('button', { name: 'Replay trimmed' }),
    'and the other track is untouched: it never sounded, so it still offers to',
  );

  await act(async () => {
    getByRole('button', { name: 'Replay trimmed' }).click();
  });

  assert.ok(getByRole('button', { name: 'Stop trimmed playback' }), 'the second track takes the speakers');
  assert.ok(
    getByRole('button', { name: 'Replay original' }),
    'and the first one is back to offering to play: one track at a time',
  );
});

test('a capture that was uploaded as recorded gets one control, not two over the same audio', async () => {
  withTrimmedPair();
  stubbedTrim.decodable = false;
  setViewportWidth(MOBILE_WIDTH);
  const view = renderComposer(() => undefined);
  const { queryByRole, getByRole } = view;

  await recordThroughComposer(view);

  assert.ok(getByRole('button', { name: 'Replay original' }), 'the recording is still replayable');
  assert.equal(
    queryByRole('button', { name: 'Replay trimmed' }),
    null,
    'nothing was trimmed, so a trimmed control would be pointing at the recording and claiming otherwise',
  );
});
