/**
 * The geometry the transcript's right-edge chrome agrees on.
 *
 * The chat module draws the transcript's turn ticks and its global scrollbar;
 * neither may carry its own copy of the numbers the two must share — the two
 * columns' widths and insets, and the pitch between ticks — so they live here.
 */

//----------------- TRANSCRIPT RIGHT-EDGE COLUMNS ------------

/** Width of the drawn scrollbar thumb, in CSS pixels. */
export const TRANSCRIPT_SCROLLBAR_WIDTH_PX = 8;

/** Inset of the scrollbar's track from the transcript pane's right edge, in CSS pixels. */
export const TRANSCRIPT_SCROLLBAR_INSET_PX = 4;

/** Width of the scrollbar's track, in CSS pixels — the thumb plus the margin its own column carries. */
export const TRANSCRIPT_SCROLLBAR_TRACK_WIDTH_PX = TRANSCRIPT_SCROLLBAR_WIDTH_PX + 4;

/** The width the scrollbar's column occupies at the pane's right edge, in CSS pixels: track plus inset. */
export const TRANSCRIPT_SCROLLBAR_COLUMN_PX =
  TRANSCRIPT_SCROLLBAR_TRACK_WIDTH_PX + TRANSCRIPT_SCROLLBAR_INSET_PX;

/** The narrowest the scrollbar's grab area may be drawn on a coarse pointer, in CSS pixels. */
export const TRANSCRIPT_SCROLLBAR_GRAB_WIDTH_PX = 32;

/** The shortest the scrollbar's grab area may be drawn on a coarse pointer, in CSS pixels. */
export const TRANSCRIPT_SCROLLBAR_GRAB_MIN_HEIGHT_PX = 44;

/** Width of the turn-tick column, in CSS pixels. */
export const TRANSCRIPT_TICK_COLUMN_WIDTH_PX = 16;

/** Inset of the turn-tick column's right edge from the transcript pane's right edge, in CSS pixels. */
export const TRANSCRIPT_TICK_COLUMN_INSET_PX = 32;

/** Distance between two adjacent ticks' centres, in CSS pixels. */
export const TRANSCRIPT_TICK_SPACING_PX = 30;

/** Tallest the turn-tick column may be drawn, in CSS pixels. */
export const TRANSCRIPT_TICK_COLUMN_MAX_HEIGHT_PX = 300;

/** The narrowest the drawn scrollbar thumb may be drawn, in CSS pixels. */
export const TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX = 28;

/** The transcript content column's own max width (`max-w-[54.25rem]`), in CSS pixels. */
export const TRANSCRIPT_CONTENT_COLUMN_MAX_PX = 868;

/** The right gutter the pane keeps while the tick column is drawn, in CSS pixels. */
export const TRANSCRIPT_TICK_BAND_GUTTER_PX = 72;

// ---------------------------

//----------------- TRANSCRIPT RIGHT-EDGE GUTTER ------------

/**
 * The pane's right padding, sized to what is actually drawn at its right edge.
 *
 * Below the tick column's breakpoint the scrollbar is the only chrome there, so
 * the pane keeps exactly the scrollbar's own column and the text spends the rest
 * of the width — the native-scrollbar reading, where text sits flush against the
 * bar's column instead of a fixed band. Once the tick column is drawn the pane
 * keeps the fixed three-column band, less whatever the content column's own outer
 * margin already leaves clear; on a wide viewport that margin absorbs the whole
 * band, so the text column ends up as wide as it would be with no chrome at all.
 *
 * Both inputs are the caller's measurement: `paneWidthPx` is the pane's own width
 * and `hasTickColumn` is whether the tick column is drawn at the current viewport
 * (the `md` breakpoint). Keeping this a pure function of the two is what lets the
 * mobile / tablet / wide readings be unit-tested with no browser.
 */
export function transcriptGutterPx(paneWidthPx: number, hasTickColumn: boolean): number {
  if (!hasTickColumn) return TRANSCRIPT_SCROLLBAR_COLUMN_PX;
  const outerMarginPx = Math.max(0, (paneWidthPx - TRANSCRIPT_CONTENT_COLUMN_MAX_PX) / 2);
  return Math.max(0, TRANSCRIPT_TICK_BAND_GUTTER_PX - outerMarginPx);
}

// ---------------------------
