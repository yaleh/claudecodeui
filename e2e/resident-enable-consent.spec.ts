import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, Page } from '@playwright/test';

/**
 * The shipped English wording, read off the disk rather than restated here.
 *
 * Every sentence this spec asserts on is the app's own copy, so a spec that carried its own strings would
 * keep passing after the locale file changed — and the whole point of the assertions below is that the words
 * the user is shown are the words the app ships. Same reading as `e2e/mobile-composer-send-key.spec.ts`.
 */
type ChatLocale = {
  resident: {
    toggle: string;
    notice: { title: string; bypass: string; trustBoundary: string; acknowledge: string };
  };
  input: { send: string };
};

const enChat = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'), 'utf8'),
) as ChatLocale;

/** The menu's own words, which live in the sidebar namespace rather than chat's. */
const enSidebar = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/sidebar.json'), 'utf8'),
) as { sessionMenu: { convertToResident: string; residentConsentConfirm: string } };

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The subject is the consent gate in front of resident mode, and it is read the way a user meets it: a real
// project from the run's own seeded HOME, a real session row in the real sidebar, and the lifecycle mode read
// back from the server the send was addressed to. Nothing here rebuilds the mode client-side — `GET
// /api/session-hosts` is the same projection a restart uses to find a resident session whose process it
// dropped, so the `resident` this spec prints is the server's own stored preference and not the switch's
// local state.
//
// The one seam is called out where it is installed: the sidebar's "is this session processing" reading in the
// last case. Every other reading in this file — the capability matrix, the mode before and after a
// conversion, the mode of a session nobody asked to keep running — comes from the real server.

const COMPOSER = '[data-slot="prompt-input-textarea"]';
/** The composer's send button, named by the shipped label rather than by a hard-coded word. */
const SEND_BUTTON = `button[aria-label="${enChat.input.send}"]`;
/** The disclosure component's own slot — the marker its module declares. */
const NOTICE = '[data-slot="resident-consent-notice"]';
const AUTH_TOKEN_KEY = 'auth-token';
/**
 * The first-paint mirror of the account's preferences.
 *
 * `src/shared/userSettings.ts` reads this blob synchronously so the very first render already knows the
 * stored provider; the server's copy is authoritative and is what the legs below change. Priming the mirror
 * is not a stub — it is the same key the app writes — it only removes the one frame in which the composer
 * would still be drawing the default provider while the hydrate was in flight.
 */
const PREFERENCES_MIRROR_KEY = 'user-preferences';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The read-only endpoint the sidebar derives "processing" from. */
const RUNNING_SESSIONS = '**/api/providers/sessions/running';
/** The provider the account starts on, and the one every leg but the matrix leg works under. */
const RESIDENT_PROVIDER = 'claude';

/** Absolute path of the workspace playwright.config.ts seeded for its own composer spec. */
let workspace = '';
/**
 * A seeded Claude transcript, indexed at boot like a developer's own `~/.claude/projects`.
 *
 * The sidebar row this spec converts has to be a session the app really discovered, so it comes from the run's
 * fixture rather than from an API call: an API-created session writes a row but no transcript, and the sidebar
 * lists what the synchronizer indexed.
 */
const SEEDED_SESSION_ID = 'e2e-mobile-send-key';
const SEEDED_SESSION_NAME = 'mobile-send-key';

/** Collapses the runs of whitespace `innerText` inserts between block elements, on both sides of a compare. */
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Signs in once for the whole file.
 *
 * Every case gets its own browser context, so the default `page` fixture starts unauthenticated. Re-running
 * onboarding per case would cost more than the whole budget, so the session is captured here and replayed into
 * each context by `restoreSession`. Same helper as `e2e/mobile-composer-send-key.spec.ts`, except for the wait
 * below: the first navigation of a run is the one that pays for the client's module graph, and the template's
 * five seconds is short enough that a loaded host loses that race and reports "element not found" — a red that
 * names nothing the reader can act on. The wait is retried and bounded, and the diagnosis is printed.
 */
