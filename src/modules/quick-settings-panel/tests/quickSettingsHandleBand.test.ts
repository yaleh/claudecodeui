import { describe, expect, it } from 'vitest';

import type { TranscriptEdgeBand } from '@/shared/transcriptEdgeLayout';
import {
  clampHandleShare,
  clampHandleTopPx,
  handleShareAtBandTop,
  publishTranscriptEdgeBand,
  readTranscriptEdgeBand,
} from '@/shared/transcriptEdgeLayout';

/** The band the transcript publishes on a 900px-tall viewport: 60px below the top, stopping 200px down. */
const BAND: TranscriptEdgeBand = { top: 60, bottom: 200, thumbLeft: 1_400 };

/** A handle the size the real one draws at. */
const HANDLE_HEIGHT = 36;
const VIEWPORT_HEIGHT = 900;

/** The share a handle's top edge would be drawn at, for the placement under test. */
const topFor = (share: number, anchoredToBottom: boolean) =>
  anchoredToBottom
    ? VIEWPORT_HEIGHT - (share / 100) * VIEWPORT_HEIGHT - HANDLE_HEIGHT
    : (share / 100) * VIEWPORT_HEIGHT - HANDLE_HEIGHT / 2;

describe('clampHandleTopPx', () => {
  it('leaves a top edge already inside the band alone', () => {
    expect(clampHandleTopPx(100, HANDLE_HEIGHT, BAND)).toBe(100);
  });

  it('pulls a top edge above the band down to its top', () => {
    expect(clampHandleTopPx(-400, HANDLE_HEIGHT, BAND)).toBe(BAND.top);
    expect(clampHandleTopPx(BAND.top - 1, HANDLE_HEIGHT, BAND)).toBe(BAND.top);
  });

  it('pulls a handle whose bottom overruns the band back up', () => {
    expect(clampHandleTopPx(400, HANDLE_HEIGHT, BAND)).toBe(BAND.bottom - HANDLE_HEIGHT);
  });

  it('pins a handle taller than the band to the band\'s top rather than below it', () => {
    expect(clampHandleTopPx(150, 500, BAND)).toBe(BAND.top);
  });
});

describe('clampHandleShare', () => {
  it('leaves a share whose handle is already inside the band untouched', () => {
    const inside = topFor(0, false) >= BAND.top && topFor(0, false) + HANDLE_HEIGHT <= BAND.bottom
      ? 0
      : 15;
    const share = inside;
    expect(clampHandleShare(share, HANDLE_HEIGHT, VIEWPORT_HEIGHT, BAND, false)).toBeCloseTo(share, 6);
  });

  it('clamps a saved position that sits below the band back into it, on both placements', () => {
    // 60% and 90% of a 900px viewport are the positions a reader could have saved
    // before the band existed; both used to fall over the tick column.
    for (const saved of [60, 90]) {
      const wideShare = clampHandleShare(saved, HANDLE_HEIGHT, VIEWPORT_HEIGHT, BAND, false);
      expect(topFor(wideShare, false)).toBeGreaterThanOrEqual(BAND.top);
      expect(topFor(wideShare, false) + HANDLE_HEIGHT).toBeLessThanOrEqual(BAND.bottom + 0.001);

      const narrowShare = clampHandleShare(saved, HANDLE_HEIGHT, VIEWPORT_HEIGHT, BAND, true);
      expect(topFor(narrowShare, true)).toBeGreaterThanOrEqual(BAND.top - 0.001);
      expect(topFor(narrowShare, true) + HANDLE_HEIGHT).toBeLessThanOrEqual(BAND.bottom + 0.001);
    }
  });

  it('clamps a position dragged above the band back down to it', () => {
    const share = clampHandleShare(0, HANDLE_HEIGHT, VIEWPORT_HEIGHT, BAND, false);
    expect(topFor(share, false)).toBeCloseTo(BAND.top, 6);
  });

  it('leaves the share alone when no band has been published', () => {
    expect(clampHandleShare(60, HANDLE_HEIGHT, VIEWPORT_HEIGHT, null, false)).toBe(60);
  });

  it('leaves the share alone until the handle has been measured', () => {
    expect(clampHandleShare(60, 0, VIEWPORT_HEIGHT, BAND, false)).toBe(60);
  });

  it('is the identity when the handle already sits exactly at the band\'s top', () => {
    const share = handleShareAtBandTop(HANDLE_HEIGHT, VIEWPORT_HEIGHT, BAND, false);
    expect(clampHandleShare(share, HANDLE_HEIGHT, VIEWPORT_HEIGHT, BAND, false)).toBeCloseTo(share, 6);
    expect(topFor(share, false)).toBeCloseTo(BAND.top, 6);
  });
});

describe('handleShareAtBandTop', () => {
  it('puts the handle\'s top edge at the band\'s top on both placements', () => {
    const wide = handleShareAtBandTop(HANDLE_HEIGHT, VIEWPORT_HEIGHT, BAND, false);
    expect(topFor(wide, false)).toBeCloseTo(BAND.top, 6);

    const narrow = handleShareAtBandTop(HANDLE_HEIGHT, VIEWPORT_HEIGHT, BAND, true);
    expect(topFor(narrow, true)).toBeCloseTo(BAND.top, 6);
  });
});

describe('the published band', () => {
  it('round-trips through the document element, and clears back to null', () => {
    publishTranscriptEdgeBand(BAND);
    expect(readTranscriptEdgeBand()).toEqual(BAND);
    publishTranscriptEdgeBand(null);
    expect(readTranscriptEdgeBand()).toBeNull();
  });
});
