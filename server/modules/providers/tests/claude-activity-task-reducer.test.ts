import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeTaskReducer, mapUpdatedStatus } from '@/modules/providers/index.js';
import type {
  ActivityTask,
  BackgroundTaskSummary,
  ClaudeTaskReducer,
  TaskState,
} from '@/modules/providers/index.js';

/**
 * The Task Reducer's criterion (AC-191).
 *
 * The fixtures are the frame sequence captured from real SDK runs on
 * 2026-10-01, replayed frame by frame. Each builder below names the shape's
 * source so the fixture can be re-derived rather than trusted:
 *
 *   · `system/task_started` / `task_updated` / `task_progress` /
 *     `task_notification` — the event timeline in
 *     `docs/proposals/claude-background-work-observability.md` §1.1 (the run's
 *     time/field table), with the nesting rule from §1.2 (a subagent's own Bash
 *     is a task whose `tool_use_id` is the inner tool and whose
 *     `parent_tool_use_id` is the outer Agent call).
 *   · Workflow — the same proposal §1.3 (`task_started{task_type:'local_workflow',
 *     workflow_name:'simple-workflow-ok'}`; `task_progress.description` is the
 *     step label).
 *   · Stop hook `background_tasks` — `docs/proposals/claude-session-activity-dock.md`
 *     §9.1 (`[{id, type, status, description, command}]`) and the SDK's
 *     `BackgroundTaskSummary` (`type` uses the friendly labels
 *     `shell`/`subagent`/`monitor`/`workflow`).
 *   · Foreground Bash backgrounded — §9.3 of the dock proposal (`backgroundTasks()`
 *     yields a `task_started{task_type:'local_bash'}` together with a
 *     `task_updated{patch:{is_backgrounded:true}}`).
 *
 * Where the record left a shape unpinned, the builder says so: the Monitor's own
 * `task_type` was never captured (the one Monitor task arrived as `local_bash`,
 * §1.1), so its `monitor` kind is only reachable through the Stop hook's
 * `type:'monitor'` label and is exercised in AC7 rather than on the frame path.
 */

/** One raw frame, as the run loop hands it to the normalizer. */
type Frame = Record<string, unknown>;

const SESSION = 'claude-activity-task-reducer-1';

const SUBAGENT_ID = 'a69e-subagent';
const SUBAGENT_TOOL = 'toolu_01Vd-agent';
const INNER_BASH_ID = 'bm82-inner-bash';
const INNER_BASH_TOOL = 'toolu_inner_bash';
const BG_BASH_ID = 'b0i4-bg-bash';
const MONITOR_ID = 'bjzt-monitor';
const WORKFLOW_ID = 'workflow-1';
const FRONT_BASH_ID = 'front-bash-task-1';
const FRONT_BASH_TOOL = 'toolu_front_bash';

/** A frame-supplied end time, so `endedAt` can be read off the frame, not a clock. */
const COMPLETED_END_TIME = 1_759_277_000_000;

/** Prints a reading, so both the green main case and the red false form are visible. */
function say(message: string): void {
  process.stdout.write(`[task-reducer] ${message}\n`);
}

// ------------------------------------------------------------- frame builders --

/** §1.1 (12.1): a background agent. `parent_tool_use_id` is null on the top task. */
function subagentStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: SUBAGENT_ID,
    tool_use_id: SUBAGENT_TOOL,
    parent_tool_use_id: null,
    task_type: 'local_agent',
    subagent_type: 'general-purpose',
    description: 'Run the background agent',
    uuid: 'u-start-subagent',
    session_id: SESSION,
  };
}

/** §1.2 (50.8): the subagent's own Bash — nested, its parent is the Agent call. */
function innerBashStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: INNER_BASH_ID,
    tool_use_id: INNER_BASH_TOOL,
    parent_tool_use_id: SUBAGENT_TOOL,
    task_type: 'local_bash',
    description: 'sleep 12',
    uuid: 'u-start-inner-bash',
    session_id: SESSION,
  };
}

/** §1.1 (59.8): the nested Bash completes. */
function innerBashCompleted(): Frame {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: INNER_BASH_ID,
    status: 'completed',
    summary: 'inner bash done',
    uuid: 'u-notification-inner-bash',
    session_id: SESSION,
  };
}

