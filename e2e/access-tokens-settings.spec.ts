import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// This criterion drives the Settings → "API & Tokens" page the way a user does and reads back what the browser
// really rendered and what the running server really answered. Nothing is stubbed: the token is created through
// the form, revoked through the list row, and the only out-of-band calls are the two real HTTP requests to
// `/api/oauth/token-info` that prove the token is accepted while live and rejected once revoked.
//
// The startup path is bounded in the same two levers its sibling specs use (`e2e/session-filter.spec.ts`,
// `e2e/model-library.spec.ts`): a client warm-up before any page exists, and a bounded navigation guard. Neither
// guard decides anything for the case — a navigation that cannot land ends the run with the page's own evidence.

/** A personal access token is `ccp_` plus 32 random bytes rendered as 64 hex digits. */
const PLAINTEXT_PATTERN = /^ccp_[0-9a-f]{64}$/;
/** Namespaced i18n keys leak into the UI as literals like "settings.accessTokens.title" when a translation is missing. */
const UNTRANSLATED_KEY = /\b(?:mainTabs|settings|chat|common|sidebar)\.[a-z][A-Za-z]+\b/;
/** The old API-key entry point's button text (`apiKeys.newButton`), which must no longer render anywhere. */
const RETIRED_BUTTON_TEXT = 'New API Key';
/** The old API-key documentation link target, which must no longer be rendered on the page. */
const RETIRED_DOCS_PATH = 'api-docs.html';

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;
/** How long this run's client is given to answer its app entry before the startup path gives up on it. */
const CLIENT_WARM_DEADLINE_MS = 30_000;
/** How long the landing of the first navigation is given on its own, before the guard starts replaying. */
const STARTUP_PROBE_MS = 8_000;
/** How long each bounded replay's landing is given; shorter than the first, because a replay is a re-ask, not a cold boot. */
const STARTUP_RELOAD_PROBE_MS = 3_000;
/** How long one navigation's own request is given before the guard treats it as a failed landing. */
const NAVIGATION_PROBE_MS = 8_000;
/** The sum the startup path may spend proving a navigation landed, replays included. */
const STARTUP_PROBE_DEADLINE_MS = 14_000;

/**
 * Takes this run's first dependency optimization out of the measurement window: the shell, the app entry and one
 * optimized dependency, all requested before any page of this run exists. A 200 on the dependency url only comes
 * once the optimizer has committed the bundle, so the page below does not race a re-optimization that would serve
 * it a superseded url. Every step is bounded; a client that accepts the connection and never answers fails here.
 */
