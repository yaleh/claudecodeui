import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Play, Power, RotateCcw } from 'lucide-react';
import type { TFunction } from 'i18next';

import {
  findBinding,
  findSessionHost,
  findSessionHostState,
  readResidentProcessState,
  useSessionHosts,
} from '@/shared/hooks/useSessionHosts';
import { cn } from '@/shared/utils';
import type { SessionHostLeaseKind } from '@/shared/types';

/** How long the copy control says so before returning to its resting label. */
const COPIED_NOTICE_MS = 1500;

/** The panel's own width, matching the `w-72` class it is drawn with. */
const POPOVER_WIDTH_PX = 288;
/** The gap between the bar and the panel below it, matching the `mt-1` it used to be laid out with. */
const POPOVER_GAP_PX = 4;
/** The least distance the panel keeps from the viewport's side edges once it is clamped into them. */
const POPOVER_VIEWPORT_MARGIN_PX = 8;

/** Where the panel is pinned, in viewport coordinates. */
type PopoverAnchor = { left: number; top: number };

/**
 * Formats an elapsed span the way the uptime line reads it.
 *
 * Coarse on purpose: this is a "since when" hint beside a pid, not a stopwatch,
 * and the bar re-renders on every poll, so seconds would redraw constantly.
 */
function formatUptime(startedAt: number | undefined, now: number): string {
  if (!startedAt) {
    return '';
  }

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h`;
}

/**
 * The resident status bar and its popover.
 *
 * Rendered by chat's ChatMessagesPane above the transcript, pinned the way the
 * export control is. It draws one thing the transcript cannot: the state of the
 * process behind the conversation — which is not a message, so it must not
 * scroll away with the turns it is describing.
 *
 * It reports the same state word as the sidebar's mark, from the same reading
 * (`readResidentProcessState`), and publishes the pair as data attributes: the
 * visible sentence says what the user reads, and `data-resident-ui-state` says
 * the same thing in the UI's own vocabulary, so the mark and the bar can be
 * compared without parsing copy. Nothing is rendered at all for a session that
 * is not stored `resident`, which is what keeps the bar off every other
 * session's transcript.
 *
 * Every fact it shows comes from `GET /api/session-hosts` — the address, the
 * pid, the lease counts and the close reason included. There is no local mirror
 * of any of them, which is deliberate: this bar's whole subject is a process it
 * does not own, and a cached copy would be able to disagree with the process.
 * The two controls that change that process (`start`, `close`) go through the
 * same hook, so their effect arrives the same way.
 */
export default function ResidentStatusBar({
  sessionId,
  t,
}: {
  sessionId: string | null;
  t: TFunction;
}) {
  const { snapshot, start, close } = useSessionHosts();
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * The panel, which is no longer a descendant of the bar.
   *
   * Kept as a ref of its own because the outside-click rule below has to treat a press inside it as
   * inside: a portal moves the DOM node out of `rootRef`, and a containment check that only knew
   * about the bar would read every click on the panel's own controls as a click away from it and
   * dismiss the panel before the button's handler could run.
   */
  const panelRef = useRef<HTMLDivElement | null>(null);
  /**
   * Where the panel is pinned, or null while it has not been placed yet.
   *
   * Viewport coordinates rather than the panel's own, because the panel is rendered into
   * `document.body`: its nearest positioned ancestor is no longer the bar, so `top-full` would
   * resolve against the page and not against the thing it describes.
   */
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  /**
   * Pins the panel just under the bar, clamped into the viewport.
   *
   * Re-run on resize and on any scroll rather than only at the moment the panel opens: the bar is
   * `sticky`, so a scroll of the transcript can move it, and a viewport change (a rotated phone, a
   * resized window) moves it without any scroll at all.
   */
  const placePopover = useCallback(() => {
    const bar = rootRef.current;
    if (!bar) {
      return;
    }

    const rect = bar.getBoundingClientRect();
    const maxLeft = Math.max(
      POPOVER_VIEWPORT_MARGIN_PX,
      window.innerWidth - POPOVER_WIDTH_PX - POPOVER_VIEWPORT_MARGIN_PX,
    );
    const next: PopoverAnchor = {
      left: Math.min(Math.max(rect.left, POPOVER_VIEWPORT_MARGIN_PX), maxLeft),
      top: rect.bottom + POPOVER_GAP_PX,
    };
    // Only when it moved: a scroll handler that set a fresh object every event would re-render the
    // whole bar (and its polled counts) on every frame of a flick.
    setAnchor((current) => (
      current && current.left === next.left && current.top === next.top ? current : next
    ));
  }, []);

  // Outside-click and Escape dismiss, matching the app's other popovers. Armed
  // only while open, so a closed bar costs no document listeners.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  // Placement is its own effect, and its own listeners, so that closing the panel is what removes
  // them: a single effect keyed on `isOpen` would either leave a stale anchor behind or re-arm the
  // document listeners every time the bar was scrolled.
  useEffect(() => {
    if (!isOpen) {
      setAnchor(null);
      return;
    }

    placePopover();
    // Capture, not bubble: the transcript scrolls inside `.chat-messages-pane`, and a scroll there
    // does not bubble to the window.
    window.addEventListener('resize', placePopover);
    window.addEventListener('scroll', placePopover, true);
    return () => {
      window.removeEventListener('resize', placePopover);
      window.removeEventListener('scroll', placePopover, true);
    };
  }, [isOpen, placePopover]);

  const copyAddress = useCallback(async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const runAction = useCallback(async (action: (id: string) => Promise<void>, id: string): Promise<boolean> => {
    setActionError(null);
    try {
      await action(id);
      return true;
    } catch (error) {
      // The server's refusals are specific (`LIFECYCLE_MODE_NOT_RESIDENT`, a
      // session that does not exist, a host that cannot be reached) and the
      // user's next move differs per case, so the message is shown verbatim
      // rather than replaced with a generic failure.
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  const stateView = sessionId ? findSessionHostState(snapshot, sessionId) : null;

  if (!sessionId || stateView?.lifecycleMode !== 'resident') {
    return null;
  }

  const host = findSessionHost(snapshot, sessionId);
  const binding = findBinding(snapshot, sessionId);
  const processState = readResidentProcessState(host);
  const address = binding?.peerName ?? '';

  // Counted from the leases the host reports and nothing else, so the reading
  // and the published sentence cannot come apart: a kind absent from the
  // listing is absent from both. The kinds are not enumerated here — iterating
  // the leases is what makes this a reading rather than a second declaration of
  // the host layer's vocabulary.
  const counts = new Map<SessionHostLeaseKind, number>();
  for (const lease of binding?.leases ?? []) {
    counts.set(lease.kind, (counts.get(lease.kind) ?? 0) + 1);
  }

  // The collapsed bar's one number, summed from the same map the panel's per-kind
  // chips are drawn from — so the bar cannot print a total the panel disagrees
  // with. It replaced one chip per kind, which grew linearly with the kinds held
  // and crowded the bar while the panel below it stayed half empty.
  let leaseTotal = 0;
  for (const count of counts.values()) {
    leaseTotal += count;
  }

  const stateText = processState === 'unstarted'
    ? t('resident.statusBar.unstarted', { reason: stateView.reason ?? '' })
    : processState === 'exited'
      ? t('resident.statusBar.exited', { detail: host?.closeDetail ?? '' })
      : t(`resident.statusBar.${processState}`);

  return (
    <div
      ref={rootRef}
      data-resident-status-bar="true"
      data-resident-ui-state={processState}
      data-resident-host-state={host?.state ?? 'absent'}
      data-resident-host-id={host?.hostId ?? ''}
      data-resident-close-reason={host?.closeReason ?? ''}
      data-resident-close-detail={host?.closeDetail ?? ''}
      data-resident-pid={host?.pid ?? ''}
      className={cn(
        'pointer-events-auto relative inline-flex items-center gap-2 rounded-lg border px-2 py-1 text-xs shadow-sm',
        processState === 'exited'
          ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
          : 'border-border/60 bg-card/95 text-foreground',
      )}
    >
      <button
        type="button"
        data-resident-status-bar-trigger="true"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={stateText}
        onClick={() => setIsOpen((open) => !open)}
        className="flex items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
      >
        <span data-resident-state-text="true" className="font-medium">
          {stateText}
        </span>
        {/*
          One merged number, not one chip per kind. The per-kind breakdown lives in the panel
          below (a row of `data-lease-kind` chips), which is where the space for it is; drawing it
          here made the bar's width scale with the number of kinds a host happened to hold. Nothing
          is drawn for a host holding no leases, matching the old chips, which simply rendered none.
        */}
        {leaseTotal > 0 ? (
          <span
            data-resident-lease-summary="true"
            data-resident-lease-total={leaseTotal}
            className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >
            {t('resident.statusBar.activeCount', { count: leaseTotal })}
          </span>
        ) : null}
      </button>

      {processState === 'exited' || processState === 'unstarted' ? (
        <button
          type="button"
          data-resident-start="true"
          onClick={() => void runAction(start, sessionId)}
          className="flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 font-medium transition-colors hover:bg-accent/60"
        >
          {processState === 'exited' ? <RotateCcw className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {processState === 'exited' ? t('resident.statusBar.restart') : t('resident.statusBar.start')}
        </button>
      ) : null}

      {/*
        The panel is rendered into `document.body`, not here.

        It used to be `absolute top-full` inside this bar, which put it inside `.chat-messages-pane`
        — an `overflow-y-auto overflow-x-hidden` scroll container. The panel opens downward, so on a
        short viewport (a 780x493 window with the resident disclosure open leaves the pane about a
        hundred pixels tall) it reached past the pane's bottom edge and the part below it was
        *clipped*: `document.elementFromPoint` at the Close button's own centre returned the
        composer's disclosure, which is what is painted under the pane, and the button could not be
        clicked at all. No `z-index` fixes a clip, which is why the panel leaves the box instead of
        out-ranking the composer — it is pinned in viewport coordinates from the bar's own rect.

        Rendered only once the anchor exists, so a first frame at the viewport's origin is never
        drawn, and unconditionally removed on close so nothing is left in `document.body`.
      */}
      {isOpen && anchor
        ? createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={stateText}
            style={{ left: anchor.left, top: anchor.top }}
            className="fixed z-30 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <div className="mb-2">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                {t('resident.statusBar.address')}
              </span>
              <span data-resident-address="true" className="block break-all font-mono text-xs">
                {address}
              </span>
            </div>

            <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span data-resident-pid-text="true">pid {host?.pid ?? '—'}</span>
              <span aria-hidden="true">·</span>
              <span data-resident-uptime="true">{formatUptime(host?.startedAt, Date.now())}</span>
            </div>

            {/*
              The per-kind breakdown the collapsed bar no longer draws. The attributes and the
              `counts.*` copy are unchanged from where they used to live — only the container moved
              — so a reader that counts leases by kind reads the same pair off this panel.
            */}
            {counts.size > 0 ? (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {[...counts.entries()].map(([kind, count]) => (
                  <span
                    key={kind}
                    data-lease-kind={kind}
                    data-lease-count={count}
                    className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {count} {t(`resident.statusBar.counts.${kind}`, { defaultValue: kind })}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-resident-copy="true"
                disabled={!address}
                onClick={() => void copyAddress(address)}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-40"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? t('resident.statusBar.copied') : t('resident.statusBar.copyAddress')}
              </button>

              <button
                type="button"
                data-resident-close="true"
                onClick={() => {
                  // The popover closes only once the close went through: on a
                  // refusal the refusal is the thing the user has to read, and it
                  // is drawn inside this panel.
                  void runAction(close, sessionId).then((closed) => {
                    if (closed) {
                      setIsOpen(false);
                    }
                  });
                }}
                className="flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
              >
                <Power className="h-3 w-3" />
                {t('resident.statusBar.close')}
              </button>
            </div>

            {actionError ? (
              <p data-resident-action-error="true" className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                {actionError}
              </p>
            ) : null}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
