/**
 * The composer's resident affordances, read off a real browser against a real server and driven by
 * the debug agent's own scenario clock.
 *
 * What this file is *for*. `ChatComposer` offers a resident switch (and, under it, the disclosure that
 * gates it) only while the session it writes into is *not* already resident. The reading is therefore
 * an absence — and an absence is only evidence when the same selector, in the same run, finds the
 * thing on a session where it belongs. So this file arms two sessions off the same clock, one stored
 * `resident` and one `per-run`, and reads the same composer-internal marker on both.
 *
 * Why the debug agent. The alternative is a real `claude` process, and a criterion that needs one is
 * a criterion that cannot run where the binary is absent. Arming a scenario writes the session row,
 * its project link and its stored lifecycle mode (`POST /api/debug-agent/scenarios`), which is
 * everything this criterion reads: the composer's gate is `isResidentSession`, and that value comes
 * from `GET /api/session-hosts` — the server's own projection of the session row — not from anything
 * this page or this file decided. The gate that mounts that face is opened by `playwright.config.ts`
 * for exactly this file's selection, so no other run's server grows a fixture-writing endpoint.
 *
 * Why the marker rather than the accessible name. The switch's `aria-label` is the `resident.toggle`
 * i18n key, which a duplicate top-level `resident` key in the locale files currently shadows to
 * `undefined` (the subject of a separate task). A locator keyed on the *name* would then match on no
 * name at all and collide with the page's dark-mode switch. So every reading here is structural:
 * `[data-resident-enable="true"]` for the switch and `[data-slot="resident-consent-notice"]` for the
 * disclosure its module already declares — the two markers the composer's own source publishes.
 *
 * Why the status bar is awaited before the resident counts. `isResidentSession` is false until the
 * host snapshot has loaded, so a count taken on arrival could read "no switch" for the wrong reason —
 * a page that simply had not fetched yet. `ResidentStatusBar` renders only for a session whose
 * snapshot reads `lifecycleMode === 'resident'` through the very same `findSessionHostState`, so
 * waiting for it is the positive signal that the page knows what this session is. The per-run arm
 * needs the mirror image: it waits for the switch itself, which only appears once the capability
 * matrix has answered, and that is the positive control that the selector is not merely always empty.
 */

import path from 'node:path';

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

/** The chat pane, the same anchor the sibling resident specs use to know the session really opened. */
const PANE = '.chat-messages-pane';
/** The composer's own root, which scopes every count below to the input area. */
const SHELL = '.chat-composer-shell';
/** The switch's structural marker, added by `ChatComposer` for exactly this reading. */
const ENABLE = '[data-resident-enable="true"]';
/** The disclosure component's own slot — the marker its module (`ResidentConsentNotice`) declares. */
const NOTICE = '[data-slot="resident-consent-notice"]';
/** The disclosure's own tick box. Addressed by element rather than by its (shadowed) label. */
const CHECKBOX = 'input[type="checkbox"]';
/**
 * The resident status bar. Its guard is the same `findSessionHostState(...)?.lifecycleMode` the
 * composer's gate reads, so its visibility is the page's own statement that this session is resident.
 */
const BAR = '[data-resident-status-bar]';

/** The account this run creates. Any name works; both sessions are read under it. */
const USERNAME = 'resident-ui-layout-e2e';
const PASSWORD = 'resident-ui-layout-e2e-pass';

/** The two sessions' titles. */
const TITLE_RESIDENT = 'Resident ui layout — the already-resident session';
const TITLE_PER_RUN = 'Resident ui layout — the per-run control';
const SEED_USER_TEXT = 'seeded user turn for the resident ui layout criterion';

/**
 * The resident arm: a session the server stores as `resident` before the page ever opens it.
 *
 * One `wait` is the whole walk and the clock is never fired — this criterion reads the affordance the
 * *stored mode* decides, not a running process, so no host is started and no step is ever reached. The
 * step exists because the loader refuses an empty `steps` array, and `at: 0` is the earliest a
 * document may place one.
 */
const ARM_RESIDENT_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_RESIDENT, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

/**
 * The per-run control: the same fixture with the other stored mode. Its switch is the one the
 * resident arm's absence is measured against; without it, a composer that never drew the affordance
 * at all would score the same as a correct one.
 */
const ARM_PER_RUN_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_PER_RUN, userText: SEED_USER_TEXT, lifecycleMode: 'per-run' },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

/**
 * An account this run owns, created over the API.
 *
 * The onboarding wizard is a three-screen flow that exists to collect a display name and an email,
 * neither of which this criterion reads; driving it would spend a third of the run's budget on screens
 * the subject never appears in. The profile flag it sets is the only thing the app checks afterwards,
 * so it is set here through the same endpoint the wizard's last screen calls. Same helper as the
 * sibling resident specs.
 */
async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', {
      headers: { Authorization: `Bearer ${registered.token}` },
    });
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

/** Arms one scenario and returns the ids the rest of this file addresses it by. */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown,
): Promise<{ sessionId: string; transcriptPath: string }> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const data = body?.data;
  if (typeof data?.sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return { sessionId: data.sessionId, transcriptPath: data.transcriptPath };
}

/** One session's stored lifecycle mode, as `GET /api/session-hosts` projects it off the session row. */
async function sessionMode(api: APIRequestContext, sessionId: string): Promise<string> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/session-hosts answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  const sessions = (body?.data?.sessions ?? []) as { appSessionId: string; lifecycleMode: string }[];
  return sessions.find((session) => session.appSessionId === sessionId)?.lifecycleMode ?? 'undefined';
}

/**
 * Everything this criterion reads inside the input area, taken in one moment.
 *
 * All four counts are scoped to `.chat-composer-shell` so the page's other switch — the dark-mode
 * toggle, which is not inside the composer — cannot contribute to any of them.
 */
