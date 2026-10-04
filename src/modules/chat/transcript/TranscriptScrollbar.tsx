import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { TurnRailTick } from '@/modules/chat/hooks/useTurnNavigation';
import { useTranscriptScrub } from '@/modules/chat/context/TranscriptScrubContext';
import {
  closestScrollTopForFraction,
  fractionAtViewportCenter,
} from '@/modules/chat/utils/scrollOrdinalMap';
import type { ScrollOrdinalRow } from '@/modules/chat/utils/scrollOrdinalMap';
import {
  TRANSCRIPT_SCROLLBAR_INSET_PX,
  TRANSCRIPT_SCROLLBAR_MAX_THUMB_RATIO,
  TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX,
  TRANSCRIPT_SCROLLBAR_WIDTH_PX,
} from '@/shared/transcriptEdgeLayout';

/**
 * How long a keyboard step rests before its jump is issued.
 *
 * A keyboard move is discrete — one press, one turn — so a rapid burst of key
 * repeats is coalesced into the last position pressed. This is only the keyboard
 * path: a pointer drag commits the instant it is released, because the content
 * is already being scrolled to follow it and there is nothing to wait for.
 */
const KEYBOARD_COMMIT_PAUSE_MS = 120;
/**
 * How long a committed position may stay drawn before the thumb tracks the
 * transcript again.
 *
 * A drag or a jump leaves the window read in flight while the thumb is already
 * at its destination; dropping the committed position at release would snap the
 * thumb back to the old window and forward again when the new one lands. The
 * bound is long enough for a window read to land (at which point the arrival
 * check drops the position immediately) and short enough that a read which never
 * lands cannot strand the thumb.
 */
const PENDING_POSITION_SETTLE_MS = 4_000;
/** A PageUp/PageDown keyboard step, as a fraction of the conversation. */
const KEYBOARD_PAGE_STEP = 0.1;
/** How close the transcript must come to a committed fraction for the commit to be considered landed. */
const COMMIT_ARRIVAL_TOLERANCE = 0.02;

type TranscriptScrollbarProps = {
  /** Every user turn in the conversation, oldest first — the positions the thumb can name. */
  turns: TurnRailTick[];
  /** The turn the viewport currently sits on, used only until the window's rows are measurable. */
  currentTurnId: string | null;
  /** Places the turn's message in the viewport through chat's shared jump. */
  onJumpToTurn: (anchorId: string) => void;
  /** The transcript's scroll container, read for the rows the viewport holds. */
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** The session's own message count, the denominator the drawn length is a share of. */
  totalMessages: number;
};

/**
 * How many messages the rows currently intersecting the viewport stand for.
 *
 * A row is one message, except a work segment, which folds its members behind a
 * single row and publishes how many it stands for; that count is read from the
 * row's own `data-transcript-row-messages` rather than assumed, so a collapsed
 * run of tool calls counts as the many messages it is. Rows are addressed
 * through the content column's direct children — the lazy-row wrappers, the ones
 * that carry a timestamp, since the column also holds the loading overlays and
 * the running turn's status line — because a mounted row's own content carries
 * the same timestamp attribute and would otherwise be counted twice.
 *
 * The first row at or below the pane's top edge is found by binary search and the
 * count walks forward from there until the first row past its bottom, so a read
 * costs the visible rows plus a logarithm, not every row the window holds — this
 * runs on every turn change, which a fast drag makes every frame.
 */
function countViewportMessages(container: HTMLDivElement | null): number {
  if (!container) return 0;
  const paneRect = container.getBoundingClientRect();
  const content = container.querySelector<HTMLElement>('[data-transcript-content]');
  if (!content) return 0;
  const children = Array.from(content.children) as HTMLElement[];
  let lo = 0;
  let hi = children.length;
  let start = children.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (children[mid].getBoundingClientRect().bottom > paneRect.top) {
      start = mid;
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  let count = 0;
  for (let index = start; index < children.length; index += 1) {
    const row = children[index];
    if (!row.hasAttribute('data-message-timestamp')) continue;
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.top >= paneRect.bottom) break;
    const declared = Number.parseInt(
      row.querySelector<HTMLElement>('[data-transcript-row-messages]')?.dataset.transcriptRowMessages ?? '1',
      10,
    );
    count += Number.isFinite(declared) && declared > 0 ? declared : 1;
  }
  return count;
}

