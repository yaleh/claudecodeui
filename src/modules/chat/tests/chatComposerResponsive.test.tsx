import assert from 'node:assert/strict';

import { fireEvent, render, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { VoiceClipSlot } from '@/shared/types';

/**
 * On a phone the composer's footer wrapped onto a second row, because it carried
 * seven controls including the commands, schedule and token ones. The fix keeps the
 * primary row to the six controls that send a message and moves the other three
 * behind a single "more" entry on the narrow layout — while the wide layout keeps
 * showing them inline, unchanged.
 *
 * jsdom parses no Tailwind, so nothing here can read a `flex-nowrap` class or a
 * breakpoint. What it can hold is the *structure* the CSS then lays out: which
 * controls exist in which tier at all. The tier is switched by the signal the
 * component itself reads — `window.innerWidth` against the `md` boundary — so a
 * component that switched on some other signal would take the same branch here and
 * these cases would fail rather than pass against a second copy of the rule. That
 * the real box really measures `scrollWidth === clientWidth` on a phone is the e2e
 * probe's job, not a unit test's.
 */

/**
 * The model label the narrow row has to fit beside the send button. A short name
 * would let a row that does not truncate anything pass; the shipping catalog's
 * entries are this long, so the cases below are read against the real shape.
 */
const LONG_MODEL_NAME = 'claude-sonnet-4-5-20250929';

const MOBILE_WIDTH = 390;
/** One pixel under the `md` boundary, where the narrow layout must still apply. */
const NARROW_EDGE_WIDTH = 767;
const DESKTOP_WIDTH = 1280;

// The real hook asks the backend whether a voice provider is configured; the mic
// button is one of the six the narrow row must keep, so it has to be offered here.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

// A plain install: no debug upload entry (an extra control) and no trim switch.
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
}));

/**
 * The clip the composer is holding, as the replay-count case below wants it.
 *
 * The voice hook is doubled because the capture chain is not what that case is about — the number of
 * accessible replay controls the composer renders is — and driving a real recording would mean
 * stubbing `MediaRecorder`, the clip's `Audio` elements and the object-URL calls in a file whose
 * subject is the breakpoint. Every other case wants a composer with nothing recorded, which is what
 * the slot's `null` default gives them, so their rendering is unchanged.
 */
const { clipFixture } = vi.hoisted(() => ({
  clipFixture: { slot: null as VoiceClipSlot | null },
}));

vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    toggle: () => undefined,
    stop: () => undefined,
    transcribeFile: () => undefined,
    clipSlot: clipFixture.slot,
    clipPlayState: { original: 'idle', trimmed: 'idle' },
    toggleClipPlayback: () => undefined,
  }),
}));

/** The pair a trimmed capture leaves in the slot: the recording, and the upload made of it. */
const CLIP_PAIR: VoiceClipSlot = {
  original: {
    url: 'blob:responsive-original',
    meta: { bytes: 6_400, mimeType: 'audio/webm', durationMs: 9_000 },
  },
  trimmed: {
    url: 'blob:responsive-trimmed',
    meta: { bytes: 32_000, mimeType: 'audio/wav', durationMs: 4_000 },
  },
};

beforeEach(() => {
  clipFixture.slot = null;
});

/**
 * jsdom implements no media queries at all. The double answers "no" to every query,
 * which is a keyboard device: the composer then prints its hint row, as it does in a
 * desktop browser — the row that a touch device hides. That keeps the hint out of the
 * way of the narrow-layout cases below only by width, exactly as it is in a browser.
 */
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
};

/** The signal the composer itself reads (`useDeviceSettings`), so a renamed source of truth fails the cases below. */
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const FOOTER_SELECTOR = '[data-slot="prompt-input-footer"]';
/** Every open overlay the composer can put on screen; two at once is the nesting bug. */
const openOverlays = () => Array.from(document.querySelectorAll('[role="menu"],[role="dialog"]'));

