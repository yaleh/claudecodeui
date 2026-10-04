import { createContext, useContext } from 'react';

/**
 * The absolute ordinal range a scrub-loaded window covers, on the same scale the
 * turn outline and the scrollbar's ordinal map use.
 */
export type TranscriptScrubWindow = {
  startIndex: number;
  endIndex: number;
};

/**
 * The transcript's drag-scrub control, published by chat's session state for the
 * drawn scrollbar and consumed by that scrollbar.
 *
 * It exists as a context rather than a prop because the scrollbar is rendered by
 * `TranscriptTurnRail`, which is handed only display data; the control's
 * implementation — the scroll-offset channel and the latest-wins window reader —
 * lives in `useChatSessionState` and is not something the rail should have to
 * thread through.
 */
export type TranscriptScrubApi = {
  /**
   * Begin a drag: the pointer owns the viewport, so the transcript's own bottom
   * follow, anchor restore and prepend bookkeeping stand down until `end`.
   */
  start: () => void;
  /** End a drag once its released position has settled. */
  end: () => void;
  /** Place the viewport for a drag frame, through the transcript's scroll channel. */
  scrollTo: (scrollTop: number) => void;
  /**
   * Read a window around `id` for a drag that has left the loaded window, or
   * answer from one the client already holds. At most one read is in flight and
   * the newest requested position wins.
   */
  loadWindow: (id: string, ordinal: number) => Promise<TranscriptScrubWindow | null>;
};

/**
 * Null for a transcript render that has no drag control — an export or a
 * standalone render — so the scrollbar falls back to its jump-only behaviour
 * instead of holding a control that would do nothing.
 */
export const TranscriptScrubContext = createContext<TranscriptScrubApi | null>(null);

/** The transcript's drag-scrub control, or null when the render does not provide one. */
export function useTranscriptScrub(): TranscriptScrubApi | null {
  return useContext(TranscriptScrubContext);
}
