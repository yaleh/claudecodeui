/**
 * The background-task strip — read off a real browser against a real server, driven by the debug
 * agent's own scenario clock.
 *
 * What this file is *for*. The defect is that a background task used to be visible only if the model
 * wrote about it: the work is a fact about the host process, but the only surface that carried it was
 * prose the model chose to emit, so a silent model left the page with nothing. This criterion reads
 * the two surfaces that now carry it — the transcript strip the session view draws, and the
 * `/api/session-hosts` listing it polls — and their *agreement* is the measurement: the row count the
 * page shows is compared against the same session's held-work lease count, read from the endpoint at
 * the same instant, so a strip that invented or hid rows has something to disagree with.
 *
 * Why the debug agent. The alternative is a real `claude` process holding a `run_in_background` call,
 * and a criterion that needs one cannot run where the binary is absent. `POST /api/debug-agent/clock`
 * walks a scenario instead: the same product chain (host manager → listing route → the shared
 * snapshot hook → the strip) with the child process replaced by a scripted clock, so a lease can be
 * opened, held and released at a moment this file chooses. The gate that mounts that face is opened
 * by `playwright.config.ts` for exactly this file's selection. Crucially, the scenario writes **no
 * assistant rows** — the model says nothing about the work — which is the negative control this
 * criterion turns on.
 *
 * Why the clock is not awaited where it is fired. `POST /clock` blocks for the whole walk; every
 * reading below happens *while* the walk is in flight, which is the only place the held state exists.
 * The response is awaited at the end, for the one fact only it carries: whether the seam that opens
 * runs was wired.
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

/** The chat pane, the same anchor the sibling resident specs use to know a session opened. */
const PANE = '.chat-messages-pane';
/** The resident pill, the positive signal that the session's own host reads `resident`. */
const BADGE = '[data-resident-badge]';
/** The pill's Start control, behind the panel it opens. */
const START = '[data-resident-start]';
const STRIP = '[data-background-task-strip]';
const UNKNOWN_STRIP = '[data-background-task-strip="unknown"]';
const ROW = '[data-background-task-row]';

const USERNAME = 'background-task-strip-e2e';
const PASSWORD = 'background-task-strip-e2e-pass';
const TITLE = 'Background task strip — held-work arm';
const SEED_USER_TEXT = 'seeded user turn for the background-task strip criterion';

/**
 * The held-work walk.
 *
 * Two leases are opened and held together (offsets 1000–2000), plateaus wide enough for the one
 * second listing poll to land inside, and released one after another at 12s and 13s — the window the
 * strip must go quiet in. The walk writes no rows of its own (`rows: { delta: 0 }`), so the work is
 * real on the host while the transcript stays silent about it.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: 'peer-background-task-strip' },
    { at: 1_000, op: 'keepalive-add', kind: 'background-task' },
    { at: 2_000, op: 'keepalive-add', kind: 'monitor' },
    { at: 12_000, op: 'keepalive-remove', kind: 'background-task' },
    { at: 13_000, op: 'keepalive-remove', kind: 'monitor' },
    { at: 14_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

// ---------------------------------------------------------------------------------------------
// The wire, read by this file rather than through the page.
// ---------------------------------------------------------------------------------------------

type HostLease = { kind: string; id?: string; since?: unknown };
type HostBinding = { appSessionId: string; leases?: HostLease[] };
type HostRecord = { hostId: string; state: string; bindings: HostBinding[] };
type HostsSnapshot = { hosts: HostRecord[]; sessions: Array<{ appSessionId: string }> };

/** The live host holding one session, or null. Closed hosts are skipped, as the frontend skips them. */
function liveHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  for (const host of snapshot.hosts) {
    if (host.state === 'closed') continue;
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) return host;
  }
  return null;
}

/** The session's binding on its live host, or null. */
function liveBinding(snapshot: HostsSnapshot, sessionId: string): HostBinding | null {
  return liveHost(snapshot, sessionId)?.bindings.find((binding) => binding.appSessionId === sessionId) ?? null;
}

/** The held-work leases the strip draws a row for: `background-task` and `monitor`. */
function heldWorkLeases(snapshot: HostsSnapshot, sessionId: string): HostLease[] {
  return (liveBinding(snapshot, sessionId)?.leases ?? []).filter(
    (lease) => lease.kind === 'background-task' || lease.kind === 'monitor',
  );
}

/** `GET /api/session-hosts`, as this file reads it. */
async function readHosts(api: APIRequestContext): Promise<HostsSnapshot> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/session-hosts answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  return { hosts: body?.data?.hosts ?? [], sessions: body?.data?.sessions ?? [] };
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator => page.locator(`a[href="/session/${sessionId}"]`).first();

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
    throw new Error(
      `could not create or sign in as ${USERNAME}: register ${register.status()} ${JSON.stringify(registered)}, `
        + `login ${login.status()} ${JSON.stringify(loggedIn)}`,
    );
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

