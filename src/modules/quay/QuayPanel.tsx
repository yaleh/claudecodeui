import { Activity, AlertTriangle, ExternalLink, Info, Loader2, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import type { QuayDriverState, QuayListItem, QuaySnapshot } from '@/shared/types';
import { cn } from '@/shared/utils';
import type { QuayPanelView } from '@/modules/quay/hooks/useQuayStatus';
import TimelineBar from '@/modules/quay/TimelineBar';

type QuayPanelProps = {
  projectId: string;
  view: QuayPanelView;
  /** Re-reads the snapshot, bypassing the backend's TTL cache. */
  onRefresh: () => void;
  /**
   * Link to quay's own `quay serve` dashboard for this project, when the host
   * knows one. The panel is a read-only mirror; the dashboard is where the full
   * task board lives, so the panel links out rather than reimplementing it.
   */
  dashboardUrl?: string | null;
};

const DRIVER_LABELS: Record<QuayDriverState, string> = {
  running: 'Driver running',
  idle: 'Driver idle',
  stale: 'Driver stale',
  'not-configured': 'Not configured',
  unavailable: 'Driver status unavailable',
};

const DRIVER_CLASSES: Record<QuayDriverState, string> = {
  running: 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
  idle: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  stale: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  'not-configured': 'bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400',
  // Grey, like `not-configured`: both are "no reading", as opposed to `stale`,
  // which is a reading that says something is wrong. The badge text tells them
  // apart, and the alarm for a failed read is the warnings banner below.
  unavailable: 'bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400',
};

/** Colour dot per suite/fan-in state, matching the timeline palette in `TimelineBar`. */
const STATE_DOT_CLASSES: Record<string, string> = {
  green: 'bg-green-500',
  landed: 'bg-green-500',
  red: 'bg-red-500',
  failed: 'bg-red-500',
  'exited-not-landed': 'bg-amber-500',
};
const DEFAULT_DOT_CLASS = 'bg-gray-400';

/**
 * Coarse goal completion percentage for the Stage goals progress bar. `quay goal
 * list --json` carries no completion ratio, so the bar is a status-derived
 * visual aid only — the status text next to it is authoritative.
 */
const GOAL_STATUS_PERCENT: Record<string, number> = {
  achieved: 100,
  superseded: 100,
  active: 50,
};

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'never';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Formats a detail row's last-updated reading for display. `null` — the
 * projection's value when quay reported no usable timestamp for the row — renders
 * the same em-dash placeholder as `formatDuration`; it must not read as `never`
 * (a real "nothing recorded yet" reading) or as `Invalid Date`. The machine-
 * readable copy of the same value lives in the row's `data-updated-at` attribute.
 */
function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Formats a millisecond duration for the Tests card, tolerating a missing value. */
function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return '—';
  }
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Parses an ISO timestamp to epoch milliseconds, or `null` when absent/unparseable. */
function toEpochMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The reading for a section whose backing quay command did not answer. Such a
 * section is *unknown*, and an unknown count must never be rendered as `0`: the
 * panel used to show "0 tasks · 0 ready · 0 needs human · 0 done" for a failed
 * `task list --json` (the payload had outgrown the adapter's output cap), which
 * reads exactly like a genuinely empty board. Used by the Task ledger, Stage
 * goals and ADRs cards; the warning banner at the foot of the panel names the
 * command that failed.
 */
function UnavailableReading({ label, testId }: { label: string; testId: string }) {
  return (
    <p className="text-xs text-amber-700 dark:text-amber-300" data-testid={testId}>
      {label} unavailable — quay did not answer. See the warnings below.
    </p>
  );
}

/** One read-only detail list (tasks, goals or ADRs): a header, then either rows of
 * id/title/last-updated/status or an explicit empty-state line. Rows are
 * display-only — quay has no per-entity page to link to, so there is nothing to
 * click. Each row states the last-updated value the list is ranked by, both as
 * visible text and verbatim in `data-updated-at`.
 */
function DetailList({
  title,
  items,
  emptyText,
  testId,
}: {
  title: string;
  /** `null` when the command behind the list did not answer; `[]` when it answered with nothing. */
  items: QuayListItem[] | null;
  emptyText: string;
  testId: string;
}) {
  let body: ReactNode;
  if (items === null) {
    body = <UnavailableReading label={title} testId={`${testId}-unavailable`} />;
  } else if (items.length === 0) {
    body = (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
        {emptyText}
      </p>
    );
  } else {
    body = (
      <ul className="space-y-1" data-testid={testId}>
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded border border-border/40 px-2 py-1 text-xs"
            data-testid={`${testId}-row`}
            // The row's own ISO reading, verbatim. Absent — not empty — when the
            // projection has no timestamp, so a reader can tell "no value" from a value.
            data-updated-at={item.updatedAt ?? undefined}
          >
            <span className="shrink-0 font-mono text-[11px] text-foreground">{item.id}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.title}>
              {item.title}
            </span>
            <span
              className="shrink-0 text-[10px] text-muted-foreground"
              data-testid={`${testId}-updated-at`}
            >
              {formatUpdatedAt(item.updatedAt)}
            </span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{item.status}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {body}
    </section>
  );
}

/** Task ledger card: task counts, the status breakdown and the recent-tasks list in one card. */
function TaskLedger({ tasks }: { tasks: QuaySnapshot['tasks'] }) {
  const statuses = Object.entries(tasks?.byStatus ?? {}).sort((a, b) => b[1] - a[1]);
  const recent = tasks?.recent ?? [];

  return (
    <section data-testid="quay-panel-task-ledger">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task ledger</h3>
      {tasks === null ? (
        // No counts at all: every one of them would be a fabricated zero.
        <UnavailableReading label="Task ledger" testId="quay-panel-task-ledger-unavailable" />
      ) : (
        <>
          <p className="mb-2 text-[11px] text-muted-foreground" data-testid="quay-panel-task-ledger-counts">
            {tasks.total} tasks · {tasks.ready} ready · {tasks.needsHuman} needs human · {tasks.done} done
          </p>
          {statuses.length === 0 ? (
            <p className="text-xs text-muted-foreground">No tasks reported.</p>
          ) : (
            <ul className="space-y-1" data-testid="quay-panel-tasks-by-status">
              {statuses.map(([status, count]) => (
                <li key={status} className="flex items-center justify-between rounded border border-border/40 px-2 py-1 text-xs">
                  <span className="text-foreground">{status}</span>
                  <span className="font-medium text-muted-foreground">{count}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            <DetailList title="Recent tasks" items={recent} emptyText="No tasks reported." testId="quay-panel-recent-tasks" />
          </div>
        </>
      )}
    </section>
  );
}

/** Stage goals card: a status breakdown plus one row per recent goal, each with a flat progress bar. */
function StageGoals({ goals }: { goals: QuaySnapshot['goals'] }) {
  const statuses = Object.entries(goals?.breakdown.byStatus ?? {}).sort((a, b) => b[1] - a[1]);
  const recent = goals?.breakdown.recent ?? [];

  return (
    <section data-testid="quay-panel-stage-goals">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Stage goals</h3>
      {goals === null ? (
        <UnavailableReading label="Stage goals" testId="quay-panel-stage-goals-unavailable" />
      ) : (
        <>
          {statuses.length > 0 && (
            <p className="mb-2 text-[11px] text-muted-foreground" data-testid="quay-panel-stage-goals-counts">
              {statuses.map(([status, count]) => `${count} ${status}`).join(' · ')}
            </p>
          )}
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="quay-panel-stage-goals-empty">
              No goals reported.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="quay-panel-stage-goals-list">
              {recent.map((goal) => (
                <li
                  key={goal.id}
                  className="rounded border border-border/40 px-2 py-1.5"
                  data-testid="quay-panel-stage-goals-row"
                  // Same machine-readable reading as the detail-list rows: this list
                  // is ranked by the goal's `updatedAt` too.
                  data-updated-at={goal.updatedAt ?? undefined}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="shrink-0 font-mono text-[11px] text-foreground">{goal.id}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-[10px] text-muted-foreground" data-testid="quay-panel-stage-goals-updated-at">
                        {formatUpdatedAt(goal.updatedAt)}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{goal.status}</span>
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={goal.title}>
                    {goal.title}
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-muted" data-testid="quay-panel-stage-goals-bar">
                    <div className="h-full rounded bg-primary" style={{ width: `${GOAL_STATUS_PERCENT[goal.status] ?? 0}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Tests card: the current suite reading plus a timeline of the recent history rounds. */
function TestsCard({ tests }: { tests: QuaySnapshot['tests'] }) {
  const current = tests?.current ?? null;
  const rounds = tests?.recentRounds ?? [];
  // Chronological: the reader returns the most recent N in file order, so the
  // timeline's x-axis runs oldest → newest left to right.
  const ranges = rounds.flatMap((round) => {
    const startMs = toEpochMs(round.startedAt);
    if (startMs === null) {
      return [];
    }

    return [
      {
        startMs,
        endMs: startMs + (round.durationMs ?? 0),
        state: round.state,
        label: `Round ${round.round}: ${round.state} (${round.pass ?? '?'} pass / ${round.fail ?? '?'} fail)`,
      },
    ];
  });

  return (
    <section data-testid="quay-panel-tests">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tests</h3>
      {current ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="quay-panel-tests-current">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', STATE_DOT_CLASSES[current.state] ?? DEFAULT_DOT_CLASS)} />
          <span className="font-medium text-foreground">{current.state}</span>
          {current.runner && <span className="text-muted-foreground">· {current.runner}</span>}
          {current.scope && <span className="text-muted-foreground">· {current.scope}</span>}
          {current.laneCount !== null && <span className="text-muted-foreground">· {current.laneCount} lanes</span>}
          {current.durationMs !== null && <span className="text-muted-foreground">· {formatDuration(current.durationMs)}</span>}
          {current.commit && (
            <span className="font-mono text-[11px] text-muted-foreground" data-testid="quay-panel-tests-current-commit">
              {current.commit.slice(0, 7)}
            </span>
          )}
          {current.taskId && (
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={current.taskId}>
              {current.taskId}
            </span>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="quay-panel-tests-current-empty">
          No suite running
        </p>
      )}
      <div className="mt-2">
        <TimelineBar ranges={ranges} emptyText="No suite rounds recorded." testId="quay-panel-tests-timeline" />
      </div>
    </section>
  );
}

/** Fan-in card: a timeline of recent lock windows plus the last five task/outcome rows. */
function FanInCard({ fanIn }: { fanIn: QuaySnapshot['fanIn'] }) {
  const attempts = fanIn?.recent ?? [];
  // The carrier stores the lock epochs in Unix seconds; the timeline works in ms.
  const ranges = attempts.flatMap((attempt) => {
    if (attempt.lockAcquireEpoch === null) {
      return [];
    }

    const startMs = attempt.lockAcquireEpoch * 1000;
    const endMs = attempt.lockReleaseEpoch === null ? startMs : attempt.lockReleaseEpoch * 1000;
    return [
      {
        startMs,
        endMs: Math.max(endMs, startMs),
        state: attempt.outcome,
        label: `${attempt.task}: ${attempt.outcome}`,
      },
    ];
  });
  // Newest first for the text list, even though the timeline reads left to right.
  const recentAttempts = attempts.slice(-5).reverse();

  return (
    <section data-testid="quay-panel-fanin">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fan-in</h3>
      <TimelineBar ranges={ranges} emptyText="No fan-in attempts recorded." testId="quay-panel-fanin-timeline" />
      {recentAttempts.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="quay-panel-fanin-list">
          {recentAttempts.map((attempt, index) => (
            <li
              key={`${attempt.task}-${index}`}
              className="flex items-center gap-2 rounded border border-border/40 px-2 py-1 text-xs"
              data-testid="quay-panel-fanin-row"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={attempt.task}>
                {attempt.task}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{attempt.outcome}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Rendered by WorkspaceMain as the Quay tab. Shows a read-only snapshot of the
 * selected project's quay state: the task ledger, stage goals, the current test
 * suite plus its recent rounds, recent fan-in attempts, the driver reading and
 * the ADR list — with a manual refresh and a link out to quay's own dashboard.
 * It never mutates quay state.
 */
export default function QuayPanel({ projectId, view, onRefresh, dashboardUrl = null }: QuayPanelProps) {
  if (view.status === 'not-configured') {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="quay-panel-not-configured">
        <div className="max-w-sm text-center text-sm text-muted-foreground">
          <Info className="mx-auto mb-2 h-5 w-5" />
          quay is not configured for this project. Add a <code>.quay/config.yml</code> to enable it.
        </div>
      </div>
    );
  }

  if (view.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground" data-testid="quay-panel-loading">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading quay status…
      </div>
    );
  }

  if (view.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="quay-panel-error">
        <div className="max-w-sm text-center text-sm text-muted-foreground">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-amber-500" />
          <p className="mb-3">{view.message}</p>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <LoadedQuayPanel projectId={projectId} snapshot={view.snapshot} onRefresh={onRefresh} dashboardUrl={dashboardUrl} />;
}

/** The `loaded` branch of `QuayPanel`; split out so the summary layout stays readable. */
function LoadedQuayPanel({
  projectId,
  snapshot,
  onRefresh,
  dashboardUrl,
}: {
  projectId: string;
  snapshot: QuaySnapshot;
  onRefresh: () => void;
  dashboardUrl: string | null;
}) {
  // This panel only renders for a project that has a `.quay/config.yml`, so a null
  // driver means `driver status --json` did not answer — never "not configured",
  // which would contradict the very tab the badge sits in.
  const driverState: QuayDriverState = snapshot.driver === null ? 'unavailable' : snapshot.driver.state;

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4" data-testid="quay-panel-loaded">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">quay status</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            read-only
          </span>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', DRIVER_CLASSES[driverState])}>
            {DRIVER_LABELS[driverState]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground" data-testid="quay-panel-synced-at">
            Last synced {formatTimestamp(snapshot.generatedAt)}
            {snapshot.cached ? ' (cached)' : ''}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          {dashboardUrl && (
            <a
              href={dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Dashboard
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TaskLedger tasks={snapshot.tasks} />
        <StageGoals goals={snapshot.goals} />
        <TestsCard tests={snapshot.tests} />
        <FanInCard fanIn={snapshot.fanIn} />

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Driver</h3>
          <dl className="space-y-1 text-xs">
            <div className="flex justify-between rounded border border-border/40 px-2 py-1">
              <dt className="text-muted-foreground">State</dt>
              <dd className="text-foreground">{DRIVER_LABELS[driverState]}</dd>
            </div>
            <div className="flex justify-between rounded border border-border/40 px-2 py-1">
              <dt className="text-muted-foreground">Last record</dt>
              <dd className="text-foreground" data-testid="quay-panel-driver-last-record">
                {/* `never` is a real reading (the driver has no record yet); a failed
                    read is not, and saying `never` for it invents one. */}
                {snapshot.driver === null ? 'unavailable' : formatTimestamp(snapshot.driver.lastRecordAt)}
              </dd>
            </div>
            <div className="flex justify-between rounded border border-border/40 px-2 py-1">
              <dt className="text-muted-foreground">Config issues</dt>
              <dd className="text-foreground" data-testid="quay-panel-config-issues">
                {snapshot.configIssues === null ? 'unavailable' : snapshot.configIssues.total}
              </dd>
            </div>
          </dl>
        </section>

        <DetailList
          title={snapshot.adrs === null ? 'ADRs' : `ADRs (${snapshot.adrs.total})`}
          items={snapshot.adrs === null ? null : snapshot.adrs.recent}
          emptyText="No ADRs reported."
          testId="quay-panel-recent-adrs"
        />
      </div>

      {snapshot.warnings.length > 0 && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50/60 p-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" data-testid="quay-panel-warnings">
          <p className="mb-1 font-medium">Some quay commands did not answer:</p>
          <ul className="list-inside list-disc space-y-0.5">
            {snapshot.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-[11px] text-muted-foreground" data-testid="quay-panel-project">
        Project {projectId}
      </p>
    </div>
  );
}
