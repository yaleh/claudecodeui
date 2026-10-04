import { describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_CONTENT_COLUMN_MAX_PX,
  TRANSCRIPT_SCROLLBAR_COLUMN_PX,
  TRANSCRIPT_TICK_BAND_GUTTER_PX,
  transcriptGutterPx,
} from '@/shared/transcriptEdgeLayout';

/**
 * AC-220 (a)-(c): the transcript pane's right gutter is what is actually drawn
 * there, not a fixed band — the scrollbar's own column on mobile, the fixed tick
 * band on tablet, and nothing once the content column's outer margin clears it on
 * a wide viewport. The three viewport readings and their boundaries are pinned
 * here so the shape is testable with no browser; the browser readings (the pane's
 * computed padding, the text column's edge, the drawn columns) live in
 * `e2e/transcript-edge-layout.spec.ts`.
 */
describe('transcriptGutterPx', () => {
  // The scrollbar's column: its 12px track inset 4px from the edge.
  it('reserves the scrollbar column and nothing else when no tick column is drawn', () => {
    expect(TRANSCRIPT_SCROLLBAR_COLUMN_PX).toBe(16);
    // Phone 390, and every width below the tick column's breakpoint.
    for (const paneWidth of [320, 390, 700, 767]) {
      expect(transcriptGutterPx(paneWidth, false), `pane ${paneWidth}`).toBe(
        TRANSCRIPT_SCROLLBAR_COLUMN_PX,
      );
    }
  });

  it('keeps the full tick band from the breakpoint up while the content column still fills the pane', () => {
    // 768 is the `md` boundary: the tick column is drawn and there is no outer
    // margin yet (the content column is narrower than its own max), so the whole
    // band stands.
    for (const paneWidth of [768, 820, TRANSCRIPT_CONTENT_COLUMN_MAX_PX]) {
      expect(transcriptGutterPx(paneWidth, true), `pane ${paneWidth}`).toBe(
        TRANSCRIPT_TICK_BAND_GUTTER_PX,
      );
    }
  });

  it('drops the band exactly when the content column\'s outer margin reaches it', () => {
    const bandWidth = TRANSCRIPT_CONTENT_COLUMN_MAX_PX + 2 * TRANSCRIPT_TICK_BAND_GUTTER_PX;
    // At the width whose outer margin is exactly the band, the band is fully
    // absorbed: the gutter bottoms out at zero and never goes negative.
    expect(transcriptGutterPx(bandWidth, true)).toBe(0);
    expect(transcriptGutterPx(bandWidth + 400, true)).toBe(0);
    expect(transcriptGutterPx(1440, true)).toBe(0);
  });

  it('shrinks the band one-for-one with the outer margin between fill and clear', () => {
    // One pixel of outer margin gained is one pixel of band given back.
    expect(transcriptGutterPx(1011, true)).toBeCloseTo(0.5, 5);
    expect(transcriptGutterPx(1000, true)).toBe(6);
    expect(transcriptGutterPx(940, true)).toBe(36);
    // just past fill: a 16px outer margin gives back 16px of the band.
    expect(transcriptGutterPx(900, true)).toBe(56);
  });

  it('never returns a negative gutter, however narrow the pane', () => {
    for (const paneWidth of [0, 1, 500, 767, 768]) {
      expect(transcriptGutterPx(paneWidth, true), `pane ${paneWidth}`).toBeGreaterThanOrEqual(0);
    }
  });
});
