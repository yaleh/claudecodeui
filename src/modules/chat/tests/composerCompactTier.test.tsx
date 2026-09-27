import assert from 'node:assert/strict';

import { act, render, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import type { MutableRefObject } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { COMPACT_TIER_WIDTH_PX } from '@/modules/chat/hooks/useComposerCompactTier';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { VoiceClipSlot } from '@/shared/types';

/**
 * The composer's footer was arranged by the window width alone, and a window 768px wide with the
 * sidebar open leaves the input box 445px — narrow enough that one recording's replay pair pushed
 * the two control groups onto separate rows (the browser probe read the groups' tops 36px apart,
 * and 72px apart with a pair). The window was never the wrong number to ask about the *device*;
 * it is the wrong number to ask about the *box*, which the sidebar, its drag, and the chat
 * column's own cap all resize while the window stands still.
 *
 * So the tier now reads two signals — the window's `md` rule, and the box's own measured width —
 * and these cases are about the second one. jsdom lays nothing out, so the box's width is not
 * something a render can produce: it is *given* here, by a getter over the form's `clientWidth`
 * (the number the hook reads) that the cases can move, and a `ResizeObserver` double that drives
 * the re-measure the way a real one drives it after a sidebar drag. Every case therefore reads one
 * thing: which signal the composer's footer is arranged by, and which controls that arrangement
 * puts in it.
 *
 * What jsdom still cannot answer — whether the box really fits its row — is the browser probe's
 * job, and the threshold it produced is the number the cells below straddle.
 */

/** The box the composer arranges in. */
const FORM_SELECTOR = 'form[data-slot="prompt-input"]';
const FOOTER_SELECTOR = '[data-slot="prompt-input-footer"]';
/** The left control group: where the replay pair lives on the wide tier. */
const TOOLS_SELECTOR = '[data-slot="prompt-input-tools"]';
/** The row of its own the replay pair gets on the compact tier. */
const CLIP_ROW_SELECTOR = '[data-slot="prompt-input-clip-row"]';

/** The window rule's two sides: one pixel under `md`, and a window with room to spare. */
const NARROW_EDGE_WIDTH = 767;
const DESKTOP_WIDTH = 1280;

/** The box the 1280px window leaves with the sidebar open and with it closed — the probe's own readings. */
const BOX_WITH_SIDEBAR_OPEN = 445;
const BOX_WITH_SIDEBAR_CLOSED = 866;

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
}));

/**
 * The clip the composer is holding. The capture chain is not what these cases are about — the
 * footer's arrangement in the presence of a pair is — so the slot is a fixture the cases set,
 * exactly as the responsive cases next door do.
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
    url: 'blob:tier-original',
    meta: { bytes: 6_400, mimeType: 'audio/webm', durationMs: 9_000 },
  },
  trimmed: {
    url: 'blob:tier-trimmed',
    meta: { bytes: 32_000, mimeType: 'audio/wav', durationMs: 4_000 },
  },
};

/**
 * The box's width, as the hook's own reading is taken: the form's `clientWidth`.
 *
 * jsdom answers 0 for every element, so the number is supplied here — over the prototype because
 * the hook measures on mount, before a case could reach the rendered node. `width` is read on
 * every access, which is what lets a case move it and re-measure.
 */
const box = { width: 0 };

const installBoxWidth = (width: number) => {
  box.width = width;
  Object.defineProperty(HTMLFormElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => box.width,
  });
};

/**
 * The observer double, shaped like the one the activity-indicator cases use: the callback is held
 * so a case can fire it, and the observed elements are kept so a case can read what was observed.
 */