async function readComposer(page: Page) {
  return {
    composerVisible: await page.locator(SHELL).isVisible(),
    switchCount: await page.locator(`${SHELL} ${ENABLE}`).count(),
    noticeCount: await page.locator(`${SHELL} ${NOTICE}`).count(),
    checkboxCount: await page.locator(`${SHELL} ${CHECKBOX}`).count(),
  };
}

test.describe.configure({ mode: 'serial' });

test.describe('resident ui layout', () => {
  let page: Page;
  let api: APIRequestContext;
  let residentSessionId = '';
  let perRunSessionId = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for the debug agent selection');
    }
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT for the elapsed reading');
    }

    // The workspace has to sit inside the fixture home: the control plane writes only under
    // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it. The transcripts it arms land under
    // that home's `.claude/projects`, which is a tree of the debug provider's own — no other
    // provider's scan reads it, so the rows stay the ones the debug synchronizer wrote.
    const workspace = path.join(fixtureHome, 'resident-ui-layout-workspace');

    // The account is created on a context of its own, and every read below runs on a context that
    // carries its token: both faces this file reads — the host listing and the debug agent's control
    // plane — are mounted behind the same `authenticateToken` as the rest of `/api`, so an anonymous
    // request is answered with a refusal rather than with the state.
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    residentSessionId = (await armScenario(api, workspace, ARM_RESIDENT_SCENARIO)).sessionId;
    perRunSessionId = (await armScenario(api, workspace, ARM_PER_RUN_SCENARIO)).sessionId;

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
      },
      { key: 'auth-token', value: token },
    );

    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[e2e] page console error: ${message.text()}`);
    });
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  /**
   * The reading the criterion is named for, and its positive control in the same run.
   *
   * One test rather than two, because the two readings are a comparison: the resident arm's absence
   * of the switch means nothing unless the same selector, in the same browser and the same run, finds
   * it on the per-run session. Splitting them would let one arm's server differ from the other's.
   */
  test('resident session hides enable affordance', async () => {
    // ---- the resident arm -------------------------------------------------------------------
    const residentMode = await sessionMode(api, residentSessionId);
    console.log(`resident.session=${residentSessionId}`);
    console.log(`session.lifecycle_mode=${residentMode}`);
    expect(
      residentMode,
      'the resident arm must be stored resident, or the counts below are about the wrong session',
    ).toBe('resident');

    await page.goto(`/session/${residentSessionId}`);
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    // The positive signal that the page has this session's mode: the bar renders only for a session
    // its own host snapshot reads `resident` — the same `findSessionHostState` the composer's gate
    // reads. Without it a `switch.count=0` could be a page that had not fetched yet.
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });

    const paneVisible = await page.locator(PANE).isVisible();
    const resident = await readComposer(page);
    console.log(`composer.visible=${resident.composerVisible}`);
    console.log(`pane.visible=${paneVisible}`);
    console.log(`composer.switch.count=${resident.switchCount}`);
    console.log(`composer.notice.count=${resident.noticeCount}`);
    console.log(`composer.checkbox.count=${resident.checkboxCount}`);
    expect(resident.composerVisible, 'the zero counts below must be a rendered composer, not a blank page').toBe(true);
    expect(paneVisible, 'and a rendered transcript pane beside it').toBe(true);
    expect(
      resident.switchCount,
      'a session already stored resident has nothing left for the switch to turn on, so it must not render',
    ).toBe(0);
    expect(
      resident.noticeCount,
      'the disclosure lives inside the switch, so it goes with it rather than sitting over the input',
    ).toBe(0);
    expect(resident.checkboxCount, 'and its tick box with it').toBe(0);

    // ---- the per-run control ----------------------------------------------------------------
    const perRunMode = await sessionMode(api, perRunSessionId);
    console.log(`per-run.session=${perRunSessionId}`);
    console.log(`session.lifecycle_mode=${perRunMode}`);
    expect(
      perRunMode,
      'the control arm must read per-run, or it would be the resident arm read twice',
    ).toBe('per-run');

    await page.goto(`/session/${perRunSessionId}`);
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    // The switch's presence is itself the wait: it appears only once the capability matrix has
    // answered, and that is when the reading below is about the gate rather than about a slow fetch.
    await expect(page.locator(`${SHELL} ${ENABLE}`)).toHaveCount(1, { timeout: 30_000 });

    const control = await readComposer(page);
    const marker = await page.locator(`${SHELL} ${ENABLE}`).first().getAttribute('data-resident-enable');
    console.log(`per-run.composer.visible=${control.composerVisible}`);
    console.log(`composer.switch.count=${control.switchCount}`);
    console.log(`composer.notice.count=${control.noticeCount}`);
    console.log(`composer.checkbox.count=${control.checkboxCount}`);
    console.log(`per-run.switch.marker=${JSON.stringify(marker)}`);
    expect(
      control.switchCount,
      'a per-run session on a resident-capable provider is exactly the session the switch is for',
    ).toBe(1);
    expect(
      marker,
      'and the element found is the composer\'s own switch, carrying the marker it publishes',
    ).toBe('true');

    /**
     * The wall clock, against the ceiling the goal gate kills at.
     *
     * Read from the run's own start — published by `playwright.config.ts` because a spec can only see
     * itself, and the ceiling binds the whole `npx playwright test` invocation: config evaluation,
     * seeding, server boot and browser launch all happen inside it. Printed by the matched test itself,
     * because the criterion runs under `-g` and no other test's output reaches the log.
     */
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    const elapsed = Date.now() - runStartedAt;
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, 'the whole invocation, measured from the config\'s own start').toBeLessThan(55_000);
  });
});
