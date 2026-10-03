import assert from 'node:assert/strict';

import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, test } from 'vitest';

import ActivityDockPanel from '@/modules/chat/transcript/ActivityDockPanel';
import {
  applyActivityFrame,
  findTaskByToolUseId,
  readSessionActivityView,
  resetSessionActivityStore,
} from '@/modules/chat/hooks/useSessionActivity';
import { deriveActivityDockView } from '@/modules/chat/utils/activityDockView';
import type { ActivityScheduleView, ActivityTaskView } from '@/shared/types';

/**
 * The background half of the activity dock, in milliseconds.
 *
 * The browser criterion (`e2e/activity-dock-background.spec.ts -g "AC-194"`) is
 * the authority on "a real server's frames drive a real page". This file pins the
 * two readings that must be right for that to be true, at the unit:
 *
 *   - a snapshot's tasks and schedules become the dock's counts and the panel's
 *     rows, with each row's own four / three readings taken from the entity;
 *   - a plan row renders **no** cancel control — the selector count is zero by
 *     construction, not by hiding.
 *
 * The store is reset per test so a frame from one case cannot be read by the
 * next; the panel reads the store through `useSessionActivity`, so this is the
 * same path the page uses.
 */

const TASKS: ActivityTaskView[] = [
  {
    taskId: 'task-agent',
    kind: 'subagent',
    state: 'completed',
    toolUseId: 'tool-agent-1',
    isBackgrounded: true,
    description: 'Explore the repo',
    stepLabel: 'reading files',
    summary: 'done',
    origin: 'sdk-event',
    startedAt: 1_000,
    endedAt: 6_000,
  },
  {
    taskId: 'task-shell',
    kind: 'shell',
    state: 'running',
    toolUseId: 'tool-shell-1',
    isBackgrounded: true,
    description: 'Long build',
    origin: 'sdk-event',
    startedAt: 2_000,
  },
];

const SCHEDULES: ActivityScheduleView[] = [
  {
    scheduleId: 'cron-abc',
    kind: 'cron',
    spec: 'Every 2 minutes',
    recurring: true,
    prompt: 'check the queue',
    nextFireAt: Date.now() + 90_000,
    source: 'tool-call',
  },
];

describe('activity dock background panel', () => {
  beforeEach(() => {
    resetSessionActivityStore();
    cleanup();
  });

  test('a snapshot frames the dock as `background` and carries its counts', () => {
    const armed = deriveActivityDockView({
      activity: null,
      liveness: 'fresh',
      elapsedMs: null,
      hasTurnAnchor: false,
      wired: true,
      hasAbort: false,
      taskCount: TASKS.length,
      scheduleCount: SCHEDULES.length,
    });
    console.log(
      `dock.state=${armed.state} dock.tasks=${armed.taskCount} dock.plans=${armed.scheduleCount}`,
    );
    assert.equal(armed.state, 'background', 'a session holding work must draw the dock between turns');
    assert.equal(armed.taskCount, 2);
    assert.equal(armed.scheduleCount, 1);

    // The negative control: with nothing held and no turn, the dock stays hidden —
    // so the branch above is the counts, not a dock that always draws.
    const idle = deriveActivityDockView({
      activity: null,
      liveness: 'fresh',
      elapsedMs: null,
      hasTurnAnchor: false,
      wired: true,
      hasAbort: false,
    });
    console.log(`dock.emptyState=${idle.state}`);
    assert.equal(idle.state, 'hidden');
  });

  test('the panel lists tasks with four readings and plans with three, and no plan control', () => {
    const sessionId = 'session-panel';
    applyActivityFrame({ sessionId, rev: 1, tasks: TASKS, schedules: SCHEDULES });

    const { container } = render(React.createElement(ActivityDockPanel, { sessionId }));

    const taskRows = container.querySelectorAll('[data-activity-task-row]');
    const scheduleRows = container.querySelectorAll('[data-activity-schedule-row]');
    console.log(`panel.tasks=${taskRows.length} panel.plans=${scheduleRows.length}`);
    assert.equal(taskRows.length, 2, 'one row per task in the snapshot');
    assert.equal(scheduleRows.length, 1, 'one row per plan in the snapshot');

    // AC4: each task row carries all four readings.
    const agentRow = container.querySelector('[data-activity-task-row][data-task-id="task-agent"]');
    assert.ok(agentRow, 'the agent task must have a row');
    assert.equal(agentRow!.getAttribute('data-task-state'), 'completed');
    assert.equal(agentRow!.querySelector('[data-task-description]')?.textContent, 'Explore the repo');
    // Elapsed = ended (6000) - started (1000) = 5s.
    assert.equal(agentRow!.querySelector('[data-task-elapsed]')?.textContent, '5s');
    assert.equal(agentRow!.querySelector('[data-task-last-action]')?.textContent, 'reading files');

    // AC5: each plan row carries all three readings.
    const planRow = container.querySelector('[data-activity-schedule-row]');
    assert.ok(planRow, 'the plan must have a row');
    assert.equal(planRow!.querySelector('[data-schedule-expression]')?.textContent, 'Every 2 minutes');
    assert.ok(
      (planRow!.querySelector('[data-schedule-countdown]')?.textContent ?? '').length > 0,
      'the plan row must show a countdown',
    );
    assert.equal(planRow!.querySelector('[data-schedule-prompt]')?.textContent, 'check the queue');

    // AC9: a plan row has no cancel control — by construction.
    const cancelCount = container.querySelectorAll('[data-schedule-cancel]').length;
    console.log(`panel.scheduleCancelControls=${cancelCount}`);
    assert.equal(cancelCount, 0, 'a plan row must render no cancel control');

    // AC8's join: a card finds its task by the call's tool_use id.
    const joined = readSessionActivityView(sessionId);
    assert.equal(joined.tasks.length, 2);
    assert.equal(findTaskByToolUseId('tool-shell-1')?.taskId, 'task-shell');
    assert.equal(findTaskByToolUseId('nope'), null);
  });
});
