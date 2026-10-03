/**
 * The activity dock's expanded panel: the session's background work, listed by
 * kind — one section of tasks and one of plans.
 *
 * It is a pure reader of the activity snapshot the server pushed
 * (`useSessionActivity`): neither section derives anything of its own. A task
 * row's four readings are the task entity's own fields (description, state,
 * elapsed from its start/end instants, last action); a plan row's three are the
 * schedule entity's (expression, next-fire countdown, prompt).
 *
 * A plan has **no control at all**, by structure rather than by hiding one: this
 * file renders no button, no cancel affordance and no `[data-schedule-cancel]`
 * node for a schedule row, and a reader that counts that selector finds zero. The
 * way to retire a plan is to ask the model to call `CronDelete` — the dock is
 * read-only over schedules on purpose (AC-194's人裁定).
 */

import { useEffect, useState } from 'react';

import type { ActivityScheduleView, ActivityTaskView } from '@/shared/types';
import { useSessionActivity } from '@/modules/chat/hooks/useSessionActivity';

type ActivityDockPanelProps = {
  sessionId?: string | null;
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

/** One task row: description, state, elapsed, last action. */
function TaskRow({ task, now }: { task: ActivityTaskView; now: number }) {
  const elapsed = taskElapsedSeconds(task, now);
  const lastAction = task.stepLabel ?? task.summary ?? task.description;
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
      </div>
      <div className="flex items-center gap-3 pl-1 text-[11px] text-muted-foreground/70">
        <span data-task-elapsed="true">{elapsed === null ? '—' : `${elapsed}s`}</span>
        <span data-task-last-action="true" className="min-w-0 flex-1 truncate">{lastAction}</span>
      </div>
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
export default function ActivityDockPanel({ sessionId }: ActivityDockPanelProps) {
  const { tasks, schedules } = useSessionActivity(sessionId);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (schedules.length === 0) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [schedules.length]);

  if (tasks.length === 0 && schedules.length === 0) {
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
              <TaskRow key={task.taskId} task={task} now={now} />
            ))}
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