/**
 * Rendered by TranscriptTurnRail as the transcript's drawn scrollbar — the
 * transcript's position, in a column of its own at the pane's right edge.
 *
 * Its thumb sits at the viewport centre's continuous position on the
 * conversation's ordinal scale — interpolated between the loaded window's turn
 * rows, so it moves with the transcript frame by frame rather than in stairs —
 * and never at the loaded window's pixel ratio, so a window prepended above the
 * viewport, or a row measured late, cannot jump it. It is a real
 * `role="scrollbar"` control: draggable by pointer (including touch), clickable,
 * Home/End/PageUp/PageDown/arrow operable, and it reads its value aloud.
 *
 * A drag scrolls the transcript to follow the pointer: inside the loaded window
 * the offset is written directly, and outside it a window is read for the
 * position under the pointer (at most one read in flight, newest position wins)
 * and the content is moved there as soon as it lands. The release commits
 * immediately — there is no rest pause to wait through.
 *
 * Its drawn length is the share of the conversation the viewport is showing —
 * clamped so it is always legible and never more than a quarter of the track —
 * rather than a fixed size, so a short session's thumb is long and a long one's
 * is a short lozenge.
 */
export default function TranscriptScrollbar({
  turns,
  currentTurnId,
  onJumpToTurn,
  scrollContainerRef,
  totalMessages,
}: TranscriptScrollbarProps) {
  const { t } = useTranslation('chat');
  const scrub = useTranscriptScrub();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  /** The thumb's travel (track less its own length), mirrored for the scroll-time write. */
  const travelRef = useRef(0);
  // The track's own drawn height, measured rather than assumed: the thumb's
  // length and its travel are both shares of it.
  const [trackHeight, setTrackHeight] = useState(0);
  // The live drag position, non-null only while a pointer holds the thumb. It is
  // what the thumb is drawn from during the gesture — the position the reader is
  // choosing, which the content is moved to follow.
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  // The position a released drag or a keyboard move committed to, kept until the
  // transcript has arrived there. Null whenever the thumb should track the real
  // scroll position again.
  const [committedFraction, setCommittedFraction] = useState<number | null>(null);
  // The turn the drag/keyboard preview floats for, or null when none is shown.
  const [previewTurnId, setPreviewTurnId] = useState<string | null>(null);
  // How many messages the viewport currently holds, read off the rendered rows.
  const [viewportMessages, setViewportMessages] = useState(0);
  // Where the viewport centre currently sits on the conversation's ordinal
  // scale, recomputed once a frame while the transcript moves. Null until the
  // window's rows can be measured.
  const [scrollFraction, setScrollFraction] = useState<number | null>(null);

  const dragActiveRef = useRef(false);
  // Mirrors `dragActiveRef` for the drawn track's own `data-scrub-dragging`, so a
  // test (or a debugger) can see whether a gesture is still holding the thumb.
  const [dragging, setDragging] = useState(false);
  // True from a release/keyboard commit until the transcript arrives there, so a
  // window read that lands afterwards still places the released position.
  const settlingRef = useRef(false);
  // The fraction the drag or release most recently asked for, so a window read
  // places the newest position rather than the one that triggered the read.
  const targetFractionRef = useRef(0);
  const scrubStartedRef = useRef(false);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placeTargetRef = useRef<() => void>(() => {});

  /** Each turn's absolute message subscript is ordered, so the last one is the track's far end. */
  const lastTurnIndex = turns.length > 0 ? turns[turns.length - 1].index : 0;
  /** Turn id to absolute subscript, so a DOM row can be placed on the scale. */
  const ordinalById = useMemo(
    () => new Map(turns.map((turn) => [turn.id, turn.index])),
    [turns],
  );

  /**
   * The loaded window's user-turn rows, on the ordinal scale and in content
   * coordinates — the input the continuous position map interpolates.
   */
  const readRows = useCallback((): ScrollOrdinalRow[] => {
    const container = scrollContainerRef.current;
    if (!container) return [];
    const paneTop = container.getBoundingClientRect().top;
    const base = container.scrollTop;
    const rows: ScrollOrdinalRow[] = [];
    for (const element of container.querySelectorAll<HTMLElement>('[data-message-anchor-id]')) {
      const id = element.getAttribute('data-message-anchor-id');
      const ordinal = id === null ? undefined : ordinalById.get(id);
      if (ordinal === undefined) continue;
      rows.push({ ordinal, top: base + (element.getBoundingClientRect().top - paneTop) });
    }
    return rows;
  }, [ordinalById, scrollContainerRef]);

  /** Re-reads the transcript's position on the conversation scale. */
  const recompute = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // While a drag holds the thumb the resting position is not drawn from at
    // all — the pointer is — so reading every row's rect each frame would only
    // force a layout for a value nobody is looking at.
    if (dragActiveRef.current) return;
    const next = fractionAtViewportCenter(
      readRows(), container.scrollTop, container.clientHeight, lastTurnIndex,
    );
    setScrollFraction(next);
    // The drawn position is written to the element here as well as declared in
    // the render: the state update commits on React's schedule, a frame or two
    // after the scroll it answers, while the position the reader is looking at
    // has to move with the transcript in the same frame.
    const thumb = thumbRef.current;
    if (thumb && next !== null) {
      thumb.style.transform = `translateY(${next * travelRef.current}px)`;
      thumb.setAttribute('data-scroll-progress', String(next));
      thumb.setAttribute('aria-valuenow', String(Math.round(next * 100)));
    }
  }, [lastTurnIndex, readRows, scrollContainerRef]);
  /** The always-current recompute, so the scroll listener never holds a stale one. */
  const recomputeRef = useRef(recompute);

  useEffect(() => {
    recomputeRef.current = recompute;
  }, [recompute]);

  /**
   * Re-reads the drawn position for a scroll report.
   *
   * Synchronous with the report rather than deferred to a frame: the transcript's
   * own `scroll` handling is read in the same frame by anything measuring the
   * drawn position, and a frame of lag there reads as the thumb standing still
   * while the content moves.
   */
  const scheduleRecompute = useCallback(() => {
    recomputeRef.current();
  }, []);

  // The drawn position tracks every scroll report. Attached once: the handler
  // reads the current recompute through the ref, so a re-render cannot leave the
  // transcript with a listener that has been detached and not put back.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    const onScroll = () => scheduleRecompute();
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [scrollContainerRef, scheduleRecompute]);

  const shownFraction = dragFraction ?? committedFraction ?? scrollFraction ?? (
    currentTurnId === null ? 0 : 1
  );

  // The track's height, kept current through a resize of the pane it is drawn in.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    const measure = () => setTrackHeight(track.getBoundingClientRect().height);
    measure();
    // jsdom ships no ResizeObserver; there the track keeps the height measured above.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(track);
    return () => observer?.disconnect();
  }, []);

  // What the viewport is showing, re-read whenever the transcript moves: the
  // current turn changes on every scroll frame, which is exactly when the visible
  // rows change.
  useEffect(() => {
    // The drawn length is not read while a drag holds the thumb — the thumb is
    // under the pointer — so re-counting the viewport's messages on every turn
    // change during the gesture would force a layout for a value nobody sees.
    if (dragActiveRef.current) return;
    setViewportMessages(countViewportMessages(scrollContainerRef.current));
  }, [scrollContainerRef, currentTurnId, totalMessages, turns]);

  // The drawn position tracks every scroll report, and every commit (a window
  // read replaces the rows without necessarily raising a `scroll` this component
  // observes). Re-asserted after every render rather than attached once: the
  // container ref can be null on the first commit, and a listener that was never
  // attached leaves the drawn position frozen on everything but a turn change.
  useEffect(() => {
    const container = scrollContainerRef.current;
    const onScroll = () => scheduleRecompute();
    scheduleRecompute();
    if (!container) return undefined;
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  });

  const finishScrub = useCallback(() => {
    settlingRef.current = false;
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (scrubStartedRef.current) {
      scrubStartedRef.current = false;
      scrub?.end();
    }
    setCommittedFraction(null);
  }, [scrub]);

  // Drop a committed position once the real position has arrived there: from
  // then on the two agree, and the thumb follows the transcript again. The
  // settle timer is the fallback for a jump whose window never moves the
  // position (a target already at the edge), so the pending value cannot stick.
  useEffect(() => {
    if (committedFraction === null) return;
    // A drag is still choosing: the arrival of a position the pointer has already
    // left is not the release settling.
    if (dragActiveRef.current) return;
    if (scrollFraction !== null && Math.abs(scrollFraction - committedFraction) < COMMIT_ARRIVAL_TOLERANCE) {
      finishScrub();
    }
  }, [scrollFraction, committedFraction, finishScrub]);

  useEffect(() => () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  /**
   * The thumb's drawn length: the share of the conversation the viewport holds,
   * floored so a very long session still draws a grabbable lozenge and capped so
   * a very short one cannot fill the track.
   */
  const thumbHeight = useMemo(() => {
    if (trackHeight <= 0) return TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX;
    const share = totalMessages > 0 ? viewportMessages / totalMessages : 1;
    const raw = share * trackHeight;
    return Math.round(
      Math.min(
        Math.max(raw, TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX),
        trackHeight * TRANSCRIPT_SCROLLBAR_MAX_THUMB_RATIO,
      ),
    );
  }, [trackHeight, totalMessages, viewportMessages]);

  // The scroll-time write needs the travel without waiting for a render.
  useEffect(() => {
    travelRef.current = Math.max(0, trackHeight - thumbHeight);
  });

  /**
   * The turn whose absolute subscript is nearest a fraction of the conversation.
   *
   * Resolved against the ticks' *subscripts* rather than their positions in the
   * array: a turn that drew many rows occupies more of the conversation than a
   * short one, and the thumb the reader aimed is a position in the conversation,
   * not a slot in the list. The ticks are ordered by subscript, so the nearest is
   * found by binary search — a pointer frame must not scan every turn.
   */
  const turnAtFraction = useCallback((fraction: number): TurnRailTick | null => {
    if (turns.length === 0) return null;
    const target = Math.min(1, Math.max(0, fraction)) * lastTurnIndex;
    let lo = 0;
    let hi = turns.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (turns[mid].index < target) lo = mid + 1;
      else hi = mid;
    }
    const above = turns[lo];
    const below = lo > 0 ? turns[lo - 1] : above;
    return Math.abs(above.index - target) <= Math.abs(below.index - target) ? above : below;
  }, [turns, lastTurnIndex]);

  /**
   * The fraction of the track a pointer height names, inverted through the
   * thumb's own geometry: the pointer grabs the thumb by its centre, so the top
   * of the thumb is half its length above the pointer and the usable travel is
   * the track's height less the thumb's.
   */
  const fractionFromClientY = useCallback((clientY: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const travel = Math.max(1, rect.height - thumbHeight);
    return Math.min(1, Math.max(0, (clientY - rect.top - thumbHeight / 2) / travel));
  }, [thumbHeight]);

  /** Keeps the thumb at a chosen position until the transcript has arrived there. */
  const commitPosition = useCallback((fraction: number) => {
    settlingRef.current = true;
    setCommittedFraction(Math.min(1, Math.max(0, fraction)));
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      finishScrub();
    }, PENDING_POSITION_SETTLE_MS);
  }, [finishScrub]);

  /**
   * Moves the transcript toward the dragged position.
   *
   * Inside the loaded window this is one scroll write. Outside it, the nearest
   * offset the window does hold is written first — so the content keeps moving
   * with the pointer instead of stalling — and a window is read for the turn
   * under the pointer; the newest requested position is placed as soon as the
   * read lands, so the pointer keeps its authority over the thumb and the
   * content follows it, never the other way round.
   */
  const placeTarget = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const fraction = targetFractionRef.current;
    const nearest = closestScrollTopForFraction(readRows(), fraction, lastTurnIndex, container.clientHeight);
    if (nearest) {
      const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
      const top = Math.max(0, Math.min(nearest.top, maxTop));
      // Only a real move is written: a write that changes nothing would still
      // owe the pane an echo it never reports, and a drag clamped at a window
      // edge repeats the same offset frame after frame.
      if (Math.abs(top - container.scrollTop) >= 0.5) scrub?.scrollTo(top);
      if (nearest.covered) {
        // A release whose position is now placed has settled: the committed
        // fraction has done its job and the thumb may track the transcript
        // again. Left to the arrival check alone it could stick if the reading
        // it compares against is unavailable.
        if (!dragActiveRef.current && settlingRef.current) finishScrub();
        return;
      }
    }
    const turn = turnAtFraction(fraction);
    if (!turn || !scrub) return;
    void scrub.loadWindow(turn.id, fraction * lastTurnIndex).then(() => {
      if (!dragActiveRef.current && !settlingRef.current) return;
      // The read's window has to be committed by React before its rows exist to
      // place against, and a cache hit resolves without any commit at all — so
      // the retry waits a frame instead of re-reading the rows the read is about
      // to replace.
      requestAnimationFrame(() => {
        if (!dragActiveRef.current && !settlingRef.current) return;
        placeTargetRef.current();
      });
    });
  }, [finishScrub, lastTurnIndex, readRows, scrub, scrollContainerRef, turnAtFraction]);

  useEffect(() => {
    placeTargetRef.current = placeTarget;
  }, [placeTarget]);

  /**
   * Arms a keyboard step's jump, coalescing a burst of key repeats into the last
   * position pressed. The thumb takes the pressed position at once, so the key
   * reads as moving the control even before its window lands.
   */
  const scheduleCommit = useCallback((fraction: number) => {
    const clamped = Math.min(1, Math.max(0, fraction));
    settlingRef.current = true;
    setCommittedFraction(clamped);
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      const turn = turnAtFraction(clamped);
      if (turn) onJumpToTurn(turn.id);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        finishScrub();
      }, PENDING_POSITION_SETTLE_MS);
    }, KEYBOARD_COMMIT_PAUSE_MS);
  }, [finishScrub, onJumpToTurn, turnAtFraction]);

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    // A new gesture supersedes whatever the last one had committed to.
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    settlingRef.current = false;
    setCommittedFraction(null);
    dragActiveRef.current = true;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const fraction = shownFraction;
    setDragFraction(fraction);
    setPreviewTurnId(turnAtFraction(fraction)?.id ?? null);
    targetFractionRef.current = fraction;
    if (scrub) {
      // Idempotent: a new gesture re-asserts the pointer's ownership even if a
      // previous one had not yet released it.
      scrubStartedRef.current = true;
      scrub.start();
    }
  };

  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return;
    const fraction = fractionFromClientY(event.clientY);
    setDragFraction(fraction);
    setPreviewTurnId(turnAtFraction(fraction)?.id ?? null);
    targetFractionRef.current = fraction;
    if (scrub) placeTarget();
  };

  const endThumbDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDrag();
  };

  /**
   * Ends a drag wherever the pointer let go.
   *
   * The thumb's own `pointerup` is the normal route, but a gesture can end
   * off the captured node (a node replaced mid-drag, a capture the browser
   * drops), and a drag that never ends leaves the thumb pinned to the pointer
   * and the transcript's own follow suppressed for the rest of the session.
   * The window-level report is the guarantee that cannot be missed.
   */
  const finishDrag = () => {
    if (!dragActiveRef.current) return;
    dragActiveRef.current = false;
    setDragging(false);
    const fraction = targetFractionRef.current;
    setDragFraction(null);
    setPreviewTurnId(null);
    if (scrub) {
      // No rest pause: the content has already been following the pointer, so the
      // release only has to settle the last position.
      commitPosition(fraction);
      placeTarget();
      // The resting position is re-read at once — the drag suppressed its own
      // recomputes, and the arrival check needs the value this release left.
      recompute();
    } else {
      // A render with no scrub control keeps the previous debounced commit.
      scheduleCommit(fraction);
    }
  };

  useEffect(() => {
    const onWindowPointerUp = () => {
      if (!dragActiveRef.current) return;
      finishDrag();
    };
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
    return () => {
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
    };
  });

  const handleThumbKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const arrowStep = turns.length > 1 ? 1 / (turns.length - 1) : KEYBOARD_PAGE_STEP;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = shownFraction + arrowStep;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = shownFraction - arrowStep;
        break;
      case 'PageDown':
        next = shownFraction + KEYBOARD_PAGE_STEP;
        break;
      case 'PageUp':
        next = shownFraction - KEYBOARD_PAGE_STEP;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const clamped = Math.min(1, Math.max(0, next));
    setPreviewTurnId(turnAtFraction(clamped)?.id ?? null);
    scheduleCommit(clamped);
  };

  const handleTrackClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Only a click on the track's own blank space is a position request; a click
    // on the thumb is a drag and is stopped at the thumb's own handler.
    if (event.target !== event.currentTarget) return;
    const turn = turnAtFraction(fractionFromClientY(event.clientY));
    if (!turn) return;
    setPreviewTurnId(null);
    // A click asserts no position of its own: it is one immediate jump, and the
    // thumb belongs wherever the window it asked for actually lands. Only a
    // gesture (a drag, an arrow/page key) holds a chosen position, because there
    // is no content behind it until it rests.
    onJumpToTurn(turn.id);
  };

  const previewTurnOrdinal = previewTurnId
    ? turns.findIndex((turn) => turn.id === previewTurnId)
    : -1;
  const previewTurn = previewTurnOrdinal >= 0 ? turns[previewTurnOrdinal] : null;

  // The thumb's travel is the track less its own length, and it is positioned by
  // transform alone so a moving thumb never re-runs layout for the track.
  const thumbTravel = Math.max(0, trackHeight - thumbHeight);
  const thumbTop = shownFraction * thumbTravel;

  return (
    <div
      ref={trackRef}
      data-scrollbar-track
      data-scrub-dragging={dragging ? 'true' : 'false'}
      onClick={handleTrackClick}
      className="pointer-events-auto absolute bottom-0 top-0 z-30 cursor-pointer"
      style={{ right: TRANSCRIPT_SCROLLBAR_INSET_PX, width: TRANSCRIPT_SCROLLBAR_WIDTH_PX + 4 }}
    >
      <div
        ref={thumbRef}
        role="scrollbar"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t('turnRail.scrollbar', { defaultValue: 'Conversation scrollbar' })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shownFraction * 100)}
        data-scrollbar-thumb
        data-scroll-progress={shownFraction}
        onPointerDown={handleThumbPointerDown}
        onPointerMove={handleThumbPointerMove}
        onPointerUp={endThumbDrag}
        onPointerCancel={endThumbDrag}
        onKeyDown={handleThumbKeyDown}
        className="absolute right-0 top-0 rounded-full bg-foreground/45 transition-colors hover:bg-foreground/70 focus:bg-primary focus:outline-none"
        style={{
          width: TRANSCRIPT_SCROLLBAR_WIDTH_PX,
          height: thumbHeight,
          transform: `translateY(${thumbTop}px)`,
          // A drag on the thumb must move the thumb, not scroll the pane under it.
          touchAction: 'none',
        }}
      />
      {/*
        The turn the reader is choosing while dragging or stepping. It carries the
        turn's summary and time so the position is identifiable before the window
        is fetched.
      */}
      {previewTurn && (
        <span
          data-scrollbar-preview
          className="pointer-events-none absolute right-full mr-2 flex -translate-y-1/2 flex-col rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground shadow-sm"
          style={{ top: thumbTop + thumbHeight / 2 }}
        >
          <span className="font-medium">
            {t('turnRail.turn', { n: previewTurnOrdinal + 1 })}
            <span className="ml-2 font-normal text-muted-foreground">
              {new Date(previewTurn.timestamp).toLocaleString()}
            </span>
          </span>
          {previewTurn.preview && (
            <span className="max-w-56 truncate text-muted-foreground">{previewTurn.preview}</span>
          )}
        </span>
      )}
    </div>
  );
}
