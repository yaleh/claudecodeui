import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test';

/**
 * The instant this criterion's `npx playwright test` invocation began.
 *
 * `playwright.config.ts` publishes it (`QUAY_E2E_RUN_STARTED_AT`) for exactly this reading: the 55 s
 * ceiling is on the whole invocation — config evaluation, seeding, server boot, browser launch — and a
 * spec that timed only its own body would report a number whose shortfall against the ceiling is the part
 * it could not see. The fallback is for a run started outside the config (there is none today); it can
 * only make the reading smaller.
 */
const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

/**
 * The viewport the criterion is pinned to.
 *
 * Both numbers are the criterion's own, not the project's default: 780x493 is the window the origin
 * screenshot was taken in, where the composer takes most of the height and the transcript is left with
 * very little of it — the conditions under which a status bar that floats inside the scroll container
 * has nowhere to sit except on top of the conversation.
 */
const VIEWPORT = { width: 780, height: 493 };

/** The chat pane, the same anchor transcript-follow and the other resident specs know the session by. */
const PANE = '.chat-messages-pane';
/** The status bar's own DOM contract (AC-172), read and never written by this file. */
const BAR = '[data-resident-status-bar]';
/** One message row. The criterion reads the outermost ones only; see `readGeometry`. */
const ROW = '[data-message-timestamp]';

const USERNAME = 'resident-ui-layout-e2e';
const PASSWORD = 'resident-ui-layout-e2e-pass';

/** The workspace directory this run's fixtures live under, inside the gate's own fixture home. */
const WORKSPACE_DIR = 'resident-ui-layout-workspace';

const TITLE_RESIDENT = 'Resident layout — resident arm';
const TITLE_PER_RUN = 'Resident layout — per-run control';
const SEED_USER_TEXT = 'the seeded turn both arms of the layout criterion start from';
/**
 * The assistant row both arms are measured against, and the only row the reading may select.
 *
 * It is written by the scenario's own clock rather than by the fixture, so the row arrives the way any
 * other row does — through the transcript the engine appends to and the app reads back.
 */
const ASSISTANT_TEXT = 'the assistant answer the status bar must not be drawn over';

/** How long the control arm waits before its bar reading is taken; see the comment at that reading. */
const CONTROL_SETTLE_MS = 2_000;

/* ── the two fixtures ───────────────────────────────────────────────────────────────────────── */

/**
 * One arm, as a scenario: a seeded session, and one clock step that lands the assistant row.
 *
 * `lifecycleMode` is the only difference between the pairs below, and it is the whole point of the pair:
 * the same seeded conversation, the same assistant row and the same reading are taken twice, once on a
 * session stored `resident` and once on one stored `per-run`. The control is therefore the identical
 * reading function on an identical fixture, differing only in the one fact the bar renders on.
 */
const scenarioFor = (title: string, lifecycleMode: 'resident' | 'per-run') => ({
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title, userText: SEED_USER_TEXT, lifecycleMode },
  steps: [{ at: 0, op: 'row', role: 'assistant', text: ASSISTANT_TEXT }],
  expect: { rows: { delta: 1 }, content: { mustContain: [ASSISTANT_TEXT] } },
});

/* ── the server's own faces ─────────────────────────────────────────────────────────────────── */

/**
 * An account this run owns, created over the API.
 *
 * The onboarding wizard is a three-screen flow this criterion never appears in; its last screen is what
 * sets the profile flag the app checks afterwards, so it is called directly. Register-then-login rather
 * than register: a re-run against a data directory that already holds this account must sign in, not
 * fail.
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

/** Arms one scenario and returns the session id it was indexed under. */
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
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return sessionId;
}

/**
 * Walks one armed scenario's clock to its end and reports that it completed.
 *
 * The clock is awaited rather than fired and left: this criterion reads the transcript *after* the walk,
 * so a walk still in flight would make the message row it is about a race. The walk is what lands the
 * assistant row, so a walk that did not complete is a red on the fixture rather than on the geometry —
 * which is why it is asserted here, in its own words, and not left to the reading below.
 */
