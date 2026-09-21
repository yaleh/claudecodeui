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
 * The composer keeps the last recording as a single slot so it can be replayed.
 *
 * Everything the recording path touches is faked below — `MediaRecorder`,
 * `getUserMedia`, the clip's `Audio` element and the two `URL` object-URL calls —
 * because jsdom has none of them and because the point is the *policy*: when a clip
 * is captured, when it is dropped, and what the pill over it says.
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
  const beforeRecording = view.result.current.voiceClip;
  assert.equal(beforeRecording, null, 'nothing to replay before a recording');

  await record(view, 2000, 1000);

  const clip = view.result.current.voiceClip;
  assert.ok(clip, 'a recording the mic accepted has to be replayable');
  assert.equal(clip.meta.bytes, 2000);
  assert.equal(clip.url, 'blob:clip-1');
  assert.equal(onTranscript.mock.calls.length, 1, 'the transcript still reaches the composer');
});

test('a recording below the size floor produces no clip', async () => {
  const { view, onError } = renderVoice();

  await record(view, 100, 1000);

  assert.equal(view.result.current.voiceClip, null, 'a too-short press must not leave a pill behind');
  assert.deepEqual(onError.mock.calls, [['Recording too short']]);
});

test('a failed transcription still leaves the clip replayable', async () => {
  const { view, onError } = renderVoice();
  transcribeVoice.mockResolvedValue({ ok: false, status: 500 });

  await record(view, 2000, 1000);

  assert.ok(
    view.result.current.voiceClip,
    'a transcription that failed is exactly when the user needs to hear what they said',
  );
  assert.equal(onError.mock.calls.length, 1, 'the failure is still reported');
});

test('a second recording evicts the first and revokes its object URL', async () => {
  const { view } = renderVoice();

  await record(view, 2000, 1000);
  await record(view, 3000, 1000);

  assert.equal(view.result.current.voiceClip?.url, 'blob:clip-2');
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
    view.result.current.toggleClipPlayback();
  });
  const audio = lastAudio();
  assert.equal(view.result.current.clipState, 'playing');

  recorderChunks = [new Blob([new Uint8Array(2000)])];
  await act(async () => {
    view.result.current.toggle();
  });

  assert.ok(audio.pauseCalls > 0, 'the previous clip must not keep sounding under the new recording');
  assert.equal(view.result.current.clipState, 'idle');
});

/* ─── Lifecycle ────────────────────────────────────────────────────── */

test('a scope change drops the clip', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  assert.ok(view.result.current.voiceClip);

  await act(async () => {
    view.rerender({ scope: 'session-b', isActive: true });
  });

  assert.equal(
    view.result.current.voiceClip,
    null,
    'the clip describes a chat that is no longer open',
  );
  assert.deepEqual(revokeObjectURL.mock.calls, [['blob:clip-1']]);
});

test('going inactive stops the sound but keeps the clip', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  await act(async () => {
    view.result.current.toggleClipPlayback();
  });
  const audio = lastAudio();

  await act(async () => {
    view.rerender({ scope: 'session-a', isActive: false });
  });

  assert.equal(view.result.current.clipState, 'idle', 'the pill is off screen; nothing can stop it');
  assert.ok(audio.pauseCalls > 0);
  assert.ok(view.result.current.voiceClip, 'the clip is not dropped — the user is coming back to it');

  await act(async () => {
    view.rerender({ scope: 'session-a', isActive: true });
  });
  await act(async () => {
    view.result.current.toggleClipPlayback();
  });

  assert.equal(
    view.result.current.clipState,
    'playing',
    'a clip kept across the hidden state must still be replayable',
  );
});

/* ─── Read-aloud is mutually exclusive ─────────────────────────────── */

test('playing a clip stops read-aloud first', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  const stopReadAloud = vi.spyOn(voicePlayer, 'stop');

  await act(async () => {
    view.result.current.toggleClipPlayback();
  });

  assert.equal(stopReadAloud.mock.calls.length, 1, 'two audio sources at once is noise');
});

test('read-aloud taking over pauses the clip', async () => {
  const { view } = renderVoice();
  await record(view, 2000, 1000);
  await act(async () => {
    view.result.current.toggleClipPlayback();
  });
  const audio = lastAudio();
  const pausesBefore = audio.pauseCalls;
  // `stop()` is the observable way to make the singleton announce its state.
  vi.spyOn(voicePlayer, 'isBusy').mockReturnValue(true);

  await act(async () => {
    voicePlayer.stop();
  });

  assert.ok(audio.pauseCalls > pausesBefore, 'the clip has to yield the speakers');
  assert.equal(view.result.current.clipState, 'idle');
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
    view.result.current.toggleClipPlayback();
  });
  assert.equal(view.result.current.clipState, 'loading', 'the control shows it is working');

  await act(async () => {
    rejectPlay(new DOMException('Playback blocked', 'NotAllowedError'));
  });

  assert.equal(
    view.result.current.clipState,
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
    const measured = view.result.current.voiceClip?.meta.durationMs ?? -1;
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

test('the replay control exists only while a clip does, and renames itself while playing', async () => {
  const view = renderComposer(() => undefined);
  const { queryByRole, getByRole } = view;

  assert.equal(
    queryByRole('button', { name: 'Play recording' }),
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

  const play = getByRole('button', { name: 'Play recording' });
  assert.ok(play, 'a recording puts a replay control in the composer tool row');

  await act(async () => {
    play.click();
  });

  assert.ok(
    getByRole('button', { name: 'Stop playback' }),
    'while the clip sounds the control has to announce that pressing it stops',
  );
  assert.equal(
    queryByRole('button', { name: 'Play recording' }),
    null,
    'the two states must be distinguishable by name alone',
  );
});
