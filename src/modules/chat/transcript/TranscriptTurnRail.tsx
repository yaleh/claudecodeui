import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { TurnRailTick } from '@/modules/chat/hooks/useTurnNavigation';
import TranscriptScrollbar from '@/modules/chat/transcript/TranscriptScrollbar';
import TranscriptTurnTicks from '@/modules/chat/transcript/TranscriptTurnTicks';
import {
  estimateContent,
  nextPxPerMessage,
  shouldUpdateEstimate,
} from '@/modules/chat/utils/contentHeightModel';
import type { ContentRowInput, EstimateState } from '@/modules/chat/utils/contentHeightModel';
import {
  TRANSCRIPT_TICK_COLUMN_MAX_HEIGHT_PX,
  TRANSCRIPT_TICK_SPACING_PX,
} from '@/shared/transcriptEdgeLayout';

/** How many ticks the column may draw at once, before the viewport has anything to say. */
const MAX_TICK_CAPACITY = Math.floor(
  TRANSCRIPT_TICK_COLUMN_MAX_HEIGHT_PX / TRANSCRIPT_TICK_SPACING_PX,
);

/**
 * How long a measurement-triggered rebuild waits.
 *
 * Rows mount and unmount on nearly every scroll frame, and each remeasurement
 * should be folded into the estimate — but rebuilding on every frame would put a
 * full-window height read in the frame path. The debounce keeps the per-frame
 * work to the binary search in `viewportTopPosition` and lets one rebuild answer
 * a burst of measurements.
 */
const CONTENT_REBUILD_DEBOUNCE_MS = 120;

/** A 1px tolerance on the "content fits the viewport" comparison, for sub-pixel layout roundings. */
const CONTENT_FITS_TOLERANCE_PX = 1;

/**
 * The estimated pixel geometry of the transcript, shared by the two right-edge
 * columns.
 *
 * `rows`, `rowHeights` and `prefix` are the loaded window in content order; the
 * per-frame position read walks them by binary search. `windowAboveOffset` is the
 * estimated pixel distance from the conversation's top to the loaded window's
 * first row — what turns a window-relative offset into a conversation-relative
 * one. `viewportHeight` is the scroll container's drawn height at the last
 * rebuild.
 */
export type TranscriptContent = {
  /** The loaded window's rows, in content order — the per-frame read's binary-search input. */
  rows: HTMLElement[];
  /** Each loaded row's estimated height. */
  rowHeights: number[];
  /** Cumulative estimated height before each row; length `rowHeights.length + 1`. */
  prefix: number[];
  /** The loaded window's estimated height. */
  windowHeight: number;
  /** The whole conversation's estimated height, the unloaded parts included. */
  estimatedTotal: number;
  /** The running average px per message, taken from the measured rows. */
  pxPerMessage: number;
  /** Estimated px of the conversation above the loaded window. */
  windowAboveOffset: number;
  /** The scroll container's drawn height at the last rebuild. */
  viewportHeight: number;
};

/** The estimate before the first measurement: nothing to draw and nothing to fit. */
const EMPTY_CONTENT: TranscriptContent = {
  rows: [],
  rowHeights: [],
  prefix: [0],
  windowHeight: 0,
  estimatedTotal: 0,
  pxPerMessage: 0,
  windowAboveOffset: 0,
  viewportHeight: 0,
};

/** How many messages the row stands for, from its own `data-transcript-row-messages`. */
function rowMessages(row: HTMLElement): number {
  const declared = Number.parseInt(
    row.querySelector<HTMLElement>('[data-transcript-row-messages]')?.dataset.transcriptRowMessages ?? '1',
    10,
  );
  return Number.isFinite(declared) && declared > 0 ? declared : 1;
}

/**
 * Estimates the conversation's pixel height from the loaded window, and keeps it
 * fresh as rows mount and measure.
 *
 * The estimate is rebuilt when `totalMessages` changes, when the scroll container
 * resizes, and — debounced — when the content column mutates (a row mounting,
 * unmounting or recording its measured height). `frozenRef` suppresses rebuilds
 * while a gesture holds the thumb, so the drawn length cannot move under the
 * pointer; `shouldUpdateEstimate` adds a 1px dead zone so a rebuild that changes
 * nothing does not re-render.
 */
