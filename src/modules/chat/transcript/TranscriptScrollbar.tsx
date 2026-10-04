import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { TurnRailTick } from '@/modules/chat/hooks/useTurnNavigation';
import {
  TRANSCRIPT_SCROLLBAR_INSET_PX,
  TRANSCRIPT_SCROLLBAR_MAX_THUMB_RATIO,
  TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX,
  TRANSCRIPT_SCROLLBAR_WIDTH_PX,
} from '@/shared/transcriptEdgeLayout';

/**
 * How long a drag must rest before its final position is fetched.
 *
 * A drag is a continuous gesture — the reader scans the whole conversation while
 * holding the thumb — so reading a page for every pointer position would fetch
 * tens of windows no one asked to see. The pause is what makes the gesture cost
 * one read: released and left alone, the last position is fetched once.
 */
const DRAG_COMMIT_PAUSE_MS = 220;
/**
 * How long a committed position may stay drawn before the thumb tracks the
 * transcript again.
 *
 * The read is in flight while the thumb is already at its destination, so
 * dropping the committed position at release would snap the thumb back to the
 * old window and forward again when the new one lands — a jump the reader sees
 * and that a per-frame reading would record as the thumb moving the wrong way.
 * The bound is long enough for a window read to land and move the current turn
 * (at which point the arrival check below drops the position immediately), and
 * short enough that a read which never lands cannot strand the thumb.
 */
const PENDING_POSITION_SETTLE_MS = 4_000;
/** A PageUp/PageDown keyboard step, as a fraction of the conversation. */
const KEYBOARD_PAGE_STEP = 0.1;

type TranscriptScrollbarProps = {
  /** Every user turn in the conversation, oldest first — the positions the thumb can name. */
  turns: TurnRailTick[];
  /** The turn the viewport currently sits on. */
  currentTurnId: string | null;
  /** Places the turn's message in the viewport through chat's shared jump. */
  onJumpToTurn: (anchorId: string) => void;
  /** The transcript's scroll container, read for the rows the viewport holds. */
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** The session's own message count, the denominator the drawn length is a share of. */
  totalMessages: number;
};

/**
 * The fraction of the conversation a turn sits at, by ordinal.
 *
 * The denominator is the last turn's own absolute message subscript, not the
 * session's total row count: the track's far end is the last turn the reader can
 * jump to, so the fraction reaches 1 exactly there, and every value in between is
 * a ratio of two absolute subscripts — never a ratio of pixels. That is the whole
 * point of the drawn track: a window prepended above the viewport moves neither
 * subscript, so the thumb neither moves nor jitters when rows are inserted or
 * measured.
 */
function progressOfTurnAt(turn: TurnRailTick | undefined, lastTurnIndex: number): number | null {
  if (!turn || lastTurnIndex <= 0) return null;
  return Math.min(1, Math.max(0, turn.index / lastTurnIndex));
}

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
 */
