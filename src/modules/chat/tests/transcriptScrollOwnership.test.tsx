import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * The transcript's scroll position is written from five places coordinated by
 * refs and timers rather than by one owner. These are the two cases where that
 * coordination was observably wrong; both are timing bugs, so they are driven
 * on fake timers rather than by clicking.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const buildMessage = (index: number, timestamp: string): NormalizedMessage => ({
  id: `m-${index}`,
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: SESSION_A,
  content: `message ${index}`,
  timestamp,
} as NormalizedMessage);

/**
 * jsdom has no layout, so scrollHeight/clientHeight are always 0 and assigning
 * scrollTop emits nothing. These are the exact reads the scroll code makes.
 */
function createContainer(scrollHeight: number, clientHeight: number) {
  const element = document.createElement('div');
  const writes: number[] = [];
  let scrollTop = scrollHeight - clientHeight;

  Object.defineProperty(element, 'scrollHeight', { get: () => scrollHeight });
  Object.defineProperty(element, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
      writes.push(next);
    },
  });

  return { element: element as HTMLDivElement, writes, scrollHeight };
}

/**
 * The same container, but with geometry that can change: the content-growth
 * follow is entirely about what happened between two layouts, so a fixture
 * whose scrollHeight is fixed could only ever observe the trivial case.
 */
function createResizableContainer(scrollHeight: number, clientHeight: number) {
  const element = document.createElement('div');
  const writes: number[] = [];
  let height = scrollHeight;
  let top = scrollHeight - clientHeight;

  Object.defineProperty(element, 'scrollHeight', { get: () => height });
  Object.defineProperty(element, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    get: () => top,
    set: (next: number) => {
      top = next;
      writes.push(next);
    },
  });

  return {
    element: element as HTMLDivElement,
    writes,
    /** The offset a pinned viewport sits at. */
    get bottom() {
      return height - clientHeight;
    },
    get scrollTop() {
      return top;
    },
    /** Grows the content the way a taller last row does — no row is added. */
    grow: (delta: number) => {
      height += delta;
    },
    /**
     * Shrinks the content the way a row above the viewport collapsing does. The
     * browser answers that by moving the offset itself, which is why the caller
     * follows it with `scrollTo` rather than letting the fixture do it.
     */
    shrink: (delta: number) => {
      height -= delta;
    },
    /** Moves the viewport the way a gesture does. */
    scrollTo: (next: number) => {
      top = next;
    },
  };
}

/**
 * Stands in for the browser's ResizeObserver, which jsdom does not ship. The
 * spec drives it directly: `emit` is the notification the browser sends once
 * layout has settled after a change.
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

  unobserve() {}

  disconnect() {
    this.observed.length = 0;
  }

  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

/** Animation frames the follow deferred its write to; the spec runs them by hand. */
let pendingFrames: FrameRequestCallback[] = [];

function runFrames() {
  const frames = pendingFrames;
  pendingFrames = [];
  for (const frame of frames) {
    frame(0);
  }
}

function attachContentRef(
  ref: unknown,
  node: HTMLDivElement | null,
) {
  (ref as (target: HTMLDivElement | null) => void)(node);
}

function createStore(messagesBySession: Map<string, NormalizedMessage[]>) {
  // A hydrated slot, so the session-loading effect takes its early return
  // instead of re-fetching on every render.
  const slotFor = (sessionId: string) => ({
    fetchedAt: 1,
    status: 'idle' as const,
    total: messagesBySession.get(sessionId)?.length ?? 0,
    hasMore: false,
    offset: messagesBySession.get(sessionId)?.length ?? 0,
  });

  return {
    fetchFromServer: vi.fn(async (sessionId: string) => slotFor(sessionId)),
    fetchMore: vi.fn(async (sessionId: string) => ({ slot: slotFor(sessionId), prependedCount: 0 })),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId),
      applied: true,
      changed: false,
      deferred: false,
    })),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn((sessionId: string) => messagesBySession.get(sessionId) ?? []),
    getSessionSlot: vi.fn((sessionId: string) => slotFor(sessionId)),
  };
}

