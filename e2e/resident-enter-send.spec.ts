import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, Page } from '@playwright/test';

/**
 * The shipped English wording, read off the disk rather than restated here.
 *
 * Every string this spec names — the switch, the disclosure and its tick, the send button — is the app's
 * own copy, so a spec that carried its own would keep passing after the locale file changed while the
 * words a user meets did not.
 */
type ChatLocale = {
  resident: { toggle: string; notice: { acknowledge: string } };
  input: { send: string };
};

const enChat = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'), 'utf8'),
) as ChatLocale;

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The subject is the ENTER key path through the composer, read the way a user meets it: a real project from
// the run's own seeded HOME, a real session row allocated by the send the key produced, and the lifecycle
// mode read back from the server the session was addressed to. Nothing here rebuilds the mode client-side —
// `GET /api/session-hosts` is the same projection a restart uses to find a resident session whose process it
// dropped, so the `resident` this spec prints is the server's own stored preference and not the switch's
// local state. The host half is read from the same endpoint's `hosts` array, so "a resident host really
// exists for this session" is the process table's answer, not an inference from the switch.
//
// `e2e/resident-enable-consent.spec.ts` already proves the SEND BUTTON goes through the consent gate and
// lands the session resident. That spec cannot see this defect: it only ever presses the button, while the
// Enter path reached the send directly and skipped both the intent and the gate. This file's whole job is to
// read those two facts off the key.

const COMPOSER = '[data-slot="prompt-input-textarea"]';
/** The composer's send button, named by the shipped label rather than by a hard-coded word. */
const SEND_BUTTON = `button[aria-label="${enChat.input.send}"]`;
/** The disclosure component's own slot — the marker its module declares. */
const NOTICE = '[data-slot="resident-consent-notice"]';
const AUTH_TOKEN_KEY = 'auth-token';
/**
 * The first-paint mirror of the account's preferences, the same key the app writes.
 *
 * `src/shared/userSettings.ts` reads it synchronously so the first render already knows the stored provider;
 * the server's copy is authoritative and is what the legs below write. Priming the mirror removes the one
 * frame in which the composer would be drawing the default provider's capability while the hydrate was in
 * flight.
 */
const PREFERENCES_MIRROR_KEY = 'user-preferences';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The one provider this spec works under: the capability matrix lists `resident` for it. */
const RESIDENT_PROVIDER = 'claude';

/** Absolute path of the workspace playwright.config.ts seeded for its composer specs. */
let workspace = '';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Signs in once for the whole file.
 *
 * Every case gets its own browser context, so the default `page` fixture starts unauthenticated. Re-running
 * onboarding per case would cost more than the whole budget, so the session is captured here and replayed
 * into each context by `restoreSession`. Same helper as `e2e/resident-enable-consent.spec.ts`, including the
 * bounded retry: the first navigation pays for the client's whole module graph, and a loaded host can lose
 * that race and report "element not found" — a red that names nothing the reader can act on.
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

/** Puts the captured session into the context the test's own options already built, mirroring the provider. */
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

/** One host as `GET /api/session-hosts` projects it: enough to say which session a resident process holds. */
type HostRow = { mode: string; state: string; bindings: { appSessionId: string }[] };
/** One session's stored mode, as the same endpoint projects it off the session rows. */
type SessionRow = { appSessionId: string; lifecycleMode: string };

