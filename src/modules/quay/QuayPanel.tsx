import { Activity, AlertTriangle, ExternalLink, Info, Loader2, RefreshCw } from 'lucide-react';

import type { QuayDriverState, QuaySnapshot } from '@/shared/types';
import { cn } from '@/shared/utils';
import type { QuayPanelView } from '@/modules/quay/hooks/useQuayStatus';

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
};

const DRIVER_CLASSES: Record<QuayDriverState, string> = {
  running: 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
  idle: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  stale: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  'not-configured': 'bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400',
};

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'never';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** One summary tile: a label and a value, used for the panel's count row. */
function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * Rendered by WorkspaceMain as the Quay tab. Shows a read-only snapshot of the
 * selected project's quay state: summary counts, the driver reading, and the
 * task status breakdown, with a manual refresh and a link out to quay's own
 * dashboard. It never mutates quay state.
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
  const driverState: QuayDriverState = snapshot.driver?.state ?? 'not-configured';
  const taskStatuses = Object.entries(snapshot.tasks?.byStatus ?? {}).sort((a, b) => b[1] - a[1]);

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

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryCard label="Tasks" value={String(snapshot.tasks?.total ?? 0)} hint={`${snapshot.tasks?.ready ?? 0} ready`} />
        <SummaryCard label="Needs human" value={String(snapshot.tasks?.needsHuman ?? 0)} />
        <SummaryCard label="Done" value={String(snapshot.tasks?.done ?? 0)} />
        <SummaryCard label="Goals" value={String(snapshot.goals?.total ?? 0)} hint={`${snapshot.goals?.achieved ?? 0} achieved`} />
        <SummaryCard label="ADRs" value={String(snapshot.adrs?.total ?? 0)} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tasks by status</h3>
          {taskStatuses.length === 0 ? (
            <p className="text-xs text-muted-foreground">No tasks reported.</p>
          ) : (
            <ul className="space-y-1">
              {taskStatuses.map(([status, count]) => (
                <li key={status} className="flex items-center justify-between rounded border border-border/40 px-2 py-1 text-xs">
                  <span className="text-foreground">{status}</span>
                  <span className="font-medium text-muted-foreground">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

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
                {formatTimestamp(snapshot.driver?.lastRecordAt ?? null)}
              </dd>
            </div>
            <div className="flex justify-between rounded border border-border/40 px-2 py-1">
              <dt className="text-muted-foreground">Config issues</dt>
              <dd className="text-foreground">{snapshot.configIssues?.total ?? 0}</dd>
            </div>
          </dl>
        </section>
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
