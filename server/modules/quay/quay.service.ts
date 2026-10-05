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

/**
 * The injected read-only filesystem boundary for quay's carrier files (the suite
 * state and the two JSONL histories). It exposes only byte-range and whole-file
 * *reads*, so the panel can never write through it, and every path is joined
 * under the project root by the service rather than accepted from a request. The
 * byte-range read is what lets `readCarrierFileTail` stream a bounded window from
 * the end of a multi-megabyte history instead of materialising the whole file.
 */
export type QuayFileReader = {
  /** Byte length of the file, or `null` when it does not exist or cannot be stat-ed. */
  size(filePath: string): Promise<number | null>;
  /** Reads up to `length` bytes starting at byte `position`, decoded as UTF-8; shorter near EOF. */
  readChunk(filePath: string, position: number, length: number): Promise<string>;
  /** Reads a small file fully as UTF-8 text; used only for the tiny suite-state JSON. */
  readText(filePath: string): Promise<string>;
};

/** Driver summary rendered by the sidebar badge and the Tier-2 panel header. */
export type QuayDriverState = 'running' | 'idle' | 'stale';

export type QuayDriverSummary = {
  state: QuayDriverState;
  alive: boolean;
  running: boolean;
  lastRecordAt: string | null;
};

/**
 * One row of a per-entity detail list (tasks, goals or ADRs). Only the fields the
 * panel renders are kept; the source command returns whole documents (body,
 * children, extra, …) which would bloat every snapshot response.
 */
