import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { TurnRailTick } from '@/modules/chat/hooks/useTurnNavigation';
import { currentTurnOrdinal, visibleTickWindow } from '@/modules/chat/utils/turnTickWindow';
import {
  TRANSCRIPT_TICK_COLUMN_INSET_PX,
  TRANSCRIPT_TICK_COLUMN_WIDTH_PX,
  TRANSCRIPT_TICK_SPACING_PX,
} from '@/shared/transcriptEdgeLayout';

/** How much wheel travel moves the window by one turn, in CSS pixels. */
const WHEEL_PIXELS_PER_TICK = 100;

/** A normal tick's drawn size, in CSS pixels. */
const TICK_WIDTH_PX = 8;
const TICK_HEIGHT_PX = 2;
/** The current turn's tick, drawn a little larger so it reads as the reader's place. */
const CURRENT_TICK_WIDTH_PX = 12;
const CURRENT_TICK_HEIGHT_PX = 3;

type TranscriptTurnTicksProps = {
  /** Every user turn in the conversation, oldest first. */
  turns: TurnRailTick[];
  /** The turn the viewport sits on, drawn in the theme colour. */
  currentTurnId: string | null;
  /** Places the turn's message in the viewport through chat's shared jump. */
  onJumpToTurn: (anchorId: string) => void;
  /** How many ticks the column may draw at this viewport height, from the rail's measurement. */
  capacity: number;
  /** The column's top edge, in pixels from the rail's own top. */
  top: number;
};

/**
 * Rendered by TranscriptTurnRail as the transcript's turn-navigation column: a
 * small window of fixed-size ticks, centred on the transcript, that a click
 * jumps through and a wheel or the arrow keys scroll through.
 *
 * The column is a sibling of the transcript's scroll container rather than a
 * child, so its wheel listener is the only thing that can move it: React's
 * `onWheel` is registered passively, so the gesture is answered by a native
 * non-passive listener that also stops it reaching anything behind the ticks.
 * Hidden below the `md` breakpoint, where there is no hover to float a tick's
 * summary and no room beside the text.
 */
export default function TranscriptTurnTicks({
  turns,
  currentTurnId,
  onJumpToTurn,
  capacity,
  top,
}: TranscriptTurnTicksProps) {
  const { t } = useTranslation('chat');
  const columnRef = useRef<HTMLDivElement | null>(null);
  // The tick the pointer is over or the keyboard is on, so its summary can float
  // beside the column. Held in state because the summary is rendered from it and
  // because a focus and a hover have to read the same way.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // How far the reader has wheeled the window away from the current turn. It is
  // reset to zero whenever the current turn changes, so a jump or a scroll of the
  // transcript always brings the window back to where the reader actually is.
  const [scrollOffset, setScrollOffset] = useState(0);

  const currentIndex = useMemo(
    () => currentTurnOrdinal(turns, currentTurnId),
    [turns, currentTurnId],
  );

  useEffect(() => {
    setScrollOffset(0);
  }, [currentTurnId]);

  const drawnRange = visibleTickWindow(turns, currentIndex, scrollOffset, capacity);
  const drawn = turns.slice(drawnRange.start, drawnRange.end);
  const canScroll = drawn.length < turns.length;

  useEffect(() => {
    const column = columnRef.current;
    if (!column) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!canScroll) return;
      // The wheel's target is the tick column, so the gesture pages these ticks
      // and never the transcript behind them.
      event.preventDefault();
      event.stopPropagation();
      // One notch of a mouse wheel is about a hundred pixels and moves the list
      // one turn; a trackpad flick or a thrown wheel reports proportionally more
      // and is answered proportionally, so a long conversation can be crossed
      // without a thousand separate gestures.
      const step = Math.round(event.deltaY / WHEEL_PIXELS_PER_TICK);
      if (step !== 0) setScrollOffset((previous) => previous + step);
    };
    column.addEventListener('wheel', onWheel, { passive: false });
    return () => column.removeEventListener('wheel', onWheel);
  }, [canScroll]);

  if (drawn.length === 0) return null;

  return (
    <div
      ref={columnRef}
      data-turn-ticks
      onMouseLeave={() => setHoveredId(null)}
      onKeyDown={(event) => {
        if (!canScroll) return;
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        setScrollOffset((previous) => previous + (event.key === 'ArrowDown' ? 1 : -1));
      }}
      className="pointer-events-auto absolute hidden flex-col md:flex"
      style={{
        right: TRANSCRIPT_TICK_COLUMN_INSET_PX,
        width: TRANSCRIPT_TICK_COLUMN_WIDTH_PX,
        // The rail's measurement says where the column goes: centred on the transcript.
        top,
      }}
    >
      {drawn.map((turn, offset) => {
        const ordinal = drawnRange.start + offset;
        const isCurrent = ordinal === currentIndex;
        const isHovered = turn.id === hoveredId;
        return (
          <button
            key={turn.id}
            type="button"
            data-turn-tick
            data-turn-id={turn.id}
            data-turn-index={turn.index}
            // The reader-facing turn number is the turn's place in the outline,
            // not its message subscript: `index` counts transcript rows, so a
            // session whose turns draw several rows each would number its turns
            // 1, 4, 7 rather than 1, 2, 3.
            aria-label={t('turnRail.jumpToTurn', { n: ordinal + 1 })}
            aria-current={isCurrent ? 'true' : undefined}
            onClick={() => onJumpToTurn(turn.id)}
            onMouseEnter={() => setHoveredId(turn.id)}
            onFocus={() => setHoveredId(turn.id)}
            onBlur={() => setHoveredId((previous) => (previous === turn.id ? null : previous))}
            className="relative flex shrink-0 items-center justify-end p-0 focus:outline-none"
            style={{
              height: TRANSCRIPT_TICK_SPACING_PX,
              width: TRANSCRIPT_TICK_COLUMN_WIDTH_PX,
            }}
          >
            <span
              data-turn-tick-mark
              className={`block rounded-full transition-colors ${
                isCurrent ? 'bg-primary' : 'bg-muted-foreground/40'
              }`}
              style={{
                width: isCurrent ? CURRENT_TICK_WIDTH_PX : TICK_WIDTH_PX,
                height: isCurrent ? CURRENT_TICK_HEIGHT_PX : TICK_HEIGHT_PX,
              }}
            />
            {isHovered && (
              <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground shadow-sm">
                <span className="font-medium">{t('turnRail.turn', { n: ordinal + 1 })}</span>
                <span className="ml-2 font-normal text-muted-foreground">
                  {new Date(turn.timestamp).toLocaleTimeString()}
                </span>
                {turn.preview && (
                  <span className="ml-2 text-muted-foreground">{turn.preview}</span>
                )}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
