import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';

import ResidentPanel from '@/modules/chat/transcript/ResidentStatusBar';
import { useActivityFreshness } from '@/modules/chat/hooks/useActivityFreshness';
import { deriveActivityDockView } from '@/modules/chat/utils/activityDockView';
import { Shimmer } from '@/shared/ui';
import type { ActivityConnection, SessionActivity } from '@/shared/types';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  /** The session whose liveness this dock reports; frames for other sessions are ignored. */
  sessionId?: string | null;
  /**
   * Test seam: an in-memory liveness channel. Production omits it and the dock
   * reads the app's own socket through `WebSocketContext`.
   */
  connection?: ActivityConnection | null;
  /** The dock's interrupt affordance. Absent on the transcript's surface, which carries none. */
  onAbort?: () => void;
  isInputFocused?: boolean;
  /**
   * True when the last send was never taken. The dock then reports the failure
   * instead of drawing nothing — the state that replaced the old silent drop.
   */
  sendFailed?: boolean;
  /**
   * True for a session whose stored lifecycle mode is `resident`. Such a session
   * has facts to show between turns — the address of the process holding it, its
   * pid, and the controls that start, restart and close it — so the dock stays on
   * screen in an `idle` reading instead of disappearing with the turn. The
   * resident facts themselves live in the dock's expanded panel; this flag only
   * decides whether the collapsed entry point is drawn.
   */
  persistWhenIdle?: boolean;
};

const ACTION_KEYS = [
  'claudeStatus.actions.thinking',
  'claudeStatus.actions.processing',
  'claudeStatus.actions.analyzing',
  'claudeStatus.actions.working',
  'claudeStatus.actions.computing',
  'claudeStatus.actions.reasoning',
];
const DEFAULT_ACTION_WORDS = ['Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning'];
const EXIT_ANIMATION_MS = 220;

/**
 * The activity dock: one honest reading of what a session is doing.
 *
 * It is the surface that replaced the rotating `Thinking…` label, and — since
 * the consolidation — the *only* one. The desktop tab-shaped strip and the
 * transcript's compact line used to be two renderings of one component behind a
 * `variant` switch, each with a marker of its own; they are now a single surface
 * with a single `[data-activity-dock]` root, mounted once per viewport, so a
 * reader that counts docks counts one and a reader that looks for the old
 * markers finds none.
 *
 * Two things decide what it says — the client's local "this session is
 * processing" table, and the freshness of the server's own frames (via
 * `useActivityFreshness`). When the server stops proving it is there, the dock
 * stops speaking for it: the state becomes `unreachable`, the elapsed reading
 * freezes at the server's last `asOf`, and the stop control is disabled with a
 * visible reason instead of being silently dropped. The six rotating action
 * words never appear in that state, in any locale.
 *
 * The dock is also where the resident session's own facts live now. They used to
 * be a status bar of their own above the transcript, with a second busy/idle
 * word and its own lease counts — a second answer to a question the dock already
 * answers. That bar is gone; what it said about *the process* (its address, its
 * pid, and the controls that start, restart and close it) is the dock's expanded
 * panel, and what it said about *activity* is this dock's one reading.
 *
 * Records `data-activity-dock` / `data-activity-state` (and the server-derived
 * `data-activity-elapsed-ms`) for the browser criterion.
 */