/** The whole listing: both halves of the one endpoint, read together so they cannot disagree. */
const sessionHosts = async (request: APIRequestContext): Promise<{ hosts: HostRow[]; sessions: SessionRow[] }> => {
  const response = await request.get('/api/session-hosts', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/session-hosts answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as { data?: { hosts?: HostRow[]; sessions?: SessionRow[] } };
  return { hosts: body.data?.hosts ?? [], sessions: body.data?.sessions ?? [] };
};

/** Every stored lifecycle mode, keyed by session id. */
const sessionModes = async (request: APIRequestContext): Promise<Map<string, string>> => {
  const { sessions } = await sessionHosts(request);
  return new Map(sessions.map((row) => [row.appSessionId, row.lifecycleMode]));
};

const modeOf = async (request: APIRequestContext, sessionId: string) =>
  (await sessionModes(request)).get(sessionId);

/** The number of session rows the server holds — the reading AC3's "会话总数不变" is a statement about. */
const sessionTotal = async (request: APIRequestContext): Promise<number> =>
  (await sessionHosts(request)).sessions.length;

/** True while some live host holds `sessionId` under the given mode. */
const hostHolds = async (request: APIRequestContext, sessionId: string, mode: string): Promise<boolean> => {
  const { hosts } = await sessionHosts(request);
  return hosts.some(
    (host) => host.mode === mode
      && host.state !== 'closed'
      && host.bindings.some((binding) => binding.appSessionId === sessionId),
  );
};

/**
 * Reads one session's mode until it is `expected`, and returns whatever it last read.
 *
 * The write this waits for travels the app's own path — the composer's send allocates the session, then asks
 * the server to keep it running — so the two are not adjacent in time. Returning the last reading rather
 * than asserting inside the loop lets the caller print what it actually saw, which is the difference between
 * a red that names the value and one that names an expectation.
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

/** Reads the host table until a `mode` host holds `sessionId`, and reports what it last saw. */
const waitForHost = async (
  request: APIRequestContext,
  sessionId: string,
  mode: string,
  budgetMs = 20_000,
): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  let last = await hostHolds(request, sessionId, mode);
  while (!last && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await hostHolds(request, sessionId, mode);
  }
  return last;
};

const composer = (page: Page) => page.locator(COMPOSER);

/** The composer's send button, read the way AC3 compares the key against: `disabled` is the button's gate. */
const submitDisabled = (page: Page) =>
  page.locator(SEND_BUTTON).evaluate((element) => (element as HTMLButtonElement).disabled);

/**
 * The seeded project's own row, whichever of the sidebar's two designs is on screen.
 *
 * The sidebar renders a dense button on desktop and a tappable card on a phone; the card's accessible name
 * sits on a heading rather than on the clickable element. Both are targeted so the spec says "open this
 * project" rather than naming markup. Same helper as `e2e/resident-enable-consent.spec.ts`.
 */
const projectRow = (page: Page) =>
  page.getByRole('heading', { name: path.basename(workspace) })
    .or(page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }))
    .first();

/**
 * Opens a composer bound to the seeded project, through the app's own "New Session" entry point.
 *
 * The composer only renders once a project is selected, and this run seeds more than one project, so the
 * selection is made the way a user makes it. The project row is a toggle, so a click landing mid-render can
 * leave it collapsed; the loop retries. Same helper as `e2e/resident-enable-consent.spec.ts`.
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

/** The switch, once the composer has drawn the capability matrix's answer for the selected provider. */
const residentToggle = (page: Page) => page.getByRole('switch', { name: enChat.resident.toggle });

/**
 * Opens the composer and, when asked, flips the resident switch on and leaves it unticked.
 *
 * The three legs differ only in this prefix, so it lives in one place: the switch OFF is the positive
 * control's state, the switch ON is the gate's, and the tick is what separates AC2 from AC3.
 */
const openResidentComposer = async (page: Page, { switchOn, acknowledge }: { switchOn: boolean; acknowledge?: boolean }) => {
  await page.goto('/');
  await openComposer(page);

  if (!switchOn) return;

  const toggle = residentToggle(page);
  await expect(
    toggle,
    `${RESIDENT_PROVIDER} lists resident in its capability matrix, so the composer must offer the switch`,
  ).toBeVisible({ timeout: 15_000 });
  await toggle.click();
  await expect(page.locator(NOTICE), 'opening the switch must disclose the mode in place').toBeVisible();
  if (acknowledge) {
    await page.getByRole('checkbox', { name: enChat.resident.notice.acknowledge }).check();
  }
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  // Onboarding is the expensive part of a fresh database and only happens once for the file.
  test.setTimeout(120_000);
  workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'mobile-send-key-workspace');
  await bootstrapAuth(browser);
});

