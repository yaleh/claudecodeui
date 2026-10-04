/**
 * Which slice of a conversation's turns the tick column draws.
 *
 * The column used to draw a tick per turn and let flexbox divide the rail's
 * height between them, so a long conversation produced sub-pixel ticks and
 * hundreds of buttons. It now draws a fixed number of fixed-size ticks — the
 * ones around where the reader is — and this is the arithmetic that picks them,
 * kept out of the component so the edges (fewer turns than fit, the reader at
 * either end, a scrolled-away window, turns arriving) can be read directly.
 */

/** A half-open run of turn ordinals: `[start, end)`. */
export type TickWindow = {
  /** First ordinal of the turn list the column draws. */
  start: number;
  /** One past the last ordinal the column draws. */
  end: number;
};

/**
 * Where the current turn sits in the window, as a share of its capacity.
 *
 * Below the middle, so the reader sees more of what is ahead of them than of
 * what is behind — the shape the column was modelled on — and so the current
 * tick never lands on the column's top edge where its hover summary would be
 * clipped.
 */
const CURRENT_TURN_WINDOW_ANCHOR = 0.6;

/**
 * The run of turns of `capacity` ticks the column draws for a reader at
 * `currentIndex`, wheeled `scrollOffset` ticks away from them.
 *
 * A conversation no longer than the capacity is drawn whole — the window has
 * nothing to hide. Otherwise the current turn is placed at the anchor above,
 * the wheel's offset moves that placement, and the result is clamped so the
 * window never runs off either end: at the first turn it starts at 0, and at
 * the last it ends at the end of the list, where the current tick is the bottom
 * one rather than floating in the middle.
 */
export function visibleTickWindow(
  turns: readonly unknown[],
  currentIndex: number,
  scrollOffset: number,
  capacity: number,
): TickWindow {
  const total = turns.length;
  if (total === 0 || capacity <= 0) return { start: 0, end: 0 };
  if (total <= capacity) return { start: 0, end: total };
  const anchor = Math.floor((capacity - 1) * CURRENT_TURN_WINDOW_ANCHOR);
  const maxStart = total - capacity;
  const start = Math.min(Math.max(currentIndex - anchor + scrollOffset, 0), maxStart);
  return { start, end: start + capacity };
}

/**
 * The ordinal of the turn the viewport sits on.
 *
 * A turn the outline does not name yet — a prompt just sent, awaiting the
 * server's reindex — is the newest one by definition, so it takes the last
 * slot; and with no current turn at all the reader is at the start, which is
 * also the answer for an empty transcript.
 */
export function currentTurnOrdinal(
  turns: readonly { id: string }[],
  currentTurnId: string | null,
): number {
  const at = turns.findIndex((turn) => turn.id === currentTurnId);
  if (at >= 0) return at;
  return currentTurnId === null ? 0 : Math.max(turns.length - 1, 0);
}