async function walkClock(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post('/api/debug-agent/clock', { data: { sessionId } });
  const body = await response.json().catch(() => null);
  expect(
    response.ok() && body?.success === true,
    `the clock walk for ${sessionId} must complete: ${response.status()} ${JSON.stringify(body)}`,
  ).toBe(true);
}

/**
 * One session's stored lifecycle mode, off the listing that publishes it.
 *
 * The same face the resident specs read their modes from, and the only one that answers the question: a
 * workspace's own session objects carry no mode at all. Read rather than assumed, because the bar's
 * presence is a function of this value — a fixture that failed to store `resident` would make the whole
 * reading below a statement about a per-run session.
 */
async function readLifecycleMode(api: APIRequestContext, sessionId: string): Promise<string> {
  const response = await api.get('/api/session-hosts');
  const body = (await response.json().catch(() => null)) as
    | { data?: { sessions?: { appSessionId: string; lifecycleMode: string }[] } }
    | null;
  expect(response.ok(), `GET /api/session-hosts answered ${response.status()}`).toBe(true);
  return body?.data?.sessions?.find((session) => session.appSessionId === sessionId)?.lifecycleMode
    ?? '<absent>';
}

/* ── the page's own reading ─────────────────────────────────────────────────────────────────── */

type Box = { x: number; y: number; w: number; h: number; x2: number; y2: number };
type RowReading = { style: string; box: Box };

/**
 * Everything the criterion reads, taken in ONE round trip.
 *
 * The boxes are one reading rather than several because the question is a relation between them: two
 * boxes measured a frame apart can be told apart from a relation that never held, and the status bar
 * polls, so "a frame apart" is a real distance here. `getBoundingClientRect` in a single `evaluate` is
 * what makes the relation the page actually drew.
 *
 * The message is the outermost `[data-message-timestamp]` row *whose `data-message-style` is `assistant`*
 * — the same outermost filter transcript-follow uses (`!row.parentElement?.closest(...)`, which drops the
 * rows nested inside a tool group), narrowed to the row kind the criterion is about. The two attributes
 * sit on two different elements: `data-message-timestamp` is on the row wrapper (LazyMessageRow, which
 * stays in the DOM even while its content is a placeholder) and `data-message-style` is published by the
 * message component inside it. So the *row* is selected by the outer attribute and the *kind* is read
 * from within it, which is what keeps this the outermost row rather than the inner element that happens
 * to be the styled one. `count` is how many rows that filter kept: it is the guard that keeps a blank
 * page from passing, because an empty transcript would otherwise report "no bar over the message" on the
 * strength of there being no message. Every outermost row is reported alongside, so a reading that
 * selected the wrong row says so.
 *
 * Two boxes from `getBoundingClientRect` are not by themselves a picture of what the user sees: the pane
 * is `overflow-y-auto` (and `contain: paint`), so a row scrolled past its top edge still reports a rect
 * that reaches up behind the bar. The reading would then say "the bar covers the message" about a part of
 * the message the pane never drew. That is why the pane's own box is taken here as well: the criterion
 * asserts the message's box lies *inside* the pane's box (`msgInPane`), which is the precondition under
 * which "the bar's box does not touch the message's box" is a statement about the drawn transcript rather
 * than about a rect the pane clips.
 *
 * `barOverPane` is the same relation asked of the scroll container itself — whether the bar is drawn
 * inside the box the transcript scrolls in. It is the reading that catches a bar put back on the wrong
 * side of that boundary: a bar drawn inside the pane can sit over a row the message reading happens to
 * miss (the top of the transcript, which is where a sticky bar comes to rest), while a bar outside the
 * pane cannot reach any row at all.
 */