async function renderChatSessionState(options: {
  session: ProjectSession;
  store: ReturnType<typeof createStore>;
}) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');

  return renderHook(
    ({ session }: { session: ProjectSession }) =>
      useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage: vi.fn(),
        resetStreamingState: vi.fn(),
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: options.store as never,
      }),
    { initialProps: { session: options.session } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // The initial-scroll effect is a separate writer that re-scrolls to the
  // bottom every animation frame until the height settles. It would satisfy an
  // assertion meant for the deferred timer, so it is silenced here — these
  // tests are about which writer wins, and it is not one of the two.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('deferred scroll-to-bottom', () => {
  it('does not yank the view back down when the user scrolls up inside the delay', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    // A new row lands while the user is at the bottom: a scroll is armed for +50ms.
    messages.set(SESSION_A, [
      ...messages.get(SESSION_A)!,
      buildMessage(1, '2026-01-01T00:00:01.000Z'),
    ]);
    act(() => {
      rerender({ session: { id: SESSION_A } as ProjectSession });
    });

    // ...and the user drags upward before it fires.
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });
    container.writes.length = 0;

    act(() => {
      vi.advanceTimersByTime(200);
    });

    assert.deepEqual(
      container.writes,
      [],
      `a scroll armed before the user scrolled up must not fire afterwards; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('still sticks to the bottom when the user has not scrolled away', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    messages.set(SESSION_A, [
      ...messages.get(SESSION_A)!,
      buildMessage(1, '2026-01-01T00:00:01.000Z'),
    ]);
    act(() => {
      rerender({ session: { id: SESSION_A } as ProjectSession });
    });
    container.writes.length = 0;

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(container.writes).toContain(container.scrollHeight);
  });
});

describe('content-growth follow', () => {
  beforeEach(() => {
    pendingFrames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    FakeResizeObserver.latest = null;
  });

  /**
   * Renders the hook over a resizable container, attaches the content column to
   * the follow and settles the baseline layout, returning the parts a case
   * drives. The container is never scrollable in jsdom, so the geometry the
   * follow reads is the one the fixture declares.
   */
  async function mountFollow(scrollHeight = 5000, clientHeight = 500) {
    const store = createStore(new Map([[SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]]]));
    const { result } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createResizableContainer(scrollHeight, clientHeight);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    const content = document.createElement('div');
    act(() => {
      attachContentRef(result.current.scrollContentRef, content);
    });

    const observer = FakeResizeObserver.latest;
    assert.ok(observer, 'attaching the content column must install a ResizeObserver');
    assert.deepEqual(
      observer.observed,
      [content, container.element],
      'the content column and the pane it scrolls in are both watched',
    );

    // The baseline: the follow judges a resize against the layout before it, so
    // the attach-time layout has to be delivered once before anything is asked.
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });
    container.writes.length = 0;

    return { result, container, observer };
  }

  it('stays pinned when the last row grows without a new one arriving', async () => {
    const { container, observer } = await mountFollow();

    // No store flush and no new row: the row already on screen is simply taller,
    // which is invisible to every row-count-driven scroll writer.
    container.grow(400);
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });

    assert.deepEqual(
      container.writes,
      [container.bottom],
      `a pinned viewport must land back on the bottom; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('leaves the viewport where a gesture put it', async () => {
    const { container, observer } = await mountFollow();

    // The user wheels away from the bottom; the follow must read that as drift
    // the user owns, not as a gap it is free to close.
    container.scrollTo(container.bottom - 300);
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });
    container.writes.length = 0;

    container.grow(400);
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });

    assert.deepEqual(
      container.writes,
      [],
      `growth must open the gap a scrolled-away viewport is holding; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('does not re-pin over a gesture that lands before the write', async () => {
    const { container, observer } = await mountFollow();

    container.grow(400);
    act(() => {
      observer.emit();
    });

    // The frame between the resize and the write is exactly the window a gesture
    // can land in, and taking the viewport back there has to win.
    container.scrollTo(container.scrollTop - 30);
    act(() => {
      runFrames();
    });

    assert.deepEqual(
      container.writes,
      [],
      `a scroll-up inside the deferred window must survive; got ${JSON.stringify(container.writes)}`,
    );
  });

  /** The shape of the browser's own scroll: the offset moves, nothing was touched. */
  const dispatchScroll = (container: HTMLElement) => {
    container.dispatchEvent(new Event('scroll'));
  };

  it('does not read a scroll with no input behind it as leaving the bottom', async () => {
    const { result, container, observer } = await mountFollow();
    // The listeners that attribute a scroll are on the window, so the pane has to
    // be a node the event can reach them through.
    document.body.appendChild(container.element);
    try {
      // The transcript has a scroll history behind it by now (the gestures that
      // brought the viewport to the bottom), so the offset the shrink is about to
      // change is one an implementation could already have recorded. Without this
      // the case below could only tell a source-based reading apart from one that
      // compares against a baseline it has never seen — and the difference this
      // test exists for is the source.
      act(() => {
        dispatchScroll(container.element);
      });
      // A row above the viewport collapses. The browser holds the visible content
      // still by moving the offset up by the same amount — the offset decreases,
      // exactly as it does under a wheel-up, with nobody touching the page.
      container.shrink(300);
      container.scrollTo(container.bottom);
      act(() => {
        observer.emit();
      });
      act(() => {
        runFrames();
      });
      const intentReadings: boolean[] = [];
      act(() => {
        dispatchScroll(container.element);
      });
      intentReadings.push(result.current.isUserScrolledUp);

      // The row that then grows in place must still be followed: the viewport
      // never left the bottom, so there is no gap for the growth to open.
      container.writes.length = 0;
      container.grow(480);
      act(() => {
        observer.emit();
      });
      act(() => {
        runFrames();
      });
      intentReadings.push(result.current.isUserScrolledUp);

      assert.deepEqual(
        intentReadings,
        [false, false],
        'a scroll the page received no input for must never raise the scroll-to-bottom state',
      );
      assert.deepEqual(
        container.writes,
        [container.bottom],
        `the growth after the browser's own scroll must still be followed; got ${JSON.stringify(container.writes)}`,
      );
    } finally {
      container.element.remove();
    }
  });

  it('still reads a wheel as the user leaving the bottom', async () => {
    const { result, container } = await mountFollow();
    document.body.appendChild(container.element);
    try {
      // The same offset change as above, and the same event — the input in front
      // of it is the only difference between them.
      act(() => {
        container.element.dispatchEvent(new Event('wheel'));
      });
      container.scrollTo(container.bottom - 300);
      act(() => {
        dispatchScroll(container.element);
      });

      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'a wheel that carries the viewport away from the bottom is the user leaving it',
      );
    } finally {
      container.element.remove();
    }
  });
});