function useTranscriptContent(
  scrollContainerRef: RefObject<HTMLDivElement>,
  turns: TurnRailTick[],
  totalMessages: number,
  frozenRef: { current: boolean },
): { content: TranscriptContent; refresh: () => TranscriptContent | null } {
  const [content, setContent] = useState<TranscriptContent>(EMPTY_CONTENT);
  /** The estimate the drawn geometry was last built from, for the update gate. */
  const builtStateRef = useRef<EstimateState | null>(null);
  /** The running px-per-message average, carried across rebuilds. */
  const pxPerMessageRef = useRef(0);
  /** The column's inter-row pitch, measured once and reused. */
  const rowGapRef = useRef<number | null>(null);
  /** Turn id to absolute message subscript, so the loaded window's opening ordinal is known. */
  const ordinalById = useMemo(
    () => new Map(turns.map((turn) => [turn.id, turn.index])),
    [turns],
  );

  const rebuild = useCallback((): TranscriptContent | null => {
    const container = scrollContainerRef.current;
    if (!container) return null;
    const contentEl = container.querySelector<HTMLElement>('[data-transcript-content]');
    if (!contentEl) return null;

    const rows = (Array.from(contentEl.children) as HTMLElement[]).filter((row) =>
      row.hasAttribute('data-message-timestamp'),
    );
    const inputs: ContentRowInput[] = rows.map((row) => {
      const height = row.offsetHeight;
      return {
        messages: rowMessages(row),
        measured: row.hasAttribute('data-row-measured') && height > 0,
        height,
      };
    });

    // The vertical space between adjacent rows — the content column's own
    // `space-y` — is part of the conversation's real height but not of any row's
    // own `offsetHeight`, so fold it into each row's slot before estimating. A
    // row's slot is its height plus the gap beneath it; the running
    // px-per-message is then a slot per message, which is what the drawn length
    // and the exposed `data-px-per-message` both mean.
    //
    // Measured once and reused: the pitch is a property of the column's styles,
    // not of the window, and re-reading every adjacent pair on every rebuild
    // (which a drag's window swaps make frequent) would put an O(rows) rect walk
    // in the frame path.
    if (rowGapRef.current === null && rows.length > 1) {
      let gapTotal = 0;
      let gapCount = 0;
      for (let index = 1; index < rows.length; index += 1) {
        const gap = rows[index].getBoundingClientRect().top - rows[index - 1].getBoundingClientRect().bottom;
        if (gap >= 0 && gap < 200) {
          gapTotal += gap;
          gapCount += 1;
        }
      }
      if (gapCount > 0) rowGapRef.current = gapTotal / gapCount;
    }
    const rowGapPx = rowGapRef.current ?? 0;
    const slotInputs: ContentRowInput[] = inputs.map((row) =>
      row.measured ? { ...row, height: row.height + rowGapPx } : row,
    );

    // A session switch changes the conversation's message count; the previous
    // session's px-per-message would otherwise slowly drag the new estimate.
    if (builtStateRef.current && builtStateRef.current.totalMessages !== totalMessages) {
      pxPerMessageRef.current = 0;
    }
    const pxPerMessage = nextPxPerMessage(pxPerMessageRef.current, slotInputs);

    // The loaded window's opening ordinal — how many messages the conversation
    // holds above it. A work-segment row counts its members, so the rows before
    // the first turn row contribute their own messages.
    let messagesBeforeWindow = 0;
    let anchored = false;
    for (let index = 0; index < rows.length; index += 1) {
      const id = rows[index].getAttribute('data-message-anchor-id');
      const ordinal = id === null ? undefined : ordinalById.get(id);
      if (ordinal !== undefined) {
        messagesBeforeWindow += ordinal;
        anchored = true;
        break;
      }
      messagesBeforeWindow += inputs[index].messages;
    }
    if (!anchored) messagesBeforeWindow = 0;

    const windowMessages = inputs.reduce((sum, row) => sum + row.messages, 0);
    const messagesAfterWindow = Math.max(0, totalMessages - messagesBeforeWindow - windowMessages);
    const estimate = estimateContent({
      rows: slotInputs,
      messagesBeforeWindow,
      messagesAfterWindow,
      pxPerMessage,
    });
    const viewportHeight = container.clientHeight;
    const next: EstimateState = {
      estimatedTotal: estimate.estimatedTotal,
      windowHeight: estimate.windowHeight,
      pxPerMessage,
      totalMessages,
      viewportHeight,
      // The row set's cheap identity: a window swap can leave the estimate's
      // numbers unchanged while every row element is replaced, and the drawn
      // geometry holds those elements.
      rowSetKey: rows.length === 0
        ? ''
        : `${rows.length}:${rows[0].getAttribute('data-message-anchor-id') ?? rows[0].getAttribute('data-message-timestamp') ?? ''}|${rows[rows.length - 1].getAttribute('data-message-anchor-id') ?? rows[rows.length - 1].getAttribute('data-message-timestamp') ?? ''}`,
    };
    const built: TranscriptContent = {
      rows,
      rowHeights: estimate.rowHeights,
      prefix: estimate.prefix,
      windowHeight: estimate.windowHeight,
      estimatedTotal: estimate.estimatedTotal,
      pxPerMessage,
      windowAboveOffset: messagesBeforeWindow * pxPerMessage,
      viewportHeight,
    };
    if (shouldUpdateEstimate(builtStateRef.current, next, frozenRef.current === true)) {
      builtStateRef.current = next;
      pxPerMessageRef.current = pxPerMessage;
      setContent(built);
    }
    // Returned as well as stored: a caller that is placing content right after a
    // window read needs the live rows synchronously, before React's state update
    // has committed them.
    return built;
  }, [frozenRef, ordinalById, scrollContainerRef, totalMessages]);

  // Mount and every totalMessages change: measure at once, then once more on the
  // next frame, so the first commit's rows are seen after their layout settles.
  useEffect(() => {
    rebuild();
    const frame = requestAnimationFrame(rebuild);
    return () => cancelAnimationFrame(frame);
  }, [rebuild]);

  // Every content mutation (a row mounting, unmounting, or recording its measured
  // height) and every container resize schedules a debounced rebuild.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        rebuild();
      }, CONTENT_REBUILD_DEBOUNCE_MS);
    };
    // jsdom ships no MutationObserver/ResizeObserver; there the mount rebuild and
    // the window resize listener are the only remeasurement.
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    observer?.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-row-measured'],
    });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(container);
    window.addEventListener('resize', schedule);
    return () => {
      observer?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', schedule);
      if (timer !== null) clearTimeout(timer);
    };
  }, [rebuild, scrollContainerRef]);

  return { content, refresh: rebuild };
}

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
  drawsRail: boolean,
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
  }, [drawsRail, railRef, turns]);

  return layout;
}

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