const ensureSignedIn = async (page: Page) => {
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  const arrived = createAccount.or(settings).or(page.locator('#username')).first();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/').catch(() => undefined);
    try {
      await expect(arrived).toBeVisible({ timeout: 15_000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1_000);
    }
  }
  if (lastError !== null) {
    const body = await page.locator('body').innerText().catch(() => '<unreadable>');
    throw new Error(
      `the app never reached a sign-in, onboarding or signed-in screen at ${page.url()}: `
        + `${body.replace(/\s+/g, ' ').trim().slice(0, 400) || '<empty body>'}`,
    );
  }

  if (await createAccount.count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  }
};

/** The signed-in token, captured once by `bootstrapAuth`. */
let authToken = '';

const bootstrapAuth = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the legs cannot authenticate');
  }
};

/**
 * Puts the captured session into the context the test's own options already built, and — for the legs that
 * need a provider other than the default — primes the preference mirror so the first paint agrees with it.
 */
const restoreSession = async (page: Page, provider?: string) => {
  await page.addInitScript(([key, token, mirrorKey, mirrorValue]) => {
    try {
      window.localStorage.setItem(key, token);
      if (mirrorValue) {
        window.localStorage.setItem(mirrorKey!, JSON.stringify({ selectedProvider: mirrorValue }));
      }
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken, provider ? PREFERENCES_MIRROR_KEY : null, provider ?? null] as const);
};

/** Writes the account's selected provider through the app's own preference API, and reads it back. */
const setSelectedProvider = async (request: APIRequestContext, provider: string) => {
  const written = await request.patch('/api/user/preferences', {
    headers: auth(authToken),
    data: { selectedProvider: provider },
  });
  expect(written.ok(), `PATCH /api/user/preferences answered ${written.status()}`).toBe(true);

  const readBack = await request.get('/api/user/preferences', { headers: auth(authToken) });
  const body = (await readBack.json()) as { preferences?: { selectedProvider?: string } };
  expect(
    body.preferences?.selectedProvider,
    'the stored provider must be the one just written — otherwise the leg below would read the default',
  ).toBe(provider);
};

/** The capability matrix as the backend answers it, parsed exactly the way the app's own hook parses it. */
const providerCapabilities = async (request: APIRequestContext) => {
  const response = await request.get('/api/providers/capabilities', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/providers/capabilities answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as {
    data?: { providers?: { provider: string; lifecycleModes?: string[] }[] };
  };
  return body.data?.providers ?? [];
};

/** Every session's stored lifecycle mode, as `GET /api/session-hosts` projects it off the session rows. */
const sessionModes = async (request: APIRequestContext): Promise<Map<string, string>> => {
  const response = await request.get('/api/session-hosts', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/session-hosts answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as {
    data?: { sessions?: { appSessionId: string; lifecycleMode: string }[] };
  };
  return new Map((body.data?.sessions ?? []).map((row) => [row.appSessionId, row.lifecycleMode]));
};

const modeOf = async (request: APIRequestContext, sessionId: string) =>
  (await sessionModes(request)).get(sessionId);

/**
 * Reads one session's mode until it is `expected`, and returns whatever it last read.
 *
 * The write this waits for travels the app's own path — the composer's send allocates the session, then asks
 * the server to keep it running — so the two are not adjacent in time. Returning the last reading rather than
 * asserting inside the loop lets the caller print what it actually saw, which is the difference between a red
 * that names the value and one that names an expectation.
 */
const waitForMode = async (
  request: APIRequestContext,
  sessionId: string,
  expected: string,
  budgetMs = 20_000,
): Promise<string> => {
  const deadline = Date.now() + budgetMs;
  let last = await modeOf(request, sessionId);
  while (last !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await modeOf(request, sessionId);
  }
  return last ?? 'undefined';
};

const composer = (page: Page) => page.locator(COMPOSER);

/** The composer's send button, mid-flight state included: `disabled` is the gate this spec is about. */
const submitDisabled = (page: Page) =>
  page.locator(SEND_BUTTON).evaluate((element) => (element as HTMLButtonElement).disabled);

/**
 * Presses send and reports whether the press was accepted.
 *
 * A disabled button is not clickable, so Playwright's actionability check is the reading: it waits for the
 * button to become enabled and gives up. The press is bounded because the answer "it never became enabled" is
 * exactly one of the two outcomes being measured — an unbounded wait would report it as a timeout instead.
 */
const attemptSend = async (page: Page): Promise<'accepted' | 'refused'> => {
  try {
    await page.locator(SEND_BUTTON).click({ timeout: 2_000 });
    return 'accepted';
  } catch {
    return 'refused';
  }
};

/**
 * The seeded project's own row, whichever of the sidebar's two designs is on screen.
 *
 * The sidebar renders a dense button on desktop and a tappable card on a phone; the card's accessible name
 * sits on a heading rather than on the clickable element. Both are targeted so the spec says "open this
 * project" rather than naming markup. Same helper as `e2e/mobile-composer-send-key.spec.ts`.
 */
const projectRow = (page: Page) =>
  page.getByRole('heading', { name: path.basename(workspace) })
    .or(page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }))
    .first();

/** One seeded session's own row in the sidebar. */
const sessionLink = (page: Page, name: string) =>
  page.locator('a[href^="/session/"]').filter({ hasText: name });

/**
 * Opens a composer bound to the seeded project, through the app's own "New Session" entry point.
 *
 * The composer only renders once a project is selected, and the app auto-selects only when the run seeded
 * exactly one project — this run seeds one per spec, so the selection is made the way a user makes it. Same
 * retry loop as `e2e/mobile-composer-send-key.spec.ts`, for the same reason: the project row is a toggle, and
 * a click landing mid-render leaves it collapsed.
 */
const openComposer = async (page: Page) => {
  const textarea = composer(page);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await textarea.isVisible().catch(() => false)) return;

    if (!(await page.getByRole('button', { name: 'Close sidebar' }).isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
    }

    const newSession = page.getByRole('button', { name: 'New Session' }).first();
    if (!(await newSession.isVisible().catch(() => false))) {
      await projectRow(page).click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
  await expect(textarea).toBeVisible({ timeout: 15_000 });
};

/** Expands the seeded project's session list, retrying the toggle the way the sidebar's own spec does. */
const openWorkspace = async (page: Page) => {
  const first = sessionLink(page, SEEDED_SESSION_NAME);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await first.isVisible().catch(() => false)) return;
    await projectRow(page).click({ timeout: 5_000 }).catch(() => undefined);
    try {
      await expect(first).toBeVisible({ timeout: 8_000 });
      return;
    } catch {
      // Collapsed again (or the click missed); the loop clicks once more.
    }
  }
  await expect(first).toBeVisible({ timeout: 15_000 });
};

