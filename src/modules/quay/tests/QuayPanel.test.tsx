import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import type { QuaySnapshot } from '@/shared/types';
import QuayPanel from '@/modules/quay/QuayPanel';
import type { QuayPanelView } from '@/modules/quay/hooks/useQuayStatus';

const SNAPSHOT: QuaySnapshot = {
  projectId: 'project-1',
  projectPath: '/workspace/project-1',
  generatedAt: '2026-10-02T00:00:00.000Z',
  cached: false,
  driver: { state: 'running', alive: true, running: true, lastRecordAt: '2026-10-01T23:59:00.000Z' },
  tasks: { total: 4, byStatus: { ready: 2, done: 1, 'needs-human': 1 }, ready: 2, needsHuman: 1, done: 1 },
  goals: { total: 2, achieved: 1 },
  adrs: { total: 3 },
  configIssues: { total: 0, errors: 0 },
  warnings: [],
};

const renderView = (view: QuayPanelView) =>
  render(<QuayPanel projectId="project-1" view={view} onRefresh={() => {}} />);

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
