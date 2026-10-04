import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { TurnRailTick } from '@/modules/chat/hooks/useTurnNavigation';
import type { TranscriptContent } from '@/modules/chat/transcript/TranscriptTurnRail';
import { useTranscriptScrub } from '@/modules/chat/context/TranscriptScrubContext';
import {
  aboveForFraction,
  estimateAbove,
  fractionAtAbove,
  rowAtAbove,
  thumbHeightPx,
} from '@/modules/chat/utils/contentHeightModel';
import {
  TRANSCRIPT_SCROLLBAR_INSET_PX,
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
  /** The conversation's own message count — the denominator the drawn length is a share of. */
  totalMessages: number;
  /** The estimated pixel geometry of the conversation and the loaded window. */
  content: TranscriptContent;
  /** Re-reads the estimate from the DOM and returns it — used to place right after a window read. */
  refreshContent?: () => TranscriptContent | null;
  /** Held true while a gesture owns the thumb, so the estimate does not breathe under the pointer. */
  freezeRef: { current: boolean };
};

/**
 * The loaded window's row the pane's top edge sits in, and how far into that
 * row — the O(log n) rect read the per-frame position is taken from.
 *
 * Rows are in content order with increasing tops, so the first row whose bottom
 * is below the pane's top edge is found by binary search. An index equal to the
 * row count means every loaded row sits above the pane's top.
 */
function viewportTopPosition(
  rows: readonly HTMLElement[],
  rowHeights: readonly number[],
  paneTop: number,
): { index: number; ratio: number } {
  const count = rows.length;
  if (count === 0) return { index: 0, ratio: 0 };
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom > paneTop) hi = mid;
    else lo = mid + 1;
  }
  if (lo >= count) return { index: count, ratio: 0 };
  const rect = rows[lo].getBoundingClientRect();
  const height = rect.height > 0 ? rect.height : rowHeights[lo] || 1;
  const ratio = Math.min(1, Math.max(0, (paneTop - rect.top) / height));
  return { index: lo, ratio };
}

/**
 * Rendered by TranscriptTurnRail as the transcript's drawn scrollbar — the
 * transcript's position, in a column of its own at the pane's right edge.
 *
 * Its drawn length is the browser's own rule — `trackHeight * viewportHeight /
 * estimatedTotal`, floored at the grabbable minimum and with no ceiling below the
 * track — and its position is the share of the conversation's estimated pixels
 * already scrolled past, `above / (estimatedTotal - viewportHeight)`. Both come
 * from the same pixel estimate, so they cannot disagree, and neither depends on
 * how many rows happen to be on screen this frame.
 *
 * It is a real `role="scrollbar"` control: draggable by pointer (including
 * touch), clickable, Home/End/PageUp/PageDown/arrow operable, and it reads its
 * value aloud. A drag scrolls the transcript to follow the pointer: inside the
 * loaded window the offset is written directly, and outside it a window is read
 * for the position under the pointer (at most one read in flight, newest position
 * wins) and the content is moved there as soon as it lands. The release commits
 * immediately — there is no rest pause to wait through.
 *
 * While a gesture holds the thumb the estimate is frozen (through `freezeRef`),
 * so the drawn length cannot breathe under the pointer.
 */
