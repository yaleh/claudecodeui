import { describe, expect, it } from 'vitest';

import {
  currentTurnOrdinal,
  visibleTickWindow,
} from '@/modules/chat/utils/turnTickWindow';

/** A stand-in turn list: `visibleTickWindow` reads only the length. */
const turnsOf = (count: number) => Array.from({ length: count }, (_, index) => index);

describe('visibleTickWindow', () => {
  it('draws every turn when the conversation is no longer than the column', () => {
    expect(visibleTickWindow(turnsOf(5), 0, 0, 10)).toEqual({ start: 0, end: 5 });
    expect(visibleTickWindow(turnsOf(5), 4, 0, 10)).toEqual({ start: 0, end: 5 });
    expect(visibleTickWindow(turnsOf(10), 7, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleTickWindow(turnsOf(0), 0, 0, 10)).toEqual({ start: 0, end: 0 });
  });

  it('never draws more ticks than the capacity, however long the conversation is', () => {
    for (const count of [11, 50, 1200]) {
      for (const current of [0, 1, Math.floor(count / 2), count - 1]) {
        const window = visibleTickWindow(turnsOf(count), current, 0, 10);
        expect(window.end - window.start).toBe(10);
        expect(window.start).toBeGreaterThanOrEqual(0);
        expect(window.end).toBeLessThanOrEqual(count);
      }
    }
  });

  it('keeps the current turn inside the window, below its middle', () => {
    const count = 500;
    const current = 250;
    const window = visibleTickWindow(turnsOf(count), current, 0, 10);
    expect(current).toBeGreaterThanOrEqual(window.start);
    expect(current).toBeLessThan(window.end);
    // Below the middle: more of the conversation ahead than behind, and never the
    // top slot, where a hover summary would be clipped by the pane's edge.
    expect(current - window.start).toBeGreaterThanOrEqual(5);
    expect(current - window.start).toBeLessThan(10);
  });

  it('pins the window to the first turn at the start of the conversation', () => {
    expect(visibleTickWindow(turnsOf(500), 0, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleTickWindow(turnsOf(500), 2, 0, 10)).toEqual({ start: 0, end: 10 });
  });

  it('pins the window to the end of the list at the last turn', () => {
    const count = 500;
    const window = visibleTickWindow(turnsOf(count), count - 1, 0, 10);
    expect(window).toEqual({ start: count - 10, end: count });
  });

  it('clamps a scroll offset that would run the window off either end', () => {
    const count = 500;
    const current = 250;
    const anchored = visibleTickWindow(turnsOf(count), current, 0, 10);
    expect(visibleTickWindow(turnsOf(count), current, -1_000, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleTickWindow(turnsOf(count), current, 1_000, 10))
      .toEqual({ start: count - 10, end: count });
    // A scroll of a few ticks is honoured exactly, which is what makes the wheel
    // over the column move it by one line per notch.
    expect(visibleTickWindow(turnsOf(count), current, 3, 10))
      .toEqual({ start: anchored.start + 3, end: anchored.end + 3 });
  });

  it('holds the window still when turns are appended past its end', () => {
    const current = 20;
    const before = visibleTickWindow(turnsOf(50), current, 0, 10);
    const after = visibleTickWindow(turnsOf(67), current, 0, 10);
    expect(after).toEqual(before);
    // ...and exactly one line further on when the reader has wheeled one line.
    expect(visibleTickWindow(turnsOf(67), current, 1, 10))
      .toEqual({ start: before.start + 1, end: before.end + 1 });
  });

  it('draws nothing for a capacity of zero', () => {
    expect(visibleTickWindow(turnsOf(500), 250, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('currentTurnOrdinal', () => {
  const turns = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('answers the turn\'s own place in the list', () => {
    expect(currentTurnOrdinal(turns, 'a')).toBe(0);
    expect(currentTurnOrdinal(turns, 'c')).toBe(2);
  });

  it('places a turn the outline does not name at the end, and no turn at all at the start', () => {
    expect(currentTurnOrdinal(turns, 'not-yet-indexed')).toBe(2);
    expect(currentTurnOrdinal(turns, null)).toBe(0);
    expect(currentTurnOrdinal([], null)).toBe(0);
    expect(currentTurnOrdinal([], 'anything')).toBe(0);
  });
});