describe('search jump ownership', () => {
  it('does not follow the user into the next session', { timeout: 20_000 }, async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
      [SESSION_B, [buildMessage(1, '2026-01-01T00:00:05.000Z')]],
    ]);
    const store = createStore(messages);
    const searchSession = {
      id: SESSION_A,
      __searchTargetSnippet: 'message 0',
      __searchTargetTimestamp: '2026-01-01T00:00:00.000Z',
    } as unknown as ProjectSession;

    const { result, rerender } = await renderChatSessionState({ session: searchSession, store });

    const container = createContainer(5000, 500);
    // The row session B renders. The jump requested against session A resolves
    // by timestamp, and on its last retry it accepts the nearest row it can
    // find — which, after the switch, is this one.
    const sessionBRow = document.createElement('div');
    sessionBRow.setAttribute('data-message-timestamp', '2026-01-01T00:00:05.000Z');
    container.element.appendChild(sessionBRow);

    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // Let the jump arm and start retrying.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The user gives up waiting and opens a different session.
    await act(async () => {
      rerender({ session: { id: SESSION_B } as ProjectSession });
    });

    // Let the whole retry budget elapse (20 retries, 150ms apart).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3400);
    });

    assert.equal(
      scrollIntoView.mock.calls.length,
      0,
      'a jump requested in the previous session must not scroll the new one',
    );
    assert.equal(
      container.element.querySelectorAll('.search-highlight-flash').length,
      0,
      'and must not flash the search highlight on one of its rows',
    );
  });
});
