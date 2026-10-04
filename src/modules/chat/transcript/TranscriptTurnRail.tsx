import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { TurnRailTick } from '@/modules/chat/hooks/useTurnNavigation';
import TranscriptScrollbar from '@/modules/chat/transcript/TranscriptScrollbar';
import TranscriptTurnTicks from '@/modules/chat/transcript/TranscriptTurnTicks';
import {
  TRANSCRIPT_TICK_COLUMN_MAX_HEIGHT_PX,
  TRANSCRIPT_TICK_SPACING_PX,
} from '@/shared/transcriptEdgeLayout';

/** Fewer turns than this and the transcript is too short to navigate; the chrome stands down. */
const MIN_TURNS_FOR_RAIL = 3;

/** How many ticks the column may draw at once, before the viewport has anything to say. */
const MAX_TICK_CAPACITY = Math.floor(
  TRANSCRIPT_TICK_COLUMN_MAX_HEIGHT_PX / TRANSCRIPT_TICK_SPACING_PX,
);

type TranscriptTurnRailProps = {
  /** Every user turn in the conversation, oldest first — the ticks and the thumb's positions. */
  turns: TurnRailTick[];
  /** The turn the viewport currently sits on. */
  currentTurnId: string | null;
  /** Places the turn's message in the viewport through chat's shared jump. */
  onJumpToTurn: (anchorId: string) => void;
  /** The transcript's scroll container, read for the rows the viewport holds. */
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** The session's own message count — the denominator the thumb's drawn length is a share of. */
  totalMessages: number;
};

/** Where the rail's tick column goes: how many ticks it may draw and the top it is centred at. */
type RailLayout = {
  /** How many ticks the column may draw at this viewport height. */
  capacity: number;
  /** The tick column's top, in pixels from the rail's own top. */
  tickTop: number;
};

/**
 * Measures the rail's tick column: how many ticks fit at this viewport height,
 * and the top that centres them on the transcript.
 *
 * Re-measured whenever the rail resolves to a new size, which covers a sidebar
 * toggle, a viewport change and a session switch. A scroll re-renders the rail
 * every frame but moves none of these numbers, so it does not re-measure.
 */
function useRailLayout(
  railRef: RefObject<HTMLDivElement>,
  turns: TurnRailTick[],
  hasRail: boolean,
): RailLayout {
  const [layout, setLayout] = useState<RailLayout>({
    capacity: MAX_TICK_CAPACITY,
    tickTop: 0,
  });

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;

    const measure = () => {
      const railRect = rail.getBoundingClientRect();
      // The column may use whatever the rail's height affords, and never more
      // than its own ceiling; its length is that many ticks at one pitch.
      const capacity = Math.max(
        1,
        Math.min(MAX_TICK_CAPACITY, Math.floor(railRect.height / TRANSCRIPT_TICK_SPACING_PX)),
      );
      const columnHeight = capacity * TRANSCRIPT_TICK_SPACING_PX;
      const centredTop = (railRect.height - columnHeight) / 2;
      setLayout({ capacity, tickTop: Math.max(centredTop, 0) });
    };

    measure();
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    // jsdom ships no ResizeObserver; there the first measure above and the resize
    // listener are the only remeasurement, and the column keeps that reading.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(rail);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [hasRail, railRef, turns]);

  return layout;
}

/**
 * Rendered by chat's ChatMessagesPane as the transcript's right-edge chrome: the
 * turn-navigation tick column and the drawn global scrollbar, mounted side by
 * side and never one inside the other.
 *
 * The two are separate controls with separate jobs — the ticks say *where in the
 * conversation* the reader can go and are drawn at a fixed size, the thumb says
 * *how far through* it they are and is the only thing that moves on a drag — so
 * this container does no more than lay them out and decide when they are worth
 * drawing (a conversation of at least three turns).
 */
export default function TranscriptTurnRail({
  turns,
  currentTurnId,
  onJumpToTurn,
  scrollContainerRef,
  totalMessages,
}: TranscriptTurnRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const hasRail = turns.length >= MIN_TURNS_FOR_RAIL;
  const layout = useRailLayout(railRef, turns, hasRail);

  return (
    <div ref={railRef} className="pointer-events-none absolute inset-x-0 bottom-4 top-4 z-20">
      {hasRail && (
        <>
          <TranscriptTurnTicks
            turns={turns}
            currentTurnId={currentTurnId}
            onJumpToTurn={onJumpToTurn}
            capacity={layout.capacity}
            top={layout.tickTop}
          />
          <TranscriptScrollbar
            turns={turns}
            currentTurnId={currentTurnId}
            onJumpToTurn={onJumpToTurn}
            scrollContainerRef={scrollContainerRef}
            totalMessages={totalMessages}
          />
        </>
      )}
    </div>
  );
}
