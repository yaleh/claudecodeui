import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';

import type { QuickSettingsHandleStyle } from '@/shared/types';
import {
  clampHandleShare,
  handleShareAtBandTop,
  readTranscriptEdgeBand,
  subscribeTranscriptEdgeBand,
} from '@/shared/transcriptEdgeLayout';
import type { TranscriptEdgeBand } from '@/shared/transcriptEdgeLayout';

const HANDLE_POSITION_STORAGE_KEY = 'quickSettingsHandlePosition';

const DRAG_THRESHOLD_PX = 5;

type UseQuickSettingsDragProps = {
  isMobile: boolean;
};

type StartDragEvent = ReactMouseEvent<HTMLButtonElement> | ReactTouchEvent<HTMLButtonElement>;
type MoveDragEvent = MouseEvent | TouchEvent;
type EventWithClientY = StartDragEvent | MoveDragEvent;

/**
 * The handle's stored position, as a share of the viewport height.
 *
 * Which edge the share measures depends on the placement (`handleStyle` centres
 * the handle on it on a wide viewport and hangs its bottom edge that far above
 * the viewport's bottom on a narrow one), which is the shape the persisted value
 * has always had; what is new is that the share is a *request* rather than the
 * answer — the handle is clamped into the band chat publishes before it is drawn.
 * `null` means the reader has never chosen one, and the band's top is used.
 */
const readStoredHandlePosition = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const saved = localStorage.getItem(HANDLE_POSITION_STORAGE_KEY);
  if (!saved) {
    return null;
  }

  try {
    const parsed = JSON.parse(saved) as { y?: unknown };
    if (typeof parsed.y === 'number' && Number.isFinite(parsed.y)) {
      return parsed.y;
    }
  } catch {
    localStorage.removeItem(HANDLE_POSITION_STORAGE_KEY);
    return null;
  }

  return null;
};

const isTouchEvent = (event: { type: string }): boolean => event.type.includes('touch');

const getClientY = (event: EventWithClientY): number | null => {
  if ('touches' in event) {
    return event.touches[0]?.clientY ?? null;
  }

  return 'clientY' in event && typeof event.clientY === 'number'
    ? event.clientY
    : null;
};

