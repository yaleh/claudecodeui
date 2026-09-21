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

function createStore(
  messagesBySession: Map<string, NormalizedMessage[]>,
  /** What the server says about the transcript's pagination, when a case needs an older page. */
  page: { hasMore?: boolean; prependCount?: number } = {},
) {
  // A hydrated slot, so the session-loading effect takes its early return
  // instead of re-fetching on every render.
  const slotFor = (sessionId: string) => ({
    fetchedAt: 1,
    status: 'idle' as const,
    total: messagesBySession.get(sessionId)?.length ?? 0,
    hasMore: page.hasMore ?? false,
    offset: messagesBySession.get(sessionId)?.length ?? 0,
  });

  return {
    fetchFromServer: vi.fn(async (sessionId: string) => slotFor(sessionId)),
    fetchMore: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId),
      prependedCount: page.prependCount ?? 0,
    })),
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

  /**
   * The first screen a chat opens on is often shorter than the pane, so it has no
   * scrollbar at all: the offset never moves and no `scroll` is ever raised. A
   * wheel up there is still the user reaching for older messages, and the prepend
   * that answers it ends with a restore whose anchor offset cannot be kept — the
   * clamp puts the viewport on the bottom, where a user who scrolled there would
   * sit. So neither the offset nor the `scroll` report the restore's own write
   * raises can say who wants the viewport there; the only thing left to go on is
   * that the newest thing that happened was the user's gesture.
   */
  it('keeps a prepend the wheel asked for out of the follow\'s hands', async () => {
    /** What the older page adds above the viewport, in CSS pixels. */
    const PREPENDED_PX = 1041;
    /** What the row that grows afterwards adds, in CSS pixels. */
    const GROWTH_PX = 480;

    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages, { hasMore: true, prependCount: 1 });
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });
    // The pane the criterion names: exactly as tall as its content, so there is no
    // offset to move and nothing for a wheel to report.
    const container = createResizableContainer(5776, 5776);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    const content = document.createElement('div');
    act(() => {
      attachContentRef(result.current.scrollContentRef, content);
    });
    const observer = FakeResizeObserver.latest;
    assert.ok(observer, 'attaching the content column must install a ResizeObserver');
    // The baseline layout, delivered once before anything is asked.
    act(() => {
      observer.emit();
    });
    // The session load reports whether an older page exists from a resolved
    // promise, and the wheel below is only a request for one if it does. It is
    // also the rerender that lets the session-open scroll below see the container
    // that was attached a moment ago.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The session-open scroll to the bottom re-scrolls every animation frame
    // until the height stops changing, so it is not a growth-driven writer at
    // all — but its frames are on the same queue as the follow's, so left armed
    // they would land in the window below and be read as the follow reacting to
    // growth. Run to completion here: over a settled height it stops after three
    // stable frames. The writes it made are counted, so a drain over an effect
    // that never ran cannot pass for one that did.
    let sessionOpenWrites = 0;
    for (let frame = 0; frame < 6; frame += 1) {
      const before = container.writes.length;
      act(() => {
        runFrames();
      });
      sessionOpenWrites += container.writes.length - before;
    }
    assert.ok(
      sessionOpenWrites > 0,
      'the session-open scroll has to have run, or the drain below certifies nothing',
    );
    container.writes.length = 0;
    act(() => {
      runFrames();
    });
    assert.deepEqual(
      container.writes,
      [],
      'the session-open scroll must be finished before the window below opens',
    );
    // A pane exactly as tall as its content has one offset the browser will hold
    // it at, whatever a writer asks for. The fixture assigns rather than clamps,
    // so the clamp is applied here — as it is after the restore below.
    container.scrollTo(Math.min(container.scrollTop, container.bottom));
    assert.equal(
      container.scrollTop,
      0,
      'the first screen has to be sitting at the top, or the gesture below is not reaching for an older page',
    );
    assert.equal(
      container.element.scrollHeight,
      container.element.clientHeight,
      'the fixture has to be a first screen with no scrollbar',
    );
    container.writes.length = 0;

    // The listeners that attribute a scroll are on the window, so the pane has to
    // be a node the event can reach them through.
    document.body.appendChild(container.element);
    try {
      assert.equal(
        result.current.hasMoreMessages,
        true,
        'the fixture has to have an older page for the wheel to ask for',
      );

      // The gesture, through the entry the app really reads it from: a wheel aimed
      // at the pane. A pane with nothing to scroll raises no scroll behind it, so
      // the wheel is the whole evidence.
      act(() => {
        container.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      });
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'a wheel up over a first screen with nothing to scroll is still the user leaving the bottom',
      );

      // The prepend, through the entry the pane's own `onWheel` prop calls. The
      // restore state is captured synchronously inside the call and the fetch
      // resolves later, so the older page lands in between — the browser's own
      // ordering: capture → older page on screen → restore. Those rows are also
      // what drives the restore: it runs off the transcript growing, so a fixture
      // whose store never grew would be waiting for an effect that never re-runs.
      const pending = result.current.handleScroll();
      container.grow(PREPENDED_PX);
      messages.set(SESSION_A, [
        buildMessage(2, '2025-12-31T23:59:59.000Z'),
        ...messages.get(SESSION_A)!,
      ]);
      await act(async () => {
        await pending;
      });

      // The restore the prepend ends with. A pane that had no scrollable height
      // cannot keep the anchor's offset, so the write lands on the bottom; the
      // browser's clamp is not a write and is applied here as the fixture's own
      // step.
      assert.deepEqual(
        container.writes,
        [container.bottom],
        `the restore must land on the bottom of the pane it could not scroll; got ${JSON.stringify(container.writes)}`,
      );
      container.scrollTo(Math.min(container.scrollTop, container.bottom));

      // (a) The report that write raises. It came from the app placing the
      // viewport, and the pane it came from could not have been scrolled by the
      // user — reading it as intent is what hands the viewport back to the follow.
      act(() => {
        dispatchScroll(container.element);
      });
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'the restore\'s own scroll report must not hand the viewport back to the follow',
      );

      // (b) The growth that follows. A row that gets taller in place, with no new
      // row and no store flush behind it.
      container.writes.length = 0;
      container.grow(GROWTH_PX);
      act(() => {
        observer.emit();
      });
      // Every deferred writer gets its chance: the follow's frame, and the delay a
      // row-triggered scroll is armed on.
      act(() => {
        runFrames();
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      assert.deepEqual(
        container.writes,
        [],
        `growth in place under a transcript the wheel took over must not move it; got ${JSON.stringify(container.writes)}`,
      );

      // ...and the shape a real arrival takes: a new row in the store. A new row
      // is the one growth a row-count-driven writer would act on.
      messages.set(SESSION_A, [
        ...messages.get(SESSION_A)!,
        buildMessage(1, '2026-01-01T00:00:01.000Z'),
      ]);
      await act(async () => {
        rerender({ session: { id: SESSION_A } as ProjectSession });
      });
      act(() => {
        runFrames();
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      assert.deepEqual(
        container.writes,
        [],
        `a row the wheel's prepend did not ask for must not pull the viewport down; got ${JSON.stringify(container.writes)}`,
      );
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'and must not re-attach the follow behind the user\'s back',
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
