/**
 * AC-177: the resident status bar's popover must be reachable on a narrow viewport.
 *
 * What this file is *for*. The bar and its popover live inside `.chat-messages-pane`, which is a
 * scroll container (`overflow-y-auto overflow-x-hidden`), and the composer sits under the pane as a
 * later flex sibling. When the composer grows tall — the resident disclosure alone is several
 * paragraphs — the pane shrinks, the popover (which opens downward from the bar) reaches past the
 * pane's bottom edge, and whatever is below it intercepts the pointer. The report this criterion
 * comes from was Playwright's own: the disclosure's `resident.notice.bypass` paragraph took the
 * click that was aimed at the popover's Close.
 *
 * Why a reading and not an assertion about classes. "Clipped by the scroll container" and "painted
 * under the composer" are two different defects with two different fixes, and CSS `z-index` alone
 * cannot tell them apart. So the first thing this file does is *measure*: the close button's box,
 * the popover's box, the pane's box, the composer's box, and — the load-bearing one — what
 * `document.elementFromPoint` returns at the close button's own centre. `hit.isClose` is that
 * reading. Everything else is printed beside it so a red says which of the two mechanisms was real.
 *
 * Why the debug agent, and why no `claude` binary. The alternative is a real process, and a
 * criterion that needs one cannot run where the binary is absent. `POST /api/debug-agent/scenarios`
 * arms a session and `POST /api/debug-agent/clock` walks a scenario: the same product chain
 * (provider runtime → host manager → run registry → the normalizer) with the child replaced by a
 * scripted clock. The popover's own subject — a live host with an address — arrives through the
 * scenario's `identity` step, so the close below is closing a process the product really owns.
 *
 * Why the close is the last act, and why the clock is awaited before it. A walk cut off mid-flight
 * answers `DEBUG_AGENT_RUN_READING_MISSING` — a red about this file's ordering rather than about the
 * product. The walk here is one second long (`identity`, then a `wait`), so it is awaited before the
 * popover is read; a resident host is meant to sit idle between turns, so it is still live when the
 * Close is finally clicked.
 */

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

/** The chat pane, the same anchor the other resident criteria use to know the session opened. */
const PANE = '.chat-messages-pane';
const BAR = '[data-resident-status-bar]';
const TRIGGER = '[data-resident-status-bar-trigger]';
const START = '[data-resident-start]';
const ADDRESS = '[data-resident-address]';
const CLOSE = '[data-resident-close]';
const COMPOSER = '.chat-composer-shell';
const NOTICE = '[data-slot="resident-consent-notice"]';

/** The two viewports the criterion names: the failing narrow one and its positive control. */
const NARROW = { width: 780, height: 493 };
const WIDE = { width: 1440, height: 900 };

/** The account this run creates. Any name works. */
const USERNAME = 'resident-ui-layout-e2e';
const PASSWORD = 'resident-ui-layout-e2e-pass';

/** The armed session, the sentence its seeded turn carries, and the address the walk reports. */
const TITLE = 'Resident ui layout — close reachability';
const SEED_USER_TEXT = 'seeded user turn for the resident ui layout criterion';
const PEER_NAME = 'peer-resident-ui-layout';

/**
 * The scenario: one identity step so the popover has an address to draw, then a short wait.
 *
 * 一 second rather than the sibling criteria's five: nothing here is read *during* the walk — the
 * popover is read after it settles — and the whole invocation has to fit under the 55 s ceiling.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: PEER_NAME },
    { at: 1_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

// ---------------------------------------------------------------------------------------------
// The wire, read by this file rather than through the page.
// ---------------------------------------------------------------------------------------------

type HostBinding = { appSessionId: string; peerName?: string | null };
type HostRecord = {
  hostId: string;
  state: string;
  closeReason: string | null;
  bindings: HostBinding[];
};
type SessionRecord = { appSessionId: string; lifecycleMode: string };
type HostsSnapshot = { hosts: HostRecord[]; sessions: SessionRecord[] };

/** The live host holding one session, or null. Closed hosts are skipped, as the frontend skips them. */
function liveHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  for (const host of snapshot.hosts) {
    if (host.state === 'closed') continue;
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) return host;
  }
  return null;
}