class FakeResizeObserver {
  static latest: FakeResizeObserver | null = null;
  readonly observed: Element[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.latest = this;
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {
    return undefined;
  }

  disconnect() {
    this.observed.length = 0;
  }

  /** One delivery, as a real observer would make after the box changed size. */
  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const installObserver = () => {
  FakeResizeObserver.latest = null;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
};

/** The signal the composer reads for the window rule, so a renamed source of truth fails these cases. */
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

/** jsdom implements no media queries; the double answers "no" to all of them, a keyboard device. */
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

let matchMediaInstalled = false;
const injectMatchMediaOnce = () => {
  if (matchMediaInstalled) return;
  installMatchMedia();
  matchMediaInstalled = true;
};

const baseProps = (options: { dropzoneRef?: MutableRefObject<HTMLFormElement | null> } = {}) => ({
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
  // The real `getRootProps` hands back a `ref` inside these props, and the composer spreads them
  // onto the form. By default the double is empty — the cases above are about the arrangement, not
  // about the refs — and case (g) is the one that makes them carry a ref.
  getRootProps: () => (options.dropzoneRef ? { ref: options.dropzoneRef } : {}),
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

/**
 * What the footer's arrangement is, read from the structure the CSS then lays out.
 *
 * `compact` is the arrangement's own entry: the three controls that moved behind it are absent
 * from the footer exactly when it is. The wrap token is read beside it because the two are one
 * branch — a composer that drew the compact controls inside the wide row would read `compact` and
 * `flex-wrap` at once, which is not a state the component has.
 */
const readFooter = (footer: Element) => {
  const inFooter = (name: string) => within(footer as HTMLElement).queryByRole('button', { name }) !== null;
  return {
    compact: inFooter(enChat.input.moreTools),
    inlineControls: [enChat.input.showAllCommands, enChat.schedule.trigger, enChat.misc.showTokenUsage]
      .filter(inFooter),
    wrapTokens: Array.from(footer.classList).filter((name) => /^flex-(?:wrap|nowrap)$/.test(name)),
  };
};

const describeArrangement = (footer: Element) => {
  const names = Array.from(footer.querySelectorAll('button'))
    .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '<unnamed>')
    .join(' | ');
  return `${JSON.stringify(readFooter(footer))} controls: ${names}`;
};

type RenderOptions = {
  /** The window width the render sees. */
  viewport: number;
  /**
   * The box's measured width, or null for a box that cannot be measured — the jsdom default, and
   * what an element that has not been laid out reports.
   */
  boxWidth: number | null;
  /** Whether a `ResizeObserver` exists at all. */
  withObserver?: boolean;
  clip?: VoiceClipSlot | null;
  /**
   * The ref the dropzone's own root props carry, when their shape is being read rather than
   * stubbed away. Absent by default: an empty props object is what the other cases pass.
   */
  dropzoneRef?: MutableRefObject<HTMLFormElement | null>;
};

const renderComposer = ({ viewport, boxWidth, withObserver = true, clip = null, dropzoneRef }: RenderOptions) => {
  injectMatchMediaOnce();
  setViewportWidth(viewport);
  if (boxWidth === null) {
    // The box reports 0, which is what "not laid out yet" looks like.
    installBoxWidth(0);
  } else {
    installBoxWidth(boxWidth);
  }
  if (withObserver) installObserver();
  clipFixture.slot = clip;

  const view = render(
    React.createElement(ChatComposer, { ...baseProps({ dropzoneRef }) } as React.ComponentProps<typeof ChatComposer>),
  );
  const footer = view.container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  const form = view.container.querySelector<HTMLFormElement>(FORM_SELECTOR);
  assert.ok(footer, `the composer must render a footer (${FOOTER_SELECTOR})`);
  assert.ok(form, `the composer must render its input box (${FORM_SELECTOR})`);

  return { view, footer, form };
};

/** The clip row, if the composer drew one. */
const clipRowOf = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLElement>(CLIP_ROW_SELECTOR);

const clipButtonsIn = (root: Element) => root.querySelectorAll('[data-clip-url]').length;

/** Generated ids differ between mounts and say nothing about structure; the rest is compared as is. */
const normalizeIds = (markup: string) =>
  markup.replace(/\s(id|aria-controls|aria-labelledby|aria-describedby)="[^"]*"/g, ' $1="#"');

beforeEach(() => {
  clipFixture.slot = null;
  box.width = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLFormElement.prototype as { clientWidth?: number }).clientWidth;
  FakeResizeObserver.latest = null;
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

test('(a) a wide window with a box under the threshold takes the compact arrangement', () => {
  const { footer } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_OPEN,
    clip: CLIP_PAIR,
  });

  const reading = describeArrangement(footer);
  assert.equal(readFooter(footer).compact, true, `a ${BOX_WITH_SIDEBAR_OPEN}px box must be compact; ${reading}`);
  assert.deepEqual(
    readFooter(footer).inlineControls,
    [],
    `commands, schedule and token usage must not stay in the footer; ${reading}`,
  );
  assert.deepEqual(readFooter(footer).wrapTokens, ['flex-nowrap'], `the compact row may not wrap; ${reading}`);
});

test('(a) with a pair, the compact arrangement puts the replay row before the footer and nothing in the tools group', () => {
  const { view, footer } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_OPEN,
    clip: CLIP_PAIR,
  });

  const row = clipRowOf(view);
  assert.ok(row, 'the compact arrangement must draw the replay pair a row of its own');
  assert.equal(clipButtonsIn(row), 2, `both tracks belong to that row; it holds ${clipButtonsIn(row)}`);
  // The row sits between the box and the footer: the footer must come after it.
  assert.equal(
    (row.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    true,
    'the replay row must come before the footer, so the footer keeps its own row',
  );
  const tools = footer.querySelector(TOOLS_SELECTOR);
  assert.ok(tools, `the footer must render its tool group (${TOOLS_SELECTOR})`);
  assert.equal(
    clipButtonsIn(tools),
    0,
    `the compact footer's tool group must hold no replay control; it holds ${clipButtonsIn(tools)}`,
  );
});

test('(b) a wide window with a box over the threshold keeps the wide arrangement', () => {
  const { view, footer } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_CLOSED,
    clip: CLIP_PAIR,
  });

