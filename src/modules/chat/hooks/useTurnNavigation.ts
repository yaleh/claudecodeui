import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';

import type { ChatMessage } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * One tick on the navigation rail: a user turn the reader can jump to.
 *
 * `index` is the turn's absolute position in the full normalized history when
 * the server reported it, or an approximation past the loaded outline for a
 * turn that only exists on this client so far. It orders the ticks and nothing
 * else — the jump addresses the turn by `id`.
 */
export type TurnRailTick = {
  /** The turn's transcript anchor id — the jump destination the server resolves. */
  id: string;
  /** Absolute 0-based position in the full normalized history. */
  index: number;
  timestamp: string;
  /** The first ~80 characters of the turn's text, line breaks flattened. */
  preview: string;
};

type UseTurnNavigationArgs = {
  isActive: boolean;
  sessionId: string | null;
  sessionStore: SessionStore;
  /** The transcript as rendered, used to append turns the outline does not know yet. */
  chatMessages: ChatMessage[];
  /** The scroll container the current turn is read against. */
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** The shared jump primitive from `useChatSessionState`, addressed by anchor id. */
  jumpToMessage: (anchorId: string) => void;
};

/** The rail's preview text: one flattened line, the same shape the server sends. */
function previewOf(content: string | undefined): string {
  return (content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Reads a session's user-turn outline, appends turns that only exist on this
 * client, tracks which turn the viewport is sitting on, and jumps to a tick.
 *
 * The outline is the index of the whole conversation — including turns this
 * client has never loaded — so the rail can offer a destination the transcript
 * does not hold yet. A turn the reader sends while the session is open is not in
 * that outline until the server reindexes, so the rendered transcript is the
 * second source: any user turn with an anchor id the outline does not name is
 * appended as a tick of its own.
 */
export function useTurnNavigation({
  isActive,
  sessionId,
  sessionStore,
  chatMessages,
  scrollContainerRef,
  jumpToMessage,
}: UseTurnNavigationArgs): {
  turns: TurnRailTick[];
  currentTurnId: string | null;
  jumpToTurn: (anchorId: string) => void;
} {
  // Read the outline once per session. Idempotent in the store, so an accidental
  // second call is a no-op rather than a second request. Optional-chained: a
  // store without the outline read (a partial render harness) simply has no
  // index, and the rail stands down rather than throwing on the read.
  useEffect(() => {
    if (!isActive || !sessionId) return;
    void sessionStore.fetchOutline?.(sessionId);
  }, [isActive, sessionId, sessionStore]);

  const outline = sessionId ? sessionStore.getOutline?.(sessionId) ?? null : null;

  const turns = useMemo<TurnRailTick[]>(() => {
    const knownIds = new Set((outline?.turns ?? []).map((turn) => turn.id));
    const ticks: TurnRailTick[] = (outline?.turns ?? []).map((turn) => ({
      id: turn.id,
      index: turn.index,
      timestamp: turn.timestamp,
      preview: turn.preview,
    }));
    // A turn past the loaded outline still needs a position; placing it after
    // the outline's own count keeps the sequence monotonic without claiming to
    // know its absolute index.
    let nextIndex = outline?.total ?? 0;
    for (const message of chatMessages) {
      if (message.type !== 'user') continue;
      const id = message.transcriptAnchorId;
      if (!id || knownIds.has(id)) continue;
      knownIds.add(id);
      ticks.push({
        id,
        index: nextIndex,
        timestamp: String(message.timestamp),
        preview: previewOf(message.content),
      });
      nextIndex += 1;
    }
    return ticks;
  }, [outline, chatMessages]);

  /**
   * The user turn the viewport currently sits on: the last turn row whose top
   * has crossed the pane's top edge. Derived from the DOM rather than stored
   * because the answer changes with every scroll, and it is read to style one
   * tick — it is not a fact anything else depends on.
   */
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isActive) return;

    let frame: number | null = null;
    const compute = () => {
      frame = null;
      const paneTop = container.getBoundingClientRect().top;
      const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-message-anchor-id]'));
      // The rows are in transcript order and their tops increase together, so the
      // last row above the pane's top edge is found by binary search — the cost of
      // a scroll frame must not grow with the rows the loaded window holds.
      let lo = 0;
      let hi = rows.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].getBoundingClientRect().top <= paneTop + 1) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const current = found >= 0 ? rows[found].getAttribute('data-message-anchor-id') : null;
      setCurrentTurnId((previous) => (previous === current ? previous : current));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(compute);
    };

    compute();
    container.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      container.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [isActive, scrollContainerRef, turns, chatMessages]);

  const jumpToTurn = useCallback((anchorId: string) => {
    jumpToMessage(anchorId);
  }, [jumpToMessage]);

  return { turns, currentTurnId, jumpToTurn };
}
