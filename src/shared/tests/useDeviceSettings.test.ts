import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test } from 'vitest';

import {
  SHORT_VIEWPORT_MAX_HEIGHT_PX,
  useDeviceSettings,
} from '@/shared/hooks/useDeviceSettings';

/**
 * The short-viewport tier is the only signal in the app read from the viewport's *height* — every
 * other responsive rule keys off the width, which is why a phone in landscape (844 wide, 330 tall)
 * was handed the desktop chrome and left with a 126px transcript.
 *
 * Three properties make it safe to build layout on, and each is pinned below: it is decided by
 * height alone rather than by any combination with the width rule, it turns on strictly below the
 * threshold (the same `<` the width rule uses, so the two read alike), and it is off in jsdom's own
 * 1024x768 window — which is what lets every pre-existing test keep reading the layout it always
 * read without being touched.
 */

/** jsdom's own window, restored before each case because the viewport is a writable global. */
const JSDOM_WIDTH = 1024;
const JSDOM_HEIGHT = 768;

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
};

beforeEach(() => {
  setViewport(JSDOM_WIDTH, JSDOM_HEIGHT);
});

test('the tier turns on below the threshold and not at it', () => {
  setViewport(844, SHORT_VIEWPORT_MAX_HEIGHT_PX - 1);
  const below = renderHook(() => useDeviceSettings());
  assert.equal(below.result.current.isShortViewport, true);
  below.unmount();

  setViewport(844, SHORT_VIEWPORT_MAX_HEIGHT_PX);
  const at = renderHook(() => useDeviceSettings());
  assert.equal(at.result.current.isShortViewport, false);
});

test('height alone decides the tier, independently of the width rule', () => {
  // A phone in landscape: wide enough for `md` and far too short to pay for the desktop chrome.
  // The pair is the point — `isMobile` is false here, so a tier derived from the width rule alone
  // can never reach this viewport.
  setViewport(844, 330);
  const landscapePhone = renderHook(() => useDeviceSettings());
  assert.equal(landscapePhone.result.current.isShortViewport, true);
  assert.equal(landscapePhone.result.current.isMobile, false);
  landscapePhone.unmount();

  // A phone upright: mobile, but with the height to afford the stacked composer and the floating
  // status tab, so it must not be pulled onto the short tier by its width.
  setViewport(390, 844);
  const portraitPhone = renderHook(() => useDeviceSettings());
  assert.equal(portraitPhone.result.current.isShortViewport, false);
  assert.equal(portraitPhone.result.current.isMobile, true);
});

test("jsdom's own window is the tall tier", () => {
  const { result } = renderHook(() => useDeviceSettings());

  assert.equal(result.current.isShortViewport, false);
});

test('a resize re-reads the tier, so a rotation does not keep the old layout', () => {
  setViewport(390, 844);
  const { result } = renderHook(() => useDeviceSettings());
  assert.equal(result.current.isShortViewport, false);

  act(() => {
    setViewport(844, 330);
    window.dispatchEvent(new Event('resize'));
  });

  assert.equal(result.current.isShortViewport, true);
});

test('a caller that opts out of viewport tracking is never told it is short', () => {
  // The one option that gates the resize listener gates this signal with it. Stated as a test
  // rather than left implicit because the coupling is invisible at the call site.
  setViewport(844, 330);
  const { result } = renderHook(() => useDeviceSettings({ trackMobile: false }));

  assert.equal(result.current.isShortViewport, false);
});
