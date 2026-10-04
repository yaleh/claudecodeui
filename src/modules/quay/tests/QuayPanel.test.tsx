import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import type { QuaySnapshot } from '@/shared/types';
import QuayPanel from '@/modules/quay/QuayPanel';
import type { QuayPanelView } from '@/modules/quay/hooks/useQuayStatus';

const DASHBOARD_URL = 'http://172.28.0.1:3651/';

const SNAPSHOT: QuaySnapshot = {
  projectId: 'project-1',
  projectPath: '/workspace/project-1',
  generatedAt: '2026-10-02T00:00:00.000Z',
  cached: false,
  driver: { state: 'running', alive: true, running: true, lastRecordAt: '2026-10-01T23:59:00.000Z' },
  tasks: {
    total: 4,
    byStatus: { ready: 2, done: 1, 'needs-human': 1 },
    ready: 2,
    needsHuman: 1,
    done: 1,
    recent: [
      { id: 'gap-task-a', title: 'Task A', status: 'ready' },
      { id: 'gap-task-b', title: 'Task B', status: 'done' },
    ],
  },
  goals: {
    total: 3,
    achieved: 1,
    breakdown: {
      byStatus: { achieved: 1, active: 2 },
      recent: [
        { id: 'GOAL-3', title: 'Third goal', status: 'active' },
        { id: 'GOAL-1', title: 'First goal', status: 'achieved' },
      ],
    },
  },
  adrs: { total: 3, recent: [{ id: 'ADR-001', title: 'First decision', status: 'accepted' }] },
  configIssues: { total: 0, errors: 0 },
  tests: {
    current: {
      state: 'green',
      runner: 'inner',
      scope: 'worktree',
      startedAt: '2026-10-01T23:00:00.000Z',
      finishedAt: 1790986890,
      durationMs: 196837,
      laneCount: 127,
      commit: '8ae18cf39e1ec22b62bc3312532340eefd8677d2',
      taskId: 'gap-x',
      runId: 'r1',
    },
    recentRounds: [
      { round: 469, startedAt: '2026-10-01T23:00:00.000Z', durationMs: 100000, pass: 310, fail: 0, tests: 310, state: 'green' },
      { round: 470, startedAt: '2026-10-01T23:10:00.000Z', durationMs: 195593, pass: 308, fail: 2, tests: 310, state: 'red' },
    ],
  },
  fanIn: {
    recent: [
      { task: 'gap-task-a', outcome: 'landed', lockAcquireEpoch: 1790986800, lockReleaseEpoch: 1790987016 },
      { task: 'gap-task-b', outcome: 'failed', lockAcquireEpoch: 1790987100, lockReleaseEpoch: null },
    ],
  },
  dashboardUrl: DASHBOARD_URL,
  warnings: [],
};

const renderView = (view: QuayPanelView, dashboardUrl: string | null = null) =>
  render(<QuayPanel projectId="project-1" view={view} onRefresh={() => {}} dashboardUrl={dashboardUrl} />);

test('QuayPanel renders the not-configured state without any counts', () => {
  const { container, getByTestId } = renderView({ status: 'not-configured' });

  getByTestId('quay-panel-not-configured');
  assert.equal(container.querySelector('[data-testid="quay-panel-loaded"]'), null);
  assert.match(container.textContent ?? '', /not configured/i);
});

test('QuayPanel renders the loading state', () => {
  const { getByTestId, container } = renderView({ status: 'loading' });

  getByTestId('quay-panel-loading');
  assert.equal(container.querySelector('[data-testid="quay-panel-error"]'), null);
});

test('QuayPanel renders the error state with the message and a retry', () => {
  const { getByTestId, getByText } = renderView({ status: 'error', message: 'boom' });

  getByTestId('quay-panel-error');
  getByText('boom');
  getByText('Retry');
});

test('QuayPanel renders the loaded snapshot counts, driver reading and sync time', () => {
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: SNAPSHOT });

  getByTestId('quay-panel-loaded');
  // The read-only marker and the driver reading the panel header promises.
  assert.match(container.textContent ?? '', /read-only/i);
  assert.match(container.textContent ?? '', /Driver running/i);
  assert.match(container.textContent ?? '', /Last synced/i);
  // Counts come from the snapshot, not a placeholder: 4 tasks, 1 needs-human.
  assert.match(container.textContent ?? '', /needs human/i);
  assert.equal(getByTestId('quay-panel-driver-last-record').textContent?.includes('never'), false);
});

