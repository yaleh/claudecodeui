/**
 * The geometry the transcript's right-edge chrome and the quick-settings handle
 * have to agree on.
 *
 * The chat module draws the transcript's turn ticks and its scrollbar; the
 * quick-settings module draws the draggable handle that floats over the same
 * edge. Neither module may import the other, so the numbers they must share —
 * the two columns' widths and insets, the clearances between them, and the
 * vertical band the handle may occupy — live here. The band itself is a runtime
 * reading, not a constant: chat publishes it onto the document element as CSS
 * custom properties and announces each change on the window, and the handle
 * reads and subscribes to that, so the two modules never hold a reference to
 * each other.
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

/** The largest share of its track's height the drawn thumb may occupy. */
export const TRANSCRIPT_SCROLLBAR_MAX_THUMB_RATIO = 0.25;

/** Clearance the quick-settings handle keeps from the band's two edges, in CSS pixels. */
export const TRANSCRIPT_HANDLE_BAND_MARGIN_PX = 8;

/** Clearance the quick-settings handle's right edge keeps from the drawn scrollbar's left edge. */
export const TRANSCRIPT_HANDLE_SCROLLBAR_GAP_PX = 4;

/**
 * The vertical room the tick column leaves for the handle above itself.
 *
 * The column is centred on the transcript, but on a short viewport a centred
 * 300px column would sit high enough to squeeze the handle's band to nothing;
 * this is the height the column keeps clear — the handle's drawn box plus the
 * margins either side of it — so it can slide down instead.
 */
export const TRANSCRIPT_HANDLE_RESERVED_HEIGHT_PX = 48;

//---------------------------

/**
 * The vertical band the quick-settings handle may occupy, in viewport pixels.
 *
 * `top` is the lowest the handle's top edge may go (the export button's bottom
 * plus a margin), `bottom` the highest its bottom edge may go (the tick column's
 * top less a margin, or the transcript pane's own bottom when there is no tick
 * column at this width), and `thumbLeft` the x the handle's right edge must stay
 * clear of so it never covers the drawn scrollbar.
 */
export type TranscriptEdgeBand = {
  /** Lowest the handle's top edge may be, in viewport pixels. */
  top: number;
  /** Highest the handle's bottom edge may be, in viewport pixels. */
  bottom: number;
  /** The drawn scrollbar thumb's left edge, in viewport pixels. */
  thumbLeft: number;
};

/** The custom properties chat publishes the band as, and the event it announces a change on. */
const BAND_TOP_VAR = '--transcript-edge-band-top';
const BAND_BOTTOM_VAR = '--transcript-edge-band-bottom';
const THUMB_LEFT_VAR = '--transcript-edge-thumb-left';
const BAND_EVENT = 'transcript-edge-band-change';

/**
 * Publishes the band chat measured, or clears it when the transcript is gone.
 *
 * The values go on the document element as CSS custom properties — so a style
 * rule can consume them without either module importing the other — and the
 * event is what lets a subscriber re-clamp on a change that no resize produces
 * (a session switch, the export menu appearing).
 */
export function publishTranscriptEdgeBand(band: TranscriptEdgeBand | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (band === null) {
    root.style.removeProperty(BAND_TOP_VAR);
    root.style.removeProperty(BAND_BOTTOM_VAR);
    root.style.removeProperty(THUMB_LEFT_VAR);
  } else {
    root.style.setProperty(BAND_TOP_VAR, `${band.top}px`);
    root.style.setProperty(BAND_BOTTOM_VAR, `${band.bottom}px`);
    root.style.setProperty(THUMB_LEFT_VAR, `${band.thumbLeft}px`);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(BAND_EVENT));
  }
}

/** Reads back the band chat last published, or null when it has published none. */
export function readTranscriptEdgeBand(): TranscriptEdgeBand | null {
  if (typeof document === 'undefined') return null;
  const styles = getComputedStyle(document.documentElement);
  const top = Number.parseFloat(styles.getPropertyValue(BAND_TOP_VAR));
  const bottom = Number.parseFloat(styles.getPropertyValue(BAND_BOTTOM_VAR));
  const thumbLeft = Number.parseFloat(styles.getPropertyValue(THUMB_LEFT_VAR));
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(thumbLeft)) {
    return null;
  }
  return { top, bottom, thumbLeft };
}

/** Calls `listener` on every band publication — used by the handle to re-clamp itself. */
export function subscribeTranscriptEdgeBand(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(BAND_EVENT, listener);
  return () => window.removeEventListener(BAND_EVENT, listener);
}

/**
 * Moves a handle of `handleHeightPx` to the nearest top edge inside `band`.
 *
 * A band shorter than the handle cannot hold it; the handle is then pinned to
 * the band's top rather than pushed below it, so it stays next to the export
 * button it belongs under instead of drifting over the ticks.
 */
export function clampHandleTopPx(
  topPx: number,
  handleHeightPx: number,
  band: TranscriptEdgeBand,
): number {
  const highest = Math.max(band.top, band.bottom - handleHeightPx);
  return Math.min(Math.max(topPx, band.top), highest);
}

/**
 * The share of the viewport the handle's stored position may take.
 *
 * The persisted value is a share of the viewport height, and which edge it
 * measures depends on the placement: wide viewports centre the handle on it,
 * narrow ones hang its bottom edge that far above the viewport's bottom. Both
 * are converted to the handle's top edge, clamped into the band, and converted
 * back, so one stored number means the same thing on either side of the
 * breakpoint and a position saved on one is still inside the band on the other.
 */
export function clampHandleShare(
  share: number,
  handleHeightPx: number,
  viewportHeightPx: number,
  band: TranscriptEdgeBand | null,
  anchoredToBottom: boolean,
): number {
  const height = Math.max(viewportHeightPx, 1);
  if (!band || handleHeightPx <= 0) return share;
  const topPx = anchoredToBottom
    ? height - (share / 100) * height - handleHeightPx
    : (share / 100) * height - handleHeightPx / 2;
  const clampedTop = clampHandleTopPx(topPx, handleHeightPx, band);
  return anchoredToBottom
    ? ((height - clampedTop - handleHeightPx) / height) * 100
    : ((clampedTop + handleHeightPx / 2) / height) * 100;
}

/** The share that puts the handle's top edge at the band's top — the default placement. */
export function handleShareAtBandTop(
  handleHeightPx: number,
  viewportHeightPx: number,
  band: TranscriptEdgeBand,
  anchoredToBottom: boolean,
): number {
  const height = Math.max(viewportHeightPx, 1);
  return anchoredToBottom
    ? ((height - band.top - handleHeightPx) / height) * 100
    : ((band.top + handleHeightPx / 2) / height) * 100;
}