/**
 * Rendered by chat's ChatMessagesPane as the transcript's right-edge chrome: the
 * turn-navigation tick column and the drawn global scrollbar, mounted side by
 * side and never one inside the other.
 *
 * The two are separate controls with separate jobs — the ticks say *where in the
 * conversation* the reader can go and are drawn at a fixed size, the thumb says
 * *how far through* it they are and is the only thing that moves on a drag — so
 * this container does no more than lay them out and decide when they are worth
 * drawing.
 *
 * The decision is the content, not a turn count: when the conversation's
 * estimated pixel height fits the viewport (+1px) there is nothing to scroll and
 * nothing to navigate, so both columns stand down — even for a conversation with
 * a turn or two. When it does not fit, both are drawn, and a viewport change that
 * flips the comparison makes them appear or disappear with it.
 */
export default function TranscriptTurnRail({
  turns,
  currentTurnId,
  onJumpToTurn,
  scrollContainerRef,
  totalMessages,
}: TranscriptTurnRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  // Held true while a gesture owns the thumb, so the estimate is not rebuilt
  // under the pointer (TranscriptScrollbar sets it from its drag/keyboard paths).
  const freezeRef = useRef(false);
  const { content, refresh } = useTranscriptContent(scrollContainerRef, turns, totalMessages, freezeRef);
  // Nothing is drawn until the estimate exists, and then only when the
  // conversation is taller than the viewport.
  const drawsRail = content.viewportHeight > 0
    && content.estimatedTotal > content.viewportHeight + CONTENT_FITS_TOLERANCE_PX;
  const layout = useRailLayout(railRef, turns, drawsRail);

  return (
    <div ref={railRef} className="pointer-events-none absolute inset-x-0 bottom-4 top-4 z-20">
      {drawsRail && (
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
            content={content}
            refreshContent={refresh}
            freezeRef={freezeRef}
          />
        </>
      )}
    </div>
  );
}
