import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  createQuayService,
  isReadOnlyQuayCommand,
  readCarrierFileTail,
  readCurrentSuiteState,
  type QuayCommandResult,
  type QuayCommandRunner,
  type QuayFileReader,
} from '../quay.service.js';

type ServiceDependencies = Parameters<typeof createQuayService>[0];

const PROJECT_PATH = path.join(path.sep, 'workspace', 'project-1');
const CONFIG_PATH = path.join(PROJECT_PATH, '.quay', 'config.yml');

/**
 * A read-only file boundary over an in-memory corpus. `size`/`readChunk` serve a
 * synthetic carrier file and record every byte-range read, so a test can assert
 * how much of a file the tail reader actually touched.
 */
function createFileReader(overrides: Partial<QuayFileReader> = {}): QuayFileReader {
  return {
    size: async () => null,
    readChunk: async () => '',
    readText: async () => {
      throw new Error('ENOENT');
    },
    ...overrides,
  };
}

/** Minimal dependency set: fake availability check, fake runner, fake file boundary and a controllable clock. */
function createDependencies(overrides: Partial<ServiceDependencies> = {}): ServiceDependencies {
  return {
    fileExists: () => false,
    resolveProjectPathById: (projectId: string) => (projectId === 'project-1' ? PROJECT_PATH : null),
    runCommand: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
    readFile: createFileReader(),
    now: () => 0,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 8_000,
    ...overrides,
  };
}

/** A runner that answers each whitelisted read-only command with a fixture JSON document. */
function createFixtureRunner(counter: { calls: number }): QuayCommandRunner {
  const responses: Record<string, unknown> = {
    'task list --json': [
      { id: 'a', title: 'Task A', status: 'ready', updatedAt: 300 },
      { id: 'b', title: 'Task B', status: 'done', updatedAt: 100 },
      { id: 'c', title: 'Task C', status: 'needs-human', updatedAt: 200 },
    ],
    'goal list --json': [{ id: 'GOAL-1', status: 'achieved' }, { id: 'GOAL-2', status: 'pending' }],
    'adr list --json': [],
    'driver status --kind worker --json': {
      alive: 1,
      running: 1,
      last_record_ts: '2026-01-01T00:00:00.000Z',
    },
    'config validate --json': [{ severity: 'error', field: 'loop.board', message: 'missing' }],
    'server status --json': {
      services: [{ name: 'web', host: '172.28.0.1', port: 3651, liveness: { alive: true } }],
    },
  };

  return async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
    counter.calls += 1;
    const key = args.join(' ');
    return { ok: true, code: 0, stdout: JSON.stringify(responses[key] ?? null), stderr: '' };
  };
}

test('detectQuayConfig reports true only when .quay/config.yml exists', () => {
  const seen: string[] = [];
  const service = createQuayService(createDependencies({
    fileExists: (filePath: string) => {
      seen.push(filePath);
      return filePath === CONFIG_PATH;
    },
  }));

  assert.equal(service.detectQuayConfig(PROJECT_PATH), true);
  assert.deepEqual(seen, [CONFIG_PATH]);

  const missing = createQuayService(createDependencies({ fileExists: () => false }));
  assert.equal(missing.detectQuayConfig(PROJECT_PATH), false);
});