test('QuayPanel renders a clickable Dashboard link when the snapshot carries a dashboardUrl', () => {
  const { container } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, DASHBOARD_URL);

  const link = container.querySelector(`a[href="${DASHBOARD_URL}"]`);
  assert.ok(link, 'expected an anchor pointing at the dashboard URL');
  assert.equal(link?.textContent?.trim(), 'Dashboard');
  assert.equal(link?.getAttribute('target'), '_blank');
});

test('QuayPanel renders no Dashboard link when the panel is given no dashboardUrl', () => {
  const { container, getByTestId } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, null);

  getByTestId('quay-panel-loaded');
  assert.equal(container.querySelector('a'), null);
  assert.equal((container.textContent ?? '').includes('Dashboard'), false);
});

test('QuayPanel renders each recent task and ADR row with id, title and status', () => {
  const { getByTestId } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, null);

  const taskRows = getByTestId('quay-panel-recent-tasks').querySelectorAll('[data-testid="quay-panel-recent-tasks-row"]');
  assert.equal(taskRows.length, 2);
  assert.match(taskRows[0]?.textContent ?? '', /gap-task-a/);
  assert.match(taskRows[0]?.textContent ?? '', /Task A/);
  assert.match(taskRows[0]?.textContent ?? '', /ready/);

  const adrRows = getByTestId('quay-panel-recent-adrs').querySelectorAll('[data-testid="quay-panel-recent-adrs-row"]');
  assert.equal(adrRows.length, 1);
  assert.match(adrRows[0]?.textContent ?? '', /ADR-001/);
  assert.match(adrRows[0]?.textContent ?? '', /First decision/);
  assert.match(adrRows[0]?.textContent ?? '', /accepted/);
});

test('QuayPanel renders an empty state for each detail list when the recents are empty', () => {
  const emptySnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    tasks: { total: 0, byStatus: {}, ready: 0, needsHuman: 0, done: 0, recent: [] },
    adrs: { total: 0, recent: [] },
  };
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: emptySnapshot }, null);

  assert.match(getByTestId('quay-panel-recent-tasks-empty').textContent ?? '', /No tasks reported/);
  assert.match(getByTestId('quay-panel-recent-adrs-empty').textContent ?? '', /No ADRs reported/);
  assert.equal(container.querySelector('[data-testid="quay-panel-recent-tasks-row"]'), null);
  assert.equal(container.querySelector('[data-testid="quay-panel-recent-adrs-row"]'), null);
});

/**
 * The reading that produced this test (2026-10-04, project `quay`): `quay task list
 * --json` printed ~26 MB — every task's whole body — which overflowed the backend's
 * 8 MiB output cap. `execFile` killed the CLI mid-string, `JSON.parse` failed on the
 * torn tail, the service degraded the section to `null`, and the panel rendered the
 * failure as "0 tasks · 0 ready · 0 needs human · 0 done" plus "No tasks reported."
 * — a reading indistinguishable from a genuinely empty board.
 */
test('QuayPanel renders a section whose command did not answer as unavailable, never as zero', () => {
  const degradedSnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    driver: null,
    tasks: null,
    goals: null,
    adrs: null,
    configIssues: null,
    warnings: ['task list --json: stdout maxBuffer length exceeded'],
  };
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: degradedSnapshot }, null);
  const text = container.textContent ?? '';

  // The Task ledger says it does not know, instead of claiming an empty board.
  assert.match(getByTestId('quay-panel-task-ledger-unavailable').textContent ?? '', /unavailable/i);
  assert.equal(container.querySelector('[data-testid="quay-panel-task-ledger-counts"]'), null);
  assert.equal(text.includes('0 tasks'), false);
  assert.equal(text.includes('0 ready'), false);
  assert.equal(container.querySelector('[data-testid="quay-panel-recent-tasks-empty"]'), null);

  assert.match(getByTestId('quay-panel-stage-goals-unavailable').textContent ?? '', /unavailable/i);
  assert.equal(container.querySelector('[data-testid="quay-panel-stage-goals-empty"]'), null);
  assert.match(getByTestId('quay-panel-recent-adrs-unavailable').textContent ?? '', /unavailable/i);
  assert.equal(container.querySelector('[data-testid="quay-panel-recent-adrs-empty"]'), null);
  assert.equal(getByTestId('quay-panel-config-issues').textContent, 'unavailable');

  // The driver reading: the panel only exists for a project that HAS a
  // `.quay/config.yml`, so a failed `driver status` read must not be reported as
  // that project being unconfigured.
  assert.match(getByTestId('quay-panel-loaded').textContent ?? '', /Driver status unavailable/i);
  assert.equal(text.includes('Not configured'), false);
  assert.equal(getByTestId('quay-panel-driver-last-record').textContent, 'unavailable');

  // The warning banner still names the command that failed.
  assert.match(getByTestId('quay-panel-warnings').textContent ?? '', /maxBuffer/);
});

