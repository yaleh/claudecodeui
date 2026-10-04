import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { TurnRailTick } from '@/modules/chat/hooks/useTurnNavigation';

type TranscriptTurnRailProps = {
  /** Every user turn in the conversation, oldest first — the rail's ticks. */
  turns: TurnRailTick[];
  /** The turn the viewport currently sits on, emphasised so the reader knows where they are. */
  currentTurnId: string | null;
  /** Places the turn's message in the viewport through chat's shared jump. */
  onJumpToTurn: (anchorId: string) => void;
};

/** The drawn thumb's fixed length, in CSS pixels; the track it slides in is the rail's own box. */
const SCROLLBAR_THUMB_PX = 40;
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
 * Used by chat's ChatMessagesPane as the transcript's turn navigation and its
 * global scrollbar in one strip down the pane's right edge.
 *
 * Navigation: a tick per user turn (from the session outline, so a turn the
 * client never loaded is still offered), floated summary on hover or focus, click
 * to jump.
 *
 * Scrollbar: a drawn thumb whose position is the current turn's *absolute message
 * subscript* over the last turn's, so it reflects the whole conversation rather
 * than the loaded window's pixels. It is a real `role="scrollbar"` control:
 * draggable by pointer (including touch), Home/End/PageUp/PageDown/arrow
 * operable, and it reads its value aloud. Dragging shows a preview of the turn
 * under the thumb and fetches nothing until the gesture rests.
 *
 * A click is resolved by *position*, not by which tick's box was hit. On a long
 * conversation the ticks are a fraction of a pixel apart (1200 turns in a
 * ~1000px rail), so no per-tick box is a reliable pointer target — the browser
 * rounds the hit test onto a neighbour. The rail therefore maps the pointer's
 * height to the nearest turn itself, which is the same answer a proportional
 * minimap gives and is exact at any density. The buttons keep taking focus and
 * Enter for keyboard use; only pointer hit-testing is bypassed.
  *
 * Hidden for a short conversation (fewer than three turns). The per-turn ticks
 * are desktop-only (touch has no hover to float a preview), but the scrollbar
 * itself is drawn at every width, which is how a touch viewport drags it.
 */
