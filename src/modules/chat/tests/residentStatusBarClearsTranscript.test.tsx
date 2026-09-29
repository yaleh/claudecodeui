import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type {
  ChatMessage,
  Project,
  ProjectSession,
  ProviderModelActions,
} from '@/shared/types';

/**
 * The status bar must not be reachable by the transcript's scroll.
 *
 * The reported symptom was a resident status bar drawn over the conversation it
 * describes, and the mechanism was where the bar *lived*: inside the transcript's
 * scrolling box, pinned with `sticky`, so the messages scrolled underneath it and
 * a bar that wrapped onto a second line came to rest over the row below. That is
 * a fact about the DOM tree, so it is read here rather than only in the browser:
 * the node carrying `[data-resident-status-bar]` is asserted to have no scrolling
 * box on its ancestor chain — it is not inside `.chat-messages-pane`, the element
 * the `overflow-y-auto` tier is written on — which is the arrangement under which
 * no message can ever pass behind it.
 *
 * jsdom parses no Tailwind and scrolls nothing, so what this can read is the
 * structure the markup declares: the classes on the elements between the bar and
 * the document root. That is the same rule the browser lays out (the class is
 * what makes the pane the scroll container), which is why the reading is stated
 * over classes and not over computed styles jsdom cannot produce. Whether the
 * boxes really end up apart at 780x493 is the browser probe's job
 * (`e2e/resident-ui-layout.spec.ts`); this case is the mechanism that makes it so.
 *
 * The second case is the reverse leg: the same reading, on the same rendered
 * tree, with the bar put back inside the pane. It has to report the pane — a
 * reading that answered "no scrolling ancestor" for both arrangements would be a
 * constant, and the first case would pass against the very markup it was written
 * to rule out.
 */

const RESIDENT_SESSION_ID = 'session-resident';

/** The pane's own selector, and the class the scroll tier is written with (`overflow-y-auto`). */
const PANE_SELECTOR = '.chat-messages-pane';
const SCROLL_CLASS = 'overflow-y-auto';
/** The bar's own DOM contract (AC-172), read and never written by this file. */
const BAR_SELECTOR = '[data-resident-status-bar]';

/**
 * The `GET /api/session-hosts` answer the bar renders from: one resident session,
 * held by one idle host.
 *
 * Built inside `vi.hoisted` because the mock below is hoisted above the imports
 * and would otherwise read this before it exists. Only the hook is replaced —
 * `findSessionHost`, `findSessionHostState` and `readResidentProcessState` are the
 * real ones, run against this snapshot — so the answer the bar draws itself from
 * is the same code path the page runs, and a case that changed the snapshot's
 * shape (a session not stored `resident`, a closed host) would change what the
 * component does for the same reason it would in the browser.
 */
const { snapshot } = vi.hoisted(() => {
  const appSessionId = 'session-resident';
  const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
  return {
    snapshot: {
      hosts: [
        {
          hostId: 'host-1',
          provider: 'claude' as const,
          mode: 'resident',
          state: 'idle',
          pid: 4242,
          startedAt,
          closeReason: null,
          closeDetail: null,
          bindings: [
            {
              appSessionId,
              providerSessionId: 'provider-session-1',
              state: 'idle',
              leases: [],
              lastActivityAt: startedAt,
              peerName: 'resident-host',
            },
          ],
        },
      ],
      sessions: [
        {
          appSessionId,
          provider: 'claude' as const,
          lifecycleMode: 'resident',
          running: true,
          reason: null,
        },
      ],
    },
  };
});

vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot,
      error: null,
      loading: false,
      refresh: async () => undefined,
      start: async () => undefined,
      close: async () => undefined,
    }),
  };
});

/** jsdom ships no media queries; the device rule the pane reads is the width one. */
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

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

/** One assistant turn: enough for the pane to be in its ordinary, non-empty state. */
const messages: ChatMessage[] = [
  { type: 'assistant', content: 'answer', timestamp: '2026-01-01T00:00:00.000Z' },
];