export function useQuickSettingsDrag({ isMobile }: UseQuickSettingsDragProps) {
  const [storedPosition, setStoredPosition] = useState<number | null>(readStoredHandlePosition);
  const [isPointerDown, setIsPointerDown] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // The band chat publishes: the vertical run the handle may occupy and the x its
  // right edge must stay clear of. Null until the transcript has published one —
  // no session open, or the transcript not mounted — in which case the handle
  // keeps whatever share it was given.
  const [band, setBand] = useState<TranscriptEdgeBand | null>(null);
  // The handle's own drawn height, measured rather than assumed: converting
  // between a centre and a top edge is what the clamp is, and a wrong height
  // would push the handle past the band's ends.
  const [handleHeight, setHandleHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    () => (typeof window === 'undefined' ? 0 : window.innerHeight),
  );

  /** Attached to the handle button by the panel view, so its height and box can be read. */
  const handleRef = useRef<HTMLButtonElement | null>(null);

  const dragStartYRef = useRef<number | null>(null);
  const dragStartPositionRef = useRef(0);
  const didDragRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const bodyStylesAppliedRef = useRef(false);

  const clearBodyDragStyles = useCallback(() => {
    if (!bodyStylesAppliedRef.current) {
      return;
    }

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.width = '';
    bodyStylesAppliedRef.current = false;
  }, []);

  const applyBodyDragStyles = useCallback((isTouchDragging: boolean) => {
    if (bodyStylesAppliedRef.current) {
      return;
    }

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    // Touch drag should lock body scroll so the handle movement stays smooth.
    if (isTouchDragging) {
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
    }

    bodyStylesAppliedRef.current = true;
  }, []);

  /**
   * The share the handle is drawn at: the reader's own position when they have
   * chosen one, the band's top otherwise, and in both cases clamped into the band
   * the transcript published. Re-clamping here rather than only on a gesture is
   * what makes a position saved against an older layout — or against a wider
   * window — land inside the band it meets on the next load.
   */
  const handlePosition = useMemo(() => {
    const share = storedPosition ?? (band ? handleShareAtBandTop(handleHeight, viewportHeight, band, isMobile) : null);
    if (share === null) return 50;
    return clampHandleShare(share, handleHeight, viewportHeight, band, isMobile);
  }, [band, handleHeight, isMobile, storedPosition, viewportHeight]);

  // The band is republished whenever chat re-measures it, and the viewport height
  // it is expressed in changes with a window resize; both move the clamp.
  useEffect(() => {
    setBand(readTranscriptEdgeBand());
    const unsubscribe = subscribeTranscriptEdgeBand(() => setBand(readTranscriptEdgeBand()));
    const onResize = () => {
      setViewportHeight(window.innerHeight);
      setBand(readTranscriptEdgeBand());
    };
    window.addEventListener('resize', onResize);
    return () => {
      unsubscribe();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useLayoutEffect(() => {
    const element = handleRef.current;
    if (!element) return undefined;
    const measure = () => {
      setHandleHeight(element.getBoundingClientRect().height);
      setViewportHeight(window.innerHeight);
    };
    measure();
    // jsdom ships no ResizeObserver; there the handle keeps the height measured above.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  const endDrag = useCallback(() => {
    if (!isPointerDown && dragStartYRef.current === null) {
      return;
    }

    suppressNextClickRef.current = didDragRef.current;
    didDragRef.current = false;
    dragStartYRef.current = null;
    setIsPointerDown(false);
    setIsDragging(false);
    clearBodyDragStyles();
  }, [clearBodyDragStyles, isPointerDown]);

  const handleMove = useCallback(
    (event: MoveDragEvent) => {
      if (!isPointerDown || dragStartYRef.current === null) {
        return;
      }

      const clientY = getClientY(event);
      if (clientY === null) {
        return;
      }

      const rawDelta = clientY - dragStartYRef.current;
      const movedPastThreshold = Math.abs(rawDelta) > DRAG_THRESHOLD_PX;

      if (!didDragRef.current && movedPastThreshold) {
        didDragRef.current = true;
        setIsDragging(true);
        applyBodyDragStyles(isTouchEvent(event));
      }

      if (!didDragRef.current) {
        return;
      }

      if (isTouchEvent(event)) {
        event.preventDefault();
      }

      const liveHeight = Math.max(window.innerHeight, 1);
      const normalizedDelta = (rawDelta / liveHeight) * 100;
      const positionDelta = isMobile ? -normalizedDelta : normalizedDelta;
      // Letting go outside the band is not a request to leave it: the position is
      // clamped as it is dragged, so the handle is already back inside when the
      // pointer is released.
      setStoredPosition(clampHandleShare(
        dragStartPositionRef.current + positionDelta,
        handleHeight,
        liveHeight,
        band,
        isMobile,
      ));
    },
    [applyBodyDragStyles, band, handleHeight, isMobile, isPointerDown],
  );

  const startDrag = useCallback((event: StartDragEvent) => {
    event.stopPropagation();

    const clientY = getClientY(event);
    if (clientY === null) {
      return;
    }

    dragStartYRef.current = clientY;
    dragStartPositionRef.current = handlePosition;
    didDragRef.current = false;
    setIsDragging(false);
    setIsPointerDown(true);
  }, [handlePosition]);

  // Persist drag-handle position so users keep their preferred quick-access
  // location. The clamped share is what is written, so the stored value is always
  // one the current band accepts.
  useEffect(() => {
    localStorage.setItem(
      HANDLE_POSITION_STORAGE_KEY,
      JSON.stringify({ y: handlePosition }),
    );
  }, [handlePosition]);

  useEffect(() => {
    if (!isPointerDown) {
      return undefined;
    }

    const handleMouseMove = (event: MouseEvent) => {
      handleMove(event);
    };
    const handleMouseUp = () => {
      endDrag();
    };
    const handleTouchMove = (event: TouchEvent) => {
      handleMove(event);
    };
    const handleTouchEnd = () => {
      endDrag();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [endDrag, handleMove, isPointerDown]);

  useEffect(() => (
    () => {
      clearBodyDragStyles();
    }
  ), [clearBodyDragStyles]);

  const consumeSuppressedClick = useCallback((): boolean => {
    if (!suppressNextClickRef.current) {
      return false;
    }

    suppressNextClickRef.current = false;
    return true;
  }, []);

  const handleStyle = useMemo<QuickSettingsHandleStyle>(() => {
    if (!isMobile || typeof window === 'undefined') {
      return {
        top: `${handlePosition}%`,
        transform: 'translateY(-50%)',
      };
    }

    return {
      bottom: `${(window.innerHeight * handlePosition) / 100}px`,
    };
  }, [handlePosition, isMobile]);

  return {
    isDragging,
    handleStyle,
    handleRef,
    startDrag,
    consumeSuppressedClick,
  };
}