test.describe.configure({ mode: 'serial' });

test.describe('background task strip', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let sessionId = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for the debug agent selection');
    }

    // The workspace has to sit inside the fixture home: the control plane writes only under
    // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it.
    workspace = path.join(fixtureHome, 'background-task-strip-workspace');
    const workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

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
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('the strip agrees with the listing while held, with the model silent, and clears when released', async () => {
    // A cold Vite optimize can replace the document whole; one bounded reload covers that replay
    // without turning "not landed" into a pass.
    await page.goto('/');
    if (!(await projectRow(page, path.basename(workspace)).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
      await page.reload();
    }
    await revealSession(page, path.basename(workspace), sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BADGE)).toBeVisible({ timeout: 30_000 });

    // Start the resident host through the product's own control, so the host the walk reports into is
    // one the app produced rather than one this file wrote.
    await page.locator(BADGE).click();
    await page.locator(START).click();
    await expect(page.locator(BADGE)).toHaveAttribute('data-resident-badge', 'running', { timeout: 15_000 });

    // Fired without awaiting: the walk holds both leases for ten seconds, and the readings below are
    // taken inside that window. The response is awaited at the end.
    const clock = api
      .post('/api/debug-agent/clock', { data: { sessionId } })
      .then(async (response) => ({
        ok: response.ok(),
        status: response.status(),
        body: (await response.json().catch(() => null)) as { success?: boolean } | null,
      }))
      .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));

    // --- AC4: the row count equals the listing's held-work lease count --------------------------
    await expect(page.locator(ROW)).toHaveCount(2, { timeout: 20_000 });
    const snapshotHeld = await readHosts(api);
    const domRowCount = await page.locator(ROW).count();
    const rowTexts = (await page.locator(ROW).allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
    const listingLeases = heldWorkLeases(snapshotHeld, sessionId);
    console.log(
      `held.domRows=${domRowCount} held.listingLeases=${listingLeases.length} `
        + `kinds=[${listingLeases.map((lease) => lease.kind).join(',')}] `
        + `since=[${listingLeases.map((lease) => String(lease.since ?? '(none)')).join(',')}]`,
    );
    console.log(`held.rowTexts=${JSON.stringify(rowTexts)}`);
    expect(domRowCount, 'the strip must draw one row per held-work lease').toBe(2);
    expect(
      domRowCount,
      'the strip and the listing must agree about the held work, read at the same instant',
    ).toBe(listingLeases.length);
    expect(
      listingLeases.map((lease) => lease.kind).sort(),
      'the two kinds the scenario opened must be the two the listing holds',
    ).toEqual(['background-task', 'monitor']);
    for (const lease of listingLeases) {
      expect(typeof lease.since, `the ${lease.kind} lease must publish a since instant`).toBe('number');
    }

    // --- AC5: the model wrote nothing, and the work is visible anyway ---------------------------
    // The scenario's `rows: { delta: 0 }` is the structural fact — the walk added no transcript rows,
    // so no assistant prose names the work — and the strip above drew it from the listing alone.
    const paneText = (await page.locator(PANE).innerText()).replace(/\s+/g, ' ');
    const paneHasSeed = paneText.includes(SEED_USER_TEXT);
    console.log(
      `negativeControl.seedUserTurnPresent=${paneHasSeed} `
        + `negativeControl.scenarioRowsDelta=${JSON.stringify(SCENARIO.expect.rows)}`,
    );
    expect(paneHasSeed, 'the seeded user turn must be rendered, or the transcript never loaded').toBe(true);

    // --- AC6: a released hold leaves the strip -----------------------------------------------
    await expect(page.locator(ROW)).toHaveCount(0, { timeout: 25_000 });
    await expect(page.locator(STRIP)).toHaveCount(0, { timeout: 10_000 });
    const snapshotReleased = await readHosts(api);
    console.log(
      `released.domRows=${await page.locator(ROW).count()} `
        + `released.listingLeases=${heldWorkLeases(snapshotReleased, sessionId).length} `
        + `stripPresent=${(await page.locator(STRIP).count()) > 0}`,
    );
    expect(
      heldWorkLeases(snapshotReleased, sessionId).length,
      "the listing must have dropped the holds the strip followed",
    ).toBe(0);
    expect(
      await page.locator(STRIP).count(),
      'a finished task must leave no strip behind',
    ).toBe(0);
    // The unreachable state is not what a released hold looks like: the poll still answers, so the
    // strip's absence is "nothing held", not "could not read".
    expect(await page.locator(UNKNOWN_STRIP).count(), 'the released strip is absent, not unknown').toBe(0);

    const clockBody = await clock;
    expect(clockBody.ok, `the walk must complete: ${JSON.stringify(clockBody)}`).toBe(true);
    expect(clockBody.body?.success, `the walk must report success: ${JSON.stringify(clockBody.body)}`).toBe(true);
  });
});