export default function TranscriptTurnRail({
  turns,
  currentTurnId,
  onJumpToTurn,
}: TranscriptTurnRailProps) {
  const { t } = useTranslation('chat');
  const railRef = useRef<HTMLElement | null>(null);
  /** The ticks' own column, kept apart from the thumb so hit-testing cannot see the thumb as a tick. */
  const ticksRef = useRef<HTMLDivElement | null>(null);
  // The tick the pointer is over, so its summary floats beside the rail. Held in
  // state rather than read from `:hover` because the ticks take no pointer
  // events — the rail itself is the hover surface — and it is what the preview
  // bubble renders from.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
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
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    const travel = Math.max(1, rect.height - SCROLLBAR_THUMB_PX);
    return Math.min(1, Math.max(0, (clientY - rect.top - SCROLLBAR_THUMB_PX / 2) / travel));
  }, []);

  /**
   * The turn whose tick the pointer is in, read from the ticks' own laid-out
   * boxes rather than from a uniform ratio.
   *
   * On a long conversation a tick is a fraction of a pixel tall and the browser
   * rounds each one's position as it lays the column out; recomputing "which
   * slot is this pixel?" from `height / count` drifts against that rounding by
   * more than a slot, so a click on one of two adjacent ticks lands on the
   * other. The ticks are ordered, so their boxes are monotonic in `clientY` and
   * the one spanning the pointer is found by bisection — exact at any density.
   * Returns null when no ticks are laid out (a narrow viewport hides them, and
   * their boxes then measure zero), so the caller falls back to the ordinal map.
   */
  const turnAt = useCallback((clientY: number): TurnRailTick | null => {
    const ticks = ticksRef.current?.children;
    if (!ticks || ticks.length === 0) return null;
    const firstBox = (ticks[0] as HTMLElement).getBoundingClientRect();
    if (firstBox.height <= 0) return null;

    let low = 0;
    let high = ticks.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const rect = (ticks[middle] as HTMLElement).getBoundingClientRect();
      if (clientY < rect.top) {
        high = middle - 1;
      } else if (clientY >= rect.bottom) {
        low = middle + 1;
      } else {
        found = middle;
        break;
      }
    }

    // A pointer above the first tick or below the last clamps to that end.
    if (found < 0) {
      const firstTop = (ticks[0] as HTMLElement).getBoundingClientRect().top;
      found = clientY < firstTop ? 0 : ticks.length - 1;
    }

    return turns[found] ?? null;
  }, [turns]);

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

  const handleTrackClick = (event: ReactMouseEvent<HTMLElement>) => {
    // A keyboard Enter on a focused tick bubbles here as a click with the button
    // as its target; that tick's own handler already placed it, so the track
    // handler answers only the clicks that arrived on the rail itself. A click on
    // the thumb is a drag, not a track click, and is stopped at its own handler.
    if (event.target !== event.currentTarget) return;
    const fraction = fractionFromClientY(event.clientY);
    // The tick under the pointer is the destination when there is one — it is
    // exact at any density — and the ordinal map answers where the ticks are not
    // laid out (a touch viewport).
    const turn = turnAt(event.clientY) ?? turnAtFraction(fraction);
    if (!turn) return;
    setPreviewTurnId(null);
    // A click — and a tick activated by the keyboard — asserts no position of its
    // own: it is one immediate jump, and the thumb belongs wherever the window it
    // asked for actually lands. Only a gesture (a drag, an arrow/page key) holds a
    // chosen position, because there is no content behind it until it rests.
    onJumpToTurn(turn.id);
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    if (dragActiveRef.current) return;
    const next = turnAt(event.clientY)?.id ?? null;
    setHoveredId((previous) => (previous === next ? previous : next));
  };

  if (turns.length < 3) {
    return null;
  }

  const previewTurnOrdinal = previewTurnId
    ? turns.findIndex((turn) => turn.id === previewTurnId)
    : -1;
  const previewTurn = previewTurnOrdinal >= 0 ? turns[previewTurnOrdinal] : null;

  return (
    <nav
      ref={railRef}
      aria-label={t('turnRail.label', { defaultValue: 'Conversation turns' })}
      data-turn-count={turns.length}
      data-scrollbar-track
      onClick={handleTrackClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredId(null)}
      className="absolute bottom-4 right-1 top-4 z-20 flex w-4 cursor-pointer justify-end"
    >
      <div
        ref={ticksRef}
        className="pointer-events-none absolute inset-0 hidden flex-col items-end md:flex"
      >
        {turns.map((turn, ordinal) => {
          const isCurrent = turn.id === currentTurnId;
          const isHovered = turn.id === hoveredId;
          return (
            <button
              key={turn.id}
              type="button"
              data-turn-index={turn.index}
              data-turn-id={turn.id}
              // The reader-facing turn number is the turn's place in the outline,
              // not its message subscript: `index` counts transcript rows, so a
              // session whose turns draw several rows each would number its turns
              // 1, 4, 7 rather than 1, 2, 3.
              aria-label={t('turnRail.jumpToTurn', { n: ordinal + 1 })}
              aria-current={isCurrent ? 'true' : undefined}
              onClick={() => onJumpToTurn(turn.id)}
              onFocus={() => setHoveredId(turn.id)}
              onBlur={() => setHoveredId((previous) => (previous === turn.id ? null : previous))}
              className="pointer-events-none relative flex w-4 shrink-0 items-stretch justify-end p-0 focus:outline-none"
              style={{ flex: '1 1 0', minHeight: 0 }}
            >
              <span
                className={`turn-rail-tick block h-full rounded-full transition-colors ${
                  isCurrent
                    ? 'w-3.5 bg-primary'
                    : 'w-1.5 bg-muted-foreground/40'
                }`}
              />
              {/* The hover/focus summary rides its own tick, so it reads beside the
                  turn the pointer is actually on. Suppressed while a drag preview
                  is up, which is the same reading at a chosen position. */}
              {isHovered && !previewTurnId && (
                <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground shadow-sm">
                  <span className="font-medium">{t('turnRail.turn', { n: ordinal + 1 })}</span>
                  {turn.preview && <span className="ml-2 text-muted-foreground">{turn.preview}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/*
        The scrollbar thumb. A real focusable `role="scrollbar"`, positioned by
        the ordinal fraction (never by scrollTop/scrollHeight), so a prepend or a
        late row measurement cannot move it. Drawn at every width — the ticks
        above are the desktop-only decoration, the thumb is the control touch
        uses.
      */}
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
        className="absolute right-0.5 z-30 w-3 rounded-full bg-foreground/45 transition-colors hover:bg-foreground/70 focus:bg-primary focus:outline-none"
        style={{
          height: SCROLLBAR_THUMB_PX,
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
    </nav>
  );
}