/** Opens one session row's options menu and waits for its items. */
const openSessionMenu = async (page: Page) => {
  await page.getByRole('button', { name: `Session options for ${SEEDED_SESSION_NAME}` }).click();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  // Onboarding is the expensive part of a fresh database and only happens once for the file.
  test.setTimeout(120_000);
  workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'mobile-send-key-workspace');
  await bootstrapAuth(browser);
});

test('opening the resident switch discloses the mode, gates send, and the ticked send lands resident', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  await page.goto('/');
  await openComposer(page);

  // ── the switch the capability matrix decides ─────────────────────────────────────────────────────────
  const toggle = page.getByRole('switch', { name: enChat.resident.toggle });
  await expect(
    toggle,
    `${RESIDENT_PROVIDER} lists resident in its capability matrix, so the composer must offer the switch`,
  ).toBeVisible({ timeout: 15_000 });
  // The positive side of the matrix reading; the negative side is the next case's.
  console.log('toggle.present=true');
  expect(await toggle.getAttribute('aria-checked'), 'the switch starts off').toBe('false');

  await toggle.click();

  // ── AC2: the disclosure opens in place, and says the two things it has to say ────────────────────────
  const notice = page.locator(NOTICE);
  await expect(notice, 'opening the switch must disclose the mode in place, not on a later screen').toBeVisible();
  const copy = normalize(await notice.innerText());
  console.log('notice.visible=true');
  console.log(`notice.copy=${copy}`);
  expect(
    copy,
    'the disclosure must state what the mode does: the process runs with bypassPermissions between turns',
  ).toContain(normalize(enChat.resident.notice.bypass));
  expect(
    copy,
    'the disclosure must state the trust boundary: the process belongs to this Unix user, so anything else '
      + 'running as that user can reach it',
  ).toContain(normalize(enChat.resident.notice.trustBoundary));

  // ── AC2, load-bearing leg: the unticked box really closes the gate ───────────────────────────────────
  //
  // The composer is given something to send first. An empty composer's send button is disabled for a reason
  // of its own — there is nothing to submit — and a reading taken over it could not tell the consent gate
  // from that. With content present, the consent gate is the only thing left in `disabled`.
  await composer(page).fill('resident consent gate probe');

  const gateBefore = await submitDisabled(page);
  console.log(`gate.before=${gateBefore}`);
  expect(
    gateBefore,
    'with the switch on and "I understand" unticked, the composer\'s send button must be disabled',
  ).toBe(true);

  const pathBefore = new URL(page.url()).pathname;
  const unacked = await attemptSend(page);
  console.log(`send.unacked=${unacked}`);
  console.log(`pathname=${new URL(page.url()).pathname}`);
  expect(
    { pathname: new URL(page.url()).pathname },
    'an un-acknowledged send must open no session — the composer stays in the new-session state',
  ).toEqual({ pathname: pathBefore });

  await page.getByRole('checkbox', { name: enChat.resident.notice.acknowledge }).check();
  const gateAfter = await submitDisabled(page);
  console.log(`gate.after=${gateAfter}`);
  expect(gateAfter, 'ticking "I understand" must open the gate').toBe(false);

  // ── AC3: the send that now goes through really lands as a resident session ───────────────────────────
  await page.locator(SEND_BUTTON).click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const createdSessionId = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`created.sessionId=${createdSessionId}`);

  const createdMode = await waitForMode(request, createdSessionId, 'resident');
  console.log(`session.lifecycle_mode=${createdMode}`);
  expect(
    createdMode,
    'the session a ticked resident send is addressed to must read back as resident from the server',
  ).toBe('resident');

  // POSITIVE CONTROL for that reading: the same field, read the same way, for a session nobody asked to keep
  // running. Without it, a projection that answered `resident` for every row would score the same.
  const control = await request.post('/api/providers/sessions', {
    headers: auth(authToken),
    data: { provider: RESIDENT_PROVIDER, projectPath: workspace, initialMessage: 'per-run control' },
  });
  expect(control.ok(), `POST /api/providers/sessions answered ${control.status()}`).toBe(true);
  const controlSessionId = ((await control.json()) as { data?: { sessionId?: string } }).data?.sessionId as string;
  const controlMode = await modeOf(request, controlSessionId);
  console.log(`control.session.lifecycle_mode=${controlMode}`);
  expect(
    controlMode,
    'a session created without the switch must read per-run — otherwise lifecycle_mode has no resolution',
  ).toBe('per-run');
});

