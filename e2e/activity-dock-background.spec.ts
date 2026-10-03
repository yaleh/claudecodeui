/**
 * AC-194 — the activity dock shows background work, on a real browser against a real server.
 *
 * What this file is *for*. A debug-agent scenario's clock writes task-lifecycle rows and a `CronCreate`
 * plan; the product's own run loop reduces them (the Task table, AC-191, and the Schedule table,
 * AC-192); the activity protocol (AC-193) carries the session's whole snapshot to a subscribed
 * browser. This file reads the four surfaces that fact lands on, each as a *reading that could have
 * gone the other way*:
 *
 *   - the dock's summary counters (task count, plan count) equal the snapshot's;
 *   - the expanded panel lists every task (description, state, elapsed, last action) and every plan
 *     (expression, countdown, prompt);
 *   - a task's state changes **without a navigation** when the clock settles it, and *survives a
 *     reload* restored from the server's snapshot;
 *   - the transcript's Agent and Bash card headers read the Task entity by `tool_use` id, so their
 *     state moves when the task does — not from whether a result row happens to be folded in;
 *   - a plan row renders no cancel control (selector count zero, by construction).
 *
 * Why the session is opened after the clock. The control plane's clock opens a *per-run* run whose writer
 * has no socket attached at open time (`openUnattendedRun` starts with `connection: null`), so a page that
 * subscribed *before* the walk does not receive its transcript frames live. Opening the session after the
 * clock has started makes the subscribe land while the run is in flight, so the socket attaches and the
 * client replays/fetches the rows written so far — which is how the cards and their running task states
 * come on screen. Everything after that (the terminal upserts) arrives live, which is exactly the reading
 * AC-194's "changes without a reload" pins. The measured window opens after the session is open and sees
 * no navigation.
 */

import path from 'node:path';

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

const PANE = '.chat-messages-pane';
const DOCK_TOGGLE = '[data-activity-dock-toggle]';
const PANEL = '[data-activity-dock-panel]';
const TASK_ROW = '[data-activity-task-row]';
const SCHEDULE_ROW = '[data-activity-schedule-row]';
const CARD_TASK_STATE = '[data-card-task-state]';
const CARD_FOLDED_STATUS = '[data-card-folded-status]';

const USERNAME = 'activity-dock-background-e2e';
const PASSWORD = 'activity-dock-background-e2e-pass';
const TITLE = 'Activity dock background — task and plan arm';
const SEED_USER_TEXT = 'seeded user turn for the activity-dock background criterion';

const TASK_AGENT = 'task-agent';
const TASK_SHELL = 'task-shell';

/**
 * The background-work walk.
 *
 * A `Task` call and a `Bash` call become the two transcript cards, each separated from its neighbours by an
 * assistant text row so it renders inline as a singleton rather than being folded into a collapsed work
 * segment; each is followed by a `task-started` that joins the task to the call's `tool_use` id (minted by
 * the engine, never named here). A `CronCreate` call/result pair becomes the plan. The two tasks start
 * early and settle late (7s / 7.5s) so there is a wide window in which the panel and the cards read
 * `running` before the terminal frames arrive — the window the "changes without a reload" arm reads
 * across. The walk writes eleven rows.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT, lifecycleMode: 'per-run' },
  steps: [
    { at: 0, op: 'tool-call', name: 'Task' },
    { at: 300, op: 'task-started', taskId: TASK_AGENT, taskType: 'local_agent', description: 'Explore the repo' },
    { at: 600, op: 'task-progress', taskId: TASK_AGENT, description: 'reading files' },
    { at: 800, op: 'row', role: 'assistant', text: 'Started the exploration agent.' },
    { at: 1_000, op: 'tool-call', name: 'Bash' },
    { at: 1_200, op: 'task-started', taskId: TASK_SHELL, taskType: 'local_bash', description: 'Long build' },
    { at: 1_400, op: 'row', role: 'assistant', text: 'And a background build.' },
    { at: 1_600, op: 'schedule-plan', expression: '*/2 * * * *', human: 'Every 2 minutes', prompt: 'check the queue' },
    { at: 2_000, op: 'wait' },
    { at: 3_600, op: 'task-updated', taskId: TASK_AGENT, status: 'completed' },
    { at: 3_800, op: 'task-notification', taskId: TASK_SHELL, status: 'completed', summary: 'build done' },
    { at: 4_400, op: 'wait' },
  ],
  expect: { rows: { delta: 11 }, content: { mustContain: [SEED_USER_TEXT] } },
};