const readGeometry = (page: Page) =>
  page.evaluate((selectors: { pane: string; bar: string; row: string; styled: string }) => {
    const boxOf = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, x2: rect.right, y2: rect.bottom };
    };

    // Two boxes overlap when no one axis separates them.
    const overlaps = (a: Box | null, b: Box | null) =>
      Boolean(a && b && a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2);

    const pane = document.querySelector(selectors.pane);
    const bar = document.querySelector(selectors.bar);
    const outermost = pane
      ? Array.from(pane.querySelectorAll(selectors.row))
        .filter((row) => !row.parentElement?.closest(selectors.row))
      : [];

    const rows = outermost.map((row) => {
      const styled = row.matches(selectors.styled) ? row : row.querySelector(selectors.styled);
      return {
        style: styled?.getAttribute('data-message-style') ?? '',
        box: boxOf(row),
      };
    });
    const assistantRows = rows.filter((row) => row.style === 'assistant');
    const msg = assistantRows.length ? assistantRows[assistantRows.length - 1].box : null;
    const barBox = bar ? boxOf(bar) : null;
    const paneBox = pane ? boxOf(pane) : null;
    const viewport = { width: window.innerWidth, height: window.innerHeight };

    return {
      bar: barBox,
      msg,
      pane: paneBox,
      rows,
      count: assistantRows.length,
      barExists: Boolean(bar),
      intersect: overlaps(barBox, msg),
      // The criterion's own "fully in the viewport": the message's box lies between the viewport's edges.
      msgVisible: Boolean(
        msg && msg.w > 0 && msg.h > 0 && msg.y >= 0 && msg.y2 <= viewport.height,
      ),
      // The precondition that makes the reading above a statement about the drawn transcript: the row is
      // not one the pane has scrolled past.
      msgInPane: Boolean(
        msg && paneBox
          && msg.x >= paneBox.x && msg.y >= paneBox.y && msg.x2 <= paneBox.x2 && msg.y2 <= paneBox.y2,
      ),
      // Whether the bar is drawn inside the scroll container — the boundary the fix moved it across.
      barOverPane: overlaps(barBox, paneBox),
      viewport,
    };
  }, { pane: PANE, bar: BAR, row: ROW, styled: '[data-message-style]' });

/** A box as the criterion prints it: `x,y,w,h`, rounded, or a named absence. */
const formatBox = (box: Box | null): string =>
  box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)}` : '<none>';

/** Prints one arm's whole reading, so the assertions below are readable against what was seen. */
const printReading = (label: string, reading: Awaited<ReturnType<typeof readGeometry>>): void => {
  console.log(`${label}.bar.exists=${reading.barExists}`);
  console.log(`${label}.bar.box=${formatBox(reading.bar)}`);
  console.log(`${label}.msg.box=${formatBox(reading.msg)}`);
  console.log(`${label}.intersect=${reading.intersect}`);
  console.log(`${label}.msg.visible=${reading.msgVisible}`);
  console.log(`${label}.msg.in.pane=${reading.msgInPane}`);
  console.log(`${label}.bar.over.pane=${reading.barOverPane}`);
  console.log(`${label}.msg.count=${reading.count}`);
  console.log(`${label}.pane.box=${formatBox(reading.pane)}`);
  console.log(`${label}.viewport=${reading.viewport.width}x${reading.viewport.height}`);
  console.log(
    `${label}.rows=${JSON.stringify(reading.rows.map((row) => `${row.style}@${formatBox(row.box)}`))}`,
  );
};

/** The page and the context it lives in, both signed in as the account this run created. */
const openPage = async (
  browser: Browser,
  baseURL: string,
  token: string,
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
  await context.addInitScript(
    ({ authKey, authToken, language }: { authKey: string; authToken: string; language: string }) => {
      window.localStorage.setItem(authKey, authToken);
      window.localStorage.setItem('userLanguage', language);
    },
    { authKey: 'auth-token', authToken: token, language: 'en' },
  );
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[e2e] page console error: ${message.text()}`);
  });
  return { context, page };
};

