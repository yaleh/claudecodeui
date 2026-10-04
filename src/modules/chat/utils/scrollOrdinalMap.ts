/**
 * The transcript's position on its conversation scale, as a continuous number.
 *
 * The drawn scrollbar used to name a position by the *turn* the viewport sat on,
 * so it could only ever be at a turn boundary — the thumb moved in stairs and
 * sat still for every frame inside one turn. This module replaces that lookup
 * with a piecewise-linear map: between two adjacent turn rows the ordinal moves
 * with the pixel, so the thumb tracks the transcript frame by frame, and the
 * inverse maps a fraction back to the offset that puts it under the viewport's
 * centre.
 *
 * Used by `TranscriptScrollbar` (the drawn thumb's resting position and a drag's
 * offset target) and by `useChatSessionState` (the scrub loader's containment
 * test), and unit-tested directly.
 */

/**
 * One user-turn row of the loaded window, as the transcript measures it.
 *
 * `ordinal` is the turn's absolute message subscript — the same scale the turn
 * outline indexes on — and `top` is the row's top edge in the scroll container's
 * own content coordinates (so it is stable while a prepend shifts both the row
 * and the scroll offset by the same amount). Rows are ordered by `top` and their
 * ordinals increase together.
 */
export type ScrollOrdinalRow = {
  ordinal: number;
  top: number;
};

/** The smallest ordinal a window can name: ordinal 0, the transcript's first row. */
const FIRST_ORDINAL = 0;

/**
 * The continuous ordinal at a y offset in the container's content coordinates.
 *
 * Below the first row and above the last the value is clamped to that row's
 * ordinal — the map can only name positions the loaded window actually holds, so
 * a y past either end is the honest nearest position rather than an extrapolated
 * one. `null` only when there are no rows to interpolate at all.
 */
export function ordinalAtY(rows: readonly ScrollOrdinalRow[], y: number): number | null {
  const count = rows.length;
  if (count === 0) return null;
  const first = rows[0];
  if (y <= first.top) return first.ordinal;
  const last = rows[count - 1];
  if (y >= last.top) return last.ordinal;

  // Rows are ordered by top, so the bracketing pair is found by binary search
  // rather than a scan: the per-frame cost of a position read must not grow with
  // the loaded window.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  const low = rows[lo];
  const high = rows[lo + 1];
  const span = high.top - low.top;
  if (span <= 0) return low.ordinal;
  const ratio = (y - low.top) / span;
  return low.ordinal + ratio * (high.ordinal - low.ordinal);
}

/**
 * The viewport's position as a fraction of the conversation's ordinal scale.
 *
 * The reading is taken at the viewport's centre, not its top edge: a jump places
 * a target at the centre, so the centre read is what makes a jump's landing and
 * the thumb's resting position the same number. Clamped to `[0, 1]`, and `null`
 * when the window holds no turn row or the scale's far end is unknown.
 */
export function fractionAtViewportCenter(
  rows: readonly ScrollOrdinalRow[],
  scrollTop: number,
  clientHeight: number,
  lastOrdinal: number,
): number | null {
  if (rows.length === 0 || lastOrdinal <= FIRST_ORDINAL) return null;
  const ordinal = ordinalAtY(rows, scrollTop + clientHeight / 2);
  if (ordinal === null) return null;
  return Math.min(1, Math.max(0, ordinal / lastOrdinal));
}

/**
 * The scroll offset that puts `fraction` at the viewport's centre.
 *
 * `null` when the fraction's ordinal lies outside the loaded window's turn rows
 * — the caller must read a window there before the position exists to scroll to.
 * The returned value is the raw offset (it can be negative near the window's own
 * top); the caller clamps it against the container's real scroll range.
 */
export function scrollTopForFraction(
  rows: readonly ScrollOrdinalRow[],
  fraction: number,
  lastOrdinal: number,
  clientHeight: number,
): number | null {
  const count = rows.length;
  if (count === 0 || lastOrdinal <= FIRST_ORDINAL) return null;
  const target = Math.min(1, Math.max(0, fraction)) * lastOrdinal;
  const first = rows[0];
  const last = rows[count - 1];
  if (target < first.ordinal || target > last.ordinal) return null;

  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].ordinal <= target) lo = mid;
    else hi = mid - 1;
  }
  const low = rows[lo];
  if (target === low.ordinal || lo === count - 1) {
    return low.top - clientHeight / 2;
  }
  const high = rows[lo + 1];
  const span = high.ordinal - low.ordinal;
  if (span <= 0) return low.top - clientHeight / 2;
  const ratio = (target - low.ordinal) / span;
  const centreTop = low.top + ratio * (high.top - low.top);
  return centreTop - clientHeight / 2;
}

/**
 * The offset that puts `fraction` as close to the viewport centre as the loaded
 * window allows, together with whether the position was actually inside it.
 *
 * A drag needs both answers at once: the edge offset keeps the content moving
 * toward the pointer while the window that would hold the exact position is
 * still being read, and `covered` is what tells the caller to go and read it.
 * `null` only when the window holds no turn row at all.
 */
export function closestScrollTopForFraction(
  rows: readonly ScrollOrdinalRow[],
  fraction: number,
  lastOrdinal: number,
  clientHeight: number,
): { top: number; covered: boolean } | null {
  const count = rows.length;
  if (count === 0 || lastOrdinal <= FIRST_ORDINAL) return null;
  const target = Math.min(1, Math.max(0, fraction)) * lastOrdinal;
  const first = rows[0];
  const last = rows[count - 1];
  if (target <= first.ordinal) {
    return { top: first.top - clientHeight / 2, covered: target >= first.ordinal };
  }
  if (target >= last.ordinal) {
    return { top: last.top - clientHeight / 2, covered: target <= last.ordinal };
  }
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].ordinal <= target) lo = mid;
    else hi = mid - 1;
  }
  const low = rows[lo];
  const high = rows[lo + 1];
  const span = high.ordinal - low.ordinal;
  const ratio = span <= 0 ? 0 : (target - low.ordinal) / span;
  return { top: low.top + ratio * (high.top - low.top) - clientHeight / 2, covered: true };
}