function countViewportMessages(container: HTMLDivElement | null): number {
  if (!container) return 0;
  const paneRect = container.getBoundingClientRect();
  const content = container.querySelector<HTMLElement>('[data-transcript-content]');
  if (!content) return 0;
  let count = 0;
  for (const row of Array.from(content.children)) {
    if (!row.hasAttribute('data-message-timestamp')) continue;
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.bottom <= paneRect.top || rect.top >= paneRect.bottom) continue;
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
 * Its thumb sits at the current turn's absolute-message-subscript fraction of
 * the whole conversation — never at the loaded window's pixel ratio — so a window
 * prepended above the viewport, or a row whose height is measured late, cannot
 * move it. It is a real `role="scrollbar"` control: draggable by pointer
 * (including touch), clickable, Home/End/PageUp/PageDown/arrow operable, and it
 * reads its value aloud. Dragging shows a preview of the turn under the thumb and
 * fetches nothing until the gesture rests.
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
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The track's own drawn height, measured rather than assumed: the thumb's
  // length and its travel are both shares of it.
  const [trackHeight, setTrackHeight] = useState(0);
  // The live drag position, non-null only while a pointer holds the thumb. It is
  // what the thumb is drawn from during the gesture — the position the reader is
  // choosing, which is deliberately ahead of where the window actually is.
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  // The position a released drag (or a keyboard move) committed to, kept until
  // the window it asked for lands. Null whenever the thumb should track the real
  // scroll position again.
  const [committedFraction, setCommittedFraction] = useState<number | null>(null);
  // The turn the drag/keyboard preview floats for, or null when none is shown.
  const [previewTurnId, setPreviewTurnId] = useState<string | null>(null);
  // How many messages the viewport currently holds, read off the rendered rows.
  const [viewportMessages, setViewportMessages] = useState(0);
  const dragActiveRef = useRef(false);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Each turn's absolute message subscript is ordered, so the last one is the track's far end. */
  const lastTurnIndex = turns.length > 0 ? turns[turns.length - 1].index : 0;

  /** Where the thumb belongs when no gesture is overriding it: the current turn's ordinal position. */
  const scrollFraction = useMemo(() => {
    const at = turns.findIndex((turn) => turn.id === currentTurnId);
    const fromTurn = progressOfTurnAt(at >= 0 ? turns[at] : undefined, lastTurnIndex);
    if (fromTurn !== null) return fromTurn;
    // No turn sits above the viewport top: an empty transcript, or one whose
    // first rows are unanchored — the top of the track is the honest answer. A
    // current turn the outline does not name yet (a just-sent prompt awaiting
    // reindex) is by definition the newest, so its place is the far end.
    return currentTurnId === null ? 0 : 1;
  }, [turns, currentTurnId, lastTurnIndex]);

  const shownFraction = dragFraction ?? committedFraction ?? scrollFraction;

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
    setViewportMessages(countViewportMessages(scrollContainerRef.current));
  }, [scrollContainerRef, currentTurnId, totalMessages, turns]);

  // Drop a committed position once the real scroll position has arrived there:
  // from then on the two agree, and the thumb follows the transcript again. The
  // settle timer is the fallback for a jump whose window never moves the current
  // turn (a position already at the edge), so the pending value cannot stick.
  useEffect(() => {
    if (committedFraction === null) return;
    if (Math.abs(scrollFraction - committedFraction) < 0.02) setCommittedFraction(null);
  }, [scrollFraction, committedFraction]);

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

  /**
   * The turn whose absolute subscript is nearest a fraction of the conversation.
   *
   * Resolved against the ticks' *subscripts* rather than their positions in the
   * array: a turn that drew many rows occupies more of the conversation than a
   * short one, and the thumb the reader aimed is a position in the conversation,
   * not a slot in the list. On a uniform transcript the two agree; on a real one
   * they do not, and this is the one the criterion reads.
   */
  const turnAtFraction = useCallback((fraction: number): TurnRailTick | null => {
    if (turns.length === 0) return null;
    const clamped = Math.min(1, Math.max(0, fraction));
    const target = clamped * lastTurnIndex;
    let nearest = turns[0];
    let nearestDistance = Math.abs(nearest.index - target);
    for (const turn of turns) {
      const distance = Math.abs(turn.index - target);
      if (distance < nearestDistance) {
        nearest = turn;
        nearestDistance = distance;
      }
    }
    return nearest;
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

  /** Places a gesture's chosen turn and keeps the thumb there until the window it asked for lands. */
  const commitTurn = useCallback((turn: TurnRailTick, fraction: number) => {
    setCommittedFraction(Math.min(1, Math.max(0, fraction)));
    onJumpToTurn(turn.id);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setCommittedFraction(null);
    }, PENDING_POSITION_SETTLE_MS);
  }, [onJumpToTurn]);

  /**
   * Arms the one read a drag or a keyboard step is allowed, cancelled by the
   * next gesture. The turn is resolved at fire time so a gesture still in
   * progress is never turned into a read.
   */
  const scheduleCommit = useCallback((fraction: number) => {
    setCommittedFraction(fraction);
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      const turn = turnAtFraction(fraction);
      if (turn) commitTurn(turn, fraction);
    }, DRAG_COMMIT_PAUSE_MS);
  }, [commitTurn, turnAtFraction]);

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    dragActiveRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragFraction(shownFraction);
    setPreviewTurnId(turnAtFraction(shownFraction)?.id ?? null);
  };

  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return;
    const fraction = fractionFromClientY(event.clientY);
    setDragFraction(fraction);
    setPreviewTurnId(turnAtFraction(fraction)?.id ?? null);
  };

  const endThumbDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return;
    dragActiveRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const fraction = fractionFromClientY(event.clientY);
    setDragFraction(null);
    setPreviewTurnId(null);
    scheduleCommit(fraction);
  };

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

  return (
    <div
      ref={trackRef}
      data-scrollbar-track
      onClick={handleTrackClick}
      className="pointer-events-auto absolute bottom-0 top-0 z-30 cursor-pointer"
      style={{ right: TRANSCRIPT_SCROLLBAR_INSET_PX, width: TRANSCRIPT_SCROLLBAR_WIDTH_PX + 4 }}
    >
      <div
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
        className="absolute right-0 rounded-full bg-foreground/45 transition-colors hover:bg-foreground/70 focus:bg-primary focus:outline-none"
        style={{
          width: TRANSCRIPT_SCROLLBAR_WIDTH_PX,
          height: thumbHeight,
          top: `${shownFraction * 100}%`,
          transform: `translateY(-${shownFraction * 100}%)`,
          // A drag on the thumb must move the thumb, not scroll the pane under it.
          touchAction: 'none',
        }}
      />
      {/*
        The turn the reader is choosing while dragging or stepping. It carries the
        turn's summary and time so the position is identifiable before the window
        is fetched; the jump itself happens only once the gesture rests.
      */}
      {previewTurn && (
        <span
          data-scrollbar-preview
          className="pointer-events-none absolute right-full mr-2 flex -translate-y-1/2 flex-col rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground shadow-sm"
          style={{ top: `${shownFraction * 100}%` }}
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
