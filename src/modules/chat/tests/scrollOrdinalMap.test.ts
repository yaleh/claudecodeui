import { describe, expect, it } from 'vitest';

import {
  closestScrollTopForFraction,
  fractionAtViewportCenter,
  ordinalAtY,
  scrollTopForFraction,
} from '@/modules/chat/utils/scrollOrdinalMap';
import type { ScrollOrdinalRow } from '@/modules/chat/utils/scrollOrdinalMap';

/**
 * Two rows 400px apart on the ordinal scale, so a pixel is a clean share of a
 * turn: rows[0] at ordinal 100/top 0, rows[1] at ordinal 200/top 400.
 */
const rows: ScrollOrdinalRow[] = [
  { ordinal: 100, top: 0 },
  { ordinal: 200, top: 400 },
];

/** The window's last ordinal — the far end of the scale the fractions are of. */
const LAST = 400;

/** A viewport tall enough that its centre can be placed anywhere in the window. */
const CLIENT_HEIGHT = 200;

describe('ordinalAtY', () => {
  it('interpolates between two turn rows by the pixel', () => {
    expect(ordinalAtY(rows, 0)).toBe(100);
    expect(ordinalAtY(rows, 200)).toBe(150);
    expect(ordinalAtY(rows, 400)).toBe(200);
  });

  it('stays continuous inside one turn — every pixel is its own ordinal', () => {
    const values = [0, 50, 100, 150, 200, 250, 300, 350, 400].map((y) => ordinalAtY(rows, y));
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]!).toBeGreaterThan(values[index - 1]!);
    }
  });

  it('clamps at both ends rather than extrapolating', () => {
    expect(ordinalAtY(rows, -10_000)).toBe(100);
    expect(ordinalAtY(rows, 10_000)).toBe(200);
  });

  it('returns null only when there are no rows to interpolate', () => {
    expect(ordinalAtY([], 0)).toBeNull();
  });
});

describe('fractionAtViewportCenter', () => {
  it('reads the viewport centre, not its top edge', () => {
    // Centre at y = 200 -> ordinal 150 -> 150/400.
    expect(fractionAtViewportCenter(rows, 100, CLIENT_HEIGHT, LAST)).toBeCloseTo(0.375, 6);
  });

  it('clamps to the window ends when the centre is beyond them', () => {
    expect(fractionAtViewportCenter(rows, -10_000, CLIENT_HEIGHT, LAST)).toBeCloseTo(100 / LAST, 6);
    expect(fractionAtViewportCenter(rows, 10_000, CLIENT_HEIGHT, LAST)).toBe(200 / LAST);
  });

  it('returns null with no rows or no scale', () => {
    expect(fractionAtViewportCenter([], 0, CLIENT_HEIGHT, LAST)).toBeNull();
    expect(fractionAtViewportCenter(rows, 0, CLIENT_HEIGHT, 0)).toBeNull();
  });

  it('does not jump when a row height is re-measured below the viewport', () => {
    // A third turn far below grows: it shifts the rows below it, but the segment
    // the viewport centre sits in is untouched, so the fraction does not move.
    const threeRow: ScrollOrdinalRow[] = [
      { ordinal: 100, top: 0 },
      { ordinal: 200, top: 400 },
      { ordinal: 300, top: 800 },
    ];
    const before = fractionAtViewportCenter(threeRow, 100, CLIENT_HEIGHT, LAST);
    const remeasured: ScrollOrdinalRow[] = [
      { ordinal: 100, top: 0 },
      { ordinal: 200, top: 400 },
      { ordinal: 300, top: 1_100 },
    ];
    const after = fractionAtViewportCenter(remeasured, 100, CLIENT_HEIGHT, LAST);
    expect(after).toBeCloseTo(before!, 6);
  });

  it('does not jump when a prepend shifts every row and the offset together', () => {
    // A window prepended above the viewport moves each row's top down by the
    // prepended height while the scroll anchor moves the offset by the same
    // amount, so the visual position — and the fraction — is unchanged.
    const before = fractionAtViewportCenter(rows, 100, CLIENT_HEIGHT, LAST);
    const shifted: ScrollOrdinalRow[] = rows.map((row) => ({ ordinal: row.ordinal, top: row.top + 120 }));
    const after = fractionAtViewportCenter(shifted, 220, CLIENT_HEIGHT, LAST);
    expect(after).toBeCloseTo(before!, 6);
  });
});

describe('scrollTopForFraction', () => {
  it('inverts fractionAtViewportCenter inside the window', () => {
    for (const fraction of [0.25, 0.375, 0.5]) {
      const top = scrollTopForFraction(rows, fraction, LAST, CLIENT_HEIGHT);
      expect(top).not.toBeNull();
      expect(fractionAtViewportCenter(rows, top!, CLIENT_HEIGHT, LAST)).toBeCloseTo(fraction, 6);
    }
  });

  it('returns null when the fraction lies outside the loaded window', () => {
    expect(scrollTopForFraction(rows, 0, LAST, CLIENT_HEIGHT)).toBeNull();
    expect(scrollTopForFraction(rows, 1, LAST, CLIENT_HEIGHT)).toBeNull();
  });

  it('maps the window ends to the viewport-centre offset', () => {
    expect(scrollTopForFraction(rows, 100 / LAST, LAST, CLIENT_HEIGHT)).toBeCloseTo(-100, 6);
    expect(scrollTopForFraction(rows, 200 / LAST, LAST, CLIENT_HEIGHT)).toBeCloseTo(300, 6);
  });
});

describe('closestScrollTopForFraction', () => {
  it('is covered exactly inside the window and clamped at its ends', () => {
    expect(closestScrollTopForFraction(rows, 0.375, LAST, CLIENT_HEIGHT)).toEqual({ top: 100, covered: true });
    expect(closestScrollTopForFraction(rows, 0.1, LAST, CLIENT_HEIGHT)).toEqual({ top: -100, covered: false });
    expect(closestScrollTopForFraction(rows, 1, LAST, CLIENT_HEIGHT)).toEqual({ top: 300, covered: false });
  });

  it('returns null with no rows to place against', () => {
    expect(closestScrollTopForFraction([], 0.5, LAST, CLIENT_HEIGHT)).toBeNull();
  });
});