/**
 * Opens one session and waits until the transcript has drawn a row.
 *
 * The pane is awaited first because it is the scroll container itself and the subject of every reading
 * below; a page that never reached the session would otherwise fail on a message-row timeout and report
 * the fixture rather than the layout.
 */
const openSession = async (page: Page, sessionId: string): Promise<void> => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(`/session/${sessionId}`);
  await expect(page.locator(PANE), `the pane must open for session ${sessionId}`).toBeVisible({ timeout: 30_000 });
  await page.waitForSelector(`${PANE} ${ROW}`, { timeout: 30_000 });
};

/**
 * AC-179: the resident status bar must not be drawn over the conversation it describes.
 *
 * Two legs, one run, one reading function. The resident leg is the load-bearing reading — at 780x493, with one
 * assistant message on screen, the bar's bounding box and that message's bounding box must not overlap,
 * the message's box must lie entirely inside the viewport *and* inside the transcript's own box, and the
 * bar's box must not overlap the scroll container's at all. The per-run leg is the control that keeps
 * the first from being satisfied by a reading that can only ever say "no bar": the same function, on the
 * same fixture, must find no bar at all — and the same message visible.
 */
test('status bar does not cover the transcript', async ({ browser }) => {
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection');
  }
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) {
    throw new Error('playwright.config.ts must give this project a baseURL');
  }

  // The workspace has to sit inside the fixture home: the control plane writes only under
  // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it.
  const workspace = path.join(fixtureHome, WORKSPACE_DIR);

  const bootstrap = await request.newContext({ baseURL });
  const token = await createAccount(bootstrap);
  await bootstrap.dispose();
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });

  const residentId = await armScenario(api, workspace, scenarioFor(TITLE_RESIDENT, 'resident'));
  const perRunId = await armScenario(api, workspace, scenarioFor(TITLE_PER_RUN, 'per-run'));
  await walkClock(api, residentId);
  await walkClock(api, perRunId);

  // The mode is read back off the listing rather than trusted to the arm: the bar's presence is a
  // function of this value, so a fixture that stored something else would silently turn the resident leg
  // into a second control leg.
  const residentMode = await readLifecycleMode(api, residentId);
  const perRunMode = await readLifecycleMode(api, perRunId);
  console.log(`resident.session=${residentId}`);
  console.log(`resident.session.lifecycle_mode=${residentMode}`);
  console.log(`per-run.session=${perRunId}`);
  console.log(`per-run.session.lifecycle_mode=${perRunMode}`);
  expect(residentMode, 'the load-bearing arm has to be a session the app stores as resident').toBe('resident');
  expect(perRunMode, 'the control arm has to be a session the app stores as per-run').toBe('per-run');

  const { context, page } = await openPage(browser, baseURL, token);

  try {
    // ── AC2: the resident arm — a bar that does not touch the message it describes ──────────────
    await openSession(page, residentId);
    await expect(page.locator(BAR), 'a resident session must draw the bar this reading is about')
      .toBeVisible({ timeout: 30_000 });
    const residentReading = await readGeometry(page);
    printReading('resident', residentReading);

    expect(
      residentReading.barExists,
      'a reading that found no bar would satisfy "no overlap" without saying anything',
    ).toBe(true);
    expect(
      residentReading.count,
      `exactly one assistant row must be the subject; the rows read were ${JSON.stringify(residentReading.rows)}`,
    ).toBe(1);
    expect(
      residentReading.msg,
      'the message row the bar is measured against must have been drawn',
    ).not.toBeNull();

    const barBox = residentReading.bar as Box;
    const msgBox = residentReading.msg as Box;
    // The precondition of the whole reading: the row the bar is measured against is one the pane drew,
    // not one scrolled past its top edge (where its raw box would reach up behind the bar).
    expect(
      residentReading.msgInPane,
      `the message row has to lie inside the transcript's own box, or "the bar does not overlap it" `
        + `would be said of a rect the pane clips; msg.box=${formatBox(msgBox)} `
        + `pane.box=${formatBox(residentReading.pane)}`,
    ).toBe(true);
    // Load-bearing: this is the reading the fake form has to falsify, and the one the origin screenshot fails.
    expect(
      residentReading.intersect,
      `the status bar must not overlap the message; intersect=${residentReading.intersect} `
        + `bar.box=${formatBox(barBox)} msg.box=${formatBox(msgBox)}`,
    ).toBe(false);
    expect(
      residentReading.msgVisible,
      `the message must be entirely inside the viewport; msg.box=${formatBox(msgBox)} `
        + `viewport=${residentReading.viewport.width}x${residentReading.viewport.height}`,
    ).toBe(true);
    // The same relation asked of the scroll container: a bar drawn inside it can come to rest over a row
    // the message reading above does not happen to select, so the boundary itself is asserted too.
    expect(
      residentReading.barOverPane,
      `the status bar must not be drawn inside the transcript's scroll box; `
        + `bar.box=${formatBox(barBox)} pane.box=${formatBox(residentReading.pane)}`,
    ).toBe(false);

    // ── AC3: the per-run control — no bar at all, same reading ─────────────────────────────────
    //
    // The absence is read after a settle, and it is not a race: the resident leg above already proved the
    // snapshot arrived, and the listing that snapshot came from carries *both* sessions — so the very
    // answer that drew the bar on the resident arm also carried this arm's row, and read it `per-run`.
    // A bar that rendered on this session would therefore have rendered before the wait below began.
    await openSession(page, perRunId);
    await page.waitForTimeout(CONTROL_SETTLE_MS);
    const perRunBarCount = await page.locator(BAR).count();
    console.log(`per-run.bar.exists=${perRunBarCount > 0}`);
    expect(
      perRunBarCount,
      'an ordinary session must draw no status bar — without this leg the reading above could be '
        + 'satisfied by a bar that never renders anywhere',
    ).toBe(0);

    const perRunReading = await readGeometry(page);
    printReading('per-run', perRunReading);
    expect(
      perRunReading.count,
      `the control leg has to read the same message; the rows read were ${JSON.stringify(perRunReading.rows)}`,
    ).toBe(1);
    expect(
      perRunReading.msgInPane,
      `the control leg has to read a row the pane drew; msg.box=${formatBox(perRunReading.msg)} `
        + `pane.box=${formatBox(perRunReading.pane)}`,
    ).toBe(true);
    expect(
      perRunReading.msgVisible,
      `the message must be visible on the control leg too; msg.box=${formatBox(perRunReading.msg)}`,
    ).toBe(true);
    expect(
      perRunReading.barOverPane,
      'the control leg has no bar, so nothing can be drawn inside the pane',
    ).toBe(false);
  } finally {
    await context.close();
    await api.dispose();
  }

  const elapsed = Date.now() - RUN_STARTED_AT;
  console.log(`elapsed=${elapsed}ms`);
  expect(elapsed, 'the criterion has to end inside the single-file ceiling').toBeLessThan(55_000);
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * AC-177 — the resident status bar's popover must be reachable on a narrow viewport.
 *
 * Two criteria share this file. The half above belongs to AC-179 (the bar must not cover the
 * transcript); everything below belongs to AC-177 (the popover's Close must be reachable at 780x493
 * and must really close the process). They read the same surface from opposite ends: AC-179 asks
 * that the bar stay out of the conversation's way, AC-177 asks that the bar's own popover still be
 * usable once the bar has moved. Each criterion selects its own test with `-g`.
 *
 * What this half is *for*. The bar and its popover live inside `.chat-messages-pane`, which is a
 * scroll container (`overflow-y-auto overflow-x-hidden`), and the composer sits under the pane as a
 * later flex sibling. When the composer grows tall — the resident disclosure alone is several
 * paragraphs — the pane shrinks, the popover (which opens downward from the bar) reaches past the
 * pane's bottom edge, and whatever is below it intercepts the pointer. The report this criterion
 * comes from was Playwright's own: the disclosure's `resident.notice.bypass` paragraph took the
 * click that was aimed at the popover's Close.
 *
 * After AC-178 the interceptor above cannot be on this page: a session that is already resident no
 * longer renders the switch or the consent notice, and this criterion's session is resident. The
 * criterion is unchanged in what it asks (the Close button's centre must hit the button, at both
 * viewports, and a real click must close the host); what changed is how its reading proves it can
 * say no. The consent notice used to be the falsifier by construction, so the test now injects an
 * element over the Close button and requires the same `elementFromPoint` reading to go red, naming
 * it, and to recover once it is removed. The clipping mechanism (`panelInPane`) is asserted as before.
 *
 * What this no longer proves, stated plainly: it cannot tell the popover as it was before the AC-177
 * fix from the fixed one. Measured — with the pre-fix component and a composer squeezed by hand until
 * the pane ended above the Close button, this reading still hit the button, because AC-179 had
 * already moved the bar out of the scroll box and the notice was the only thing that ever stacked
 * over the popover. What it does prove is that the button is reachable at both viewports, that a
 * real click closes the host, and that the hit reading itself would go red if anything covered it.
 *
 * Why a reading and not an assertion about classes. "Clipped by the scroll container" and "painted
 * under the composer" are two different defects with two different fixes, and CSS `z-index` alone
 * cannot tell them apart. So the first thing this half does is *measure*: the close button's box,
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
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

