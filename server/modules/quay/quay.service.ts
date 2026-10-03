import path from 'node:path';

/**
 * Outcome of one quay CLI invocation, normalized so callers never have to read
 * child-process internals. `error` is set only when the command was refused
 * locally (not on the whitelist) or the process could not be started at all.
 */
export type QuayCommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

/**
 * The injected child-process boundary. It always receives an argument array
 * (never a shell string) and a wall-clock bound, so the only way a caller can
 * influence what runs is through arguments that `runQuayCommand` has already
 * matched against the read-only whitelist.
 */
export type QuayCommandRunner = (
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<QuayCommandResult>;

/** Driver summary rendered by the sidebar badge and the Tier-2 panel header. */
export type QuayDriverState = 'running' | 'idle' | 'stale';

export type QuayDriverSummary = {
  state: QuayDriverState;
  alive: boolean;
  running: boolean;
  lastRecordAt: string | null;
};

/**
 * One row of a per-entity detail list (tasks or ADRs). Only the three fields the
 * panel renders are kept; the source command returns whole documents (body,
 * children, extra, …) which would bloat every snapshot response.
 */
export type QuayListItem = {
  id: string;
  title: string;
  status: string;
};

/** How many `recent` rows each detail list keeps; the cap the panel copy promises. */
export const QUAY_RECENT_LIST_LIMIT = 10;

export type QuayTaskCounts = {
  total: number;
  byStatus: Record<string, number>;
  ready: number;
  needsHuman: number;
  done: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` tasks, most recently updated first. */
  recent: QuayListItem[];
};

export type QuayGoalCounts = {
  total: number;
  achieved: number;
};

export type QuayAdrCounts = {
  total: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` ADRs, most recently updated first. */
  recent: QuayListItem[];
};

export type QuayConfigIssueCounts = {
  total: number;
  errors: number;
};

/**
 * Everything the Tier-2 panel renders, assembled from whitelisted read-only
 * commands. A section is `null` when its command failed or returned unparseable
 * output; the failure is recorded in `warnings` rather than thrown, so one
 * misbehaving subcommand never blanks the whole panel.
 */
export type QuaySnapshot = {
  projectId: string;
  projectPath: string;
  generatedAt: string;
  cached: boolean;
  driver: QuayDriverSummary | null;
  tasks: QuayTaskCounts | null;
  goals: QuayGoalCounts | null;
  adrs: QuayAdrCounts | null;
  configIssues: QuayConfigIssueCounts | null;
  /**
   * Link to quay's own `quay serve` dashboard, when a live web service is
   * reported for this project. `null` when no dashboard is running — an absent
   * dashboard is a normal state, never a warning.
   */
  dashboardUrl: string | null;
  warnings: string[];
};

/** Tier-1 reading: whether a project directory carries a `.quay/config.yml`. */
export type QuayProjectStatus = {
  projectId: string;
  projectPath: string;
  hasQuayConfig: boolean;
};

const QUAY_DRIVER_KINDS = ['promotion', 'worker', 'outer', 'quality', 'meta', 'goal'] as const;

/**
 * The complete read-only command whitelist.
 *
 * `runQuayCommand` accepts an argv only when it equals one of these arrays
 * element-by-element, so no caller — and therefore no frontend request — can
 * reach a write command (`task create/edit/check`, `driver start/stop`,
 * `gate run`, `promote/retreat`, …). Widening the display surface means adding
 * an entry here; every entry must stay a read-only verb.
 */
export const QUAY_READ_ONLY_COMMANDS: readonly (readonly string[])[] = [
  ['config', 'validate', '--json'],
  ['server', 'status', '--json'],
  ['task', 'list', '--json'],
  ['goal', 'list', '--json'],
  ['adr', 'list', '--json'],
  ...QUAY_DRIVER_KINDS.map((kind) => ['driver', 'status', '--kind', kind, '--json']),
];

/** True when `args` is exactly one of the whitelisted read-only commands. */
export function isReadOnlyQuayCommand(args: readonly string[]): boolean {
  return QUAY_READ_ONLY_COMMANDS.some(
    (allowed) =>
      allowed.length === args.length
      && allowed.every((value, index) => value === args[index]),
  );
}

type QuayServiceDependencies = {
  fileExists(filePath: string): boolean;
  resolveProjectPathById(projectId: string): string | null;
  runCommand: QuayCommandRunner;
  now(): number;
  /** How long a Tier-2 snapshot stays fresh; requests inside the window reuse it. */
  snapshotTtlMs: number;
  /** Per-command subprocess timeout. */
  commandTimeoutMs: number;
};

type QuaySnapshotOptions = {
  /** Bypass the TTL cache for the manual refresh button. */
  forceRefresh?: boolean;
};

type QuayCacheEntry = {
  expiresAt: number;
  snapshot: QuaySnapshot;
};

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Projects a `task list --json` / `adr list --json` array into the panel's
 * detail rows: at most `QUAY_RECENT_LIST_LIMIT` entries, most recently updated
 * first (`updatedAt` descending, ties broken by id ascending so the order is
 * deterministic even when timestamps collide). Records without a string id are
 * skipped rather than rendered as blank rows.
 */
function summarizeRecentItems(value: unknown): QuayListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asRecord(item))
    .filter((record): record is Record<string, unknown> => record !== null && typeof record.id === 'string')
    .sort((a, b) => {
      const byRecency = readCount(b.updatedAt) - readCount(a.updatedAt);
      return byRecency !== 0 ? byRecency : String(a.id).localeCompare(String(b.id));
    })
    .slice(0, QUAY_RECENT_LIST_LIMIT)
    .map((record) => ({
      id: String(record.id),
      title: typeof record.title === 'string' ? record.title : '',
      status: typeof record.status === 'string' ? record.status : 'unknown',
    }));
}

