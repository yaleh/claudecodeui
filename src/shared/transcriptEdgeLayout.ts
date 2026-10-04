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

// ---------------------------
