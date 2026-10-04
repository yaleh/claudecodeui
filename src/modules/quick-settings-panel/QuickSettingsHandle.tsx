import type {
  MouseEvent as ReactMouseEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { QuickSettingsHandleStyle } from '@/shared/types';
import { TRANSCRIPT_HANDLE_SCROLLBAR_GAP_PX } from '@/shared/transcriptEdgeLayout';

type QuickSettingsHandleProps = {
  isOpen: boolean;
  isDragging: boolean;
  style: QuickSettingsHandleStyle;
  /** Attached by the drag hook so it can measure the handle's box. */
  handleRef: RefObject<HTMLButtonElement>;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLButtonElement>) => void;
};

/**
 * Rendered by QuickSettingsPanelView as the draggable edge handle that opens and
 * closes the drawer.
 *
 * Closed, it parks just clear of the transcript's drawn scrollbar rather than on
 * the pane's edge — the scrollbar chat publishes the x of — so the two never
 * overlap; open, it keeps the `right-64` berth the drawer's own width gives it.
 */
export default function QuickSettingsHandle({
  isOpen,
  isDragging,
  style,
  handleRef,
  onClick,
  onMouseDown,
  onTouchStart,
}: QuickSettingsHandleProps) {
  const { t } = useTranslation('settings');

  const placementClass = isOpen ? 'right-64' : '';
  const borderClass = isDragging
    ? 'border-blue-500 dark:border-blue-400'
    : 'border-gray-200 dark:border-gray-700';
  const transitionClass = isDragging
    ? ''
    : 'transition-all duration-150 ease-out';
  const cursorClass = isDragging ? 'cursor-grabbing' : 'cursor-pointer';
  const ariaLabel = isDragging
    ? t('quickSettings.dragHandle.dragging')
    : isOpen
      ? t('quickSettings.dragHandle.closePanel')
      : t('quickSettings.dragHandle.openPanel');
  const title = isDragging
    ? t('quickSettings.dragHandle.draggingStatus')
    : t('quickSettings.dragHandle.toggleAndMove');

  return (
    <button
      ref={handleRef}
      type="button"
      data-quick-settings-handle
      onClick={onClick}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      className={`fixed ${placementClass} z-50 ${transitionClass} border bg-white dark:bg-gray-800 ${borderClass} rounded-l-md p-2 shadow-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 ${cursorClass} touch-none`}
      style={{
        ...style,
        // Clear of the drawn scrollbar: the transcript publishes its thumb's left
        // edge, and the handle's right edge stops a gap short of it. The fallback
        // is the viewport's own edge, for a page where no transcript is mounted.
        ...(isOpen
          ? null
          : {
              right: `calc(100% - var(--transcript-edge-thumb-left, calc(100% - 4px)) + ${TRANSCRIPT_HANDLE_SCROLLBAR_GAP_PX}px)`,
            }),
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
      }}
      aria-label={ariaLabel}
      title={title}
    >
      {isDragging ? (
        <GripVertical className="h-5 w-5 text-blue-500 dark:text-blue-400" />
      ) : isOpen ? (
        <ChevronRight className="h-5 w-5 text-gray-600 dark:text-gray-400" />
      ) : (
        <ChevronLeft className="h-5 w-5 text-gray-600 dark:text-gray-400" />
      )}
    </button>
  );
}