function summarizeTasks(value: unknown): QuayTaskCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const byStatus: Record<string, number> = {};
  for (const task of value) {
    const status = typeof asRecord(task)?.status === 'string' ? (asRecord(task)?.status as string) : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return {
    total: value.length,
    byStatus,
    ready: byStatus.ready ?? 0,
    needsHuman: byStatus['needs-human'] ?? 0,
    done: byStatus.done ?? 0,
    recent: summarizeRecentItems(value),
  };
}

function summarizeGoals(value: unknown): QuayGoalCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const achieved = value.filter((goal) => asRecord(goal)?.status === 'achieved').length;
  return { total: value.length, achieved };
}

function summarizeAdrs(value: unknown): QuayAdrCounts | null {
  return Array.isArray(value) ? { total: value.length, recent: summarizeRecentItems(value) } : null;
}

/**
 * Reads the `quay serve` web endpoint out of a `server status --json` body.
 * Returns `http://<host>:<port>/` only when the `web` service is present and its
 * liveness probe says it is alive; any other shape — no services array, no web
 * entry, a dead probe, a missing host/port — is `null`. A dashboard that simply
 * is not running is not an error, so the caller reads this without a warning.
 */
function summarizeDashboardUrl(value: unknown): string | null {
  const web = asArray(asRecord(value)?.services)
    .map((service) => asRecord(service))
    .find((service) => service?.name === 'web');
  if (!web) {
    return null;
  }

  const alive = Boolean(readCount(asRecord(web.liveness)?.alive));
  const host = typeof web.host === 'string' && web.host ? web.host : null;
  const port = readCount(web.port);
  if (!alive || !host || port <= 0) {
    return null;
  }

  return `http://${host}:${port}/`;
}

function summarizeConfigIssues(value: unknown): QuayConfigIssueCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const errors = value.filter((issue) => asRecord(issue)?.severity === 'error').length;
  return { total: value.length, errors };
}

function summarizeDriver(value: unknown): QuayDriverSummary | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  // `alive`/`running` arrive as numbers (0/1) from `--json`; a driver that is
  // configured but not alive reads `stale`, which is the state the badge paints
  // differently from a live-but-idle driver.
  const alive = Boolean(readCount(record.alive));
  const running = Boolean(readCount(record.running));
  const state: QuayDriverState = !alive ? 'stale' : running ? 'running' : 'idle';

  return {
    state,
    alive,
    running,
    lastRecordAt: typeof record.last_record_ts === 'string' ? record.last_record_ts : null,
  };
}

/**
 * Creates the quay read-only display service.
 *
 * Every filesystem, clock and subprocess access is an explicit dependency so the
 * composition root binds production adapters while tests drive pure fakes. The
 * Tier-2 snapshot keeps an in-memory TTL cache plus an in-flight promise map, so
 * a burst of panel opens for one project spawns the CLI once rather than once per
 * request — the concurrency guard against a subprocess storm.
 */
