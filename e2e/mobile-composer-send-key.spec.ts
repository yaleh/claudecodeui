import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The shipped English strings, read off the disk rather than restated here.
 *
 * A spec that hard-coded "Enter to send" would keep passing after the locale file changed, and the whole
 * point of these assertions is that the hint the user reads is the one the app ships.
 */
const enChat = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'),
    'utf8',
  ),
) as { input: { hintText: { enter: string; touch: string } } };

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data
// dir). Nothing here stubs a media query, a keyboard event or an API response: the device the browser
// reports is the device the app reads, the key press is a real one, and the message the button sends
// really opens a session.
//
// This spec is the only place the media query STRING is proven. A jsdom test cannot implement media
// queries, so `src/modules/chat/tests/sendOnEnter.test.tsx` proves the policy against a double; whether
// `(pointer: coarse) and (hover: none)` is what a touch device really answers can only be read here.

/**
 * The touch-only signal the composer must gate on, both halves required.
 *
 * `'ontouchstart' in window` is NOT the same question — it is false under this emulation, so a spec (or
 * a hook) sniffing for it would read a touch device as a keyboard one.
 */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';
const COMPOSER = '[data-slot="prompt-input-textarea"]';
const SEND_BUTTON = 'button[aria-label="Send"]';
const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The stored preference must outlive a debounced push before the "after" reading is taken. */
const PREFERENCE_WRITE_SETTLE_MS = 900;

/**
 * Both legs share one `DATABASE_PATH` (playwright.config.ts sets one for the whole run), so the account
 * is created at most once and every later navigation logs in instead. Same helper as
 * e2e/model-library-layout.spec.ts, for the same reason.
 */
const ensureSignedIn = async (page: Page) => {
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible();
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
/** Absolute path of the workspace playwright.config.ts seeded for this spec. */
let workspace = '';

/**
 * Signs in once for the whole file.
 *
 * `test.use({ hasTouch, isMobile, viewport })` is per-describe, so each leg gets its own browser context
 * and the default `page` fixture starts unauthenticated. Re-running onboarding per leg would cost more
 * than the whole budget, so the session is captured here and replayed into each leg by `restoreSession`.
 */
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

/** Puts the captured session into a context that the `test.use` options already built. */
const restoreSession = async (page: Page) => {
  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);
};

/**
 * Records every keydown the composer really saw, as the LAST listener in the chain.
 *
 * React 18 attaches its handler to the root container, which is inside the document, so a bubble-phase
 * listener on `window` runs after it and reads the `defaultPrevented` the app left behind — the same
 * reading the task's matrix is written in.
 */
const installKeyProbe = async (page: Page) => {
  await page.addInitScript(() => {
    const readings: { key: string; shiftKey: boolean; ctrlKey: boolean; defaultPrevented: boolean }[] = [];
    (window as unknown as { __keyReadings: typeof readings }).__keyReadings = readings;
    window.addEventListener('keydown', (event) => {
      readings.push({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        defaultPrevented: event.defaultPrevented,
      });
    });
  });
};

const keyReadings = (page: Page) =>
  page.evaluate(() => (window as unknown as {
    __keyReadings: { key: string; shiftKey: boolean; ctrlKey: boolean; defaultPrevented: boolean }[];
  }).__keyReadings);

const composer = (page: Page) => page.locator(COMPOSER);

/**
 * The project's own row, whichever of the sidebar's two designs is on screen.
 *
 * The sidebar renders a dense button on desktop and a tappable card on a phone; only the card exists at
 * 390px, and its accessible name sits on a heading rather than on the clickable div. Both are targeted so
 * the spec says "open this project" rather than "click this markup".
 */
