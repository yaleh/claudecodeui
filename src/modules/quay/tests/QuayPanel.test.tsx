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
  goals: { total: 2, achieved: 1 },
  adrs: { total: 3, recent: [{ id: 'ADR-001', title: 'First decision', status: 'accepted' }] },
  configIssues: { total: 0, errors: 0 },
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
    2,
    `expected both of the panel's \`md:grid-cols-2\` grids; found ${JSON.stringify(gridClassNames)}`,
  );
  for (const className of responsive) {
    const tokens = className.split(/[\s"]+/);
    assert.ok(
      tokens.includes('grid-cols-1'),
      `a \`md:grid-cols-2\` grid is missing its base column count (grid-cols-1): ${className}`,
    );
  }
});
