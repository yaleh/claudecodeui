import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActivityFreshness } from '@/modules/chat/hooks/useActivityFreshness';
import { deriveActivityDockView } from '@/modules/chat/utils/activityDockView';
import { Shimmer } from '@/shared/ui';
import type { ActivityConnection, SessionActivity } from '@/shared/types';

/**
 * Which surface the indicator draws. `tab` is the tab-shaped strip that hangs
 * off the composer's top edge; `inline` is the compact line the message pane
 * puts at the end of the transcript, in its flow.
 *
 * The two share everything but the surface: the timing, the label, the elapsed
 * reading and the enter/exit animation below are one implementation, so the two
 * surfaces can never drift into telling two different stories about one turn.
 */
type ActivityIndicatorVariant = 'tab' | 'inline';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  /** The session whose liveness this dock reports; frames for other sessions are ignored. */
  sessionId?: string | null;
  /**
   * Test seam: an in-memory liveness channel. Production omits it and the dock
   * reads the app's own socket through `WebSocketContext`.
   */
  connection?: ActivityConnection | null;
  /** The tab's interrupt affordance; ignored by `inline`, which never carries one. */
  onAbort?: () => void;
  isInputFocused?: boolean;
  /** Defaults to `tab`, the composer's surface; the transcript's status line asks for `inline`. */
  variant?: ActivityIndicatorVariant;
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
 * It is the surface that replaced the rotating `Thinking…` label. Two things
 * decide what it says — the client's local "this session is processing" table,
 * and the freshness of the server's own frames (via `useActivityFreshness`).
 * When the server stops proving it is there, the dock stops speaking for it:
 * the state becomes `unreachable`, the elapsed reading freezes at the server's
 * last `asOf`, and the stop control is disabled with a visible reason instead of
 * being silently dropped. The six rotating action words never appear in that
 * state, in any locale.
 *
 * The `tab` variant is rendered by chat's ChatComposer above the input, so the
 * user can see and interrupt the in-flight turn without leaving the composer.
 * The `inline` variant is rendered by chat's ChatMessagesPane at the end of the
 * message list below `md`, where the tab would cover the messages it floats
 * over; it deliberately carries no Stop, because the composer's submit button
 * is already the one stop entry on that layout.
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
  variant = 'tab',
}: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const freshness = useActivityFreshness(sessionId, connection);
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const stopReasonId = useId();

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

  const dock = deriveActivityDockView({
    activity: renderedActivity,
    liveness: freshness.liveness,
    elapsedMs: freshness.elapsedMs,
    hasTurnAnchor: freshness.hasTurnAnchor,
    wired: freshness.wired,
    hasAbort: Boolean(onAbort),
  });

  if (!renderedActivity || dock.state === 'hidden') return null;

  const dockAttributes = {
    'data-activity-dock': '',
    'data-activity-state': dock.state,
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

  const isUnreachable = dock.state === 'unreachable';
  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  const rotatingWord = actionWords[Math.floor((elapsedSeconds ?? 0) / 4) % actionWords.length];
  const label = isUnreachable
    ? t('claudeStatus.unreachable.title', { defaultValue: 'Connection lost · reconnecting…' })
    : (renderedActivity.statusText || rotatingWord).replace(/\.+$/, '');
  const stopReason = dock.stopReasonKey === null
    ? null
    : t(dock.stopReasonKey, { defaultValue: 'Stop is unavailable while the server is unreachable' });

  const animationClassName = isExiting ? 'chat-activity-exit' : 'chat-activity-enter';

  /** The label's own pixels: a shimmered word while a turn runs, a plain sentence when it cannot. */
  const labelNode = isUnreachable
    ? <span className="font-medium">{label}</span>
    : <Shimmer className="font-medium">{`${label}…`}</Shimmer>;

  if (variant === 'inline') {
    // In the message flow by construction: no absolute or fixed positioning, so
    // the row cannot cover the message above it and moves with the transcript
    // when it scrolls. The three parts are the tab's own, minus the Stop.
    return (
      <div
        data-slot="chat-activity-inline"
        {...dockAttributes}
        className={`flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground ${animationClassName}`}
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
        {labelNode}
        {elapsedLabel !== null && (
          <span className="tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
        )}
      </div>
    );
  }

  const tabSurfaceClassName = [
    'chat-activity-tab inline-flex h-8 items-center rounded-b-none rounded-t-lg border border-b-0 bg-card px-3 text-xs transition-all duration-200',
    isInputFocused
      ? 'border-primary/30 shadow-[0_-1px_2px_hsl(var(--foreground)/0.08),1px_0_2px_hsl(var(--foreground)/0.06),-1px_0_2px_hsl(var(--foreground)/0.06)]'
      : 'border-border/50 shadow-[0_-1px_1px_hsl(var(--foreground)/0.04),1px_0_1px_hsl(var(--foreground)/0.03),-1px_0_1px_hsl(var(--foreground)/0.03)]',
  ].join(' ');

  return (
    <div className={`pointer-events-none bg-transparent ${animationClassName}`} {...dockAttributes}>
      <div className="flex items-end justify-between gap-2">
        <div className={`${tabSurfaceClassName} gap-2`}>
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
          {labelNode}
          {elapsedLabel !== null && (
            <span className="tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
          )}
        </div>

        {dock.showStop && onAbort && (
          <button
            type="button"
            onClick={onAbort}
            disabled={dock.stopDisabled}
            aria-disabled={dock.stopDisabled || undefined}
            aria-describedby={stopReason === null ? undefined : stopReasonId}
            title={stopReason ?? t('claudeStatus.stop', { defaultValue: 'Stop' })}
            className={`${tabSurfaceClassName} pointer-events-auto gap-1.5 text-muted-foreground hover:bg-card hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card disabled:hover:text-muted-foreground`}
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
      </div>
    </div>
  );
}
