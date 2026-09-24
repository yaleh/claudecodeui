import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Shimmer } from '@/shared/ui';
import type { SessionActivity } from '@/shared/types';

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
 * Minimal response-in-progress indicator, in the spirit of the inline status
 * lines in Claude Code / Codex / OpenCode: a shimmering activity label, the
 * elapsed time, and — on the tab — an interrupt affordance. Rendered only while
 * the viewed session has an entry in the processing map; it disappears the
 * instant that entry is removed.
 *
 * The `tab` variant is rendered by chat's ChatComposer above the input, so the
 * user can see and interrupt the in-flight turn without leaving the composer.
 * The `inline` variant is rendered by chat's ChatMessagesPane at the end of the
 * message list below `md`, where the tab would cover the messages it floats
 * over; it deliberately carries no Stop, because the composer's submit button
 * is already the one stop entry on that layout.
 */
export default function ActivityIndicator({
  activity,
  onAbort,
  isInputFocused = false,
  variant = 'tab',
}: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

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

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!renderedActivity) return null;

  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  const label = (renderedActivity.statusText || actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length])
    .replace(/\.+$/, '');

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
  const animationClassName = isExiting ? 'chat-activity-exit' : 'chat-activity-enter';

  if (variant === 'inline') {
    // In the message flow by construction: no absolute or fixed positioning, so
    // the row cannot cover the message above it and moves with the transcript
    // when it scrolls. The three parts are the tab's own, minus the Stop.
    return (
      <div
        data-slot="chat-activity-inline"
        className={`flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground ${animationClassName}`}
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
        <Shimmer className="font-medium">{`${label}…`}</Shimmer>
        <span className="tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
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
    <div className={`pointer-events-none bg-transparent ${animationClassName}`}>
      <div className="flex items-end justify-between gap-2">
        <div className={`${tabSurfaceClassName} gap-2`}>
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
          <Shimmer className="font-medium">{`${label}…`}</Shimmer>
          <span className="tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
        </div>

        {renderedActivity.canInterrupt && onAbort && (
          <button
            type="button"
            onClick={onAbort}
            className={`${tabSurfaceClassName} pointer-events-auto gap-1.5 text-muted-foreground hover:bg-card hover:text-destructive`}
            aria-label={t('claudeStatus.stop', { defaultValue: 'Stop' })}
          >
            <svg className="h-2.5 w-2.5 fill-current" viewBox="0 0 24 24" aria-hidden>
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
            <span>{t('claudeStatus.stop', { defaultValue: 'Stop' })}</span>
            <kbd className="inline-block rounded border border-border/60 px-1 text-[10px] text-muted-foreground/70">
              esc
            </kbd>
          </button>
        )}
      </div>
    </div>
  );
}