/** §1.5/§9.5: a subagent's `task_progress` describes its last action, not a step. */
function subagentProgress(description: string): Frame {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: SUBAGENT_ID,
    description,
    uuid: 'u-progress-subagent',
    session_id: SESSION,
  };
}

/** §1.1 (62.5): the subagent completes (a `task_updated` plus a `task_notification`). */
function subagentCompleted(): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: SUBAGENT_ID,
    patch: { status: 'completed' },
    uuid: 'u-updated-subagent',
    session_id: SESSION,
  };
}

/** §1.1 (12.8): a background Bash. */
function backgroundBashStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: BG_BASH_ID,
    tool_use_id: 'toolu_bg_bash',
    task_type: 'local_bash',
    description: 'loop 3x sleep 4',
    uuid: 'u-start-bg-bash',
    session_id: SESSION,
  };
}

/** §1.1 (25.4)/(e): the background Bash ends with only a `task_updated` — no notification. */
function backgroundBashCompleted(): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: BG_BASH_ID,
    patch: { status: 'completed', end_time: COMPLETED_END_TIME },
    uuid: 'u-updated-bg-bash',
    session_id: SESSION,
  };
}

/**
 * §1.1 (26.6): a Monitor is itself a task, and the capture shows its `task_type`
 * as `local_bash` — so on the frame path it reduces to `kind:'shell'`. The
 * `monitor` kind is only reachable through the Stop hook's `type:'monitor'`
 * label, which AC7 exercises.
 */
function monitorStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: MONITOR_ID,
    task_type: 'local_bash',
    description: 'Monitor task',
    uuid: 'u-start-monitor',
    session_id: SESSION,
  };
}

/** §1.1 (86.7) / §9.3: the Monitor is killed when its 60s timeout fires. */
function monitorKilled(): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: MONITOR_ID,
    patch: { status: 'killed' },
    uuid: 'u-updated-monitor',
    session_id: SESSION,
  };
}

/** The `task_notification{status:'stopped'}` that accompanies the kill. */
function monitorStoppedNotification(): Frame {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: MONITOR_ID,
    status: 'stopped',
    summary: 'Monitor timed out',
    uuid: 'u-notification-monitor',
    session_id: SESSION,
  };
}

/** §1.3: a workflow run. */
function workflowStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: WORKFLOW_ID,
    tool_use_id: 'toolu_workflow',
    task_type: 'local_workflow',
    workflow_name: 'simple-workflow-ok',
    description: 'Run the workflow',
    uuid: 'u-start-workflow',
    session_id: SESSION,
  };
}

/** §1.3: `task_progress.description` is the workflow's current step label. */
function workflowProgress(description: string): Frame {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: WORKFLOW_ID,
    description,
    uuid: `u-progress-${description}`,
    session_id: SESSION,
  };
}

/** §9.3: the plain foreground `tool_use` — deliberately **not** a task. */
function frontBashToolUse(): Frame {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: FRONT_BASH_TOOL, name: 'Bash', input: {} }],
    },
    parent_tool_use_id: null,
    uuid: 'u-tool-front-bash',
    session_id: SESSION,
  };
}

/** §9.3: the `task_started` the CLI emits when the foreground Bash is backgrounded. */
function frontBashStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: FRONT_BASH_ID,
    tool_use_id: FRONT_BASH_TOOL,
    task_type: 'local_bash',
    description: 'python3 -c "import time; time.sleep(20)"',
    uuid: 'u-start-front-bash',
    session_id: SESSION,
  };
}

/** §9.3: the `task_updated` that flips `is_backgrounded` on the same instant. */
function frontBashBackgrounded(): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: FRONT_BASH_ID,
    patch: { is_backgrounded: true },
    uuid: 'u-updated-front-bash',
    session_id: SESSION,
  };
}

/** The whole captured run, in arrival order, for the replay reading (AC8). */
function capturedFrameSequence(): Frame[] {
  return [
    subagentStarted(),
    backgroundBashStarted(),
    backgroundBashCompleted(),
    monitorStarted(),
    subagentProgress('Running sleep 12'),
    innerBashStarted(),
    innerBashCompleted(),
    subagentCompleted(),
    workflowStarted(),
    workflowProgress('Say OK: say-ok'),
    workflowProgress('Say OK: done'),
    frontBashToolUse(),
    frontBashStarted(),
    frontBashBackgrounded(),
    monitorKilled(),
    monitorStoppedNotification(),
  ];
}