export default function ActivityIndicator({
  activity,
  sessionId,
  connection,
  onAbort,
  isInputFocused = false,
  sendFailed = false,
  persistWhenIdle = false,
}: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const freshness = useActivityFreshness(sessionId, connection);
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const stopReasonId = useId();
  const panelId = useId();

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  // A failed send must be reportable the moment it is known. While the turn is
  // real (`activity` present) the exit animation's last frame is the better
  // reading; with no turn at all there is nothing to animate out of, so the
  // failed-send state takes the live prop rather than the exiting render.
  const dockActivity = sendFailed ? activity : renderedActivity;
  const dock = deriveActivityDockView({
    activity: dockActivity,
    liveness: freshness.liveness,
    elapsedMs: freshness.elapsedMs,
    hasTurnAnchor: freshness.hasTurnAnchor,
    wired: freshness.wired,
    hasAbort: Boolean(onAbort),
    sendFailed,
  });

  // `hidden` — nothing to say and nothing to hold open — is the only state that
  // draws nothing at all. A resident session has facts to keep reachable between
  // turns, so its collapsed dock stays and reports `idle`: an absence and a
  // reading of "nothing is running" are different answers, and the criteria that
  // compare this dock against the sidebar and the send button need the second one.
  const state = dock.state === 'hidden' ? (persistWhenIdle ? 'idle' : 'hidden') : dock.state;

  if (state === 'hidden') return null;

  const dockAttributes = {
    'data-activity-dock': '',
    'data-activity-state': state,
    ...(dock.elapsedMs === null ? {} : { 'data-activity-elapsed-ms': String(dock.elapsedMs) }),
  } as const;

  const elapsedSeconds = dock.elapsedSeconds;
  const minutes = elapsedSeconds === null ? 0 : Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds === null ? 0 : elapsedSeconds % 60;
  const elapsedLabel = elapsedSeconds === null
    ? null
    : minutes < 1
      ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
      : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });

  const isUnreachable = state === 'unreachable';
  const isSendFailed = state === 'send-failed';
  const isIdle = state === 'idle';
  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  const rotatingWord = actionWords[Math.floor((elapsedSeconds ?? 0) / 4) % actionWords.length];
  const label = isSendFailed
    ? t('claudeStatus.sendFailed.title', { defaultValue: 'Send failed · server not responding' })
    : isUnreachable
      ? t('claudeStatus.unreachable.title', { defaultValue: 'Connection lost · reconnecting…' })
      : isIdle
        ? t('claudeStatus.dock.idleLabel', { defaultValue: 'Idle' })
        : (renderedActivity?.statusText || rotatingWord).replace(/\.+$/, '');
  const sendFailedReason = t('claudeStatus.sendFailed.reason', {
    defaultValue: 'The message was not sent. Your draft is still in the box — try again.',
  });
  const stopReason = dock.stopReasonKey === null
    ? null
    : t(dock.stopReasonKey, { defaultValue: 'Stop is unavailable while the server is unreachable' });

  const animationClassName = isExiting ? 'chat-activity-exit' : 'chat-activity-enter';

  /**
   * The label's own pixels: a shimmered word while a turn runs, a plain
   * sentence when it cannot. The failed send is its own sentence with the way
   * out beside it — the draft the user still has, and the button that sends it.
   */
  const labelNode = isSendFailed ? (
    <span className="font-medium">
      {label}
      <span className="text-muted-foreground/70"> · {sendFailedReason}</span>
    </span>
  ) : isUnreachable || isIdle ? (
    <span className="font-medium">{label}</span>
  ) : (
    <Shimmer className="font-medium">{`${label}…`}</Shimmer>
  );

  const surfaceClassName = [
    'chat-activity-dock-surface inline-flex h-8 items-center gap-2 rounded-lg border bg-card px-3 text-xs transition-all duration-200',
    isInputFocused
      ? 'border-primary/30 shadow-[0_-1px_2px_hsl(var(--foreground)/0.08),1px_0_2px_hsl(var(--foreground)/0.06),-1px_0_2px_hsl(var(--foreground)/0.06)]'
      : 'border-border/50 shadow-[0_-1px_1px_hsl(var(--foreground)/0.04),1px_0_1px_hsl(var(--foreground)/0.03),-1px_0_1px_hsl(var(--foreground)/0.03)]',
  ].join(' ');

  return (
    <div className={`pointer-events-none bg-transparent ${animationClassName}`} {...dockAttributes}>
      {/*
        The collapsed row. The surface is a plain element, not a control: it says
        what is happening, and the two things a reader can *do* — stop the turn,
        open the resident panel — are the buttons beside it. That ordering is
        load-bearing for a reader that addresses "the dock's first button" as the
        interrupt affordance.
      */}
      <div className="flex items-end justify-between gap-2">
        <div className={surfaceClassName} data-activity-dock-surface="true">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
          {labelNode}
          {elapsedLabel !== null && (
            <span className="tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
          )}
        </div>

        <div className="pointer-events-auto flex items-end gap-2">
          {dock.showStop && onAbort && (
            <button
              type="button"
              onClick={onAbort}
              disabled={dock.stopDisabled}
              aria-disabled={dock.stopDisabled || undefined}
              aria-describedby={stopReason === null ? undefined : stopReasonId}
              title={stopReason ?? t('claudeStatus.stop', { defaultValue: 'Stop' })}
              className={`${surfaceClassName} gap-1.5 text-muted-foreground hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground`}
              aria-label={t('claudeStatus.stop', { defaultValue: 'Stop' })}
            >
              <svg className="h-2.5 w-2.5 fill-current" viewBox="0 0 24 24" aria-hidden>
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
              <span>{t('claudeStatus.stop', { defaultValue: 'Stop' })}</span>
              {stopReason === null ? (
                <kbd className="inline-block rounded border border-border/60 px-1 text-[10px] text-muted-foreground/70">
                  esc
                </kbd>
              ) : (
                // The reason is drawn, not just described: a greyed control with no
                // visible explanation is the silent drop this state exists to replace.
                <span id={stopReasonId} className="text-[10px] font-normal text-muted-foreground/70">
                  {stopReason}
                </span>
              )}
            </button>
          )}

          {persistWhenIdle && (
            <button
              type="button"
              data-activity-dock-toggle="true"
              aria-expanded={panelOpen}
              aria-controls={panelId}
              aria-label={t('claudeStatus.dock.toggle', { defaultValue: 'Resident process details' })}
              title={t('claudeStatus.dock.toggle', { defaultValue: 'Resident process details' })}
              onClick={() => setPanelOpen((open) => !open)}
              className={`${surfaceClassName} gap-1 text-muted-foreground`}
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${panelOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>
          )}
        </div>
      </div>

      {/*
        The expanded panel: the resident process's own facts, and nothing about
        activity — the row above already answers that question, and a second
        answer here is exactly the disagreement this consolidation removed.
      */}
      {persistWhenIdle && panelOpen && (
        <div id={panelId} data-activity-dock-panel="true" className="pointer-events-auto mt-1">
          <ResidentPanel sessionId={sessionId ?? null} t={t} />
        </div>
      )}
    </div>
  );
}