test('the switch is the capability matrix\'s answer rather than a provider id', async ({ page, request }) => {
  const rows = await providerCapabilities(request);
  const resident = rows.filter((row) => row.lifecycleModes?.includes('resident')).map((row) => row.provider);
  const nonResident = rows.filter((row) => !row.lifecycleModes?.includes('resident')).map((row) => row.provider);
  console.log(`capability.residentProviders=${resident.join(',')}`);
  console.log(`capability.nonResidentProviders=${nonResident.join(',')}`);
  expect(resident, 'the matrix must name a resident provider, or the positive leg above proves nothing').not.toHaveLength(0);
  expect(nonResident, 'the matrix must name a non-resident provider, or this leg has nothing to read').not.toHaveLength(0);

  const other = nonResident[0];
  await setSelectedProvider(request, other);

  // The reading below is an absence, and an absence is only worth something if the answer it is the absence of
  // has really arrived: the composer on screen is the one the matrix has already answered for.
  const capabilitiesAnswered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/providers/capabilities',
  );
  await restoreSession(page, other);
  await page.goto('/');
  await openComposer(page);
  await expect(composer(page), 'the composer must be on screen for its absence of a switch to mean anything').toBeVisible();
  expect((await capabilitiesAnswered).ok(), 'the capability request the composer makes must have succeeded').toBe(true);

  const switches = await page.getByRole('switch', { name: enChat.resident.toggle }).count();
  console.log(`toggle.present=${switches > 0}`);
  expect(
    switches,
    `${other} does not list resident in lifecycleModes (${JSON.stringify(
      rows.find((row) => row.provider === other)?.lifecycleModes,
    )}), so the composer must not offer the switch`,
  ).toBe(0);
});