// ------------------------------------------------------------ reading helpers --

/** The state of one task in one session's table, or `null` when it is absent. */
function taskState(reducer: ClaudeTaskReducer, sessionId: string, taskId: string): TaskState | null {
  const task = reducer.getTasks(sessionId).find((candidate) => candidate.taskId === taskId);
  return task ? task.state : null;
}

function taskOf(reducer: ClaudeTaskReducer, taskId: string): ActivityTask | undefined {
  return reducer.getTasks(SESSION).find((candidate) => candidate.taskId === taskId);
}

/**
 * (b) The reading both the main case and its false form share: feed the Monitor
 * start, the kill and the notification, and record the state right after the
 * kill and right after the notification.
 *
 * The kill pair is same-instant in the record, and the correct reducer reduces
 * both frames to `stopped`; a reducer that mapped `killed → failed` would still
 * be visible in `afterKill`, which is why both readings are returned.
 */
type MonitorTimeoutReading = { afterKill: TaskState | null; afterNotification: TaskState | null };

function readMonitorTimeout(reducer: ClaudeTaskReducer): MonitorTimeoutReading {
  reducer.observe(SESSION, monitorStarted());
  reducer.observe(SESSION, monitorKilled());
  const afterKill = taskState(reducer, SESSION, MONITOR_ID);
  reducer.observe(SESSION, monitorStoppedNotification());
  const afterNotification = taskState(reducer, SESSION, MONITOR_ID);
  return { afterKill, afterNotification };
}

/**
 * (d) The reading both the main case and its false form share: feed the plain
 * foreground `tool_use` (asking how many tasks the table holds for that tool),
 * then the backgrounding pair (asking how many, and whether the flag is set).
 */
type FrontBashReading = {
  beforeBackground: number;
  afterBackground: number;
  isBackgrounded: boolean | null;
};

function readFrontBashBackgrounding(reducer: ClaudeTaskReducer): FrontBashReading {
  reducer.observe(SESSION, frontBashToolUse());
  const beforeBackground = reducer
    .getTasks(SESSION)
    .filter((task) => task.toolUseId === FRONT_BASH_TOOL).length;

  reducer.observe(SESSION, frontBashStarted());
  reducer.observe(SESSION, frontBashBackgrounded());
  const after = reducer.getTasks(SESSION).filter((task) => task.toolUseId === FRONT_BASH_TOOL);
  return {
    beforeBackground,
    afterBackground: after.length,
    isBackgrounded: after[0] ? after[0].isBackgrounded : null,
  };
}

// ------------------------------------------------------------------- AC2 (a) --

test('AC2 a nested task recovers its parent from parent_tool_use_id', () => {
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, subagentStarted());
  reducer.observe(SESSION, innerBashStarted());

  const parent = taskOf(reducer, SUBAGENT_ID);
  const child = taskOf(reducer, INNER_BASH_ID);
  assert.ok(parent, 'the subagent task exists');
  assert.ok(child, 'the nested Bash task exists');
  assert.equal(parent.toolUseId, SUBAGENT_TOOL);
  assert.equal(child.parentTaskId, parent.taskId, 'the child points at the task owning its parent tool_use');
  assert.equal(child.parentTaskId, SUBAGENT_ID);
});

// --------------------------------------------------------------- AC3 (b) -----

test('AC3 a killed Monitor is stopped, not failed', () => {
  const reading = readMonitorTimeout(createClaudeTaskReducer());
  say(`(b) reading: afterKill=${String(reading.afterKill)} afterNotification=${String(reading.afterNotification)}`);

  assert.equal(reading.afterKill, 'stopped', 'task_updated{killed} is a stop, not an error');
  assert.notEqual(reading.afterKill, 'failed');
  assert.equal(reading.afterNotification, 'stopped', 'the paired notification agrees');
});

test('a stopped task carries no timestamp the frames never supplied', () => {
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, monitorStarted());
  reducer.observe(SESSION, monitorKilled());
  reducer.observe(SESSION, monitorStoppedNotification());

  const monitor = taskOf(reducer, MONITOR_ID);
  assert.ok(monitor);
  assert.equal('startedAt' in monitor, false, 'no frame carried a start time, so none may be invented');
  assert.equal('endedAt' in monitor, false, 'no frame carried an end time, so none may be invented');
});