const TRIGGER = '[data-resident-status-bar-trigger]';
const START = '[data-resident-start]';
const ADDRESS = '[data-resident-address]';
const CLOSE = '[data-resident-close]';

/** The two viewports the criterion names: the failing narrow one and its positive control. */
const NARROW = { width: 780, height: 493 };
const WIDE = { width: 1440, height: 900 };

/** The armed session, the sentence its seeded turn carries, and the address the walk reports. */
const TITLE = 'Resident ui layout — close reachability';
const CLOSE_SEED_USER_TEXT = 'seeded user turn for the resident ui layout criterion';
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
  seed: { title: TITLE, userText: CLOSE_SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: PEER_NAME },
    { at: 1_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [CLOSE_SEED_USER_TEXT] } },
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

test.describe('resident ui layout', () => {
  test.describe.configure({ mode: 'serial' });
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

    // No composer switch and no disclosure here, on purpose. This session is already resident, and
    // AC-178 keeps the switch and the consent notice off a resident session's composer — the notice
    // that used to take this pointer can no longer be on this page. The reading below therefore asks
    // the question that outlives that fix: whatever is over the Close button's centre, is it the
    // button. The control after the narrow reading (an element injected over the popover) is what
    // proves the reading can still say no.

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
    // Nothing inside the composer may take the pointer at the close button. (The consent notice is
    // absent on a resident session — AC-178 — so it is part of this composer check, not its own.)
    expect(narrow.noticePresent, 'AC-178: a resident session carries no consent notice').toBe(false);
    expect(narrow.hitInComposer, 'nothing in the composer may take the pointer at the close button').toBe(false);

    // --- the falsifying control ------------------------------------------------------------------
    // The reading above is only evidence if it can say no. The product state that used to make it say
    // no (the consent notice stacked over the popover) no longer exists, so the interceptor is put
    // there by hand: a fixed element above everything, centred on the Close button. The same
    // `measure` must now report that the pointer does NOT reach the button, and name the injected
    // element; once it is removed the reading must hit the button again. Without this leg a run where
    // `elementFromPoint` had been replaced by something that always answers "the button" would pass.
    await page.evaluate(() => {
      const close = document.querySelector('[data-resident-close]');
      if (!close) throw new Error('the falsifying control needs the close button on the page');
      const box = close.getBoundingClientRect();
      const cover = document.createElement('div');
      cover.setAttribute('data-e2e-falsifier', 'cover');
      cover.style.cssText =
        `position:fixed;z-index:2147483647;left:${box.left - 8}px;top:${box.top - 8}px;`
        + `width:${box.width + 16}px;height:${box.height + 16}px;background:transparent;`;
      document.body.appendChild(cover);
    });
    const covered = await measure(page);
    console.log(`falsifier.hit.element=${covered.hit} falsifier.hit.isClose=${String(covered.isClose)}`);
    expect(covered.isClose, 'an element stacked over the Close button must turn the reading red').toBe(false);
    expect(covered.hit, 'the red must land on the hit reading and name what took the pointer').toContain(
      'data-e2e-falsifier="cover"',
    );
    await page.evaluate(() => {
      document.querySelector('[data-e2e-falsifier="cover"]')?.remove();
    });
    const uncovered = await measure(page);
    expect(uncovered.isClose, 'with the injected element removed the reading must hit the button again').toBe(true);

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
/* ── AC-178: the composer's own resident affordances ─────────────────────────────────────────── */

/**
 * The reading AC-178 is named for: the resident switch — and the disclosure under it — is offered
 * only while the session it writes into is *not* already resident.
 *
 * The reading is an absence, and an absence is only evidence when the same selector, in the same run,
 * finds the thing on a session where it belongs. So this leg arms two sessions off the same fixture
 * and reads the same composer-internal marker on both: the stored `resident` one must carry neither
 * the switch nor its disclosure nor its tick box, and the `per-run` one must carry exactly one switch.
 *
 * Why the marker rather than the accessible name. The switch's `aria-label` is the `resident.toggle`
 * i18n key, which a duplicate top-level `resident` key in the shipped locale files currently shadows
 * to `undefined` (the subject of a separate task). A locator keyed on the *name* would then match on
 * no name at all and collide with the page's dark-mode switch. So every reading here is structural —
 * `[data-resident-enable="true"]` for the switch and `[data-slot="resident-consent-notice"]` for the
 * disclosure its module already declares — and each count is scoped to the composer's own root, so the
 * page's other switch cannot contribute to any of them.
 *
 * Why the status bar is awaited before the resident counts. `isResidentSession` is false until the host
 * snapshot has loaded, so a count taken on arrival could read "no switch" for the wrong reason — a page
 * that simply had not fetched yet. `ResidentStatusBar` renders only for a session whose snapshot reads
 * `lifecycleMode === 'resident'` through the very same `findSessionHostState`, so waiting for it is the
 * positive signal that the page knows what this session is. The per-run arm needs the mirror image: it
 * waits for the switch itself, which only appears once the capability matrix has answered, and that is
 * the positive control that the selector is not merely always empty.
 *
 * The scenario is stored and never clocked: this criterion reads the affordance the *stored mode*
 * decides, not a running process, so no host is started and no step is ever reached. The step exists
 * because the loader refuses an empty `steps` array, and `at: 0` is the earliest a document may place
 * one.
 */

/** The composer's own root class, which scopes every count below to the input area. */
const COMPOSER_SHELL = '.chat-composer-shell';
/** The switch's structural marker, added by `ChatComposer` for exactly this reading. */
const COMPOSER_ENABLE = '[data-resident-enable="true"]';
/** The disclosure component's own slot — the marker its module (`ResidentConsentNotice`) declares. */
const COMPOSER_NOTICE = '[data-slot="resident-consent-notice"]';
/** The disclosure's own tick box. Addressed by element rather than by its (shadowed) label. */
const COMPOSER_CHECKBOX = 'input[type="checkbox"]';

const COMPOSER_TITLE_RESIDENT = 'Resident ui layout — the already-resident session';
const COMPOSER_TITLE_PER_RUN = 'Resident ui layout — the per-run control';

/** One arm of the composer pair: the same seeded session, stored under one lifecycle mode. */
const composerScenarioFor = (title: string, lifecycleMode: 'resident' | 'per-run') => ({
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title, userText: SEED_USER_TEXT, lifecycleMode },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
});

/**
 * Everything this criterion reads inside the input area, taken in one moment.
 *
 * All four counts are scoped to the composer's root so the page's other switch — the dark-mode toggle,
 * which is not inside the composer — cannot contribute to any of them.
 */
async function readComposer(page: Page) {
  return {
    composerVisible: await page.locator(COMPOSER_SHELL).isVisible(),
    switchCount: await page.locator(`${COMPOSER_SHELL} ${COMPOSER_ENABLE}`).count(),
    noticeCount: await page.locator(`${COMPOSER_SHELL} ${COMPOSER_NOTICE}`).count(),
    checkboxCount: await page.locator(`${COMPOSER_SHELL} ${COMPOSER_CHECKBOX}`).count(),
  };
}

test('resident session hides enable affordance', async ({ browser }) => {
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection');
  }
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) {
    throw new Error('playwright.config.ts must give this project a baseURL');
  }

  // The workspace sits inside the fixture home: the control plane writes only under `DEBUG_AGENT_HOME`
  // and refuses a `projectPath` outside it, and the transcripts it arms land under that home's own
  // `.claude/projects`, which no other provider's scan reads.
  const workspace = path.join(fixtureHome, WORKSPACE_DIR);

  const bootstrap = await request.newContext({ baseURL });
  const token = await createAccount(bootstrap);
  await bootstrap.dispose();
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });

  const residentId = await armScenario(api, workspace, composerScenarioFor(COMPOSER_TITLE_RESIDENT, 'resident'));
  const perRunId = await armScenario(api, workspace, composerScenarioFor(COMPOSER_TITLE_PER_RUN, 'per-run'));

  const { context, page } = await openPage(browser, baseURL, token);

  try {
    // ── AC2: the resident arm — no switch, no disclosure, no tick box ─────────────────────────
    const residentMode = await readLifecycleMode(api, residentId);
    console.log(`resident.session=${residentId}`);
    console.log(`session.lifecycle_mode=${residentMode}`);
    expect(
      residentMode,
      'the resident arm must be stored resident, or the counts below are about the wrong session',
    ).toBe('resident');

    await page.goto(`/session/${residentId}`);
    await expect(page.locator(PANE), 'the pane must open for the resident arm').toBeVisible({ timeout: 30_000 });
    // The positive signal that the page has this session's mode: the bar renders only for a session its
    // own host snapshot reads `resident` — the same `findSessionHostState` the composer's gate reads.
    await expect(page.locator(BAR), 'a resident session must draw the bar that proves the mode arrived')
      .toBeVisible({ timeout: 30_000 });

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

    // ── AC3: the per-run control — the same selector, the same run, finds the switch ───────────
    const perRunMode = await readLifecycleMode(api, perRunId);
    console.log(`per-run.session=${perRunId}`);
    console.log(`session.lifecycle_mode=${perRunMode}`);
    expect(
      perRunMode,
      'the control arm must read per-run, or it would be the resident arm read twice',
    ).toBe('per-run');

    await page.goto(`/session/${perRunId}`);
    await expect(page.locator(PANE), 'the pane must open for the control arm').toBeVisible({ timeout: 30_000 });
    // The switch's presence is itself the wait: it appears only once the capability matrix has answered,
    // and that is when the reading below is about the gate rather than about a slow fetch.
    await expect(page.locator(`${COMPOSER_SHELL} ${COMPOSER_ENABLE}`)).toHaveCount(1, { timeout: 30_000 });

    const control = await readComposer(page);
    const marker = await page.locator(`${COMPOSER_SHELL} ${COMPOSER_ENABLE}`).first().getAttribute('data-resident-enable');
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
  } finally {
    await context.close();
    await api.dispose();
  }

  const elapsed = Date.now() - RUN_STARTED_AT;
  console.log(`elapsed=${elapsed}ms`);
  expect(elapsed, 'the criterion has to end inside the single-file ceiling').toBeLessThan(55_000);
});
