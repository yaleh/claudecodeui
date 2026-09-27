import { useCallback, useEffect, useRef, useState } from 'react';
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

  // Outside-click and Escape dismiss, matching the app's other popovers. Armed
  // only while open, so a closed bar costs no document listeners.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
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

      {isOpen ? (
        <div
          role="dialog"
          aria-label={stateText}
          className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
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
        </div>
      ) : null}
    </div>
  );
}