test('AC2: Enter with the disclosure ticked allocates a resident session, and a resident host holds it', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  await openResidentComposer(page, { switchOn: true, acknowledge: true });

  const textarea = composer(page);
  await textarea.fill('enter key resident probe');
  await textarea.press('Enter');

  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const createdSessionId = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`created.sessionId=${createdSessionId}`);

  const createdMode = await waitForMode(request, createdSessionId, 'resident');
  console.log(`session.lifecycle_mode=${createdMode}`);
  expect(
    createdMode,
    'the session a ticked Enter send is addressed to must read back as resident from the server — the key '
      + 'reached the send without recording the resident intent it was given',
  ).toBe('resident');

  const heldByResidentHost = await waitForHost(request, createdSessionId, 'resident');
  const { hosts } = await sessionHosts(request);
  console.log(`host.resident.bindsSession=${heldByResidentHost}`);
  console.log(`hosts=${JSON.stringify(hosts.map((host) => ({ mode: host.mode, state: host.state, sessions: host.bindings.map((b) => b.appSessionId) })))}`);
  expect(
    heldByResidentHost,
    'a session stored resident must have a resident host holding it — the mode is the stored wish, the host is '
      + 'the process that is really there',
  ).toBe(true);
});

test('AC3: Enter with the switch on but the disclosure unticked sends nothing and keeps the draft', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  await openResidentComposer(page, { switchOn: true, acknowledge: false });

  const textarea = composer(page);
  const draft = 'enter key gate probe';
  await textarea.fill(draft);

  // The premise the assertion is about: with the switch on and nothing ticked, the composer is in the one
  // state where the consent gate is the ONLY thing that can refuse a send. An empty composer would be
  // refused for a reason of its own and could not witness this gate.
  const gate = await submitDisabled(page);
  console.log(`gate.closed=${gate}`);
  expect(gate, 'with the switch on and the box unticked the send button must be disabled').toBe(true);

  const pathBefore = new URL(page.url()).pathname;
  const totalBefore = await sessionTotal(request);
  console.log(`sessions.before=${totalBefore}`);

  await textarea.press('Enter');
  // The send the buggy key produces is asynchronous (allocate the session, then navigate), so the
  // unchanged readings are taken after a bound that clears that write rather than on the next frame.
  await page.waitForTimeout(1_500);

  const pathAfter = new URL(page.url()).pathname;
  const totalAfter = await sessionTotal(request);
  const valueAfter = await textarea.inputValue();
  console.log(`pathname=${pathAfter}`);
  console.log(`sessions.after=${totalAfter}`);
  console.log(`composer.value=${JSON.stringify(valueAfter)}`);

  expect(
    { pathname: pathAfter },
    'an unticked Enter must open no session — a send here would navigate to the new session row',
  ).toEqual({ pathname: pathBefore });
  expect(
    totalAfter,
    `an unticked Enter must not allocate a session; the server held ${totalBefore} before and ${totalAfter} after`,
  ).toBe(totalBefore);
  expect(
    valueAfter,
    'an unticked Enter must keep the draft — a send would have cleared the composer',
  ).toBe(draft);
});

test('AC4: Enter with the switch off still sends, and lands per-run', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  // No switch interaction at all: this is the shape every non-resident send has always had.
  await openResidentComposer(page, { switchOn: false });

  const textarea = composer(page);
  await textarea.fill('enter key per-run control');
  await textarea.press('Enter');

  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const createdSessionId = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`control.sessionId=${createdSessionId}`);

  const createdMode = await waitForMode(request, createdSessionId, 'per-run');
  console.log(`control.lifecycle_mode=${createdMode}`);
  expect(
    createdMode,
    'a session created with the switch off must read per-run — otherwise the resident reading above has no '
      + 'resolution and would score the same for every session',
  ).toBe('per-run');
});