const warmClientStartup = async (clientUrl: string): Promise<number> => {
  const startedAt = Date.now();
  const deadline = startedAt + CLIENT_WARM_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs());
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (error) {
      throw new Error(
        `the client did not answer ${url} inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget `
        + `(${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const shellUrl = new URL('/', clientUrl).href;
  const shell = await fetchWithin(shellUrl);
  if (!shell.ok) throw new Error(`the client's shell did not load: ${shellUrl} answered HTTP ${shell.status}`);
  await shell.text();

  const entryUrl = new URL('/src/main.tsx', clientUrl).href;
  const entry = await fetchWithin(entryUrl);
  if (!entry.ok) throw new Error(`the app entry did not transform: ${entryUrl} answered HTTP ${entry.status}`);
  await entry.text();

  let lastAnswer = 'no dependency url was ever served';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await (await fetchWithin(entryUrl)).text())?.[1];
    if (!specifier) break;
    const depUrl = new URL(specifier, clientUrl).href;
    const dep = await fetchWithin(depUrl);
    if (dep.ok) {
      console.log(`[e2e] client warm-up: pre-bundle committed in ${Date.now() - startedAt}ms`);
      return Date.now() - startedAt;
    }
    lastAnswer = `${depUrl} answered HTTP ${dep.status}`;
    await dep.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `this run's dependency pre-bundle never committed, so the criterion cannot drive a document that stays: `
    + lastAnswer,
  );
};

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/** What a guarded navigation is expected to land on — and how the guard names it when it never lands. */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('personal access tokens in settings', () => {
  let page: Page;
  const startupEvidence = {
    consoleErrors: [] as string[],
    failedRequests: [] as string[],
  };

  const settingsButton = () => page.getByRole('button', { name: 'Settings', exact: true }).first();
  const apiTokensTab = () => page.getByRole('button', { name: 'API & Tokens', exact: true });
  const tokensHeading = () => page.getByRole('heading', { name: 'Personal Access Tokens' });
  const tokenRow = (name: string) => page.getByTestId('access-token-row').filter({ hasText: name });

  /** Unreadable evidence is still evidence: what the page said when a startup landing never arrived. */
  const readStartupEvidence = async (): Promise<string> => {
    const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
    const errors = startupEvidence.consoleErrors.slice(0, 5);
    const failed = startupEvidence.failedRequests.slice(0, 5);
    return `the page shows ${JSON.stringify(shown.slice(0, 300))}`
      + `; console errors: ${errors.length > 0 ? errors.join(' | ') : '<none>'}`
      + `; failed requests: ${failed.length > 0 ? failed.join(' | ') : '<none>'}`;
  };

  /**
   * The one place this spec navigates: navigate, probe the landing with a short budget, and on a missed landing
   * replay the navigation (a fresh document, which recovers from module requests interrupted once) until the
   * deadline. A probe that cannot land ends the run here with a cause rather than letting the case wait out its
   * own budget on a blank page.
   */
  const navigateBounded = async (landing: StartupLanding, kind: 'first-load' | 'replay'): Promise<void> => {
    const startedAt = Date.now();
    const deadline = startedAt + STARTUP_PROBE_DEADLINE_MS;
    const budgetMs = () => Math.max(1, deadline - Date.now());
    let navigationFailure: string | null = null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (attempt === 1 && kind === 'first-load') {
          await page.goto('/', { timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()) });
        } else {
          await page.reload({ timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()) });
        }
        navigationFailure = null;
      } catch (error) {
        navigationFailure = error instanceof Error ? error.message : String(error);
      }
      const landingBudget = Math.min(attempt === 1 ? STARTUP_PROBE_MS : STARTUP_RELOAD_PROBE_MS, budgetMs());
      if (await landing.present(landingBudget)) {
        console.log(`[e2e] startup: ${landing.label()} landed after ${Date.now() - startedAt}ms (attempt ${attempt})`);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${landing.label()} never rendered, so this run's client never came up to a document that stays`
          + `${navigationFailure === null ? '' : ` (the navigation itself failed: ${navigationFailure})`}`
          + `: ${await readStartupEvidence()}`,
        );
      }
    }
  };

  /** What the first navigation must land on: the fresh database's account form or the app shell, whichever this run has. */
  const FIRST_LANDING: StartupLanding = {
    label: () => 'the account form or the app shell',
    present: async (budgetMs) =>
      (await appears(page.locator('#username'), budgetMs)) || (await appears(settingsButton(), budgetMs)),
  };

  /**
   * What every later navigation must land on: the app shell's Settings button. The shell's first paint renders it
   * before any of this spec's own data, so a landing here proves the document mounted — the property the guard is
   * about — and not that a particular read happened to arrive.
   */
  const APP_SHELL_LANDING: StartupLanding = {
    label: () => 'the app shell (Settings button)',
    present: (budgetMs) => appears(settingsButton(), budgetMs),
  };

  /** Opens Settings → API & Tokens, so the token section's own heading is on screen. */
  const openAccessTokensTab = async (): Promise<void> => {
    await settingsButton().click();
    await expect(apiTokensTab()).toBeVisible({ timeout: 15_000 });
    await apiTokensTab().click();
    await expect(tokensHeading()).toBeVisible({ timeout: 15_000 });
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) {
      throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up to address');
    }
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    // The revoke flow confirms through `window.confirm`; accept it so the DELETE really runs.
    page.on('dialog', (dialog) => { void dialog.accept(); });
    page.on('console', (message) => {
      if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });

    // First run on a fresh database: create the single account, then finish onboarding. Tolerant of an existing
    // account so the spec also runs against a database another spec in the same invocation signed into.
    await navigateBounded(FIRST_LANDING, 'first-load');
    if (await page.locator('#username').count()) {
      await page.locator('#username').fill('e2euser');
      await page.locator('input[type=password]').nth(0).fill('e2epassword');
      await page.locator('input[type=password]').nth(1).fill('e2epassword');
      await page.getByRole('button', { name: 'Create Account' }).click();
      await page.getByPlaceholder('John Doe').fill('E2E User');
      await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Complete Setup' }).click();
    }
    await expect(settingsButton()).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('creates a token once, hides its plaintext after reload, offers exactly 7/30/90, and revocation really rejects it', async () => {
    const serverBase = `http://127.0.0.1:${process.env.QUAY_E2E_SERVER_PORT}`;
    /** The real HTTP self-check a client makes with the token itself as the credential. */
    const tokenInfo = (token: string) =>
      fetch(`${serverBase}/api/oauth/token-info`, { headers: { authorization: `Bearer ${token}` } });

    await openAccessTokensTab();

    // (c) The lifetime dropdown offers exactly 7/30/90 and defaults to 30.
    await page.getByRole('button', { name: 'New Token', exact: true }).click();
    const expiry = page.getByTestId('access-token-expiry');
    await expect(expiry).toBeVisible();
    const optionValues = await expiry.evaluate((node) =>
      Array.from((node as HTMLSelectElement).options).map((option) => option.value));
    const defaultExpiry = await expiry.inputValue();
    console.log(`(c) option values = ${JSON.stringify(optionValues)}; default = ${defaultExpiry}`);
    expect([...optionValues].sort()).toEqual(['30', '7', '90']);
    expect(defaultExpiry).toBe('30');

    // (a) Create through the form and capture the one-time plaintext the response carries.
    const tokenName = `e2e-token-${Date.now()}`;
    await page.getByPlaceholder('Token name (e.g., My MCP client)').fill(tokenName);
    await expiry.selectOption('30');
    const [createResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/settings/access-tokens')),
      page.getByRole('button', { name: 'Create token', exact: true }).click(),
    ]);
    const plaintext = (await page.getByTestId('new-access-token-plaintext').innerText()).trim();
    console.log(`(a) POST /api/settings/access-tokens -> ${createResponse.status()}; plaintext matches ccp_<64 hex> = ${PLAINTEXT_PATTERN.test(plaintext)}`);
    expect(createResponse.status()).toBe(201);
    expect(plaintext).toMatch(PLAINTEXT_PATTERN);
    const prefix = plaintext.slice(0, 8);
    expect(prefix).toHaveLength(8);
    await expect(tokenRow(tokenName)).toHaveCount(1);
    const tokenId = await tokenRow(tokenName).getAttribute('data-token-id');
    expect(tokenId).toBeTruthy();

    // (d) While live, the token really authenticates against the running server.
    const liveResponse = await tokenInfo(plaintext);
    const liveBody = await liveResponse.json() as { userId: number; scopes: string[]; expiresAt: string };
    console.log(`(d) token-info with the live token -> ${liveResponse.status}; userId=${liveBody.userId} scopes=${JSON.stringify(liveBody.scopes)} expiresAt=${liveBody.expiresAt}`);
    expect(liveResponse.status).toBe(200);
    expect(typeof liveBody.userId).toBe('number');
    expect(Array.isArray(liveBody.scopes)).toBe(true);
    expect(typeof liveBody.expiresAt).toBe('string');

    // (b) A reload drops the one-time plaintext from the document entirely, leaving prefix and name.
    await navigateBounded(APP_SHELL_LANDING, 'replay');
    await openAccessTokensTab();
    const reloadedRow = tokenRow(tokenName);
    await expect(reloadedRow).toHaveCount(1);
    await expect(reloadedRow).toContainText(prefix);
    await expect(reloadedRow).toContainText(tokenName);
    const documentContent = await page.content();
    const documentText = await page.locator('body').innerText();
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));
    const documentHits = documentContent.split(plaintext).length - 1;
    const textHits = documentText.split(plaintext).length - 1;
    console.log(`(b) after reload: plaintext hits in content = ${documentHits}, in body.innerText = ${textHits}, in localStorage = ${storageDump.local.includes(plaintext)}, in sessionStorage = ${storageDump.session.includes(plaintext)}; row shows prefix "${prefix}" and name "${tokenName}"`);
    expect(documentHits).toBe(0);
    expect(textHits).toBe(0);
    expect(storageDump.local.includes(plaintext)).toBe(false);
    expect(storageDump.session.includes(plaintext)).toBe(false);

    // (d) Revoke through the row, confirm, and prove the server now rejects the same token.
    await reloadedRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(tokenRow(tokenName)).toContainText('Revoked', { timeout: 15_000 });

    await navigateBounded(APP_SHELL_LANDING, 'replay');
    await openAccessTokensTab();
    const revokedRow = tokenRow(tokenName);
    await expect(revokedRow).toHaveCount(1);
    await expect(revokedRow).toContainText('Revoked');
    const revokedResponse = await tokenInfo(plaintext);
    console.log(`(d) after revoke: id=${tokenId} row still present and marked Revoked; token-info -> ${revokedResponse.status}`);
    expect(revokedResponse.status).toBe(401);

    // (e) The retired API-key entry point is gone: no old button text, no docs link, no anchor to it.
    const finalText = await page.locator('body').innerText();
    const docsAnchors = await page.locator('a[href*="api-docs.html"]').count();
    console.log(`(e) body.innerText contains "${RETIRED_BUTTON_TEXT}" = ${finalText.includes(RETIRED_BUTTON_TEXT)}; contains "${RETIRED_DOCS_PATH}" = ${finalText.includes(RETIRED_DOCS_PATH)}; anchors to it = ${docsAnchors}`);
    expect(finalText).not.toContain(RETIRED_BUTTON_TEXT);
    expect(finalText).not.toContain(RETIRED_DOCS_PATH);
    expect(docsAnchors).toBe(0);

    // No untranslated i18n literal anywhere on the page — the settings tab included.
    expect(finalText).not.toMatch(UNTRANSLATED_KEY);
  });
});