test('runQuayCommand refuses a non-whitelisted command without spawning a subprocess', async () => {
  let spawnCount = 0;
  const service = createQuayService(createDependencies({
    runCommand: async () => {
      spawnCount += 1;
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const writeCommands = [
    ['task', 'create', '--json'],
    ['task', 'edit', 'gap-x'],
    ['task', 'check', 'gap-x'],
    ['driver', 'start', '--kind', 'worker'],
    ['driver', 'stop', '--kind', 'worker'],
    ['gate', 'run', 'gap-x'],
    ['promote', 'gap-x'],
    ['retreat', 'gap-x'],
    // A read-only prefix with an extra argument must not slip through the exact-match rule.
    ['task', 'list', '--json', '--inject'],
  ];

  for (const args of writeCommands) {
    const result = await service.runQuayCommand(PROJECT_PATH, args);
    assert.equal(result.ok, false, `expected refusal for: ${args.join(' ')}`);
    assert.match(result.error ?? '', /whitelist/);
  }

  assert.equal(spawnCount, 0, 'no refused command may reach the subprocess runner');
});

test('runQuayCommand executes a whitelisted read-only command', async () => {
  const seen: string[][] = [];
  const service = createQuayService(createDependencies({
    runCommand: async (cwd: string, args: readonly string[]) => {
      seen.push([cwd, ...args]);
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const result = await service.runQuayCommand(PROJECT_PATH, ['adr', 'list', '--json']);

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [[PROJECT_PATH, 'adr', 'list', '--json']]);
  assert.equal(isReadOnlyQuayCommand(['driver', 'status', '--kind', 'promotion', '--json']), true);
  assert.equal(isReadOnlyQuayCommand(['driver', 'status', '--json']), false);
  // The dashboard URL probe is a read-only verb on the whitelist, and only in
  // its exact spelling: an extra argument must still be refused.
  assert.equal(isReadOnlyQuayCommand(['server', 'status', '--json']), true);
  assert.equal(isReadOnlyQuayCommand(['server', 'status']), false);
  assert.equal(isReadOnlyQuayCommand(['server', 'start']), false);
});

test('getQuaySnapshot deduplicates concurrent calls and reuses a fresh snapshot', async () => {
  const counter = { calls: 0 };
  let nowMs = 0;
  const service = createQuayService(createDependencies({
    now: () => nowMs,
    runCommand: createFixtureRunner(counter),
  }));

  // Two concurrent opens of the same project must share one CLI pass, not two.
  const [first, second] = await Promise.all([
    service.getQuaySnapshot('project-1'),
    service.getQuaySnapshot('project-1'),
  ]);

  const perPassCommands = 6; // task + goal + adr + driver + config + server
  assert.equal(counter.calls, perPassCommands, 'two concurrent calls spawn the CLI once per command');
  assert.equal(first, second, 'the in-flight promise is shared, not recomputed');

  assert.ok(first);
  assert.equal(first.cached, false);
  assert.deepEqual(first.tasks, {
    total: 3,
    byStatus: { ready: 1, done: 1, 'needs-human': 1 },
    ready: 1,
    needsHuman: 1,
    done: 1,
    // Most recently updated first: a(300) → c(200) → b(100).
    recent: [
      { id: 'a', title: 'Task A', status: 'ready' },
      { id: 'c', title: 'Task C', status: 'needs-human' },
      { id: 'b', title: 'Task B', status: 'done' },
    ],
  });
  assert.deepEqual(first.goals, {
    total: 2,
    achieved: 1,
    breakdown: {
      byStatus: { achieved: 1, pending: 1 },
      // Both goals share updatedAt 0, so the tie breaks by id ascending.
      recent: [
        { id: 'GOAL-1', title: '', status: 'achieved' },
        { id: 'GOAL-2', title: '', status: 'pending' },
      ],
    },
  });
  assert.deepEqual(first.adrs, { total: 0, recent: [] });
  assert.deepEqual(first.configIssues, { total: 1, errors: 1 });
  assert.equal(first.driver?.state, 'running');
  assert.equal(first.dashboardUrl, 'http://172.28.0.1:3651/');
  // No carrier files on disk in this fixture (the default reader returns nothing).
  assert.deepEqual(first.tests, { current: null, recentRounds: [] });
  assert.deepEqual(first.fanIn, { recent: [] });

  // A call inside the TTL window is served from cache — no new subprocess.
  const cached = await service.getQuaySnapshot('project-1');
  assert.equal(counter.calls, perPassCommands, 'a TTL hit must not spawn the CLI again');
  assert.equal(cached?.cached, true);

  // Past the TTL the snapshot is rebuilt; `forceRefresh` bypasses it outright.
  nowMs += 60_000;
  const refreshed = await service.getQuaySnapshot('project-1');
  assert.equal(counter.calls, perPassCommands * 2);
  assert.equal(refreshed?.cached, false);

  await service.getQuaySnapshot('project-1', { forceRefresh: true });
  assert.equal(counter.calls, perPassCommands * 3);
});

test('getQuaySnapshot keeps the findings of a command that signals via its exit code', async () => {
  // `quay config validate --json` prints its issue list and exits 1 to say the
  // issues exist; that list is the reading, so a non-zero exit must not discard it.
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      if (args.join(' ') === 'config validate --json') {
        return {
          ok: false,
          code: 1,
          stdout: JSON.stringify([{ severity: 'error', field: 'loop.board', message: 'missing' }]),
          stderr: '',
        };
      }
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.deepEqual(snapshot?.configIssues, { total: 1, errors: 1 });
  assert.deepEqual(snapshot?.warnings, []);
});

test('getQuaySnapshot returns null for an unknown project', async () => {
  const service = createQuayService(createDependencies());
  assert.equal(await service.getQuaySnapshot('missing'), null);
});

test('getQuaySnapshot leaves dashboardUrl null and warns nothing when no live web service answers', async () => {
  const cases: Array<{ name: string; serverResult: QuayCommandResult }> = [
    {
      name: 'web service reported but not alive',
      serverResult: {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          services: [{ name: 'web', host: '127.0.0.1', port: 3651, liveness: { alive: false } }],
        }),
        stderr: '',
      },
    },
    {
      name: 'no web service entry',
      serverResult: {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          services: [{ name: 'control', host: '127.0.0.1', port: 21353, liveness: { alive: true } }],
        }),
        stderr: '',
      },
    },
    {
      name: 'server status command failed',
      serverResult: { ok: false, code: null, stdout: '', stderr: '', error: 'spawn quay ENOENT' },
    },
  ];

  for (const scenario of cases) {
    const service = createQuayService(createDependencies({
      runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> =>
        (args.join(' ') === 'server status --json'
          ? scenario.serverResult
          : { ok: true, code: 0, stdout: '[]', stderr: '' }),
    }));

    const snapshot = await service.getQuaySnapshot('project-1');
    assert.equal(snapshot?.dashboardUrl, null, scenario.name);
    assert.deepEqual(snapshot?.warnings, [], `${scenario.name}: an absent dashboard is not a warning`);
  }
});

test('getQuaySnapshot caps the recent lists and orders them most-recent-first', async () => {
  const makeItems = (prefix: string, count: number) =>
    Array.from({ length: count }, (_item, index) => ({
      id: `${prefix}-${String(index).padStart(2, '0')}`,
      title: `${prefix} ${index}`,
      status: 'done',
      // Distinct timestamps so recency — not source order — decides the ranking.
      updatedAt: index,
    }));

  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      const key = args.join(' ');
      if (key === 'task list --json') {
        return { ok: true, code: 0, stdout: JSON.stringify(makeItems('T', 12)), stderr: '' };
      }
      if (key === 'adr list --json') {
        return { ok: true, code: 0, stdout: JSON.stringify(makeItems('ADR', 12)), stderr: '' };
      }
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  // 12 items, updatedAt 0..11 → the ten newest, newest first.
  const expectedIds = (prefix: string) =>
    Array.from({ length: 10 }, (_item, index) => `${prefix}-${String(11 - index).padStart(2, '0')}`);

  assert.deepEqual(snapshot.tasks?.recent.map((item) => item.id), expectedIds('T'));
  assert.deepEqual(snapshot.adrs?.recent.map((item) => item.id), expectedIds('ADR'));
  assert.equal(snapshot.tasks?.recent.length, 10);
  assert.equal(snapshot.adrs?.recent.length, 10);
  // The counts still describe the whole array, not just the capped recent slice.
  assert.equal(snapshot.tasks?.total, 12);
  assert.equal(snapshot.adrs?.total, 12);
});

test('getQuaySnapshot breaks a recency tie by id so the recent order is deterministic', async () => {
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      if (args.join(' ') === 'task list --json') {
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify([
            { id: 'zzz', title: 'Z', status: 'ready', updatedAt: 5 },
            { id: 'aaa', title: 'A', status: 'ready', updatedAt: 5 },
          ]),
          stderr: '',
        };
      }
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.deepEqual(snapshot?.tasks?.recent.map((item) => item.id), ['aaa', 'zzz']);
});

test('readCarrierFileTail keeps only the last N records and reads a bounded tail window, not the whole file', async () => {
  // ~1.4 MB of records; a whole-file read would be the very thing this reader exists to avoid.
  const lines = Array.from({ length: 100_000 }, (_line, index) => JSON.stringify({ round: index }));
  const content = `${lines.join('\n')}\n`;
  const reads: Array<{ position: number; length: number }> = [];
  const reader = createFileReader({
    size: async () => content.length,
    readChunk: async (_filePath, position, length) => {
      reads.push({ position, length });
      return content.slice(position, position + length);
    },
  });

  const records = await readCarrierFileTail(reader, '/workspace/history.jsonl', 10);

  assert.deepEqual(
    records.map((record) => (record as { round: number }).round),
    [99_990, 99_991, 99_992, 99_993, 99_994, 99_995, 99_996, 99_997, 99_998, 99_999],
  );
  assert.equal(reads.length, 1, 'one 64 KiB window already holds more than ten lines');
  assert.ok(reads[0].length <= 64 * 1024, `read ${reads[0].length} bytes, expected <= 64 KiB`);
  assert.ok(reads[0].length < content.length / 10, 'the tail read must be a small fraction of the file');
});

test('readCarrierFileTail skips malformed lines instead of failing the whole read', async () => {
  const content = `${JSON.stringify({ round: 1 })}\nnot json at all\n${JSON.stringify({ round: 3 })}\n`;
  const reader = createFileReader({
    size: async () => content.length,
    readChunk: async (_filePath, position, length) => content.slice(position, position + length),
  });

  assert.deepEqual(await readCarrierFileTail(reader, '/workspace/history.jsonl', 10), [{ round: 1 }, { round: 3 }]);
});

test('readCurrentSuiteState returns the projected reading, and null for a missing or unparseable file', async () => {
  const present = createFileReader({
    readText: async () => JSON.stringify({ state: 'red', laneCount: 3 }),
  });
  assert.deepEqual(await readCurrentSuiteState(present, '/workspace/full-suite-state.json'), {
    state: 'red',
    runner: null,
    scope: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    laneCount: 3,
    commit: null,
    taskId: null,
    runId: null,
  });

  const garbage = createFileReader({ readText: async () => '{ not json' });
  assert.equal(await readCurrentSuiteState(garbage, '/workspace/full-suite-state.json'), null);

  const noState = createFileReader({ readText: async () => JSON.stringify({ laneCount: 3 }) });
  assert.equal(await readCurrentSuiteState(noState, '/workspace/full-suite-state.json'), null);

  // The default reader throws (file absent): a normal "nothing running" state, never an error.
  assert.equal(await readCurrentSuiteState(createFileReader(), '/workspace/full-suite-state.json'), null);
});

test('getQuaySnapshot projects the Tests and Fan-in cards and drops the heavy round detail', async () => {
  const roundContent = `${[
    JSON.stringify({
      round: 7,
      startedAt: '2026-10-03T01:00:00.000Z',
      durationMs: 12_000,
      pass: 4,
      fail: 1,
      tests: 5,
      state: 'red',
      perFile: [{ file: 'a.test.ts', detail: 'x'.repeat(5_000) }],
    }),
    JSON.stringify({
      round: 8,
      startedAt: '2026-10-03T02:00:00.000Z',
      durationMs: 9_000,
      pass: 5,
      fail: 0,
      tests: 5,
      state: 'green',
      perFile: [],
    }),
  ].join('\n')}\n`;
  const outcomeContent = `${[
    JSON.stringify({
      task: 'gap-a',
      mechanical_fan_in: { outcome: 'landed', lockAcquireEpoch: 1_791_003_441, lockReleaseEpoch: 1_791_003_657 },
    }),
    // No mechanical_fan_in block: the task never reached fan-in, so it is filtered out.
    JSON.stringify({ task: 'gap-b' }),
    JSON.stringify({
      task: 'gap-c',
      mechanical_fan_in: { outcome: 'failed', lockAcquireEpoch: 1_791_010_000, lockReleaseEpoch: null },
    }),
  ].join('\n')}\n`;

  const reader = createFileReader({
    size: async (filePath) => {
      if (filePath.endsWith('verification-round.jsonl')) return roundContent.length;
      if (filePath.endsWith('worker-outcome.jsonl')) return outcomeContent.length;
      return null;
    },
    readChunk: async (filePath, position, length) => {
      const content = filePath.endsWith('verification-round.jsonl') ? roundContent : outcomeContent;
      return content.slice(position, position + length);
    },
    readText: async (filePath) => {
      if (filePath.endsWith('full-suite-state.json')) {
        return JSON.stringify({
          state: 'green',
          runner: 'inner',
          scope: 'worktree',
          startedAt: '2026-10-03T06:58:14.072Z',
          finishedAt: 1_791_010_890,
          durationMs: 196_837,
          laneCount: 127,
          commit: '8ae18cf39e1ec22b62bc3312532340eefd8677d2',
          taskId: 'gap-x',
          runId: 'r1',
        });
      }
      throw new Error('ENOENT');
    },
  });

  const service = createQuayService(createDependencies({
    readFile: reader,
    runCommand: async (_cwd, args): Promise<QuayCommandResult> => ({
      ok: true,
      code: 0,
      stdout: args.join(' ') === 'goal list --json'
        ? JSON.stringify([
            { id: 'GOAL-1', status: 'achieved', updatedAt: 2 },
            { id: 'GOAL-2', status: 'active', updatedAt: 1 },
            { id: 'GOAL-3', status: 'active', updatedAt: 3 },
          ])
        : '[]',
      stderr: '',
    }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  assert.deepEqual(snapshot.tests.current, {
    state: 'green',
    runner: 'inner',
    scope: 'worktree',
    startedAt: '2026-10-03T06:58:14.072Z',
    finishedAt: 1_791_010_890,
    durationMs: 196_837,
    laneCount: 127,
    commit: '8ae18cf39e1ec22b62bc3312532340eefd8677d2',
    taskId: 'gap-x',
    runId: 'r1',
  });
  assert.deepEqual(snapshot.tests.recentRounds, [
    { round: 7, startedAt: '2026-10-03T01:00:00.000Z', durationMs: 12_000, pass: 4, fail: 1, tests: 5, state: 'red' },
    { round: 8, startedAt: '2026-10-03T02:00:00.000Z', durationMs: 9_000, pass: 5, fail: 0, tests: 5, state: 'green' },
  ]);
  assert.equal('perFile' in (snapshot.tests.recentRounds[0] as object), false, 'the heavy per-file detail must be dropped');

  assert.deepEqual(snapshot.fanIn.recent, [
    { task: 'gap-a', outcome: 'landed', lockAcquireEpoch: 1_791_003_441, lockReleaseEpoch: 1_791_003_657 },
    { task: 'gap-c', outcome: 'failed', lockAcquireEpoch: 1_791_010_000, lockReleaseEpoch: null },
  ]);

  // Stage goals breakdown groups by status and orders the recent rows newest first.
  assert.deepEqual(snapshot.goals?.breakdown.byStatus, { achieved: 1, active: 2 });
  assert.deepEqual(snapshot.goals?.breakdown.recent.map((goal) => goal.id), ['GOAL-3', 'GOAL-1', 'GOAL-2']);

  // Missing carrier files are a normal empty reading, never a warning.
  assert.deepEqual(snapshot.warnings, []);
});