const projectToggle = (page: Page) =>
  page.getByRole('heading', { name: path.basename(workspace) })
    .or(page.getByRole('button', {
      name: new RegExp(`^${path.basename(workspace).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    }))
    .first();

/**
 * Opens a composer bound to the seeded project, through the app's own "New Session" entry point.
 *
 * The composer only renders once a project is selected, and the app auto-selects only when the run seeded
 * exactly one project — this one seeds five, so the selection has to be made the way a user makes it. On a
 * phone the sidebar is a drawer behind the menu button; on desktop both of those controls are absent and
 * the sidebar is already docked.
 */
const openComposer = async (page: Page) => {
  const textarea = composer(page);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await textarea.isVisible().catch(() => false)) return;

    // `Open menu` is still "visible" to Playwright while the drawer covers it, so the drawer's own
    // backdrop — labelled "Close sidebar" — is what says whether it is already open.
    if (!(await page.getByRole('button', { name: 'Close sidebar' }).isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
    }

    const newSession = page.getByRole('button', { name: 'New Session' }).first();
    if (!(await newSession.isVisible().catch(() => false))) {
      // The row is a toggle, so a click landing mid-render can leave it collapsed; the loop retries.
      await projectToggle(page).click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
  await expect(textarea).toBeVisible({ timeout: 15_000 });
};

/** The hint line, its text and the computed styles that decide whether a user can read it. */
const readHint = (page: Page) =>
  page.locator('div.basis-full').evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { text: element.textContent, display: style.display, opacity: style.opacity };
  });

/** The media features the browser really reports, so a failed premise says which half was wrong. */
const readMediaFeatures = (page: Page, query: string) =>
  page.evaluate((touchQuery) => ({
    touchOnly: window.matchMedia(touchQuery).matches,
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    hoverNone: window.matchMedia('(hover: none)').matches,
    // The sniff the task warns about: false here, so it cannot stand in for the query above.
    ontouchstart: 'ontouchstart' in window,
    innerWidth: window.innerWidth,
  }), query);

/** What the account has stored, both raw and as the client reads it. */
type StoredSendKey = { raw: unknown; enabled: boolean };

/**
 * The preference lives at `preferences.uiPreferences.sendByCtrlEnter`, and an absent key means the user
 * never changed it — which the client reads as its default, off. Both are reported so the evidence shows
 * the raw value rather than only the normalised one.
 */
const readStoredSendKey = async (page: Page): Promise<StoredSendKey> => {
  const raw = await page.evaluate(async ([key]) => {
    const response = await window.fetch('/api/user/preferences', {
      headers: { Authorization: `Bearer ${window.localStorage.getItem(key) ?? ''}` },
    });
    const body = (await response.json()) as {
      preferences?: { uiPreferences?: { sendByCtrlEnter?: unknown } };
    };
    return body.preferences?.uiPreferences?.sendByCtrlEnter;
  }, [AUTH_TOKEN_KEY] as const);
  return { raw, enabled: raw === true };
};

/** Every `GET /api/user/preferences` the app itself made on this page, oldest first. */
const recordPreferenceReads = (page: Page): StoredSendKey[] => {
  const reads: StoredSendKey[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/api/user/preferences') return;
    if (response.request().method() !== 'GET') return;
    void response
      .json()
      .then((body: { preferences?: { uiPreferences?: { sendByCtrlEnter?: unknown } } }) => {
        const raw = body.preferences?.uiPreferences?.sendByCtrlEnter;
        reads.push({ raw, enabled: raw === true });
      })
      .catch(() => undefined);
  });
  return reads;
};

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeAll(async ({ browser }) => {
  workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'mobile-send-key-workspace');
  await bootstrapAuth(browser);
});

test.describe('the composer send key on a touch-only device', () => {
  // Viewport and touch come from ONE place on purpose. `page.setViewportSize` flips the width but not
  // the pointer media features, and a CDP metrics override outlives its session while touch emulation
  // does not — splitting them across two calls is how a 1280px-wide viewport ends up being measured as
  // a phone. The premise assertion below is what makes that mistake fail instead of pass.
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('Enter breaks the line, the button sends, and the preference is untouched', async ({ page }) => {
    const preferenceReads = recordPreferenceReads(page);
    await restoreSession(page);
    await installKeyProbe(page);
    await page.goto('/');
    await openComposer(page);

    // PREMISE, asserted before any behaviour: without this the whole leg passes on a desktop config.
    const features = await readMediaFeatures(page, TOUCH_ONLY_QUERY);
    expect(
      features.touchOnly,
      `this leg needs a touch-only device; ${TOUCH_ONLY_QUERY} read ${JSON.stringify(features)}`,
    ).toBe(true);
    expect(
      features.pointerCoarse && features.hoverNone,
      `both halves of the query must hold; the features read ${JSON.stringify(features)}`,
    ).toBe(true);

    // PREMISE for the reading itself: with the preference already on, Enter breaks the line on any
    // device and the three assertions below would pass without the touch gate existing at all.
    await expect.poll(() => preferenceReads.length).toBeGreaterThan(0);
    const storedBefore = await readStoredSendKey(page);
    console.log('PREFERENCE before', JSON.stringify(storedBefore));
    expect(
      storedBefore.enabled,
      'this leg measures what a touch device does with the preference OFF; the account has '
        + `sendByCtrlEnter=${JSON.stringify(storedBefore.raw)}`,
    ).toBe(false);

    const textarea = composer(page);

    // 1. The defect itself: Enter with text typed used to send the message. It now adds exactly one line
    //    break and stays put. This is the assertion the anti-fake variant is required to redden.
    await textarea.fill('hello');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue('hello\n');
    expect(
      { pathname: new URL(page.url()).pathname },
      'Enter must break the line on a touch device, not submit',
    ).toEqual({ pathname: '/' });

    // 2. The dead key. Return used to send, and with nothing typed it did nothing at all; it is now the
    //    newline key, so an empty input gains exactly one line break.
    await textarea.fill('');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue('\n');
    expect(
      { pathname: new URL(page.url()).pathname },
      'an empty Enter must not send: no session may be opened by it',
    ).toEqual({ pathname: '/' });

    const afterEnter = await keyReadings(page);
    console.log('TOUCH Enter readings', JSON.stringify(afterEnter));
    expect(
      afterEnter.filter((reading) => reading.key === 'Enter' && !reading.shiftKey && !reading.ctrlKey),
      'neither Enter press may reach the app un-prevented — that is what "Enter sends" looked like',
    ).toEqual([
      expect.objectContaining({ defaultPrevented: false }),
      expect.objectContaining({ defaultPrevented: false }),
    ]);

    // POSITIVE CONTROL: the hint is driven by a live `change` listener, not by one first-frame read.
    // The input is cleared so the hint is at full opacity while it is being read.
    await textarea.fill('');
    const touchHint = await readHint(page);
    await page.locator(SEND_BUTTON).waitFor({ state: 'attached' });

    const cdp = await page.context().newCDPSession(page);
    const setTouchEmulation = async (enabled: boolean) => {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled, maxTouchPoints: enabled ? 5 : 1 });
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 1, mobile: enabled,
      });
    };

    await setTouchEmulation(false);
    await expect.poll(
      async () => (await readHint(page)).text,
      { message: 'unplugging the touch device must hand the hint back to the keyboard wording' },
    ).toBe(enChat.input.hintText.enter);
    const flippedToKeyboard = await readHint(page);
    console.log('HINT after touch→keyboard flip', JSON.stringify(flippedToKeyboard));

    await setTouchEmulation(true);
    await expect.poll(
      async () => (await readHint(page)).text,
      { message: 'plugging the touch device back in must restore the touch wording' },
    ).toBe(enChat.input.hintText.touch);
    const flippedBack = await readHint(page);
    console.log('HINT after keyboard→touch flip', JSON.stringify(flippedBack));

    expect(
      { touch: touchHint.text, keyboard: flippedToKeyboard.text, back: flippedBack.text },
      'the hint must follow the device in both directions without a reload',
    ).toEqual({
      touch: enChat.input.hintText.touch,
      keyboard: enChat.input.hintText.enter,
      back: enChat.input.hintText.touch,
    });
    // The touch hint used to be `hidden lg:block`, i.e. `display: none` at every width below 1024px —
    // which is every phone and tablet. The keyboard hint keeps that hiding on purpose, which is what makes
    // the touch reading evidence rather than an artefact of deleting the class everywhere.
    expect(
      { touch: touchHint.display, keyboard: flippedToKeyboard.display, back: flippedBack.display },
      `the touch hint must be laid out at 390px while the keyboard one stays hidden: ${JSON.stringify({ touchHint, flippedToKeyboard })}`,
    ).toEqual({ touch: 'block', keyboard: 'none', back: 'block' });
    expect(
      { opacity: touchHint.opacity },
      `the touch hint must be at full opacity while the input is empty: ${JSON.stringify(touchHint)}`,
    ).toEqual({ opacity: '1' });

    // 3. The button is the only way out, and it really opens a session.
    await textarea.fill('hello again');
    await page.locator(SEND_BUTTON).click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);

    // POSITIVE CONTROL for "the device judgement wrote nothing back": an independent GET of the same
    // account preference, after the write debounce has had time to fire.
    await page.waitForTimeout(PREFERENCE_WRITE_SETTLE_MS);
    const storedAfter = await readStoredSendKey(page);
    console.log('PREFERENCE readings', JSON.stringify({ before: storedBefore, after: storedAfter }));
    expect(
      storedAfter,
      'the touch leg must leave the account preference exactly as it found it — the device decides its own '
        + `Enter behaviour and writes nothing back. Before: ${JSON.stringify(storedBefore)}`,
    ).toEqual(storedBefore);
    expect(
      preferenceReads.map((read) => read.enabled),
      `no GET /api/user/preferences this page made may report the preference on: ${JSON.stringify(preferenceReads)}`,
    ).toEqual(preferenceReads.map(() => false));
  });
});

test.describe('the composer send key on a device with a keyboard', () => {
  test('Enter submits, Shift+Enter breaks the line, and an empty Enter stays a dead key', async ({ page }) => {
    const preferenceReads = recordPreferenceReads(page);
    await restoreSession(page);
    await installKeyProbe(page);
    await page.goto('/');
    await openComposer(page);

    // PREMISE: this leg is the desktop reading, so the same query must be false here — it is what makes
    // the touch leg above evidence of anything.
    const features = await readMediaFeatures(page, TOUCH_ONLY_QUERY);
    expect(
      features.touchOnly,
      `this leg needs a keyboard device; ${TOUCH_ONLY_QUERY} read ${JSON.stringify(features)}`,
    ).toBe(false);

    await expect.poll(() => preferenceReads.length).toBeGreaterThan(0);
    const stored = await readStoredSendKey(page);
    console.log('KEYBOARD preference', JSON.stringify(stored));
    expect(
      stored.enabled,
      'this leg measures the default send key; the account has '
        + `sendByCtrlEnter=${JSON.stringify(stored.raw)}. A touch leg that wrote its device setting back into `
        + 'the account would show up right here.',
    ).toBe(false);

    const textarea = composer(page);

    // The empty-input dead key, unchanged by this task: Enter is swallowed and nothing happens.
    await textarea.click();
    await page.keyboard.press('Enter');
    await expect(textarea).toHaveValue('');
    expect(
      { pathname: new URL(page.url()).pathname },
      'an empty Enter on desktop is a dead key — it must neither send nor insert',
    ).toEqual({ pathname: '/' });

    // Shift+Enter is the newline key, and it is the browser's own default action, not the app's.
    await textarea.fill('line one');
    await textarea.press('Shift+Enter');
    await expect(textarea).toHaveValue('line one\n');
    expect(
      { pathname: new URL(page.url()).pathname },
      'Shift+Enter must not submit',
    ).toEqual({ pathname: '/' });

    // Plain Enter does submit.
    await textarea.press('Enter');
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);

    const readings = await keyReadings(page);
    console.log('KEYBOARD Enter readings', JSON.stringify(readings));
    expect(
      readings.filter((reading) => reading.key === 'Enter'),
      'exactly the two bare Enters are the app\'s to decide; Shift+Enter is the browser\'s default',
    ).toEqual([
      expect.objectContaining({ shiftKey: false, ctrlKey: false, defaultPrevented: true }),
      expect.objectContaining({ shiftKey: true, ctrlKey: false, defaultPrevented: false }),
      expect.objectContaining({ shiftKey: false, ctrlKey: false, defaultPrevented: true }),
    ]);
  });
});