/** The names the six primary controls carry in the narrow layout, read from the shipping locale. */
const PRIMARY_NAMES = [
  enChat.input.attachFiles,
  enChat.voice.input,
  enChat.input.moreTools,
  enChat.composer.modelMenu,
  enChat.composer.permissionHeading.replace('{{provider}}', 'Claude'),
  enChat.input.send,
];

const baseProps = () => ({
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
  // A real provider offers both, and the model button only exists when one does —
  // which is the arrangement the narrow row has to survive, not the empty one.
  availableEffortOptions: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
  onSelectEffort: () => undefined,
  model: LONG_MODEL_NAME,
  availableModelOptions: [{ value: LONG_MODEL_NAME, label: LONG_MODEL_NAME }],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: vi.fn(),
  slashCommandsCount: 0,
  onToggleCommandMenu: vi.fn(),
  hasInput: false,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDraft: null,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: vi.fn(),
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
  scope: 'session-a',
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

type ComposerOverrides = Partial<ReturnType<typeof baseProps>>;

const renderComposer = (width: number, overrides: ComposerOverrides = {}) => {
  injectMatchMediaOnce();
  setViewportWidth(width);
  const props = { ...baseProps(), ...overrides } as React.ComponentProps<typeof ChatComposer>;
  const view = render(React.createElement(ChatComposer, props));
  const footer = view.container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  assert.ok(footer, `the composer must render a footer (${FOOTER_SELECTOR})`);
  return { view, footer, props };
};

/**
 * A real media query for the hint row's device rule, and nothing else — it answers
 * "no" to every query, so the composer behaves as it does on a keyboard device.
 */
let matchMediaInstalled = false;
const injectMatchMediaOnce = () => {
  if (matchMediaInstalled) return;
  installMatchMedia();
  matchMediaInstalled = true;
};

/** Every interactive control inside the footer, named for a failure message that can be acted on. */
const describeFooterControls = (footer: Element) =>
  Array.from(footer.querySelectorAll('button'))
    .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '<unnamed>')
    .join(' | ');

const openMoreMenu = (view: ReturnType<typeof render>) => {
  fireEvent.click(view.getByRole('button', { name: enChat.input.moreTools }));
  return view.getByRole('menu');
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

test('(a) the narrow footer holds exactly the six primary controls, and none of the three that moved', () => {
  const { footer } = renderComposer(MOBILE_WIDTH);
  const controls = Array.from(footer.querySelectorAll('button'));

  assert.equal(
    controls.length,
    PRIMARY_NAMES.length,
    `the narrow footer must hold ${PRIMARY_NAMES.length} controls; it holds ${controls.length}: ${describeFooterControls(footer)}`,
  );

  const found: string[] = [];
  for (const name of PRIMARY_NAMES) {
    const control = within(footer).queryByRole('button', { name });
    found.push(control ? name : `MISSING(${name})`);
  }
  assert.deepEqual(found, PRIMARY_NAMES, `narrow footer controls read: ${describeFooterControls(footer)}`);

  for (const moved of [enChat.input.showAllCommands, enChat.schedule.trigger, enChat.misc.showTokenUsage]) {
    assert.equal(
      within(footer).queryByRole('button', { name: moved }),
      null,
      `"${moved}" must not stay in the narrow footer; controls read: ${describeFooterControls(footer)}`,
    );
  }
});

test('(a) the tier boundary is md: 767px is still the narrow layout, and 768px is not', () => {
  const narrow = renderComposer(NARROW_EDGE_WIDTH);
  assert.equal(
    within(narrow.footer).queryByRole('button', { name: enChat.input.moreTools }) !== null,
    true,
    `767px must take the narrow layout; controls read: ${describeFooterControls(narrow.footer)}`,
  );
  narrow.view.unmount();

  const wide = renderComposer(NARROW_EDGE_WIDTH + 1);
  assert.equal(
    within(wide.footer).queryByRole('button', { name: enChat.input.moreTools }),
    null,
    `768px must take the wide layout; controls read: ${describeFooterControls(wide.footer)}`,
  );
});

test('(b) the wide footer still shows commands, schedule and token usage inline, with no "more" entry', () => {
  const { view, footer } = renderComposer(DESKTOP_WIDTH);

  for (const inline of [enChat.input.showAllCommands, enChat.schedule.trigger, enChat.misc.showTokenUsage]) {
    assert.ok(
      within(footer).queryByRole('button', { name: inline }),
      `"${inline}" must stay directly in the wide footer; controls read: ${describeFooterControls(footer)}`,
    );
  }

  assert.equal(
    view.queryByRole('button', { name: enChat.input.moreTools }),
    null,
    'the wide layout must not introduce the narrow layout\'s "more" entry',
  );
});

test('(c) the "more" menu offers all three, and the commands item calls the composer\'s own toggle once', () => {
  const onToggleCommandMenu = vi.fn();
  const { view } = renderComposer(MOBILE_WIDTH, { onToggleCommandMenu });
  const menu = openMoreMenu(view);

  const commands = within(menu).getByRole('menuitem', { name: new RegExp(enChat.input.showAllCommands) });
  within(menu).getByRole('menuitem', { name: enChat.schedule.trigger });
  within(menu).getByRole('menuitem', { name: new RegExp(enChat.misc.showTokenUsage) });

  fireEvent.click(commands);

  assert.equal(
    onToggleCommandMenu.mock.calls.length,
    1,
    `choosing commands must call the composer's toggle exactly once, called ${onToggleCommandMenu.mock.calls.length}`,
  );
  assert.equal(openOverlays().length, 0, 'the menu must close once its item is chosen');
});

test('(c) the token item opens the composer\'s own detail panel once', () => {
  const onShowTokenUsage = vi.fn();
  const { view } = renderComposer(MOBILE_WIDTH, { onShowTokenUsage });
  const menu = openMoreMenu(view);

  fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(enChat.misc.showTokenUsage) }));

  assert.equal(
    onShowTokenUsage.mock.calls.length,
    1,
    `choosing token usage must open the panel exactly once, opened ${onShowTokenUsage.mock.calls.length}`,
  );
  assert.equal(openOverlays().length, 0, 'the menu must close once its item is chosen');
});

