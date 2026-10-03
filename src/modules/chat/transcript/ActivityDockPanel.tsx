/**
 * The activity dock's expanded panel: the session's background work, listed by
 * kind — one section of tasks, one of a running foreground tool, and one of
 * plans.
 *
 * It is a pure reader of the activity snapshot the server pushed
 * (`useSessionActivity`): a task row's four readings are the task entity's own
 * fields (description, state, elapsed from its start/end instants, last action);
 * a plan row's three are the schedule entity's (expression, next-fire
 * countdown, prompt). The one row that is not a snapshot entity is the running
 * foreground tool, and it too is a *reading*: its id is taken off the loaded
 * transcript ({@link findPendingForegroundTool}) — the same id the server's
 * Turn Tracker holds as pending.
 *
 * Two controls live here, and neither is optimistic. A task row that is not in a
 * terminal state carries a `[data-task-stop]` button; a running foreground tool
 * carries a `[data-background-tool]` button. A click sends exactly one frame
 * (`useActivityControls`) and changes nothing locally — the row's state, and a
 * backgrounded task's arrival, come back only through the server's own activity
 * frames. Both are disabled when the dock's liveness reading is `unreachable`,
 * each beside its own `[data-control-disabled-reason]` text.
 *
 * A plan has **no control at all**, by structure rather than by hiding one: this
 * file renders no button, no cancel affordance and no `[data-schedule-cancel]`
 * node for a schedule row, and a reader that counts that selector finds zero. The
 * way to retire a plan is to ask the model to call `CronDelete` — the dock is
 * read-only over schedules on purpose (AC-194's人裁定).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ActivityScheduleView, ActivityTaskState, ActivityTaskView } from '@/shared/types';
import type { ActivityLiveness } from '@/modules/chat/utils/activityFreshness';
import { useSessionActivity } from '@/modules/chat/hooks/useSessionActivity';
import {
  useActivityControls,
  type ActivityControls,
  type ForegroundTool,
} from '@/modules/chat/hooks/useActivityControls';

/** The states from which a task cannot move again — a terminal row offers no stop. */
const TERMINAL_TASK_STATES: ReadonlySet<ActivityTaskState> = new Set<ActivityTaskState>([
  'completed',
  'failed',
  'stopped',
  'ended',
]);

type ActivityDockPanelProps = {
  sessionId?: string | null;
  /**
   * The dock's liveness reading. `unreachable` disables both controls and draws
   * their reason. Defaults to `fresh`, the reading a caller with no liveness
   * channel states.
   */
  liveness?: ActivityLiveness;
  /**
   * The running foreground tool, read off the loaded transcript. Null (or
   * absent) draws no foreground row at all.
   */
  foregroundTool?: ForegroundTool | null;
};

/** Seconds between a schedule's next fire and `now`, floored at zero; null when unknown. */
function secondsUntil(nextFireAt: number | undefined, now: number): number | null {
  if (typeof nextFireAt !== 'number' || !Number.isFinite(nextFireAt)) {
    return null;
  }
  return Math.max(0, Math.floor((nextFireAt - now) / 1000));
}