// ---------------------------------------------------------------------------------------------
// The wire, read by this file rather than through the page.
// ---------------------------------------------------------------------------------------------

type ActivitySnapshot = {
  sessionId?: string;
  rev?: number;
  tasks?: Array<{ taskId: string; state: string; description?: string }>;
  schedules?: Array<{ scheduleId: string; spec?: string }>;
};

type HostsSnapshot = { hosts: Array<{ bindings: Array<{ appSessionId: string; leases?: unknown[] }> }> };

/** `GET /api/session-hosts`, as this file reads it — the poll source the panel must NOT be drawn from. */
async function readHosts(api: APIRequestContext): Promise<HostsSnapshot> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/session-hosts answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  return { hosts: body?.data?.hosts ?? [] };
}

/** `GET /api/sessions/:id/activity` — the snapshot the panel and the dock are drawn from. */
async function readActivitySnapshot(api: APIRequestContext, sessionId: string): Promise<{
  status: number;
  snapshot: ActivitySnapshot | null;
}> {
  const response = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/activity`);
  const body = await response.json().catch(() => null);
  return { status: response.status(), snapshot: (body as ActivitySnapshot | null) ?? null };
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator =>
  page.locator(`a[href="/session/${sessionId}"]`).first();

async function explain(page: Page, what: string): Promise<never> {
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`${what}; the page held:\n${body.slice(0, 2_000)}`);
}

/** Expands the fixture project until the session's row is on screen. Bounded, and never silent. */
async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  await explain(page, `the sidebar never showed a row for session ${sessionId}`);
}

/** Creates (or signs in) the fixture account and returns its bearer token. */
async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', { headers: { Authorization: `Bearer ${registered.token}` } });
    return registered.token;
  }
  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(`could not create or sign in as ${USERNAME}: ${register.status()} ${JSON.stringify(registered)}`);
  }
  return loggedIn.token;
}

/** Arms one scenario and returns the session id the rest of this file addresses it by. */
async function armScenario(api: APIRequestContext, projectPath: string, scenario: unknown): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return sessionId;
}

/** The panel's readings, straight off the DOM. */
async function readPanel(page: Page): Promise<{
  tasks: Array<{ id: string | null; state: string | null; description: string; elapsed: string; lastAction: string }>;
  plans: Array<{ id: string | null; expression: string; countdown: string; prompt: string }>;
}> {
  const tasks = await page.locator(TASK_ROW).evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute('data-task-id'),
      state: row.getAttribute('data-task-state'),
      description: row.querySelector('[data-task-description]')?.textContent?.trim() ?? '',
      elapsed: row.querySelector('[data-task-elapsed]')?.textContent?.trim() ?? '',
      lastAction: row.querySelector('[data-task-last-action]')?.textContent?.trim() ?? '',
    })),
  );
  const plans = await page.locator(SCHEDULE_ROW).evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute('data-schedule-id'),
      expression: row.querySelector('[data-schedule-expression]')?.textContent?.trim() ?? '',
      countdown: row.querySelector('[data-schedule-countdown]')?.textContent?.trim() ?? '',
      prompt: row.querySelector('[data-schedule-prompt]')?.textContent?.trim() ?? '',
    })),
  );
  return { tasks, plans };
}

/** The cards' task-driven states, one per card that reads a Task entity. */
async function readCardTaskStates(page: Page): Promise<string[]> {
  return (await page.locator(CARD_TASK_STATE).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-card-task-state') ?? ''),
  )).filter((value) => value.length > 0).sort();
}

/** The cards' transcript-own (folded-row) states — the reading the false form would use instead. */
async function readCardFoldedStates(page: Page): Promise<string[]> {
  return (await page.locator(CARD_FOLDED_STATUS).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-card-folded-status') ?? ''),
  )).sort();
}

test.describe.configure({ mode: 'serial' });

test.describe('activity dock background', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let sessionId = '';
  let navigations = 0;

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT');

    workspace = path.join(fixtureHome, 'activity-dock-background-workspace');
    const workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    sessionId = await armScenario(api, workspace, SCENARIO);

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', 'en');
      },
      { key: 'auth-token', value: token },
    );
    page = await context.newPage();
    page.on('pageerror', (error) => console.log(`[e2e] pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[e2e] console.error: ${message.text()}`);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });

    // The first load lands on the sidebar; a cold Vite optimize can replace the document whole, so one
    // bounded reload covers that replay without turning "not landed" into a pass. The session row is
    // revealed but *not* opened here: the test opens it after the clock starts, so the subscribe that
    // mounts the session view lands while the run is already in flight and attaches the live stream.
    await page.goto('/');
    if (!(await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
      await page.reload();
    }
    await revealSession(page, workspaceName, sessionId);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('AC-194 background work reaches the dock, changes without a reload, and restores from a snapshot', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);

    // Fire the walk without awaiting it: the readings below happen while it is in flight. The response is
    // awaited at the very end, for the one fact only it carries — that the walk completed.
    const clock = api
      .post('/api/debug-agent/clock', { data: { sessionId } })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { success?: boolean; error?: unknown } | null;
        console.log(`clock.status=${response.status()} clock.body=${JSON.stringify(body).slice(0, 400)}`);
        return { ok: response.ok(), status: response.status(), body };
      })
      .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));

    // Let the run open and write its first rows, then open the session: the subscribe that mounts the
    // view lands while the run is in flight, so the socket attaches and the client replays/fetches the
    // rows written so far. This is before the measured window; from here on the panel and the cards must
    // move with the frames alone.
    await page.waitForTimeout(500);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    // The transcript renders each card inline: an assistant text row separates the calls, so no two work
    // rows are adjacent and each is a singleton rather than a folded work segment.
    const preSnapshot = await readActivitySnapshot(api, sessionId);
    console.log(`diag.snapshot.status=${preSnapshot.status} snapshot.tasks=${preSnapshot.snapshot?.tasks?.length} snapshot.plans=${preSnapshot.snapshot?.schedules?.length}`);
    console.log(`diag.dockToggleCount=${await page.locator(DOCK_TOGGLE).count()} diag.cardCount=${await page.locator(CARD_TASK_STATE).count()} diag.foldedCount=${await page.locator(CARD_FOLDED_STATUS).count()}`);

    // The cards and the plan come on screen as the run streams; the dock's counter makes the panel
    // reachable.
    await expect(page.locator(DOCK_TOGGLE)).toBeVisible({ timeout: 25_000 });
    await page.locator(DOCK_TOGGLE).click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(TASK_ROW)).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(SCHEDULE_ROW)).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(CARD_TASK_STATE)).toHaveCount(2, { timeout: 8_000 });

    const running = await readPanel(page);
    const runningCards = await readCardTaskStates(page);
    console.log(`running.tasks=${JSON.stringify(running.tasks)}`);
    console.log(`running.plans=${JSON.stringify(running.plans)}`);
    console.log(`running.cardTaskStates=${JSON.stringify(runningCards)} at +${Date.now() - runStartedAt}ms`);
    expect(running.tasks.map((task) => task.state).sort()).toEqual(['running', 'running']);
    expect(runningCards, 'the cards must read the running task states before the terminal frames').toEqual(['running', 'running']);

    // --- AC3: the dock summary counters agree with the snapshot --------------------------------
    const dockTaskCount = await page.locator('[data-activity-task-count]').getAttribute('data-activity-task-count');
    const dockScheduleCount = await page.locator('[data-activity-schedule-count]').getAttribute('data-activity-schedule-count');
    const { status: snapStatus, snapshot } = await readActivitySnapshot(api, sessionId);
    console.log(`dock.counts=${dockTaskCount}/${dockScheduleCount} snapshot.status=${snapStatus} snapshot.tasks=${snapshot?.tasks?.length} snapshot.plans=${snapshot?.schedules?.length}`);
    expect(snapStatus).toBe(200);
    expect(Number(dockTaskCount)).toBe(snapshot?.tasks?.length);
    expect(Number(dockScheduleCount)).toBe(snapshot?.schedules?.length);
    expect(snapshot?.tasks?.length).toBe(2);
    expect(snapshot?.schedules?.length).toBe(1);

    // --- AC4: four readings per task row -------------------------------------------------------
    for (const task of running.tasks) {
      expect(task.description.length, 'a task row must carry its description').toBeGreaterThan(0);
      expect(task.elapsed.length, 'a task row must carry an elapsed reading').toBeGreaterThan(0);
      expect(task.lastAction.length, 'a task row must carry a last-action reading').toBeGreaterThan(0);
    }

    // --- AC5: three readings per plan row ------------------------------------------------------
    const plan = running.plans[0];
    expect(plan.expression, 'the plan row must show the expression').toContain('Every');
    expect(plan.countdown, 'the plan row must show a next-fire countdown').toMatch(/^\d/);
    expect(plan.prompt, 'the plan row must show the prompt').toBe('check the queue');

    // --- AC9: a plan has no control at all -----------------------------------------------------
    const cancelControls = await page.locator('[data-schedule-cancel]').count();
    console.log(`plan.cancelControls=${cancelControls}`);
    expect(cancelControls, 'a plan row must render no cancel control').toBe(0);

    // --- AC6: the state changes without a reload -----------------------------------------------
    // The measured window opens here: no navigation may happen between now and the terminal reading.
    navigations = 0;
    await expect(page.locator(`${TASK_ROW}[data-task-state="completed"]`)).toHaveCount(2, { timeout: 20_000 });
    const settled = await readPanel(page);
    await expect(page.locator(CARD_TASK_STATE)).toHaveCount(2, { timeout: 8_000 });
    const settledCards = await readCardTaskStates(page);
    console.log(`settled.tasks=${JSON.stringify(settled.tasks.map((task) => task.state))} settled.cards=${JSON.stringify(settledCards)}`);
    expect(settled.tasks.map((task) => task.state).sort()).toEqual(['completed', 'completed']);
    expect(navigations, 'the state must change without a navigation').toBe(0);

    // --- AC8: the card header reads the Task entity, and moves with it ---------------------------
    // The folded-row reading is the negative control: for a task whose result row never arrived it is
    // still `running`, while the task-driven reading is terminal. A card that inferred state from the
    // folded row would read `running` here and fail the assertion above.
    const foldedStates = await readCardFoldedStates(page);
    console.log(`settled.cardTaskStates=${JSON.stringify(settledCards)} settled.cardFoldedStates=${JSON.stringify(foldedStates)}`);
    expect(settledCards, 'the card headers must have moved to the terminal task state').toEqual(['completed', 'completed']);
    expect(runningCards, 'the card headers must have been running before the terminal frames').not.toEqual(settledCards);
    expect(foldedStates.every((value) => value === 'running'), 'the folded-row reading must still be running').toBe(true);

    // --- AC7: a fresh load restores the panel from the snapshot ---------------------------------
    const beforeReload = await readPanel(page);
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    // The restored dock must show the counts again (the snapshot path), so the panel is reachable.
    await expect(page.locator(DOCK_TOGGLE)).toBeVisible({ timeout: 25_000 });
    await page.locator(DOCK_TOGGLE).click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(TASK_ROW)).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator(SCHEDULE_ROW)).toHaveCount(1, { timeout: 15_000 });
    const restored = await readPanel(page);
    console.log(`restored.tasks=${JSON.stringify(restored.tasks.map((task) => task.id))} restored.plans=${JSON.stringify(restored.plans.map((plan) => plan.id))}`);
    expect(restored.tasks.map((task) => task.id).sort()).toEqual(beforeReload.tasks.map((task) => task.id).sort());
    expect(restored.plans.map((plan) => plan.id)).toEqual(beforeReload.plans.map((plan) => plan.id));
    // The restore comes from the activity snapshot, not the session-hosts poll.
    const afterReloadSnapshot = await readActivitySnapshot(api, sessionId);
    expect(afterReloadSnapshot.status).toBe(200);
    expect(afterReloadSnapshot.snapshot?.tasks?.length).toBe(2);
    expect(afterReloadSnapshot.snapshot?.schedules?.length).toBe(1);

    // --- AC11(2): the panel is not drawn from the session-hosts poll ----------------------------
    // The poll source carries host leases, not tasks or plans — a panel driven by it could not show
    // these rows. Proven by reading the listing and showing it has no task rows while the panel does.
    const hosts = await readHosts(api);
    const listingLeases = hosts.hosts
      .flatMap((host) => host.bindings)
      .filter((binding) => binding.appSessionId === sessionId)
      .flatMap((binding) => binding.leases ?? []);
    console.log(`falseForm2.sessionHostsLeases=${listingLeases.length} falseForm2.panelRows=${restored.tasks.length + restored.plans.length}`);
    expect(restored.tasks.length + restored.plans.length, 'the panel is drawn from the snapshot and carries rows').toBe(3);
    expect(listingLeases.length, 'the session-hosts poll carries no task/schedule rows').toBe(0);

    // --- The walk itself completed --------------------------------------------------------------
    const clockBody = await clock;
    expect(clockBody.ok, `the walk must complete: ${JSON.stringify(clockBody)}`).toBe(true);
    expect(clockBody.body?.success, `the walk must report success: ${JSON.stringify(clockBody.body)}`).toBe(true);

    // --- AC1: the wall clock ------------------------------------------------------------------
    const elapsedMs = Date.now() - runStartedAt;
    console.log(`AC-194 wall clock: ${elapsedMs}ms`);
    expect(elapsedMs, 'the criterion must complete within 40s').toBeLessThanOrEqual(40_000);
  });
});
