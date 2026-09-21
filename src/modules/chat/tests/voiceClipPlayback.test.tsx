import assert from 'node:assert/strict';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { voicePlayer } from '@/modules/chat/utils/voicePlayer';
import enChat from '@/modules/i18n/locales/en/chat.json';

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

vi.mock('@/shared/api', () => ({
  transcribeVoice,
  synthesizeVoice: vi.fn(),
  voiceConfigSignature: () => 'test-signature',
}));

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

vi.mock('@/shared/voiceTrim', () => ({
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

test('a capture that was uploaded untrimmed gets one track, not a second copy of the first', async () => {
  voiceFlags.trim = true;
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

test('the replay controls exist only while a clip does, one per track, and rename themselves while playing', async () => {
  voiceFlags.trim = true;
  const view = renderComposer(() => undefined);
  const { queryByRole, getByRole } = view;

  assert.equal(
    queryByRole('button', { name: 'Replay original' }),
    null,
    'a composer with nothing recorded must not show a replay control',
  );

  recorderChunks = [new Blob([new Uint8Array(2000)])];
  await act(async () => {
    getByRole('button', { name: 'Voice input' }).click();
  });
  await act(async () => {
    getByRole('button', { name: 'Stop recording' }).click();
  });
  await act(async () => {});

  const replayOriginal = getByRole('button', { name: 'Replay original' });
  assert.ok(replayOriginal, 'a recording puts a replay control in the composer tool row');
  const replayTrimmed = getByRole('button', { name: 'Replay trimmed' });
  assert.ok(replayTrimmed, 'the uploaded copy is a second control beside the recording, not a second state of the first');
  assert.notEqual(
    replayOriginal.getAttribute('data-clip-url'),
    replayTrimmed.getAttribute('data-clip-url'),
    'the two controls have to be over two different audio sources',
  );

  await act(async () => {
    replayOriginal.click();
  });

  assert.ok(
    getByRole('button', { name: 'Stop original playback' }),
    'while the clip sounds the control has to announce that pressing it stops',
  );
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
  voiceFlags.trim = true;
  stubbedTrim.decodable = false;
  const view = renderComposer(() => undefined);
  const { queryByRole, getByRole } = view;

  recorderChunks = [new Blob([new Uint8Array(2000)])];
  await act(async () => {
    getByRole('button', { name: 'Voice input' }).click();
  });
  await act(async () => {
    getByRole('button', { name: 'Stop recording' }).click();
  });
  await act(async () => {});

  assert.ok(getByRole('button', { name: 'Replay original' }), 'the recording is still replayable');
  assert.equal(
    queryByRole('button', { name: 'Replay trimmed' }),
    null,
    'nothing was trimmed, so a trimmed control would be pointing at the recording and claiming otherwise',
  );
});