/** The host that most recently served one session, closed or not — the frontend's `findSessionHost`. */
function lastHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  let found: HostRecord | null = null;
  for (const host of snapshot.hosts) {
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) found = host;
  }
  return found;
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
// The page-side reading.
// ---------------------------------------------------------------------------------------------

/**
 * One geometry reading, taken in a single `page.evaluate` so every number describes one moment.
 *
 * `describe` is deliberately coarse: the question it answers is "which element took the pointer",
 * and a reader needs the tag, the nearest `data-*` attribute that names the surface, and — for the
 * composer's disclosure — the slot name. Not the whole `outerHTML`, which for the composer is
 * thousands of characters and pushes the real reading off the end of a log line.
 */
type Projection = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};
type Reading = {
  viewport: string;
  closeBox: Projection | null;
  popoverBox: Projection | null;
  paneBox: Projection | null;
  composerBox: Projection | null;
  noticeBox: Projection | null;
  noticePresent: boolean;
  hit: string;
  isClose: boolean;
  hitInNotice: boolean;
  hitInComposer: boolean;
  /**
   * Whether the panel is still a DOM descendant of the scroll container.
   *
   * This is the *mechanism* reading: while it is true the pane's `overflow` clips the panel, so the
   * part of it below the pane's bottom edge is painted by whatever is under the pane — which is what
   * the report saw. False means the panel left the clipping box, which is the fix.
   */
  panelInPane: boolean;
  /**
   * Whether the panel's box still reaches below the pane's bottom edge.
   *
   * Kept beside {@link panelInPane} because the two readings disagree by design after the fix: the
   * panel is anchored under the bar, so on a short viewport it *does* overlap the composer — it just
   * paints above it now instead of being cut off. A reader seeing only this one would think the
   * defect was still there.
   */
  overlapsPaneEdge: boolean;
};

function measure(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const rect = (el: Element | null): Projection | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const describe = (el: Element | null): string => {
      if (!el) return 'null';
      const parts: string[] = [el.tagName.toLowerCase()];
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-')) parts.push(`${attr.name}=${JSON.stringify(attr.value)}`);
      }
      const aria = el.getAttribute('aria-label');
      if (aria) parts.push(`aria-label=${JSON.stringify(aria)}`);
      return parts.join(' ');
    };

    const close = document.querySelector('[data-resident-close]');
    const popover = close?.closest('[role="dialog"]') ?? null;
    const pane = document.querySelector('.chat-messages-pane');
    const composer = document.querySelector('.chat-composer-shell');
    const notice = document.querySelector('[data-slot="resident-consent-notice"]');
    const closeBox = rect(close);
    const hitEl = closeBox
      ? document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2)
      : null;
    const popoverBox = rect(popover);
    const paneBox = rect(pane);
    const contains = (outer: Element | null, inner: Element | null): boolean =>
      !!(outer && inner && (outer === inner || outer.contains(inner)));

    return {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      closeBox,
      popoverBox,
      paneBox,
      composerBox: rect(composer),
      noticeBox: rect(notice),
      noticePresent: notice !== null,
      hit: describe(hitEl),
      isClose: contains(close, hitEl),
      hitInNotice: contains(notice, hitEl),
      hitInComposer: contains(composer, hitEl),
      panelInPane: contains(pane, popover),
      overlapsPaneEdge: !!(popoverBox && paneBox && popoverBox.bottom > paneBox.bottom),
    } satisfies Reading;
  });
}

// ---------------------------------------------------------------------------------------------
// Setup.
// ---------------------------------------------------------------------------------------------