/** The countdown label for a schedule row, or a dash when the fire time is unknown. */
function countdownLabel(nextFireAt: number | undefined, now: number): string {
  const seconds = secondsUntil(nextFireAt, now);
  if (seconds === null) {
    return '—';
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/** A task's elapsed runtime in whole seconds: from start to end, or to now while running. */
function taskElapsedSeconds(task: ActivityTaskView, now: number): number | null {
  if (typeof task.startedAt !== 'number' || !Number.isFinite(task.startedAt)) {
    return null;
  }
  const end = typeof task.endedAt === 'number' && Number.isFinite(task.endedAt) ? task.endedAt : now;
  return Math.max(0, Math.floor((end - task.startedAt) / 1000));
}

/**
 * The stop control for one task, or nothing at all.
 *
 * Rendered only while the task is non-terminal — a terminal row carries no
 * `[data-task-stop]` node, by structure rather than by hiding or disabling it,
 * so a reader that counts the selector over a finished task's row finds zero.
 * A click places a `chat.stop-task` request and nothing else; the row moves only
 * when the server's own frame says the task stopped.
 */
function StopTaskControl({ task, controls }: { task: ActivityTaskView; controls: ActivityControls }) {
  const { t } = useTranslation('chat');
  const label = t('claudeStatus.controls.stopTask', { defaultValue: 'Stop task' });
  return (
    <button
      type="button"
      data-task-stop="true"
      data-task-id={task.taskId}
      disabled={controls.disabled}
      title={controls.disabled ? controls.disabledReason : label}
      onClick={() => controls.stopTask(task.taskId)}
      className="flex-shrink-0 rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground/80 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}

/** One task row: description, state, elapsed, last action, and its stop control. */
function TaskRow({
  task,
  now,
  controls,
}: {
  task: ActivityTaskView;
  now: number;
  controls: ActivityControls;
}) {
  const elapsed = taskElapsedSeconds(task, now);
  const lastAction = task.stepLabel ?? task.summary ?? task.description;
  const canStop = !TERMINAL_TASK_STATES.has(task.state);
  return (
    <li
      data-activity-task-row="true"
      data-task-id={task.taskId}
      data-task-state={task.state}
      className="flex flex-col gap-0.5 py-1"
    >
      <div className="flex items-center gap-2">
        <span data-task-kind={task.kind} className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground/70">
          {task.kind}
        </span>
        <span data-task-description="true" className="min-w-0 flex-1 truncate font-medium">
          {task.description}
        </span>
        <span data-task-state-text="true" data-task-state={task.state} className="flex-shrink-0 tabular-nums">
          {task.state}
        </span>
        {canStop && <StopTaskControl task={task} controls={controls} />}
      </div>
      <div className="flex items-center gap-3 pl-1 text-[11px] text-muted-foreground/70">
        <span data-task-elapsed="true">{elapsed === null ? '—' : `${elapsed}s`}</span>
        <span data-task-last-action="true" className="min-w-0 flex-1 truncate">{lastAction}</span>
      </div>
      {canStop && controls.disabled && (
        <div data-control-disabled-reason="true" className="pl-1 text-[10px] text-muted-foreground/60">
          {controls.disabledReason}
        </div>
      )}
    </li>
  );
}

/**
 * The running foreground tool's row and its background control.
 *
 * The id is the one the transcript carries (`data-tool-use-id`), which is the
 * same id the server's Turn Tracker holds as pending — a background request that
 * names anything else is answered `no-foreground-match`. A click places a
 * `chat.background-task` request and nothing else; the task appears in the table
 * only when the server's own `task_started` + `task_updated{is_backgrounded}`
 * frames arrive.
 */
function ForegroundToolRow({
  tool,
  controls,
}: {
  tool: ForegroundTool;
  controls: ActivityControls;
}) {
  const { t } = useTranslation('chat');
  const label = t('claudeStatus.controls.backgroundTool', { defaultValue: 'Move to background' });
  return (
    <li
      data-foreground-tool-row="true"
      data-tool-use-id={tool.toolUseId}
      className="flex flex-col gap-0.5 py-1"
    >
      <div className="flex items-center gap-2">
        <span data-foreground-tool-name="true" className="min-w-0 flex-1 truncate font-medium">
          {tool.toolName}
        </span>
        <button
          type="button"
          data-background-tool="true"
          data-tool-use-id={tool.toolUseId}
          disabled={controls.disabled}
          title={controls.disabled ? controls.disabledReason : label}
          onClick={() => controls.backgroundTool(tool.toolUseId)}
          className="flex-shrink-0 rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground/80 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {label}
        </button>
      </div>
      {controls.disabled && (
        <div data-control-disabled-reason="true" className="pl-1 text-[10px] text-muted-foreground/60">
          {controls.disabledReason}
        </div>
      )}
    </li>
  );
}

/**
 * One plan row: expression, next-fire countdown, prompt. Deliberately read-only —
 * see the module comment on why no control is rendered here.
 */
function ScheduleRow({ schedule, now }: { schedule: ActivityScheduleView; now: number }) {
  return (
    <li
      data-activity-schedule-row="true"
      data-schedule-id={schedule.scheduleId}
      data-schedule-kind={schedule.kind}
      className="flex flex-col gap-0.5 py-1"
    >
      <div className="flex items-center gap-2">
        <span data-schedule-expression="true" className="min-w-0 flex-1 truncate font-mono">
          {schedule.spec}
        </span>
        <span data-schedule-countdown="true" className="flex-shrink-0 tabular-nums text-muted-foreground/70">
          {countdownLabel(schedule.nextFireAt, now)}
        </span>
      </div>
      <div className="pl-1 text-[11px] text-muted-foreground/70">
        <span data-schedule-prompt="true" className="line-clamp-2 break-words">
          {schedule.prompt ?? '—'}
        </span>
      </div>
    </li>
  );
}

/**
 * The expanded background-work panel for one session.
 *
 * Renders nothing when the session holds no tasks and no schedules, so a dock
 * that is only reporting a turn never grows an empty panel. The one-second ticker
 * is the countdown's clock and nothing else: it never re-reads the server, and it
 * only runs while a plan is on screen.
 */
export default function ActivityDockPanel({
  sessionId,
  liveness = 'fresh',
  foregroundTool = null,
}: ActivityDockPanelProps) {
  const { tasks, schedules } = useSessionActivity(sessionId);
  const [now, setNow] = useState(() => Date.now());
  // One controls reading for the whole panel, so every button shares the same
  // enabled/disabled verdict and the same reason sentence.
  const controls = useActivityControls(sessionId, liveness);

  useEffect(() => {
    if (schedules.length === 0) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [schedules.length]);

  if (tasks.length === 0 && schedules.length === 0 && !foregroundTool) {
    return null;
  }

  return (
    <div
      data-activity-dock-panel="true"
      data-task-count={tasks.length}
      data-schedule-count={schedules.length}
      className="pointer-events-auto w-[min(28rem,80vw)] rounded-lg border border-border/60 bg-card p-2 text-xs shadow-lg"
    >
      {tasks.length > 0 && (
        <section data-activity-task-section="true">
          <div className="px-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            Tasks {tasks.length}
          </div>
          <ul className="divide-y divide-border/40">
            {tasks.map((task) => (
              <TaskRow key={task.taskId} task={task} now={now} controls={controls} />
            ))}
          </ul>
        </section>
      )}
      {/*
        The running foreground tool. It is not a task yet — the task table only
        gains a row for it when the CLI backgrounds it — so it is drawn from the
        transcript's own unpaired `tool_use`, and its one control places the
        background request that makes it one.
      */}
      {foregroundTool && (
        <section data-activity-foreground-section="true">
          <div className="px-1 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            Foreground tool
          </div>
          <ul className="divide-y divide-border/40">
            <ForegroundToolRow tool={foregroundTool} controls={controls} />
          </ul>
        </section>
      )}
      {schedules.length > 0 && (
        <section data-activity-schedule-section="true">
          <div className="px-1 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            Plans {schedules.length}
          </div>
          <ul className="divide-y divide-border/40">
            {schedules.map((schedule) => (
              <ScheduleRow key={schedule.scheduleId} schedule={schedule} now={now} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