// --------------------------------------------------------------- AC4 (c) -----

test('AC4 a workflow task carries its name and its latest step label', () => {
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, workflowStarted());
  reducer.observe(SESSION, workflowProgress('Say OK: say-ok'));
  reducer.observe(SESSION, workflowProgress('Say OK: done'));

  const workflow = taskOf(reducer, WORKFLOW_ID);
  assert.ok(workflow);
  assert.equal(workflow.kind, 'workflow');
  assert.equal(workflow.workflowName, 'simple-workflow-ok');
  assert.equal(workflow.stepLabel, 'Say OK: done', 'the most recent progress wins');
});

// --------------------------------------------------------------- AC5 (d) -----

test('AC5 a foreground tool is not a task until it is backgrounded', () => {
  const reading = readFrontBashBackgrounding(createClaudeTaskReducer());
  say(
    `(d) reading: beforeBackground=${reading.beforeBackground} afterBackground=${reading.afterBackground} ` +
      `isBackgrounded=${String(reading.isBackgrounded)}`,
  );

  assert.equal(reading.beforeBackground, 0, 'an assistant tool_use is never a task on its own');
  assert.equal(reading.afterBackground, 1, 'backgrounding creates the task');
  assert.equal(reading.isBackgrounded, true, 'the backgrounding flag is carried');
});

// --------------------------------------------------------------- AC6 (e) -----

test('AC6 a background Bash that only updates to completed still terminates', () => {
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, backgroundBashStarted());
  reducer.observe(SESSION, backgroundBashCompleted());

  const task = taskOf(reducer, BG_BASH_ID);
  assert.ok(task);
  assert.equal(task.state, 'completed', 'task_updated alone is a terminal state');
  assert.equal(task.endedAt, COMPLETED_END_TIME, 'the end time comes from the frame, not a clock');
});

// --------------------------------------------------------------- AC7 (f) -----

test('AC7 the Stop hook snapshot ends vanished tasks and backfills unseen ones', () => {
  const reducer = createClaudeTaskReducer();
  // A subagent that started and is still running when the turn ends.
  reducer.observe(SESSION, subagentStarted());
  assert.equal(taskState(reducer, SESSION, SUBAGENT_ID), 'running');

  const snapshotTaskId = 'stop-hook-monitor-1';
  const snapshot: BackgroundTaskSummary[] = [
    {
      id: snapshotTaskId,
      type: 'monitor',
      status: 'running',
      description: 'Monitor polling',
      tool: 'Bash',
    },
  ];
  reducer.reconcileStopHook(SESSION, snapshot);

  const vanished = taskOf(reducer, SUBAGENT_ID);
  assert.ok(vanished);
  assert.equal(vanished.state, 'ended', 'a running task the snapshot no longer names is over');
  assert.equal(vanished.endReason, 'unknown', 'and the cause is the unknown one');

  const backfilled = taskOf(reducer, snapshotTaskId);
  assert.ok(backfilled, 'a snapshot task the events never saw is backfilled');
  assert.equal(backfilled.origin, 'stop-hook-snapshot');
  assert.equal(backfilled.kind, 'monitor');
  assert.equal(backfilled.state, 'running');

  // The same snapshot again is a no-op: the reduction overwrites keys, never appends.
  const afterFirstReconcile = reducer.getTasks(SESSION);
  reducer.reconcileStopHook(SESSION, snapshot);
  assert.deepEqual(reducer.getTasks(SESSION), afterFirstReconcile);
});

// --------------------------------------------------------------- AC8 (g) -----

test('AC8 replaying the captured sequence reduces to the same table', () => {
  const sequence = capturedFrameSequence();

  const replayed = createClaudeTaskReducer();
  for (const frame of sequence) {
    replayed.observe(SESSION, frame);
  }
  const first = replayed.getTasks(SESSION);
  for (const frame of sequence) {
    replayed.observe(SESSION, frame);
  }
  assert.deepEqual(replayed.getTasks(SESSION), first, 'same-instance replay is idempotent');

  const instanceA = createClaudeTaskReducer();
  const instanceB = createClaudeTaskReducer();
  for (const frame of sequence) {
    instanceA.observe(SESSION, frame);
  }
  for (const frame of sequence) {
    instanceB.observe(SESSION, frame);
  }
  assert.deepEqual(instanceA.getTasks(SESSION), instanceB.getTasks(SESSION), 'two fresh instances agree');
  assert.deepEqual(instanceA.getTasks(SESSION), first);
});

