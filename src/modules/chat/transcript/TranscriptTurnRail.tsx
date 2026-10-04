import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { TurnRailTick } from '@/modules/chat/hooks/useTurnNavigation';
import TranscriptScrollbar from '@/modules/chat/transcript/TranscriptScrollbar';
import TranscriptTurnTicks from '@/modules/chat/transcript/TranscriptTurnTicks';
import {
  TRANSCRIPT_HANDLE_BAND_MARGIN_PX,
  TRANSCRIPT_HANDLE_RESERVED_HEIGHT_PX,
  TRANSCRIPT_SCROLLBAR_INSET_PX,
  TRANSCRIPT_SCROLLBAR_WIDTH_PX,
  TRANSCRIPT_TICK_COLUMN_MAX_HEIGHT_PX,
  TRANSCRIPT_TICK_SPACING_PX,
  publishTranscriptEdgeBand,
} from '@/shared/transcriptEdgeLayout';
import type { TranscriptEdgeBand } from '@/shared/transcriptEdgeLayout';

/** Fewer turns than this and the transcript is too short to navigate; the chrome stands down. */
const MIN_TURNS_FOR_RAIL = 3;

/** The breakpoint the tick column is drawn above, matching its `md:` utility. */
const TICK_COLUMN_MEDIA_QUERY = '(min-width: 768px)';

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

/** Where the rail's two columns go, and the band the neighbouring handle is allowed to occupy. */
type RailLayout = {
  /** How many ticks the column may draw at this viewport height. */
  capacity: number;
  /** The tick column's top, in pixels from the rail's own top. */
  tickTop: number;
  /** What the quick-settings handle may occupy, or null before the first measurement. */
  band: TranscriptEdgeBand | null;
};

/**
 * Measures the rail's two columns and the band the quick-settings handle is
 * allowed to occupy, and publishes the band for that other module to read.
 *
 * One measurement site rather than one per column, because the two are coupled
 * by this one number: the band's bottom is the tick column's top, and the tick
 * column's top is whichever of "centred on the transcript" and "low enough to
 * leave the handle its band" is lower. The column therefore also decides its own
 * capacity here — a short viewport draws fewer ticks rather than a column that
 * would push the handle off the export button.
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
    band: null,
  });

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;

    const measure = () => {
      const pane = document.querySelector<HTMLElement>('.chat-messages-pane');
      if (!pane) return;
      const railRect = rail.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      const anchor = document.querySelector<HTMLElement>('[data-transcript-export-anchor]');
      const thumb = rail.querySelector<HTMLElement>('[data-scrollbar-thumb]');

      // The band's top: clear of the export control, which is pinned to the
      // pane's top and so does not move as the transcript scrolls.
      const bandTop = (anchor?.getBoundingClientRect().bottom ?? paneRect.top)
        + TRANSCRIPT_HANDLE_BAND_MARGIN_PX;
      const minTickTop = bandTop + TRANSCRIPT_HANDLE_RESERVED_HEIGHT_PX
        + TRANSCRIPT_HANDLE_BAND_MARGIN_PX - railRect.top;

      // The column may use whatever the handle's band does not need, and never
      // more than its own ceiling; its length is that many ticks at one pitch.
      const available = railRect.height - minTickTop - TRANSCRIPT_HANDLE_BAND_MARGIN_PX;
      const capacity = Math.max(
        1,
        Math.min(MAX_TICK_CAPACITY, Math.floor(available / TRANSCRIPT_TICK_SPACING_PX)),
      );
      const columnHeight = capacity * TRANSCRIPT_TICK_SPACING_PX;
      const centredTop = (railRect.height - columnHeight) / 2;
      const tickTop = Math.max(centredTop, minTickTop);

      // The column is only drawn — and so only bounds the band — above the
      // breakpoint and for a conversation long enough to navigate. Below either,
      // the pane's own bottom is the honest bound.
      const columnDrawn = hasRail && window.matchMedia(TICK_COLUMN_MEDIA_QUERY).matches;
      const bandBottom = columnDrawn
        ? railRect.top + tickTop - TRANSCRIPT_HANDLE_BAND_MARGIN_PX
        : paneRect.bottom - TRANSCRIPT_HANDLE_BAND_MARGIN_PX;
      const thumbLeft = thumb?.getBoundingClientRect().left
        ?? paneRect.right - TRANSCRIPT_SCROLLBAR_INSET_PX - TRANSCRIPT_SCROLLBAR_WIDTH_PX;
      const band: TranscriptEdgeBand = {
        top: bandTop,
        bottom: Math.max(bandBottom, bandTop),
        thumbLeft,
      };

      publishTranscriptEdgeBand(band);
      setLayout({ capacity, tickTop, band });
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
      publishTranscriptEdgeBand(null);
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
 * this container does no more than lay them out, decide when they are worth
 * drawing (a conversation of at least three turns) and keep the handle of the
 * neighbouring quick-settings module informed of the band it may occupy.
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