export function createQuayService(dependencies: QuayServiceDependencies) {
  const snapshotCache = new Map<string, QuayCacheEntry>();
  const inFlightSnapshots = new Map<string, Promise<QuaySnapshot>>();

  /** Tier-1 detection: a pure path check, never a subprocess. */
  const detectQuayConfig = (projectPath: string): boolean =>
    dependencies.fileExists(path.join(projectPath, '.quay', 'config.yml'));

  /** Runs one whitelisted read-only command; refuses anything else without spawning. */
  const runQuayCommand = async (
    cwd: string,
    args: readonly string[],
  ): Promise<QuayCommandResult> => {
    if (!isReadOnlyQuayCommand(args)) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: `refused: "${args.join(' ')}" is not on the quay read-only command whitelist`,
      };
    }

    return dependencies.runCommand(cwd, args, { timeoutMs: dependencies.commandTimeoutMs });
  };

  const getQuayStatus = (projectId: string): QuayProjectStatus | null => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return null;
    }

    return { projectId, projectPath, hasQuayConfig: detectQuayConfig(projectPath) };
  };

  const collectSnapshot = async (projectId: string, projectPath: string): Promise<QuaySnapshot> => {
    const warnings: string[] = [];

    /**
     * Runs one command and reads its JSON body. A non-zero exit is not on its
     * own a failure of this read: `quay config validate --json` prints its issue
     * list and then exits 1 to signal that issues exist, and that list is exactly
     * the reading we want. So stdout is parsed first, and the exit status only
     * decides the outcome when nothing parseable came back.
     */
    const readJson = async (args: readonly string[]): Promise<unknown> => {
      const result = await runQuayCommand(projectPath, args);

      if (result.stdout.trim()) {
        try {
          return parseJson(result.stdout);
        } catch {
          // Fall through: an unparseable body is reported below.
        }
      }

      const reason = result.error ?? (result.stderr.trim() || `exit code ${result.code}`);
      warnings.push(`${args.join(' ')}: ${result.ok ? 'returned non-JSON output' : reason}`);
      return null;
    };

    /**
     * Same read as `readJson`, but never records a warning. The dashboard URL is
     * an optional extra: a machine without `quay serve` running has no web
     * service to report, and that absence must not paint the panel's
     * "some commands did not answer" banner.
     */
    const readJsonQuietly = async (args: readonly string[]): Promise<unknown> => {
      const result = await runQuayCommand(projectPath, args);
      if (!result.stdout.trim()) {
        return null;
      }
      try {
        return parseJson(result.stdout);
      } catch {
        return null;
      }
    };

    const tasks = summarizeTasks(await readJson(['task', 'list', '--json']));
    const goals = summarizeGoals(await readJson(['goal', 'list', '--json']));
    const adrs = summarizeAdrs(await readJson(['adr', 'list', '--json']));
    const driver = summarizeDriver(await readJson(['driver', 'status', '--kind', 'worker', '--json']));
    const configIssues = summarizeConfigIssues(await readJson(['config', 'validate', '--json']));
    const dashboardUrl = summarizeDashboardUrl(await readJsonQuietly(['server', 'status', '--json']));

    return {
      projectId,
      projectPath,
      generatedAt: new Date(dependencies.now()).toISOString(),
      cached: false,
      driver,
      tasks,
      goals,
      adrs,
      configIssues,
      dashboardUrl,
      warnings,
    };
  };

  const loadSnapshot = (projectId: string, projectPath: string): Promise<QuaySnapshot> => {
    const pending = inFlightSnapshots.get(projectId);
    if (pending) {
      return pending;
    }

    const promise = collectSnapshot(projectId, projectPath)
      .then((snapshot) => {
        snapshotCache.set(projectId, {
          expiresAt: dependencies.now() + dependencies.snapshotTtlMs,
          snapshot,
        });
        return snapshot;
      })
      .finally(() => {
        inFlightSnapshots.delete(projectId);
      });

    inFlightSnapshots.set(projectId, promise);
    return promise;
  };

  const getQuaySnapshot = async (
    projectId: string,
    options: QuaySnapshotOptions = {},
  ): Promise<QuaySnapshot | null> => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return null;
    }

    if (!options.forceRefresh) {
      const cached = snapshotCache.get(projectId);
      if (cached && cached.expiresAt > dependencies.now()) {
        return { ...cached.snapshot, cached: true };
      }

      const pending = inFlightSnapshots.get(projectId);
      if (pending) {
        return pending;
      }
    }

    return loadSnapshot(projectId, projectPath);
  };

  return {
    detectQuayConfig,
    runQuayCommand,
    getQuayStatus,
    getQuaySnapshot,
  };
}
