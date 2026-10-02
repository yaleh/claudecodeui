import { useEffect, useState } from 'react';

/**
 * The viewport height, in CSS pixels, below which the layout takes the short tier.
 *
 * Height, and not width, because a phone in landscape is *wide*: 844px clears `md` comfortably, so
 * every width-keyed rule in the app reads it as a small desktop and hands it the desktop's chrome —
 * a 57px header, a 57px composer row, 24px of composer padding — while it has only ~330px of screen
 * to pay for them with, once a browser's own toolbar is drawn. Measured before this tier existed:
 * 844x330 left the transcript 126px, and a 20-line draft pushed the submit button off the viewport
 * entirely. This constant is the axis those rules cannot see.
 *
 * 480 sits above every landscape phone (320-390 tall before browser chrome) and below any window a
 * desktop is actually worked in, so the tier turns on for the viewports that cannot afford the
 * chrome and for no others. Read by `useDeviceSettings` below and mirrored by the e2e layout matrix,
 * which takes its threshold cells from this one value.
 */
export const SHORT_VIEWPORT_MAX_HEIGHT_PX = 480;

type UseDeviceSettingsOptions = {
  mobileBreakpoint?: number;
  shortViewportMaxHeight?: number;
  trackMobile?: boolean;
  trackPWA?: boolean;
};

const getIsMobile = (mobileBreakpoint: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth < mobileBreakpoint;
};

const getIsShortViewport = (shortViewportMaxHeight: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerHeight < shortViewportMaxHeight;
};

const getIsPWA = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean(navigatorWithStandalone.standalone) ||
    document.referrer.includes('android-app://')
  );
};

export function useDeviceSettings(options: UseDeviceSettingsOptions = {}) {
  const {
    mobileBreakpoint = 768,
    shortViewportMaxHeight = SHORT_VIEWPORT_MAX_HEIGHT_PX,
    trackMobile = true,
    trackPWA = true
  } = options;

  const [isMobile, setIsMobile] = useState<boolean>(() => (
    trackMobile ? getIsMobile(mobileBreakpoint) : false
  ));
  // Held as state rather than read during render because three surfaces draw a different structure
  // on this tier — the composer's row, the transcript's bottom padding, the workspace header's
  // padding — and a rotation has to redraw all three without any of them changing for another
  // reason. A value read at render time would leave the landscape layout in place after the device
  // was turned upright.
  const [isShortViewport, setIsShortViewport] = useState<boolean>(() => (
    trackMobile ? getIsShortViewport(shortViewportMaxHeight) : false
  ));
  const [isPWA, setIsPWA] = useState<boolean>(() => (
    trackPWA ? getIsPWA() : false
  ));

  useEffect(() => {
    if (!trackMobile || typeof window === 'undefined') {
      return;
    }

    // One listener drives both viewport signals: they are read from the same event, and a caller
    // that opts out of viewport tracking (`trackMobile: false`, which the sidebar does because it
    // reads neither) has no use for either of them.
    const checkViewport = () => {
      setIsMobile(getIsMobile(mobileBreakpoint));
      setIsShortViewport(getIsShortViewport(shortViewportMaxHeight));
    };

    checkViewport();
    window.addEventListener('resize', checkViewport);

    return () => {
      window.removeEventListener('resize', checkViewport);
    };
  }, [mobileBreakpoint, shortViewportMaxHeight, trackMobile]);

  useEffect(() => {
    if (!trackPWA || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const checkPWA = () => {
      setIsPWA(getIsPWA());
    };

    checkPWA();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', checkPWA);
      return () => {
        mediaQuery.removeEventListener('change', checkPWA);
      };
    }

    mediaQuery.addListener(checkPWA);
    return () => {
      mediaQuery.removeListener(checkPWA);
    };
  }, [trackPWA]);

  return { isMobile, isPWA, isShortViewport };
}
