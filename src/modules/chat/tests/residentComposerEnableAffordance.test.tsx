import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import type { LLMProvider, SessionHostsSnapshot } from '@/shared/types';

/**
 * The composer's resident switch — and the disclosure under it — is rendered only while the session
 * it writes into is *not* already resident.
 *
 * jsdom parses no Tailwind and renders no real host listing, but the decision this criterion is about
 * is a structural one: given a session's stored `lifecycleMode`, does the switch's `<button>` exist in
 * the tree at all? That is exactly what the component computes from `findSessionHostState(...)`, so a
 * component that read the mode some other way fails these cases rather than passing against a second
 * copy of the rule. What the real `GET /api/session-hosts` answers, and what a real browser lays out,
 * is the e2e probe's job (`e2e/resident-ui-layout.spec.ts`), not a unit test's.
 *
 * The two cases are each other's control. The resident case asserts an *absence*, and an absence is
 * only evidence when the same reading finds the thing present somewhere: the per-run case is that leg.
 * Reverting the render gate to its old `canRunResident` (mode ignored) reds the resident case;
 * dropping the switch entirely reds the per-run case. Either way the file is not a constant.
 *
 * The reading is deliberately structural — `[data-resident-enable="true"]` and the disclosure's own
 * `[data-slot="resident-consent-notice"]` — and never the `resident.toggle` / `resident.notice.*` i18n
 * keys: a duplicate top-level `resident` key in the shipped locale files shadows those to `undefined`
 * today, so a reader keyed on the copy would be reading a variable that is presently empty.
 */

const SESSION_ID = 'session-under-test';

/** The marker the composer publishes on the switch, and the slot the disclosure declares. */
const ENABLE = '[data-resident-enable="true"]';
const NOTICE = '[data-slot="resident-consent-notice"]';
const CHECKBOX = '.chat-composer-shell input[type="checkbox"]';

/**
 * The host snapshot the composer reads, held mutable so each case can state the session's stored mode.
 *
 * `useSessionHosts` is the one seam doubled here: in jsdom there is no server to answer
 * `GET /api/session-hosts`, and the criterion is about what the component does with the answer, not
 * about how the answer is fetched. The real `findSessionHostState` is left in place, so the lookup the
 * component performs is the shipping one.
 */
const { hostFixture } = vi.hoisted(() => ({
  hostFixture: { snapshot: null as SessionHostsSnapshot | null },
}));

vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot: hostFixture.snapshot,
      error: null,
      loading: false,
      refresh: async () => undefined,
      start: async () => undefined,
      close: async () => undefined,
    }),
  };
});

// `claude` is the shipping resident-capable provider, so `canRunResident` is true and the only thing
// that can keep the switch off the screen is the session's own stored mode.
vi.mock('@/shared/hooks/useProviderCapabilities', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useResidentProviders: () => new Set<LLMProvider>(['claude']) };
});

vi.mock('@/shared/selectedProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readSelectedProvider: () => 'claude' as const };
});

// The voice chain is not what this criterion is about; a plain install keeps the mic button the
// composer always draws from reaching for a recorder, a debug entry or a trim switch it has no reason
// to have. Same doubles as `chatComposerResponsive.test.tsx`.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default: keeps this whole-module replacement complete.
  isVoiceVadEnabled: () => true,
}));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    toggle: () => undefined,
    stop: () => undefined,
    transcribeFile: () => undefined,
    clipSlot: null,
    clipPlayState: { original: 'idle', trimmed: 'idle' },
    toggleClipPlayback: () => undefined,
  }),
}));

/** A snapshot naming exactly one session and its stored mode — everything `findSessionHostState` reads. */
const snapshotWith = (sessionId: string, lifecycleMode: string): SessionHostsSnapshot => ({
  hosts: [],
  sessions: [{ appSessionId: sessionId, provider: 'claude', lifecycleMode, running: false, reason: null }],
});

/** jsdom implements no media queries at all; the composer's device rules must still find an answer. */
const installMatchMedia = () => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
};

/**
 * The composer's props, only as far as a render with no turn, no attachments and no menus needs them.
 *
 * Taken from `chatComposerResponsive.test.tsx`, whose scaffold this file shares: every prop the
 * composer destructures without a default has to be present, and this is the known-good set.
 */
const baseProps = () => ({
  sessionId: SESSION_ID,
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
  availableEffortOptions: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
  onSelectEffort: () => undefined,
  model: 'claude-sonnet-4-5-20250929',
  availableModelOptions: [{ value: 'claude-sonnet-4-5-20250929', label: 'claude-sonnet-4-5-20250929' }],
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
  onVoiceTranscript: () => undefined,
  scope: SESSION_ID,
  projectId: null,
  isActive: true,
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Ask anything',
  isTextareaExpanded: false,
});

/** Renders the real composer against the fixture snapshot and reports the three markers it publishes. */
const renderComposer = () => {
  installMatchMedia();
  const view = render(
    React.createElement(ChatComposer, baseProps() as unknown as React.ComponentProps<typeof ChatComposer>),
  );
  assert.ok(
    view.container.querySelector('.chat-composer-shell'),
    'the composer must render its shell, or the counts below are readings of nothing',
  );
  return {
    switches: view.container.querySelectorAll(ENABLE).length,
    notices: view.container.querySelectorAll(NOTICE).length,
    checkboxes: view.container.querySelectorAll(CHECKBOX).length,
  };
};

afterEach(() => {
  hostFixture.snapshot = null;
  document.body.innerHTML = '';
});

test('a session already stored resident renders no switch and no disclosure', () => {
  hostFixture.snapshot = snapshotWith(SESSION_ID, 'resident');
  const reading = renderComposer();
  assert.equal(
    reading.switches,
    0,
    'the switch is how a session becomes resident; on a resident session there is nothing to turn on, '
      + 'so it — and the disclosure inside it — must be absent from the input area',
  );
  assert.equal(reading.notices, 0, 'the disclosure lives inside the switch and goes with it');
  assert.equal(reading.checkboxes, 0, 'and its tick box with it');
});

test('a per-run session renders the switch — the control that makes the absence above a reading', () => {
  hostFixture.snapshot = snapshotWith(SESSION_ID, 'per-run');
  const reading = renderComposer();
  assert.equal(
    reading.switches,
    1,
    'a per-run session on a resident-capable provider is exactly the session the switch is for; if this '
      + 'leg went to 0 the case above would be proving only that the composer never draws it',
  );
});
