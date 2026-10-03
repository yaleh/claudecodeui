import { useCallback, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
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

/**
 * Used by chat's ChatMessagesPane as the transcript's turn navigation: a narrow
 * strip down the pane's right edge with one tick per user turn, so a reader can
 * reach any turn — including one the client never loaded — without scrolling for
 * it. Each tick is a real button, so the rail is reachable by keyboard and reads
 * its destination aloud; hovering or focusing one floats the turn's summary and
 * time beside it.
 *
 * A click is resolved by *position*, not by which tick's box was hit. On a long
 * conversation the ticks are a fraction of a pixel apart (1200 turns in a
 * ~1000px rail), so no per-tick box is a reliable pointer target — the browser
 * rounds the hit test onto a neighbour. The rail therefore maps the pointer's
 * height to the nearest turn itself, which is the same answer a proportional
 * minimap gives and is exact at any density. The buttons keep taking focus and
 * Enter for keyboard use; only pointer hit-testing is bypassed.
 *
 * Hidden for a short conversation (fewer than three turns) and on narrow/touch
 * viewports, where the global scrollbar task takes over.
 */
export default function TranscriptTurnRail({
  turns,
  currentTurnId,
  onJumpToTurn,
}: TranscriptTurnRailProps) {
  const { t } = useTranslation('chat');
  const railRef = useRef<HTMLElement | null>(null);
  // The tick the pointer is over, so its summary floats beside the rail. Held in
  // state rather than read from `:hover` because the ticks take no pointer
  // events — the rail itself is the hover surface — and it is what the preview
  // bubble renders from.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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
   */
  const turnAt = useCallback((clientY: number): TurnRailTick | null => {
    const rail = railRef.current;
    if (!rail || rail.children.length === 0) return null;
    const ticks = rail.children;

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

  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    // A keyboard Enter on a focused tick bubbles here as a click with the button
    // as its target; that tick's own handler already placed it, so the track
    // handler answers only the clicks that arrived on the rail itself.
    if (event.target !== event.currentTarget) return;
    const turn = turnAt(event.clientY);
    if (turn) onJumpToTurn(turn.id);
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    const next = turnAt(event.clientY)?.id ?? null;
    setHoveredId((previous) => (previous === next ? previous : next));
  };

  if (turns.length < 3) {
    return null;
  }

  return (
    <nav
      ref={railRef}
      aria-label={t('turnRail.label', { defaultValue: 'Conversation turns' })}
      data-turn-count={turns.length}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredId(null)}
      className="absolute bottom-4 right-1 top-4 z-20 hidden w-4 cursor-pointer flex-col items-end md:flex"
    >
      {turns.map((turn) => {
        const isCurrent = turn.id === currentTurnId;
        const isHovered = turn.id === hoveredId;
        return (
          <button
            key={turn.id}
            type="button"
            data-turn-index={turn.index}
            data-turn-id={turn.id}
            aria-label={t('turnRail.jumpToTurn', { n: turn.index + 1 })}
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
            {isHovered && (
              <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground shadow-sm">
                <span className="font-medium">{t('turnRail.turn', { n: turn.index + 1 })}</span>
                {turn.preview && (
                  <span className="ml-2 text-muted-foreground">{turn.preview}</span>
                )}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
