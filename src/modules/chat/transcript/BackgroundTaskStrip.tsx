import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  findBackgroundTaskLeases,
  useSessionHosts,
} from '@/shared/hooks/useSessionHosts';
import type { ChatMessage, SessionHostLease } from '@/shared/types';

/** The two held-work lease kinds this strip draws, as one alias. */
type HeldWorkLease = Extract<SessionHostLease, { kind: 'background-task' | 'monitor' }>;

/** How often the elapsed readings are recomputed while a strip is on screen. */
const ELAPSED_TICK_MS = 1000;

/** The production clock, held at module scope so the default prop is stable across renders. */
const systemNow = () => Date.now();

/**
 * A background task's human-readable label, resolved from the transcript by the
 * lease's own id.
 *
 * The id the manager holds a host for is the same id the CLI put on the tool
 * call that started the work — that is the join the server's own reconciliation
 * uses — so the transcript is the one place a description exists and no second
 * registry has to be invented for it. Preference is the tool's own `description`
 * (what `Bash` and `Monitor` both carry), then the first line of a shell
 * `command`, then the tool's name; a lease whose call never reached the loaded
 * transcript yields null and the caller falls back to a generic word.
 */
function labelForLease(messages: readonly ChatMessage[], lease: HeldWorkLease): string | null {
  for (const message of messages) {
    if (!message.isToolUse || (message.toolId ?? message.toolCallId) !== lease.id) {
      continue;
    }

    const input = message.toolInput;
    if (typeof input === 'object' && input !== null) {
      const record = input as Record<string, unknown>;
      if (typeof record.description === 'string' && record.description.trim().length > 0) {
        return record.description.trim();
      }
      if (typeof record.command === 'string' && record.command.trim().length > 0) {
        return record.command.trim().split('\n', 1)[0].trim();
      }
    }

    return typeof message.toolName === 'string' && message.toolName.length > 0 ? message.toolName : null;
  }

  return null;
}

/**
 * How long a held task has been running, as a compact `M:SS` / `H:MM:SS`.
 *
 * Deliberately clock-arithmetic and not a localized sentence: the strip's words
 * come from the locale files, but a duration is a reading, and formatting it as
 * words would put a unit vocabulary in twelve files to say the same digits.
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The timestamp of the newest turn a background task started, or null.
 *
 * This is the "when did we last hear from a task" reading, and the transcript's
 * own divider is the only honest source: it is stamped when a turn triggered by
 * background work was drawn, so it says when a *notification arrived*, not when
 * the task is progressing — the work's internal progress is not observable from
 * here and is deliberately not claimed.
 */
function latestNotificationAt(messages: readonly ChatMessage[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (message.origin?.trigger !== 'background-task') {
      continue;
    }
    const at = new Date(message.timestamp).getTime();
    if (Number.isFinite(at) && (latest === null || at > latest)) {
      latest = at;
    }
  }
  return latest;
}

type BackgroundTaskStripProps = {
  /** The conversation whose held work this strip reports; null draws nothing. */
  sessionId: string | null;
  /**
   * The loaded transcript. Read only to turn a lease id into a label — never to
   * decide that work exists: a task the model never mentioned must still appear.
   */
  messages: readonly ChatMessage[];
  /** Test seam: the clock the elapsed readings are taken against. */
  now?: () => number;
};