  const reading = describeArrangement(footer);
  assert.equal(readFooter(footer).compact, false, `a ${BOX_WITH_SIDEBAR_CLOSED}px box must stay wide; ${reading}`);
  assert.deepEqual(
    readFooter(footer).inlineControls,
    [enChat.input.showAllCommands, enChat.schedule.trigger, enChat.misc.showTokenUsage],
    `commands, schedule and token usage stay inline on the wide tier; ${reading}`,
  );
  assert.equal(readFooter(footer).wrapTokens.includes('flex-wrap'), true, `the wide row may wrap; ${reading}`);

  assert.equal(clipRowOf(view), null, 'the wide tier must not draw the compact replay row');
  const tools = footer.querySelector(TOOLS_SELECTOR);
  assert.ok(tools, `the footer must render its tool group (${TOOLS_SELECTOR})`);
  assert.equal(
    clipButtonsIn(tools),
    2,
    `the wide tier keeps both replay controls in the tool group; it holds ${clipButtonsIn(tools)}`,
  );
});

test('(c) a narrow window stays compact however wide the box measures', () => {
  const { footer } = renderComposer({
    viewport: NARROW_EDGE_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_CLOSED,
    clip: CLIP_PAIR,
  });

  const reading = describeArrangement(footer);
  assert.equal(
    readFooter(footer).compact,
    true,
    `the window's own rule decides below md, whatever the box measures; ${reading}`,
  );
  assert.deepEqual(
    readFooter(footer).inlineControls,
    [],
    `the three wide-only controls must not appear in a narrow window; ${reading}`,
  );
});

test('(d) the threshold is one cell wide: the constant minus one is compact, the constant is wide', () => {
  const narrow = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: COMPACT_TIER_WIDTH_PX - 1 });
  assert.equal(
    readFooter(narrow.footer).compact,
    true,
    `a box of ${COMPACT_TIER_WIDTH_PX - 1}px must be compact; ${describeArrangement(narrow.footer)}`,
  );
  narrow.view.unmount();

  const atThreshold = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: COMPACT_TIER_WIDTH_PX });
  assert.equal(
    readFooter(atThreshold.footer).compact,
    false,
    `a box of exactly ${COMPACT_TIER_WIDTH_PX}px must be wide; ${describeArrangement(atThreshold.footer)}`,
  );
});

