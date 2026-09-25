import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';

/**
 * The width of the composer's own input box, in CSS pixels, below which the footer takes the
 * compact arrangement.
 *
 * The box's width, not the window's: the footer arranges itself inside the box, so the box is what
 * decides whether its controls fit on one row. It was derived from the box, on the tree before this
 * change, with a replay pair in the footer — the widest this row gets — by sweeping the box and
 * reading where the two control groups stop sharing a row: at 742px they landed on separate rows
 * (tops 36px apart, box 113px tall) and at 757px they shared one (4px apart, 77px), so the crossing
 * is in (742, 757]. 800 puts the widths that still fit inside that band on the compact side as
 * well: 58px above the widest box that wrapped, 43px above the narrowest that fit, and 66px below
 * the 866px the box is capped at — which is the box a 1280px window gives, where the desktop
 * arrangement is unchanged.
 *
 * Read by `useComposerCompactTier` below and by the hook's own test, which takes both of its
 * threshold cells from this one value.
 */
export const COMPACT_TIER_WIDTH_PX = 800;

/** The box to measure, and the arrangement the caller draws for it. */
type ComposerCompactTier = {
  /**
   * Goes on the composer's `PromptInput` form — the box whose width decides the tier.
   *
   * Mutable, and written by the caller rather than only read: the form already carries a `ref` of
   * react-dropzone's (its root props put one there, and the dropzone's document-level containment
   * checks read it), so the caller attaches both from one callback ref instead of a `ref=`, and
   * that callback needs somewhere to put the node.
   */
  containerRef: MutableRefObject<HTMLFormElement | null>;
  /** True when the footer must take the compact arrangement. */
  isCompactTier: boolean;
};

/**
 * Used by the chat module's `ChatComposer` to decide the footer's arrangement from the width of the
 * box it is arranging in rather than from the window alone: a window wide enough for the desktop
 * arrangement still gets the compact one when the sidebar — or a drag of it — has left the box
 * narrower than the row needs.
 *
 * The window rule stays a rule of its own: below `md` the compact arrangement is taken whatever the
 * box measures, so the two signals are ORed and either one is enough. A box that cannot be measured
 * at all — no `ResizeObserver`, or a box that has not been laid out yet and so reads 0 — leaves the
 * window rule as the whole answer, which is what keeps an unmeasured render's structure identical to
 * the structure the window rule alone produced.
 */
export function useComposerCompactTier(): ComposerCompactTier {
  // The viewport signal, read through the same hook the rest of the app uses for `md`.
  const { isMobile } = useDeviceSettings();
  const containerRef = useRef<HTMLFormElement | null>(null);
  // The box's last measured width, or null while it has never been measured. State rather than a
  // value read during render because the box can change without the window changing — opening the
  // sidebar, or dragging its edge, resizes the box while `innerWidth` stands still — and the
  // arrangement has to follow that without the composer being remounted.
  const [boxWidth, setBoxWidth] = useState<number | null>(null);

  useEffect(() => {
    const box = containerRef.current;
    // Nothing to observe, or nothing that can observe: the window rule is the whole answer.
    if (!box || typeof ResizeObserver === 'undefined') {
      return;
    }

    // The box's own content width, read off the element rather than off the observer's entries, so
    // the measured number is the same one the layout is using. 0 means "not laid out yet" and is
    // kept as unmeasured rather than read as a narrow box, which would flip a hidden composer.
    const measure = () => {
      setBoxWidth(box.clientWidth);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const boxIsNarrow = boxWidth !== null && boxWidth > 0 && boxWidth < COMPACT_TIER_WIDTH_PX;

  return { containerRef, isCompactTier: isMobile || boxIsNarrow };
}