/** The pane's own props, only as far as a transcript with a message needs them. */
const paneProps = (): React.ComponentProps<typeof ChatMessagesPane> => ({
  scrollContainerRef: { current: null },
  scrollContentRef: () => undefined,
  onWheel: () => undefined,
  onTouchMove: () => undefined,
  isLoadingSessionMessages: false,
  chatMessages: messages,
  selectedSession: { id: RESIDENT_SESSION_ID } as ProjectSession,
  currentSessionId: RESIDENT_SESSION_ID,
  provider: 'claude' as const,
  setProvider: () => undefined,
  textareaRef: { current: null },
  providerModels: { claude: 'claude-sonnet-4-5', cursor: 'cursor-small', codex: 'codex-mini', opencode: 'opencode-default' },
  setProviderModel: () => undefined,
  providerModelCatalog: {},
  providerModelActions: {} as ProviderModelActions,
  providerModelsLoading: false,
  tasksEnabled: false,
  isTaskMasterInstalled: null,
  setInput: () => undefined,
  isLoadingMoreMessages: false,
  hasMoreMessages: false,
  totalMessages: messages.length,
  sessionMessagesCount: messages.length,
  visibleMessageCount: messages.length,
  visibleMessages: messages,
  loadEarlierMessages: () => undefined,
  loadAllMessages: () => undefined,
  allMessagesLoaded: true,
  isLoadingAllMessages: false,
  loadAllJustFinished: false,
  showLoadAllOverlay: false,
  createDiff: () => undefined,
  onGrantToolPermission: () => ({ success: true }),
  selectedProject: project,
});

const renderPane = () => {
  const view = render(
    <UiPreferencesProvider>
      <ChatMessagesPane {...paneProps()} />
    </UiPreferencesProvider>,
  );
  const pane = view.container.querySelector<HTMLElement>(PANE_SELECTOR);
  assert.ok(pane, `the pane must render its scroll container (${PANE_SELECTOR})`);
  const bar = view.container.querySelector<HTMLElement>(BAR_SELECTOR);
  assert.ok(
    bar,
    `the bar must render for a resident session, or the reading below would be about nothing; DOM: `
      + view.container.innerHTML.slice(0, 600),
  );
  return { view, pane, bar };
};

/**
 * The scrolling boxes between a node and the document root.
 *
 * The chain is walked rather than queried with `closest`, because the question is
 * not "is there a scrolling ancestor" but "which one" — the failure message has to
 * name it. Both halves of the pane's own rule are read: the class that makes it
 * scroll (`overflow-y-auto`), and the pane's own selector, so a bar put back
 * inside the pane is reported even if the class were ever renamed out from under
 * this file.
 */
const scrollAncestorsOf = (node: Element): Element[] => {
  const found: Element[] = [];
  for (let element = node.parentElement; element !== null; element = element.parentElement) {
    if (element.classList.contains(SCROLL_CLASS) || element.matches(PANE_SELECTOR)) {
      found.push(element);
    }
  }
  return found;
};

/** The ancestor chain as `tag.class` readings, so a failure says what the arrangement was. */
const ancestorChainOf = (node: Element): string[] => {
  const chain: string[] = [];
  for (let element = node.parentElement; element !== null; element = element.parentElement) {
    chain.push(`${element.tagName.toLowerCase()}.${element.className || '(no class)'}`);
  }
  return chain;
};

beforeEach(() => {
  installMatchMedia();
  setViewportWidth(1280);
});

afterEach(() => {
  vi.useRealTimers();
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

test('(a) the status bar has no scrolling box on its ancestor chain', () => {
  const { view, pane, bar } = renderPane();
  const chain = ancestorChainOf(bar);
  const scrollAncestors = scrollAncestorsOf(bar);

  console.log(`status-bar.ancestors=${JSON.stringify(chain)}`);
  console.log(`status-bar.scroll.ancestors=${scrollAncestors.length}`);

  assert.equal(
    scrollAncestors.length,
    0,
    `the status bar must not live inside a scrolling box — that is what lets a message slide behind it; `
      + `its scroll ancestors are ${JSON.stringify(scrollAncestors.map((element) => element.className))}, `
      + `its chain is ${JSON.stringify(chain)}`,
  );
  assert.equal(
    pane.contains(bar),
    false,
    `the status bar must not be a descendant of ${PANE_SELECTOR}; its chain is ${JSON.stringify(chain)}`,
  );
  view.unmount();
});

test('(b) reverse leg: put the bar back inside the pane and the same reading reports it', () => {
  const { view, pane, bar } = renderPane();

  // The arrangement the fix replaced: the bar back inside the transcript's own
  // scroll container, which is where a `sticky` bar comes to rest over a row.
  pane.insertBefore(bar, pane.firstChild);

  const scrollAncestors = scrollAncestorsOf(bar);
  console.log(`reverse.status-bar.scroll.ancestors=${JSON.stringify(scrollAncestors.map((element) => element.className))}`);

  assert.equal(
    scrollAncestors.length,
    1,
    'the reading has to notice the bar put back inside the scroll container, or case (a) would pass '
      + 'against the very arrangement it rules out; it read '
      + `${JSON.stringify(scrollAncestors.map((element) => element.className))}`,
  );
  assert.equal(
    scrollAncestors[0],
    pane,
    `the scrolling ancestor reported must be the pane itself; it read ${scrollAncestors[0]?.className}`,
  );
  assert.equal(pane.contains(bar), true, 'the bar is a descendant of the pane in this arrangement');
  view.unmount();
});