// --------------------------------------------------------------- AC9 (h) -----

test('AC9 two sessions fed interleaved frames never read each other', () => {
  const sessionA = 'claude-activity-task-a';
  const sessionB = 'claude-activity-task-b';
  const reducer = createClaudeTaskReducer();

  reducer.observe(sessionA, subagentStarted());
  reducer.observe(sessionB, backgroundBashStarted());
  reducer.observe(sessionA, innerBashStarted());

  const aIds = reducer.getTasks(sessionA).map((task) => task.taskId);
  const bIds = reducer.getTasks(sessionB).map((task) => task.taskId);
  assert.deepEqual(aIds, [SUBAGENT_ID, INNER_BASH_ID]);
  assert.deepEqual(bIds, [BG_BASH_ID]);
  assert.ok(!aIds.includes(BG_BASH_ID), 'session A must not see B');
  assert.ok(!bIds.includes(SUBAGENT_ID), 'session B must not see A');
  assert.ok(!bIds.includes(INNER_BASH_ID), 'session B must not see A’s nested task');
  assert.deepEqual(reducer.getTasks('claude-activity-task-c'), [], 'an unobserved session is empty');
});

// -------------------------------------------------------------- AC10 (arms) --

test('AC10 false form (b): a reducer that calls killed “failed” reds the (b) reading', () => {
  const miswired = createClaudeTaskReducer({
    mapUpdatedStatus: (status) => (status === 'killed' ? 'failed' : mapUpdatedStatus(status)),
  });
  const reading = readMonitorTimeout(miswired);
  say(
    `(b) false form reading: afterKill=${String(reading.afterKill)} ` +
      `afterNotification=${String(reading.afterNotification)} (main case expects stopped)`,
  );

  // The main case's own assertion, applied to the variant, must throw — otherwise
  // `state === 'stopped'` was never discriminating.
  assert.throws(
    () => {
      assert.equal(reading.afterKill, 'stopped');
    },
    'a killed-as-failed reducer must red the (b) reading',
  );
  assert.equal(reading.afterKill, 'failed');
});

test('AC10 false form (d): a reducer that builds on tool_use reds the (d) reading', () => {
  const miswired = createClaudeTaskReducer({ taskOnToolUse: true });
  const reading = readFrontBashBackgrounding(miswired);
  say(
    `(d) false form reading: beforeBackground=${reading.beforeBackground} ` +
      `(main case expects 0) afterBackground=${reading.afterBackground} ` +
      `isBackgrounded=${String(reading.isBackgrounded)}`,
  );

  assert.throws(
    () => {
      assert.equal(reading.beforeBackground, 0);
    },
    'a tool_use-builds-a-task reducer must red the (d) reading',
  );
  assert.equal(reading.beforeBackground, 1);
});

// -------------------------------------------------------- the whole sequence -

test('the captured sequence reduces to one table with the expected terminal states', () => {
  const reducer = createClaudeTaskReducer();
  for (const frame of capturedFrameSequence()) {
    reducer.observe(SESSION, frame);
  }

  const byId = new Map(reducer.getTasks(SESSION).map((task) => [task.taskId, task]));
  assert.deepEqual(
    [...byId.keys()],
    [SUBAGENT_ID, BG_BASH_ID, MONITOR_ID, INNER_BASH_ID, WORKFLOW_ID, FRONT_BASH_ID],
    'one row per task the SDK named, in first-seen order',
  );
  assert.equal(byId.get(SUBAGENT_ID)?.state, 'completed');
  assert.equal(byId.get(BG_BASH_ID)?.state, 'completed');
  assert.equal(byId.get(MONITOR_ID)?.state, 'stopped');
  assert.equal(byId.get(INNER_BASH_ID)?.state, 'completed');
  assert.equal(byId.get(INNER_BASH_ID)?.parentTaskId, SUBAGENT_ID);
  assert.equal(byId.get(WORKFLOW_ID)?.state, 'running');
  assert.equal(byId.get(WORKFLOW_ID)?.stepLabel, 'Say OK: done');
  assert.equal(byId.get(FRONT_BASH_ID)?.state, 'running');
  assert.equal(byId.get(FRONT_BASH_ID)?.isBackgrounded, true);
});