/**
 * Rendered by chat's ChatMessagesPane at the end of the message flow: the
 * background tasks the current session's host is being held for.
 *
 * This surface exists because the work is real whether or not the model says
 * so. A held task is a fact about the process — the same fact the host layer
 * uses to keep it alive — and until now the only place a user could learn of it
 * was prose the model chose to write; a model that stayed silent made the work
 * invisible. The strip reads the leases off the shared `/api/session-hosts`
 * snapshot (through `useSessionHosts`) and reports identity and elapsed time,
 * and nothing else: a task's internal progress lives in its own stdout, is
 * relayed by the model, and drawing it would be endorsing a source this view
 * cannot check.
 *
 * It draws three programmatically distinct shapes, and the difference is load
 * bearing:
 *
 *   - **held work** — one row per `background-task` / `monitor` lease, with its
 *     label and how long it has been held.
 *   - **unknown** — the poll failed or has never answered, so the strip says so
 *     with its own marker rather than drawing zero rows. Collapsing "cannot
 *     read" into "nothing is running" is the exact lie this state exists to
 *     prevent.
 *   - **nothing held** — no element at all. Zero is *absence*, not a row, which
 *     is what makes a task's wire form the only thing on screen: when the last
 *     task ends the strip disappears rather than leaving a permanent entry for
 *     a finished task.
 *
 * Records `data-background-task-strip` (`active` | `unknown`), one
 * `[data-background-task-row]` per held lease, and `[data-background-task-label]`
 * / `[data-background-task-elapsed]` inside each row.
 */
export function BackgroundTaskStrip({ sessionId, messages, now = systemNow }: BackgroundTaskStripProps) {
  const { t } = useTranslation('chat');
  const { snapshot, error } = useSessionHosts();
  // The instant the elapsed readings are measured against. State rather than a
  // per-render `Date.now()` so the row's text only moves when the second does;
  // its only job is to force the re-render a ticking duration needs.
  const [nowMs, setNowMs] = useState(now);

  const tick = useCallback(() => setNowMs(now()), [now]);

  useEffect(() => {
    const handle = setInterval(tick, ELAPSED_TICK_MS);
    return () => clearInterval(handle);
  }, [tick]);

  const leases = useMemo(
    () => (sessionId ? findBackgroundTaskLeases(snapshot, sessionId) : []),
    [snapshot, sessionId],
  );

  if (!sessionId) {
    return null;
  }

  // The poll's own result, not the host's: a snapshot on hand is the one from
  // before the failure, and reporting its leases as current would be a claim
  // nothing is backing. `snapshot === null` is the same absence on the first
  // render — nothing has answered yet.
  if (error !== null || snapshot === null) {
    return (
      <div
        data-background-task-strip="unknown"
        role="status"
        className="flex items-center gap-2 px-1 py-1 text-xs text-amber-600 dark:text-amber-400"
      >
        <span
          data-background-task-unknown=""
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full border border-dashed border-amber-500"
        />
        <span>{t('resident.backgroundTasks.unknown', { defaultValue: 'Background task state unknown' })}</span>
      </div>
    );
  }

  if (leases.length === 0) {
    return null;
  }

  const notificationAt = latestNotificationAt(messages);

  return (
    <div
      data-background-task-strip="active"
      role="status"
      aria-label={t('resident.backgroundTasks.title', { defaultValue: 'Background tasks' })}
      className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <div data-background-task-header="" className="mb-1 flex items-center justify-between gap-2">
        <span className="font-medium">{t('resident.backgroundTasks.title', { defaultValue: 'Background tasks' })}</span>
        {notificationAt !== null && (
          <span data-background-task-last-notification="">
            {t('resident.backgroundTasks.lastNotification', {
              elapsed: formatElapsed(nowMs - notificationAt),
              defaultValue: 'Last notification {{elapsed}} ago',
            })}
          </span>
        )}
      </div>
      <ul className="space-y-0.5">
        {leases.map((lease) => {
          const resolved = labelForLease(messages, lease);
          const label =
            resolved ??
            t(lease.kind === 'monitor' ? 'resident.backgroundTasks.monitorLabel' : 'resident.backgroundTasks.genericLabel', {
              defaultValue: lease.kind === 'monitor' ? 'Monitor' : 'Background task',
            });
          return (
            <li
              key={`${lease.kind}:${lease.id}`}
              data-background-task-row=""
              data-background-task-kind={lease.kind}
              data-background-task-id={lease.id}
              data-background-task-since={String(lease.since)}
              className="flex items-center justify-between gap-3"
            >
              <span data-background-task-label="" className="truncate">
                {label}
              </span>
              <span data-background-task-elapsed="" className="shrink-0 tabular-nums">
                {formatElapsed(nowMs - lease.since)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default BackgroundTaskStrip;