test('the session menu converts through the same disclosure, and is disabled while the session is processing', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);

  // ── THE ONE SEAM IN THIS FILE ────────────────────────────────────────────────────────────────────────
  //
  // `GET /api/providers/sessions/running` is the read-only answer the sidebar derives "processing" from, and
  // the server's own answer comes from the in-flight chat-run registry: a session is in it only while a real
  // model turn is streaming, and no fixture can put it there for the length of an assertion. So this leg
  // states the server's answer directly. It stands in for the *input* to the gate; the gate's own effect —
  // the menu item's `disabled` attribute — and every lifecycle mode below are read from the running app and
  // the real server. `processing` is dropped once the disabled reading has been taken, and the item's return
  // to enabled is then a real response to the real, now-empty, list.
  let processing = true;
  await page.route(RUNNING_SESSIONS, async (route) => {
    if (!processing) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        success: true,
        data: {
          sessions: [
            { sessionId: SEEDED_SESSION_ID, provider: RESIDENT_PROVIDER, startedAt: Date.now(), lastSeq: 1 },
          ],
        },
      },
    });
  });

  await restoreSession(page, RESIDENT_PROVIDER);
  await page.goto('/');
  await openWorkspace(page);

  const modeBefore = await modeOf(request, SEEDED_SESSION_ID);
  expect(modeBefore, `the seeded session must start per-run; the server read ${modeBefore}`).toBe('per-run');

  await openSessionMenu(page);
  const convert = page.getByRole('menuitem', { name: enSidebar.sessionMenu.convertToResident });
  await expect(
    convert,
    `${RESIDENT_PROVIDER} can run resident, so the session menu must offer the conversion`,
  ).toBeVisible();
  console.log('menu.item=present');

  const disabledWhileProcessing = await convert.evaluate((element) => (element as HTMLButtonElement).disabled);
  console.log(`menu.disabledWhenProcessing=${disabledWhileProcessing}`);
  expect(
    disabledWhileProcessing,
    'a session mid-turn must not offer a conversion the server would refuse — the item stays, but unusable',
  ).toBe(true);

  // The session stops processing. The menu is left open: the item's state is what changes, and re-opening a
  // menu would only re-read it. The sidebar polls the running set every 5s, so the bound clears that interval.
  processing = false;
  await expect
    .poll(() => convert.isEnabled(), { timeout: 25_000 })
    .toBe(true);

  // ── AC4: the same disclosure, and the conversion it gates ────────────────────────────────────────────
  await convert.click();
  const notice = page.locator(NOTICE);
  await expect(notice, 'the menu item must open the same disclosure the composer shows').toBeVisible();

  const confirm = page.getByRole('button', { name: enSidebar.sessionMenu.residentConsentConfirm });
  const blockedUntilAck = await confirm.isDisabled();
  console.log(`convert.blockedUntilAck=${blockedUntilAck}`);
  expect(blockedUntilAck, 'the conversion must be shut until "I understand" is ticked').toBe(true);

  const blockedAttempt = await confirm
    .click({ timeout: 2_000 })
    .then(() => 'accepted')
    .catch(() => 'refused');
  const modeAfterBlockedAttempt = await modeOf(request, SEEDED_SESSION_ID);
  console.log(`modeBefore=modeAfter=${modeAfterBlockedAttempt}`);
  expect(
    modeAfterBlockedAttempt,
    `an un-acknowledged conversion must not reach the server (the press was ${blockedAttempt})`,
  ).toBe(modeBefore);

  await page.getByRole('checkbox', { name: enChat.resident.notice.acknowledge }).check();
  await expect(confirm, 'ticking "I understand" must open the conversion').toBeEnabled();
  await confirm.click();

  const converted = await waitForMode(request, SEEDED_SESSION_ID, 'resident');
  console.log(`modeAfterConvert=${converted}`);
  expect(converted, 'the acknowledged conversion must reach the server').toBe('resident');
});