test('(c) the schedule item reaches the original commit path and submits one instant', () => {
  const onScheduleMessage = vi.fn();
  const { view } = renderComposer(MOBILE_WIDTH, { input: 'later', hasInput: true, onScheduleMessage });
  const menu = openMoreMenu(view);

  fireEvent.click(within(menu).getByRole('menuitem', { name: enChat.schedule.trigger }));

  // The picker's own rows, rendered in the menu's surface: the same ones the wide
  // footer's popover shows, so the commit below is the shipping one.
  const picker = view.getByRole('menuitemradio', { name: new RegExp(enChat.schedule.in['15']) });
  assert.equal(openOverlays().length, 1, 'the picker must not open a second overlay');

  fireEvent.click(picker);

  assert.equal(
    onScheduleMessage.mock.calls.length,
    1,
    `scheduling must commit exactly once, committed ${onScheduleMessage.mock.calls.length}`,
  );
  assert.ok(
    onScheduleMessage.mock.calls[0]?.[0] instanceof Date,
    `the commit must carry the chosen instant, carried ${String(onScheduleMessage.mock.calls[0]?.[0])}`,
  );
});

test('(d) the commands item still carries the slash-command count badge', () => {
  const { view } = renderComposer(MOBILE_WIDTH, { slashCommandsCount: 7 });
  const menu = openMoreMenu(view);
  const commands = within(menu).getByRole('menuitem', { name: new RegExp(enChat.input.showAllCommands) });

  assert.ok(
    within(commands).queryByText('7'),
    `the commands item must show its count; it reads "${commands.textContent ?? ''}"`,
  );
});