export type QuayListItem = {
  id: string;
  title: string;
  status: string;
  /**
   * The row's last-updated instant as ISO-8601, converted from the epoch
   * **milliseconds** the CLI prints (`1786439928515.85`), or `null` when the
   * record carried no usable timestamp. This is the value the list is ranked by,
   * so the panel can show the ordering key instead of an invisible one. It is
   * never epoch 0 (`1970-01-01T00:00:00.000Z`) for a missing reading, and never
   * an `Invalid Date` string.
   */
  updatedAt: string | null;
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

/** Goal counts read from `quay goal list --json`; the panel shows the stage breakdown. */
export type QuayGoalCounts = {
  total: number;
  achieved: number;
  /** Per-status grouping plus the most recent goals, for the panel's "Stage goals" card. */
  breakdown: QuayGoalBreakdown;
};

/**
 * Stage-goals card payload: how many goals sit in each status the CLI reports,
 * plus the most recently updated goals as display rows.
 */
export type QuayGoalBreakdown = {
  /** Counts keyed by the CLI's own status string (`active`/`achieved`/`draft`/`superseded`/…). */
  byStatus: Record<string, number>;
  /** Up to `QUAY_RECENT_LIST_LIMIT` goals, most recently updated first. */
  recent: QuayListItem[];
};

export type QuayAdrCounts = {
  total: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` ADRs, most recently updated first. */
  recent: QuayListItem[];
};

/**
 * Current full-suite reading from `.quay/full-suite-state.json`, rendered as the
 * "current" half of the Tests card. `null` means no run state is on disk — a
 * normal "nothing running" state, never a warning.
 */
export type QuaySuiteState = {
  state: string;
  runner: string | null;
  scope: string | null;
  /** ISO timestamp the run started, as the carrier file stores it. */
  startedAt: string | null;
  /** Unix epoch **seconds** the run finished, as the carrier file stores it. */
  finishedAt: number | null;
  durationMs: number | null;
  laneCount: number | null;
  commit: string | null;
  taskId: string | null;
  runId: string | null;
};

/** One history round projected from `.quay/verification-round.jsonl`; the heavy per-file detail is dropped. */
export type QuayTestRoundSummary = {
  round: number;
  startedAt: string | null;
  durationMs: number | null;
  pass: number | null;
  fail: number | null;
  tests: number | null;
  state: string;
};

/** Tests card payload: the current run (if any) plus the most recent history rounds. */
export type QuayTestsSummary = {
  current: QuaySuiteState | null;
  recentRounds: QuayTestRoundSummary[];
};

/** One fan-in attempt projected from `.quay/worker-outcome.jsonl`. */
export type QuayFanInAttemptSummary = {
  task: string;
  outcome: string;
  /** Lock acquisition as Unix epoch **seconds** (quay's own unit); the panel converts to ms. */
  lockAcquireEpoch: number | null;
  /** Lock release as Unix epoch **seconds**; `null` when the attempt never released the lock. */
  lockReleaseEpoch: number | null;
};

/** Fan-in card payload: the most recent mechanical fan-in attempts across all tasks. */
export type QuayFanInSummary = {
  recent: QuayFanInAttemptSummary[];
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
  /** Tests card: the current suite run plus recent history rounds, read from `.quay/` carrier files. */
  tests: QuayTestsSummary;
  /** Fan-in card: recent mechanical fan-in attempts, read from `.quay/worker-outcome.jsonl`. */
  fanIn: QuayFanInSummary;
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
  /** Read-only filesystem boundary for the `.quay/` carrier files behind the Tests and Fan-in cards. */
  readFile: QuayFileReader;
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
 * Projects a `task list --json` / `goal list --json` / `adr list --json` array
 * into the panel's detail rows: at most `QUAY_RECENT_LIST_LIMIT` entries, most
 * recently updated first (`updatedAt` descending, ties broken by id ascending so
 * the order is deterministic even when timestamps collide — and a row with no
 * timestamp is the *least* recent, so it sorts last rather than first).
 *
 * Each row keeps the ISO-8601 form of the very epoch it was ranked by, so the
 * order the reader sees is the order they can check. Records without a string id
 * are skipped rather than rendered as blank rows.
 */
function summarizeRecentItems(value: unknown): QuayListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asRecord(item))
    .filter((record): record is Record<string, unknown> => record !== null && typeof record.id === 'string')
    .map((record) => ({
      record,
      epochMs: readUpdatedAtEpochMs(record.updatedAt),
    }))
    .sort((a, b) => {
      // Descending by epoch; a missing timestamp has no instant to place, so it
      // goes after every dated row. `null`-vs-`null` falls through to the id
      // tie-break rather than comparing two absent numbers.
      if (a.epochMs !== b.epochMs) {
        if (a.epochMs === null) return 1;
        if (b.epochMs === null) return -1;
        return b.epochMs - a.epochMs;
      }
      return String(a.record.id).localeCompare(String(b.record.id));
    })
    .slice(0, QUAY_RECENT_LIST_LIMIT)
    .map(({ record, epochMs }) => ({
      id: String(record.id),
      title: typeof record.title === 'string' ? record.title : '',
      status: typeof record.status === 'string' ? record.status : 'unknown',
      // `readUpdatedAtEpochMs` has already refused anything a `Date` cannot hold,
      // so this conversion cannot throw.
      updatedAt: epochMs === null ? null : new Date(epochMs).toISOString(),
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

  const byStatus: Record<string, number> = {};
  for (const goal of value) {
    const status = typeof asRecord(goal)?.status === 'string' ? (asRecord(goal)?.status as string) : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return {
    total: value.length,
    achieved: byStatus.achieved ?? 0,
    breakdown: { byStatus, recent: summarizeRecentItems(value) },
  };
}

function summarizeAdrs(value: unknown): QuayAdrCounts | null {
  return Array.isArray(value) ? { total: value.length, recent: summarizeRecentItems(value) } : null;
}

/** Reads a non-empty string field from an untyped JSON record, or `null`. */
function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads a finite number field from an untyped JSON record, or `null` for absent/non-numeric values. */
function readNullableNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

/**
 * A detail row's `updatedAt` as epoch milliseconds, or `null` when the record
 * carries no usable timestamp.
 *
 * `null` covers every shape that is not a real instant: an absent field, an
 * explicit `null`, a non-numeric string, `NaN`/`Infinity` — and a finite number
 * outside the range a `Date` can represent (`1e20`), which would otherwise throw
 * on `toISOString()` and take the whole snapshot down with it. Reading the sort
 * key and the displayed value from this one function is what keeps the list's
 * order and the time printed beside each row the same reading.
 */
function readUpdatedAtEpochMs(value: unknown): number | null {
  const epochMs = readNullableNumber(value);
  if (epochMs === null) {
    return null;
  }

  return Number.isNaN(new Date(epochMs).getTime()) ? null : epochMs;
}

/** Carrier files read under the project's `.quay/` directory by the Tests and Fan-in cards. */
const QUAY_SUITE_STATE_FILE = 'full-suite-state.json';
const QUAY_ROUND_HISTORY_FILE = 'verification-round.jsonl';
const QUAY_WORKER_OUTCOME_FILE = 'worker-outcome.jsonl';

/**
 * Bytes read per step when streaming a carrier file's tail. 64 KiB holds ten
 * lines of every carrier here except the per-file round history (whose lines run
 * tens of KB); there the window doubles a couple of times, still a few hundred KB
 * against a 16 MB file — never the whole file.
 */
const CARRIER_TAIL_WINDOW_BYTES = 64 * 1024;

/** Number of JSONL records a tail window currently holds, ignoring a possibly split leading line and blank segments. */
function countTailRecords(text: string, hasPartialLeadingLine: boolean): number {
  const lines = text.split('\n');
  if (hasPartialLeadingLine) {
    lines.shift();
  }
  return lines.filter((line) => line.trim() !== '').length;
}

/**
 * Streams the last `maxLines` newline-delimited JSON records out of a carrier
 * file without materialising the whole file: it reads a bounded byte window from
 * the end through the injected reader and, when that window holds too few
 * complete lines, doubles the window and re-reads. A 16 MB round history
 * therefore costs a few hundred KB of reads rather than 16 MB, and the read is a
 * byte-range read rather than a whole-file `readFile`.
 *
 * Malformed lines (a torn tail, a non-JSON record) are skipped, so a partially
 * written file degrades to fewer rows instead of failing the whole snapshot.
 */
export async function readCarrierFileTail(
  reader: QuayFileReader,
  filePath: string,
  maxLines: number,
): Promise<unknown[]> {
  if (maxLines <= 0) {
    return [];
  }

  const size = await reader.size(filePath);
  if (size === null || size <= 0) {
    return [];
  }

  let windowBytes = Math.min(CARRIER_TAIL_WINDOW_BYTES, size);
  let text = '';
  let start = 0;
  // Grow the trailing window until it holds maxLines records (a non-zero start
  // can split one leading line in half, which countTailRecords drops).
  for (;;) {
    start = Math.max(0, size - windowBytes);
    text = await reader.readChunk(filePath, start, size - start);
    if (start === 0 || countTailRecords(text, true) >= maxLines) {
      break;
    }
    windowBytes *= 2;
  }

  const lines = text.split('\n');
  if (start > 0) {
    lines.shift();
  }

  return lines
    .filter((line) => line.trim() !== '')
    .slice(-maxLines)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

/** Projects a parsed `full-suite-state.json` body; `null` when it carries no usable `state` string. */
function summarizeSuiteState(value: unknown): QuaySuiteState | null {
  const record = asRecord(value);
  const state = record ? readNullableString(record.state) : null;
  if (!record || !state) {
    return null;
  }

  return {
    state,
    runner: readNullableString(record.runner),
    scope: readNullableString(record.scope),
    startedAt: readNullableString(record.startedAt),
    finishedAt: readNullableNumber(record.finishedAt),
    durationMs: readNullableNumber(record.durationMs),
    laneCount: readNullableNumber(record.laneCount),
    commit: readNullableString(record.commit),
    taskId: readNullableString(record.taskId),
    runId: readNullableString(record.runId),
  };
}

/**
 * Reads `.quay/full-suite-state.json` and projects it to the Tests card's
 * "current" reading. A missing or unparseable file reads as `null` — the same
 * "nothing is running" state as a dashboard with no suite — so it is never
 * recorded as a warning.
 */
export async function readCurrentSuiteState(
  reader: QuayFileReader,
  filePath: string,
): Promise<QuaySuiteState | null> {
  let text: string;
  try {
    text = await reader.readText(filePath);
  } catch {
    return null;
  }

  try {
    return summarizeSuiteState(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** Projects round-history records to the panel's summary; the heavy `perFile` detail is deliberately dropped. */
function summarizeTestRounds(value: unknown): QuayTestRoundSummary[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const state = record ? readNullableString(record.state) : null;
    if (!record || !state) {
      return [];
    }

    return [
      {
        round: readCount(record.round),
        startedAt: readNullableString(record.startedAt),
        durationMs: readNullableNumber(record.durationMs),
        pass: readNullableNumber(record.pass),
        fail: readNullableNumber(record.fail),
        tests: readNullableNumber(record.tests),
        state,
      },
    ];
  });
}

/** Keeps only the tasks whose outcome record carries a `mechanical_fan_in` block, projected to the Fan-in card's fields. */
function summarizeFanInAttempts(value: unknown): QuayFanInAttemptSummary[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const fanIn = record ? asRecord(record.mechanical_fan_in) : null;
    const task = record ? readNullableString(record.task) : null;
    const outcome = fanIn ? readNullableString(fanIn.outcome) : null;
    if (!task || !outcome) {
      return [];
    }

    return [
      {
        task,
        outcome,
        lockAcquireEpoch: readNullableNumber(fanIn?.lockAcquireEpoch),
        lockReleaseEpoch: readNullableNumber(fanIn?.lockReleaseEpoch),
      },
    ];
  });
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

    // The Tests and Fan-in cards read quay's own carrier files under the trusted
    // project root — never a path from the request. A missing file is a normal
    // empty reading, so these reads never push a warning.
    const quayDir = path.join(projectPath, '.quay');
    const currentSuite = await readCurrentSuiteState(
      dependencies.readFile,
      path.join(quayDir, QUAY_SUITE_STATE_FILE),
    );
    const recentRounds = summarizeTestRounds(
      await readCarrierFileTail(
        dependencies.readFile,
        path.join(quayDir, QUAY_ROUND_HISTORY_FILE),
        QUAY_RECENT_LIST_LIMIT,
      ),
    );
    const fanInAttempts = summarizeFanInAttempts(
      await readCarrierFileTail(
        dependencies.readFile,
        path.join(quayDir, QUAY_WORKER_OUTCOME_FILE),
        QUAY_RECENT_LIST_LIMIT,
      ),
    );

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
      tests: { current: currentSuite, recentRounds },
      fanIn: { recent: fanInAttempts },
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

  /**
   * Reads a project's Tier-2 snapshot from the in-memory TTL cache WITHOUT ever
   * loading it: the two outcomes are the cached snapshot (marked `cached: true`)
   * or `null` on a miss / an expired entry. It never calls {@link loadSnapshot}
   * / {@link collectSnapshot} / `runCommand`, so a caller fanning out over N
   * projects spawns zero quay CLI processes — the property the MCP `overview`
   * tool (AC-247) rests on, where an unbounded cold-cache fan-out would otherwise
   * spawn one `quay` invocation per project.
   *
   * The freshness test is the SAME predicate `getQuaySnapshot`'s cache branch
   * uses (`cached.expiresAt > now()`), so the Tier-2 panel and the MCP gateway can
   * never disagree about whether a reading is fresh.
   *
   * Consumer: `server/index.ts` binds the MCP gateway's `McpQuayRunner.readCached`
   * to this method (AC-247); `getQuaySnapshot` keeps its existing load-on-demand
   * semantics and is bound to `refresh` instead.
   */
  const getCachedSnapshot = (projectId: string): QuaySnapshot | null => {
    const cached = snapshotCache.get(projectId);
    if (cached && cached.expiresAt > dependencies.now()) {
      return { ...cached.snapshot, cached: true };
    }
    return null;
  };

  return {
    detectQuayConfig,
    runQuayCommand,
    getQuayStatus,
    getQuaySnapshot,
    getCachedSnapshot,
  };
}