test('QuayPanel renders the Stage goals, Tests and Fan-in cards with the snapshot data', () => {
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, null);

  // Stage goals: one row per recent goal, each carrying the status and a progress bar.
  const goalRows = getByTestId('quay-panel-stage-goals-list').querySelectorAll('[data-testid="quay-panel-stage-goals-row"]');
  assert.equal(goalRows.length, 2);
  assert.match(goalRows[0]?.textContent ?? '', /GOAL-3/);
  assert.match(getByTestId('quay-panel-stage-goals-counts').textContent ?? '', /active/);
  const goalBars = getByTestId('quay-panel-stage-goals-list').querySelectorAll('[data-testid="quay-panel-stage-goals-bar"]');
  assert.equal(goalBars.length, 2);
  assert.ok(Array.from(goalBars).every((bar) => bar.querySelector('div') !== null));

  // Tests: the current reading plus one timeline rect per recent round.
  assert.match(getByTestId('quay-panel-tests-current').textContent ?? '', /green/);
  assert.equal(
    getByTestId('quay-panel-tests-timeline').querySelectorAll('[data-testid="quay-panel-tests-timeline-rect"]').length,
    2,
  );

  // Fan-in: one rect per attempt that carries a lock epoch, plus the recent task rows.
  assert.equal(
    getByTestId('quay-panel-fanin-timeline').querySelectorAll('[data-testid="quay-panel-fanin-timeline-rect"]').length,
    2,
  );
  const fanInRows = getByTestId('quay-panel-fanin-list').querySelectorAll('[data-testid="quay-panel-fanin-row"]');
  assert.equal(fanInRows.length, 2);
  assert.match(fanInRows[0]?.textContent ?? '', /gap-task-b/);
  assert.match(container.textContent ?? '', /landed/);
});

test('QuayPanel renders empty states for the Stage goals, Tests and Fan-in cards', () => {
  const emptySnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
    tests: { current: null, recentRounds: [] },
    fanIn: { recent: [] },
  };
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: emptySnapshot }, null);

  assert.match(getByTestId('quay-panel-stage-goals-empty').textContent ?? '', /No goals reported/);
  assert.match(getByTestId('quay-panel-tests-current-empty').textContent ?? '', /No suite running/);
  assert.match(getByTestId('quay-panel-tests-timeline-empty').textContent ?? '', /No suite rounds/);
  assert.match(getByTestId('quay-panel-fanin-timeline-empty').textContent ?? '', /No fan-in attempts/);
  assert.equal(container.querySelector('[data-testid="quay-panel-stage-goals-row"]'), null);
  assert.equal(container.querySelector('[data-testid="quay-panel-fanin-row"]'), null);
});

/**
 * Every `md:grid-cols-2` grid on the panel must also declare a base column count.
 *
 * Without `grid-cols-1` Tailwind emits no `grid-template-columns` below `md`, and an
 * implicit grid track has no `minmax(0, 1fr)` floor: its min width falls back to the
 * content's min-content width. A row title is `truncate`d (`white-space: nowrap`), so
 * its min-content width is the whole unbroken line — and on a 390px phone the track is
 * stretched to that width, the grid overflows its `overflow-hidden` ancestor, and the
 * text is clipped instead of ellipsised.
 *
 * This is a source-level assertion because jsdom does not compute real CSS grid track
 * sizes, so a rendered reading here cannot see the defect at all. The real-browser
 * reading lives in `e2e/zz-quay-panel-mobile-grid.spec.ts`; this one exists so that a
 * future edit cannot silently drop the base column count again.
 */
test('QuayPanel’s responsive grids declare a base column count so they cannot blow out below `md`', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/quay/QuayPanel.tsx'), 'utf8');
  const gridClassNames = source.match(/className="[^"]*\bgrid\b[^"]*"/g) ?? [];
  const responsive = gridClassNames.filter((className) => className.includes('md:grid-cols-2'));

  assert.equal(
    responsive.length,
    1,
    `expected the panel's single \`md:grid-cols-2\` grid (the Task ledger/Stage goals/Tests/Fan-in grid); found ${JSON.stringify(gridClassNames)}`,
  );
  for (const className of responsive) {
    const tokens = className.split(/[\s"]+/);
    assert.ok(
      tokens.includes('grid-cols-1'),
      `a \`md:grid-cols-2\` grid is missing its base column count (grid-cols-1): ${className}`,
    );
  }
});