test('(e) the schedule item is disabled while the box is empty and available once it holds text', () => {
  const empty = renderComposer(MOBILE_WIDTH);
  const emptyRow = within(openMoreMenu(empty.view)).getByRole('menuitem', { name: enChat.schedule.trigger });
  assert.ok(
    emptyRow.hasAttribute('disabled') || emptyRow.getAttribute('aria-disabled') === 'true',
    `an empty box must leave scheduling unavailable; the row reads ${emptyRow.outerHTML}`,
  );
  empty.view.unmount();

  const filled = renderComposer(MOBILE_WIDTH, { input: 'later', hasInput: true });
  const filledRow = within(openMoreMenu(filled.view)).getByRole('menuitem', { name: enChat.schedule.trigger });
  assert.equal(
    filledRow.hasAttribute('disabled') || filledRow.getAttribute('aria-disabled') === 'true',
    false,
    `text in the box must make scheduling available; the row reads ${filledRow.outerHTML}`,
  );
});

test('(f) reaching the picker never leaves two overlays open, and closing returns focus to the trigger', () => {
  const { view } = renderComposer(MOBILE_WIDTH, { input: 'later', hasInput: true });
  const trigger = view.getByRole('button', { name: enChat.input.moreTools });

  fireEvent.click(trigger);
  assert.equal(
    openOverlays().length,
    1,
    `the menu must be the only overlay open; open overlays read ${openOverlays().length}`,
  );

  fireEvent.click(view.getByRole('menuitem', { name: enChat.schedule.trigger }));
  assert.equal(
    openOverlays().length,
    1,
    `the picker lives in the menu's own surface, so it must not add a second overlay; open overlays read ${openOverlays().length}`,
  );
  assert.ok(
    view.queryByRole('menuitemradio', { name: new RegExp(enChat.schedule.in['15']) }),
    'the picker must actually be showing, or the reading above is about nothing',
  );

  fireEvent.keyDown(document, { key: 'Escape' });

  assert.equal(
    openOverlays().length,
    0,
    `closing must leave nothing open; open overlays read ${openOverlays().length}`,
  );
  assert.equal(
    document.activeElement,
    trigger,
    'closing from the picker must return focus to the "more" trigger',
  );
});

test('(g) a clip leaves exactly one accessible replay control per track, in each tier', () => {
  // The pair is drawn at narrow widths in a row of its own and from `md` up in the left tool group —
  // one renderer switched by `isMobile`, not two DOM copies with one hidden by a class. That is the
  // mechanism under test: with a single copy there is no second one for the accessibility tree to
  // have to hide, and the count below is the reading that says so. (A two-copy implementation would
  // have to make this file parse a `display:none` rule to keep the count at one; nothing here has to
  // read CSS, which is the observable difference between the two mechanisms.)
  clipFixture.slot = CLIP_PAIR;
  const readings: string[] = [];

  for (const tier of [
    { label: 'narrow (390px)', width: MOBILE_WIDTH },
    { label: 'wide (1280px)', width: DESKTOP_WIDTH },
  ]) {
    const { view } = renderComposer(tier.width);
    // `queryAllByRole` is `getAllByRole`'s accessible-elements query in its non-throwing form: a
    // count of zero is a reading here rather than a caught error, which is what lets the failure
    // message print the number — and a composer that never rendered would otherwise report the same
    // thing as one that rendered two copies.
    const original = view.queryAllByRole('button', { name: 'Replay original' });
    const trimmed = view.queryAllByRole('button', { name: 'Replay trimmed' });
    readings.push(
      `${tier.label}: Replay original=${original.length}, Replay trimmed=${trimmed.length}`,
    );

    assert.equal(
      original.length,
      1,
      `each tier must expose exactly one accessible "Replay original"; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      trimmed.length,
      1,
      `each tier must expose exactly one accessible "Replay trimmed"; readings: ${readings.join(' | ')}`,
    );

    view.unmount();
  }
});