/**
 * An account this run owns, created over the API.
 *
 * The onboarding wizard is a three-screen flow that collects a display name and an email, neither of
 * which this criterion reads; the profile flag it sets is the only thing the app checks afterwards,
 * so it is set here through the same endpoint the wizard's last screen calls.
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

/** Arms the scenario and returns the id the rest of this file addresses it by. */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown,
): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const data = body?.data;
  if (typeof data?.sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return data.sessionId;
}

/**
 * The project row's toggle, whose accessible name starts with the workspace's directory name.
 *
 * The sidebar's own control, clicked rather than bypassed: a session row only exists once its
 * project is expanded.
 */
const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator => page.locator(`a[href="/session/${sessionId}"]`).first();

/** Expands the fixture project until the session's row is on screen. Bounded, and never silent. */
async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`the sidebar never showed a row for session ${sessionId}; the page held:\n${body.slice(0, 2_000)}`);
}

test.describe.configure({ mode: 'serial' });

test.describe('resident ui layout', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let workspaceName = '';
  let sessionId = '';

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
    // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it.
    workspace = `${fixtureHome}/resident-ui-layout-workspace`;
    workspaceName = workspace.split('/').pop() as string;

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
      },
      { key: 'auth-token', value: token },
    );
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[e2e] page console error: ${message.text()}`);
    });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await revealSession(page, workspaceName, sessionId);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('the popover close is reachable at a narrow viewport and closes the process', async () => {
    // The failing viewport, set before the session is opened so the transcript, the composer and
    // the bar are all laid out at it — the state the report was taken in.
    await page.setViewportSize(NARROW);
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });

    // The composer's resident disclosure, flipped on the way a user turns it on. This is what makes
    // the composer tall enough to matter, and it is the element the report named as the interceptor —
    // so a reading taken without it would be a reading of a different page.
    const toggle = page.locator(`${COMPOSER} [role="switch"]`).first();
    await toggle.waitFor({ state: 'visible', timeout: 15_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
    await expect(page.locator(NOTICE)).toBeVisible({ timeout: 10_000 });

    // Start the process through the bar's own control, so the host this criterion closes is one the
    // product opened rather than one this file wrote.
    await page.locator(START).click();
    await expect(page.locator(BAR)).toHaveAttribute('data-resident-ui-state', 'idle', { timeout: 15_000 });

    // The walk, awaited before the popover is read: `identity` runs at its own zero, and the one
    // second that follows is short enough to sit inside the budget.
    const clock = await api.post('/api/debug-agent/clock', { data: { sessionId } });
    expect(clock.ok(), `the scenario walk must complete: ${clock.status()}`).toBe(true);

    await page.locator(TRIGGER).click();
    await expect(page.locator(ADDRESS)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(ADDRESS)).not.toBeEmpty({ timeout: 10_000 });
    const address = (await page.locator(ADDRESS).innerText()).trim();
    const snapshotAtAddress = await readHosts(api);
    const peerName = liveHost(snapshotAtAddress, sessionId)?.bindings
      .find((binding) => binding.appSessionId === sessionId)?.peerName ?? null;
    console.log(`popover.address=${JSON.stringify(address)} snapshot.peerName=${JSON.stringify(peerName)}`);
    expect(address, 'the popover must show the address the listing publishes').toBe(peerName);

    // --- the narrow reading (AC2) ---------------------------------------------------------------
    const narrow = await measure(page);
    console.log(
      `viewport=${narrow.viewport} hit.element=${narrow.hit} hit.isClose=${String(narrow.isClose)} `
      + `close.box=${JSON.stringify(narrow.closeBox)}`,
    );
    console.log(
      `popover.box=${JSON.stringify(narrow.popoverBox)} pane.box=${JSON.stringify(narrow.paneBox)} `
      + `composer.box=${JSON.stringify(narrow.composerBox)} notice.box=${JSON.stringify(narrow.noticeBox)} `
      + `notice.present=${String(narrow.noticePresent)} panel.inPane=${String(narrow.panelInPane)} `
      + `popover.overlapsPaneEdge=${String(narrow.overlapsPaneEdge)}`,
    );
    console.log(
      `hit.inNotice=${String(narrow.hitInNotice)} hit.inComposer=${String(narrow.hitInComposer)}`,
    );

    expect(narrow.closeBox, 'the popover must be open before it can be measured').not.toBeNull();
    expect(
      narrow.isClose,
      `elementFromPoint at the close button's centre returned ${narrow.hit} — `
      + `panel.inPane=${String(narrow.panelInPane)} `
      + `popover.bottom=${narrow.popoverBox?.bottom ?? 'null'} pane.bottom=${narrow.paneBox?.bottom ?? 'null'}`,
    ).toBe(true);
    // The panel must have left the scroll container: with it inside, the clip above is what makes
    // the button unreachable, and a run where this is true could only be green by luck of geometry.
    expect(narrow.panelInPane, 'the panel must not be clipped by the transcript scroll container').toBe(false);
    // The two negative readings the criterion names: the interceptor the report saw must not be what
    // the pointer reaches, and nothing inside the composer may be either.
    expect(narrow.hitInNotice, 'the resident disclosure must not be what the pointer reaches').toBe(false);
    expect(narrow.hitInComposer, 'nothing in the composer may take the pointer at the close button').toBe(false);

    // --- the positive control viewport (AC4) ----------------------------------------------------
    await page.setViewportSize(WIDE);
    await expect(page.locator(CLOSE)).toBeVisible({ timeout: 10_000 });
    const wide = await measure(page);
    console.log(
      `viewport=${wide.viewport} hit.element=${wide.hit} hit.isClose=${String(wide.isClose)} `
      + `close.box=${JSON.stringify(wide.closeBox)} panel.inPane=${String(wide.panelInPane)}`,
    );
    expect(
      wide.isClose,
      `the same reading on a wide viewport must also hit: elementFromPoint returned ${wide.hit}`,
    ).toBe(true);

    // --- the real click and the host read-back (AC3) --------------------------------------------
    // The positive control for the close below: the same host must exist *before* it is closed, or
    // "the host went away" would also be satisfied by one that was never there.
    const beforeClose = await readHosts(api);
    const hostBeforeClose = liveHost(beforeClose, sessionId);
    console.log(`host.present=${String(hostBeforeClose !== null)} host.id=${hostBeforeClose?.hostId ?? '(none)'}`);
    expect(hostBeforeClose, 'the popover was opened over a process, so a live host must exist').not.toBeNull();

    const [closeResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/session-hosts/${sessionId}/close`)),
      page.locator(CLOSE).click(),
    ]);
    const afterClose = await readHosts(api);
    const record = lastHost(afterClose, sessionId);
    console.log(
      `close.request=${closeResponse.status()} host.state.after=${record?.state ?? 'absent'} `
      + `closeReason.after=${record?.closeReason ?? '(none)'} `
      + `liveHost.after=${liveHost(afterClose, sessionId) ? 'present' : 'absent'}`,
    );
    expect(closeResponse.status(), 'closing a live host is accepted').toBeLessThan(300);
    expect(record?.state, 'the closed host must be recorded as closed').toBe('closed');
    expect(record?.closeReason, 'the record must say the user is why it closed').toBe('user');
    expect(liveHost(afterClose, sessionId), 'the host must stop being a live host for its session').toBeNull();

    // --- the ceiling (AC1) ----------------------------------------------------------------------
    // Read from the run's own start, published by `playwright.config.ts`: the ceiling binds the whole
    // `npx playwright test` invocation, and a spec can only see itself.
    const elapsed = Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, 'the whole invocation, measured from the config\'s own start').toBeLessThan(55_000);
  });
});