export default function TranscriptScrollbar({
  turns,
  currentTurnId,
  onJumpToTurn,
  scrollContainerRef,
  totalMessages,
  content,
  refreshContent,
  freezeRef,
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
  // The thumb length a gesture holds, snapshotted when it begins and cleared when
  // it settles. A window swap underneath a drag rebuilds the estimate (the rows
  // the position reads are replaced), so the *length* cannot be read live under
  // the pointer — it is frozen on this value instead.
  const [frozenLength, setFrozenLength] = useState<number | null>(null);
  // Where the viewport top currently sits on the conversation's estimated pixel
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

  /** The turns' far end on the ordinal scale — the conversation position a fraction names. */
  const lastTurnOrdinal = turns.length > 0 ? turns[turns.length - 1].index : 0;

  /** The turn whose absolute message subscript is nearest an ordinal on the conversation scale. */
  const turnAtMessageOrdinal = useCallback((ordinal: number): TurnRailTick | null => {
    if (turns.length === 0) return null;
    const target = Math.min(totalMessages, Math.max(0, ordinal));
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
  }, [turns, totalMessages]);

  /** Re-reads the transcript's position on the estimated pixel scale. */
  const recompute = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // While a drag holds the thumb the resting position is not drawn from at
    // all — the pointer is — so reading every row's rect each frame would only
    // force a layout for a value nobody is looking at.
    if (dragActiveRef.current) return;
    // A window swap replaces the rows the estimate was built from; until the
    // rebuild lands, the cached elements are detached and their rects read as
    // zero, which would throw the position to the window's end. Hold the last
    // value instead — the rebuild follows within a frame or two.
    if (content.rows.length > 0 && !content.rows[0].isConnected) return;
    const paneTop = container.getBoundingClientRect().top;
    const { index, ratio } = viewportTopPosition(content.rows, content.rowHeights, paneTop);
    const above = content.windowAboveOffset + estimateAbove(content, index, ratio);
    const next = fractionAtAbove(above, content.estimatedTotal, container.clientHeight);
    setScrollFraction(next);
    // The drawn position is written to the element here as well as declared in
    // the render: the state update commits on React's schedule, a frame or two
    // after the scroll it answers, while the position the reader is looking at
    // has to move with the transcript in the same frame.
    const thumb = thumbRef.current;
    if (thumb) {
      thumb.style.transform = `translateY(${next * travelRef.current}px)`;
      thumb.setAttribute('data-scroll-progress', String(next));
      thumb.setAttribute('aria-valuenow', String(Math.round(next * 100)));
    }
  }, [content, scrollContainerRef]);
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

  const finishScrub = useCallback(() => {
    freezeRef.current = false;
    settlingRef.current = false;
    setFrozenLength(null);
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (scrubStartedRef.current) {
      scrubStartedRef.current = false;
      scrub?.end();
    }
    setCommittedFraction(null);
  }, [freezeRef, scrub]);

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
   * The thumb's drawn length, by the browser's own rule against the estimated
   * conversation height: floored so a very long session still draws a grabbable
   * lozenge, and with no ceiling below the track. A gesture that holds the thumb
   * draws the length it captured when it began, so a window swap underneath it
   * cannot move the length.
   */
  const liveThumbHeight = thumbHeightPx(
    content.estimatedTotal,
    content.viewportHeight,
    trackHeight,
    TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX,
  );
  const thumbHeight = frozenLength ?? liveThumbHeight;

  // The scroll-time write needs the travel without waiting for a render.
  useEffect(() => {
    travelRef.current = Math.max(0, trackHeight - thumbHeight);
  });

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
    freezeRef.current = true;
    settlingRef.current = true;
    setFrozenLength(thumbHeight);
    setCommittedFraction(Math.min(1, Math.max(0, fraction)));
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      finishScrub();
    }, PENDING_POSITION_SETTLE_MS);
  }, [finishScrub, freezeRef, thumbHeight]);

  /**
   * Moves the transcript toward the dragged position.
   *
   * The requested fraction names an estimated pixel offset in the whole
   * conversation; the loaded window's own stretch is `[windowAboveOffset,
   * windowAboveOffset + windowHeight]`. Inside it the position is mapped to the
   * owning row's real DOM top and written directly, so the content keeps moving
   * with the pointer. Outside it the nearest offset the window does hold is
   * written first and a window is read for the turn under the pointer; the newest
   * requested position is placed as soon as the read lands, so the pointer keeps
   * its authority over the thumb and the content follows it, never the other way
   * round.
   */
  const placeTarget = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const fraction = targetFractionRef.current;
    // The conversation position a fraction names, on the turn scale the outline
    // indexes on. Used to address the turn a released position must land on.
    const turn = turnAtMessageOrdinal(fraction * lastTurnOrdinal);

    // A committed position (a release or a keyboard step) has to land ON the turn
    // its fraction names, not a few messages from it: a row's own height varies
    // enough on the fixture that the pixel inverse is close but not exact, and the
    // criterion asks for the named turn itself to be visible. So while a commit is
    // settling the turn's own row is centred directly — the same placement the
    // shared jump uses — and its window is read if it is not loaded yet.
    if (settlingRef.current && turn) {
      const anchor = container.querySelector<HTMLElement>(
        `[data-message-anchor-id="${CSS.escape(turn.id)}"]`,
      );
      if (anchor) {
        const paneTop = container.getBoundingClientRect().top;
        const rect = anchor.getBoundingClientRect();
        const rowTop = container.scrollTop + (rect.top - paneTop);
        const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
        const top = Math.max(0, Math.min(rowTop - container.clientHeight / 2, maxTop));
        if (Math.abs(top - container.scrollTop) >= 0.5) scrub?.scrollTo(top);
        finishScrub();
        return;
      }
    }

    // The cached rows are the ones the position must be placed against, but a
    // just-loaded window leaves them detached; re-read the live rows then (and
    // only then, so a drag's every frame does not pay a full re-measure).
    const live = content.rows.length > 0 && !content.rows[0].isConnected
      ? refreshContent?.() ?? content
      : content;
    const targetAbove = aboveForFraction(fraction, live.estimatedTotal, container.clientHeight);
    const relative = targetAbove - live.windowAboveOffset;
    const covered = live.rows.length > 0 && relative >= 0 && relative <= live.windowHeight;
    if (live.rows.length > 0) {
      const clamped = Math.min(Math.max(relative, 0), live.windowHeight);
      const { rowIndex, ratio } = rowAtAbove(live, clamped);
      const row = live.rows[rowIndex];
      if (row) {
        const paneTop = container.getBoundingClientRect().top;
        const rowRect = row.getBoundingClientRect();
        const rowTop = container.scrollTop + (rowRect.top - paneTop);
        const realHeight = rowRect.height > 0 ? rowRect.height : live.rowHeights[rowIndex] || 1;
        const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
        // The target is placed at the viewport's CENTRE — the same convention the
        // shared jump uses, so a released position lands where a clicked tick
        // would. The thumb's own reading is taken at the top edge (the browser's
        // own rule); on a conversation far taller than the viewport the two differ
        // by half a screen out of the whole conversation, which is negligible.
        const top = Math.max(
          0,
          Math.min(rowTop + ratio * realHeight - container.clientHeight / 2, maxTop),
        );
        // Only a real move is written: a write that changes nothing would still
        // owe the pane an echo it never reports, and a drag clamped at a window
        // edge repeats the same offset frame after frame.
        if (Math.abs(top - container.scrollTop) >= 0.5) scrub?.scrollTo(top);
      }
      if (covered) {
        // A release whose position is now placed has settled: the committed
        // fraction has done its job and the thumb may track the transcript
        // again. Left to the arrival check alone it could stick if the reading
        // it compares against is unavailable.
        if (!dragActiveRef.current && settlingRef.current) finishScrub();
        return;
      }
    }
    if (!turn || !scrub) return;
    void scrub.loadWindow(turn.id, fraction * lastTurnOrdinal).then(() => {
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
  }, [content, finishScrub, refreshContent, scrub, scrollContainerRef, totalMessages, turnAtMessageOrdinal]);

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
    freezeRef.current = true;
    settlingRef.current = true;
    setFrozenLength(thumbHeight);
    setCommittedFraction(clamped);
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      const turn = turnAtMessageOrdinal(clamped * lastTurnOrdinal);
      if (turn) onJumpToTurn(turn.id);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        finishScrub();
      }, PENDING_POSITION_SETTLE_MS);
    }, KEYBOARD_COMMIT_PAUSE_MS);
  }, [finishScrub, freezeRef, onJumpToTurn, thumbHeight, totalMessages, turnAtMessageOrdinal]);

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
    freezeRef.current = true;
    setFrozenLength(thumbHeight);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const fraction = shownFraction;
    setDragFraction(fraction);
    setPreviewTurnId(turnAtMessageOrdinal(fraction * lastTurnOrdinal)?.id ?? null);
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
    setPreviewTurnId(turnAtMessageOrdinal(fraction * lastTurnOrdinal)?.id ?? null);
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
      // recomputes and released the freeze, so the arrival check needs the value
      // this release left. The freeze is dropped before the read so the estimate
      // may catch up again.
      freezeRef.current = false;
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
    setPreviewTurnId(turnAtMessageOrdinal(clamped * lastTurnOrdinal)?.id ?? null);
    scheduleCommit(clamped);
  };

  const handleTrackClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Only a click on the track's own blank space is a position request; a click
    // on the thumb is a drag and is stopped at the thumb's own handler.
    if (event.target !== event.currentTarget) return;
    const turn = turnAtMessageOrdinal(fractionFromClientY(event.clientY) * lastTurnOrdinal);
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
      // The estimate the drawn length and position are both taken from, in pixels,
      // together with the average px per message — read by AC-219's evidence.
      data-content-estimate-px={String(Math.round(content.estimatedTotal))}
      data-px-per-message={content.pxPerMessage > 0 ? content.pxPerMessage.toFixed(2) : '0'}
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