test('(e) an unmeasured box leaves the window rule alone, and the structure byte-identical', () => {
  // The reference: jsdom's own defaults, no observer and a box that reports 0 — the render every
  // other case in this file would produce if the measurement never happened.
  const reference = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: null, withObserver: false });
  const referenceMarkup = normalizeIds(reference.footer.outerHTML);
  assert.equal(readFooter(reference.footer).compact, false, 'the reference render must be the wide one for this to read');
  reference.view.unmount();

  // A box that cannot be measured at all: no observer exists, so the hook never asks.
  const noObserver = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: BOX_WITH_SIDEBAR_OPEN, withObserver: false });
  assert.equal(
    readFooter(noObserver.footer).compact,
    false,
    'without a ResizeObserver the window rule is the whole answer, so a narrow box cannot matter',
  );
  assert.equal(
    normalizeIds(noObserver.footer.outerHTML),
    referenceMarkup,
    'an unmeasurable box must leave the footer structurally identical to the window-only render',
  );
  noObserver.view.unmount();

  // An observer that exists but reports a box with no width yet: 0 is "not laid out", not "narrow".
  const zeroWidth = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: null, withObserver: true });
  assert.equal(
    readFooter(zeroWidth.footer).compact,
    false,
    'a box that has not been laid out reads 0 and must not be taken for a narrow one',
  );
  assert.equal(
    normalizeIds(zeroWidth.footer.outerHTML),
    referenceMarkup,
    'a zero-width box must leave the footer structurally identical to the window-only render',
  );
  zeroWidth.view.unmount();

  // And the window rule still decides on its own when nothing is measured: 767 is compact.
  const narrow = renderComposer({ viewport: NARROW_EDGE_WIDTH, boxWidth: BOX_WITH_SIDEBAR_OPEN, withObserver: false });
  assert.equal(
    readFooter(narrow.footer).compact,
    true,
    'with nothing measured, a narrow window must still take the compact arrangement',
  );
});

test('(f) a box that changes width flips the arrangement without remounting, and flips back', () => {
  const { footer, form, view } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_CLOSED,
    clip: CLIP_PAIR,
  });

  const observer = FakeResizeObserver.latest;
  assert.ok(observer, 'the composer must install an observer to watch its box');
  assert.equal(
    observer.observed.includes(form),
    true,
    'the observer must be watching the composer\'s own box, or a flip could not reach it',
  );

  assert.equal(readFooter(footer).compact, false, `the ${BOX_WITH_SIDEBAR_CLOSED}px box must start wide`);
  // A mark on the node itself: a remount would replace the element and lose it, so the flip below
  // is read as a re-render of this same box rather than as a new one that happens to be narrow.
  form.dataset.tierProbe = 'first-box';
  const stamp = form;

  // A sidebar drag: the box narrows while the window stands still.
  act(() => {
    box.width = BOX_WITH_SIDEBAR_OPEN;
    observer.emit();
  });
  assert.equal(
    readFooter(footer).compact,
    true,
    `a box dragged to ${BOX_WITH_SIDEBAR_OPEN}px must flip to compact; ${describeArrangement(footer)}`,
  );
  assert.equal(
    view.container.querySelector<HTMLFormElement>(FORM_SELECTOR),
    stamp,
    'the flip must re-render the same box, not remount the composer',
  );
  assert.equal(
    view.container.querySelector<HTMLFormElement>(FORM_SELECTOR)?.dataset.tierProbe,
    'first-box',
    'the mark on the box must survive the flip',
  );

  // And back the other way, with the pair's row leaving as it goes.
  act(() => {
    box.width = BOX_WITH_SIDEBAR_CLOSED;
    observer.emit();
  });
  assert.equal(
    readFooter(footer).compact,
    false,
    `a box dragged back to ${BOX_WITH_SIDEBAR_CLOSED}px must flip back to wide; ${describeArrangement(footer)}`,
  );
  assert.equal(clipRowOf(view), null, 'flipping back to wide must take the compact replay row away');
  assert.equal(
    view.container.querySelector<HTMLFormElement>(FORM_SELECTOR)?.dataset.tierProbe,
    'first-box',
    'the same box must still be the one on screen after flipping back',
  );
});

test('(g) the box is measured even when the dropzone’s root props carry a ref of their own', () => {
  // react-dropzone's root props put a `ref` in the object the composer spreads onto the form, and a
  // `ref=` written beside a spread is replaced by the one inside it — so the tier hook's box goes
  // unmeasured and the whole arrangement silently falls back to the window rule, which is what the
  // browser read until both refs were attached from one callback. The cases above pass an empty
  // props object and so cannot see it; this one renders with the shape the real props have.
  const dropzoneRef: MutableRefObject<HTMLFormElement | null> = { current: null };
  const { footer, form } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_OPEN,
    clip: CLIP_PAIR,
    dropzoneRef,
  });

  assert.equal(
    readFooter(footer).compact,
    true,
    `the box must be measured with the dropzone's ref in the props; ${describeArrangement(footer)}`,
  );
  assert.equal(
    dropzoneRef.current,
    form,
    'the dropzone\'s own root ref must still reach the form it was handed',
  );
});
