/**
 * The mobile workspace header and composer layout, read as a matrix in a real Chromium.
 *
 * Four implementation tasks each promised a shape for one part of the mobile chrome: the workspace header collapses
 * to a single row with one selector instead of a tablist, the composer footer stays on one line with everything
 * else behind a "more" menu, a recording's replay pair gets its own row *below* the textarea rather than pushing
 * the footer apart, and the running state shows exactly one interrupt control instead of two. Each of those was
 * read once, by hand, while it was being built. This file is the permanent reading: six viewports on both sides of
 * the 768 breakpoint, four states each, in one run against the real backend and the real Vite client.
 *
 * Why a matrix rather than one case per shape: the shapes are conditions, not constants. A bound like "the footer
 * may be 57px" is only meaningful at the width where the layout is supposed to be single-row, and a rule like
 * "the replay pair sits below the footer" is only meaningful once a clip exists. So each cell declares its width
 * and its state, asserts the *premise* that would make its reading meaningless (the viewport really is that wide,
 * the running state really appeared, both clips really exist), and only then asserts the geometry — a cell that
 * skipped the premise would pass against a clamped viewport or a recording that never produced a clip.
 *
 * Nothing here is a stand-in for the app. The recordings are real: Chromium is launched with a fake audio device
 * whose samples come from the WAV `playwright.config.ts` writes before the servers boot, the app's own recorder
 * and trim run, and the recogniser is a local HTTP server answering `/audio/transcriptions` the way the shipped
 * voice-trim spec does. The running state is the one exception, and it is a stand-in for the *transport*, never
 * for the consumer: an init script wraps `window.WebSocket` and hands the app one frame on its own chat socket,
 * exactly the frame shape the server sends (`kind: 'status'` with `canInterrupt`), so what the cells read is the
 * app's own reaction to a real frame arriving on a real socket.
 *
 * The readings are Chromium's viewport and touch emulation, not a real device, and the PWA safe-area inset is not
 * in effect in headless: `MOBILE_HEADER_MAX` is the bound *without* a safe area.
 *
 * Two measurement traps this file has to avoid, both found by reading the app rather than assuming it:
 *
 * The recogniser stand-in has to answer. With a base URL that refuses the connection, the app renders its voice
 * error notice inside the footer's right-hand control cluster, which grows the footer's scroll extent by 32px at
 * 320 — a *failing backend* moving the very number `noOverflow` asserts. A dead recogniser would red this matrix
 * for a reason that has nothing to do with layout, so the stand-in answers every transcription.
 *
 * The workspace dialog animates in. Radix mounts it with an entrance scale, so a reading taken on the first visible
 * frame measures the animation instead of the layout: the probe caught a 44px entry at 42.24px (44 x 0.96) and an
 * earlier one at 43px, either of which reads as a touch target below the declared minimum. The dialog's entries are
 * therefore polled until they settle before their height is used as a touch-target reading.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
/** The fake microphone's samples, written by the config before the browser was launched. */
const AUDIO_FILE = process.env.QUAY_E2E_VOICE_TRIM_AUDIO!;
/** The fixture's own duration, derived by the config from the samples it wrote. */
const FIXTURE_SEC = Number(process.env.QUAY_E2E_VOICE_TRIM_FIXTURE_SEC);
/** One pass of the fixture, so the trim has a pause inside the window to remove. */
const CAPTURE_MS = Math.round(FIXTURE_SEC * 1000);

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/** The seeded long-title session the mobile cells read; its workspace is seeded by the config before boot. */
const MOBILE_SESSION = 'e2e-mobile-layout';
/**
 * The language the mobile cells read, chosen for its long tab labels rather than its own sake.
 *
 * The desktop cells read it too: the language a document ends up with is decided by whichever preference reaches the
 * server first, so a run that mixes languages across cells is reading a moving target. One language for the whole
 * matrix also means the baseline commit's narrowed desktop-only run reads the same bundle, which is what makes the
 * two sets of boxes comparable at all.
 */
const MOBILE_LANGUAGE = 'de';

/**
 * The three controls the mobile layout moved out of the footer and behind the `more` menu, under the names the
 * German bundle renders for them — read off the running app, not translated here. The German bundle has no `misc`
 * entries, so the token-usage label stays English at `de`; both cells assert the same three strings, the mobile ones
 * that the footer does not have them and the desktop ones that it does.
 */
const FOOTER_ONLY_CONTROLS = ['Alle Befehle anzeigen', 'Show token usage', 'Nachricht planen'];
/**
 * The pre-existing session the desktop cells read.
 *
 * Pre-existing on purpose: the desktop half of this matrix has to be readable on a baseline commit that predates
 * this task's fixtures as well, which is what makes the two readings comparable at all.
 */
const DESKTOP_SESSION = 'e2e-voice-trim';

/**
 * A model whose *label* is long — the default entry is `Default (recommended)`, which is short enough to hide an
 * overflow that a real model name would cause.
 *
 * Created through the provider API for the duration of the run and deleted again at the end: the model library
 * spec asserts the number of rows it finds, so a row left behind by this file is a red in another file.
 */
const LONG_MODEL_ID = 'e2e-layout-long-model';
const LONG_MODEL_LABEL = 'claude-sonnet-4-5-20250929';

/**
 * The header bound at mobile widths, with no PWA safe-area inset (headless has none) — 56px is the implementation
 * task's own bound, restated here so a drift shows up as a reading rather than as a number nobody wrote down.
 */
const MOBILE_HEADER_MAX = 56;
/**
 * The header's own computed top padding on each side of the breakpoint: the mobile branch's `py-1.5` and the desktop
 * branch's `py-2`.
 *
 * Read as a pair on purpose. `MOBILE_HEADER_MAX` is a *bound*, and a bound cannot see which CSS branch produced the
 * number it bounds: applying the desktop branch one pixel below the breakpoint moves the 767 header from 45px to 49px
 * and every bound-based assertion in the matrix still passes. The padding is the branch itself, so the pair
 * (`6px` at 767, `8px` at 768) is what makes the *position* of the CSS breakpoint a reading.
 */
const MOBILE_HEADER_PADDING_TOP = '6px';
const DESKTOP_HEADER_PADDING_TOP = '8px';
/** The footer bound once a replay row exists: the row is meant to be *outside* the footer, so the footer cannot grow. */
const MOBILE_FOOTER_MAX = 57;
/** How far the two footer control groups' tops may differ and still be one row (button heights differ by 4px). */
const SAME_ROW_TOP_TOLERANCE = 4;
/** The touch target the workspace dialog's entries have to offer. */
const MIN_TOUCH_TARGET = 44;

/** The interrupt control's accessible name, in the language the cell is reading and in the one a missing translation falls back to. */
const STOP_NAMES = ['Stop', 'Stoppen'];
/** The replay pair's accessible names. The German bundle has no `voice.*` entries, so these are the English fallback at every width. */
const REPLAY_ORIGINAL = /Replay original/;
const REPLAY_TRIMMED = /Replay trimmed/;

const MOBILE_VIEWPORTS = [
  { width: 320, height: 700 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 767, height: 900 },
];
const DESKTOP_VIEWPORTS = [
  { width: 768, height: 900 },
  { width: 1280, height: 720 },
];
/**
 * The desktop width whose footer content fits on one line. 768's does not — its two control groups sit 36px apart,
 * stacked, which is the desktop footer's own `flex-wrap` at work — so only the widest viewport can be asked for a
 * single row, and the other one is asked for the wrap it really has.
 */
const ONE_LINE_DESKTOP_WIDTH = Math.max(...DESKTOP_VIEWPORTS.map((viewport) => viewport.width));

/* ------------------------------------------------------------------------------------------------------------
 * The recogniser stand-in
 * --------------------------------------------------------------------------------------------------------- */

/**
 * The stand-in the shipped voice-trim spec uses, answering the one endpoint the direct voice path posts to.
 *
 * A cross-origin multipart POST carrying `Authorization` is not a simple request, so the browser sends a preflight
 * first and would block the call without an answer to it.
 */
const startRecognizer = async (): Promise<http.Server> => {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ text: 'a sentence the layout matrix records and never reads' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};

/* ------------------------------------------------------------------------------------------------------------
 * Session, language and the wire double
 * --------------------------------------------------------------------------------------------------------- */

/**
 * The premise that a sign-in worked: the token every later context replays is in `localStorage`.
 *
 * Read from storage rather than from the Settings button the older specs in this directory wait on. That button's
 * accessible name is `t('actions.settings')` — a *translated* label, "Einstellungen" once this same file's cells have
 * moved the account's language to de, and that preference is sticky on the server. So a second sign-in in one run (a
 * worker Playwright had to restart, say) would look for an English label the app no longer renders and sit there for
 * its whole timeout, failing a cell whose actual work never started. The token is what this helper needs, and it is
 * language-free.
 */
const authTokenStored = (page: Page) =>
  page.waitForFunction((key) => Boolean(window.localStorage.getItem(key)), AUTH_TOKEN_KEY, { timeout: 30_000 });

/** Creates the account (or signs in to it) and returns the token every later context replays. */
const bootstrapAuth = async (browser: Browser): Promise<string> => {
  const context = await browser.newContext({ baseURL: CLIENT_URL });
  const page = await context.newPage();
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  await expect(createAccount.or(page.locator('#username')).first()).toBeVisible({ timeout: 30_000 });
  if (await createAccount.count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await authTokenStored(page);
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.locator('form button[type=submit]').click();
    await authTokenStored(page);
  }
  const token = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!token) throw new Error('the account was created but no auth token was captured');
  return token;
};

/**
 * Installs the transport-layer double: one socket wrapper, and a way to hand the app one frame on its own chat
 * socket. Only the chat socket is addressed — the shell keeps one of its own, and a chat frame delivered there
 * would be recorded as received without the composer ever seeing it.
 */
const installWireDouble = () => {
  const page = window as unknown as {
    __wireSockets: { url: string; socket: WebSocket }[];
    __injectFrame: (frame: unknown) => number;
  };
  page.__wireSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      page.__wireSockets.push({ url: String(args[0]), socket: this as WebSocket });
    }
  } as unknown as typeof WebSocket;
  page.__injectFrame = (frame: unknown) => {
    const data = JSON.stringify(frame);
    let delivered = 0;
    for (const entry of page.__wireSockets) {
      if (!entry.url.includes('/ws')) continue;
      if (entry.socket.readyState !== 1) continue;
      entry.socket.dispatchEvent(new MessageEvent('message', { data }));
      delivered += 1;
    }
    return delivered;
  };
};

/** Everything a context needs before its first navigation: the session, the language, the voice backend, the double. */
const seedContext = async (
  context: BrowserContext,
  options: { token: string; language: string; recognizerUrl: string },
): Promise<void> => {
  await context.addInitScript(
    ({ token, language, recognizerUrl: url, authKey }: { token: string; language: string; recognizerUrl: string; authKey: string }) => {
      window.localStorage.setItem(authKey, token);
      // The two keys the first paint reads and the one hydration migrates from, exactly as the shipped voice spec
      // seeds them: a language that only existed in one of them would be dropped when the other one arrived.
      window.localStorage.setItem('userLanguage', language);
      window.localStorage.setItem(
        'user-preferences',
        JSON.stringify({ userLanguage: language, uiPreferences: { voiceEnabled: true } }),
      );
      window.localStorage.setItem('uiPreferences', JSON.stringify({ voiceEnabled: true }));
      window.localStorage.setItem(
        'voiceConfig',
        JSON.stringify({ baseUrl: url, apiKey: 'sk-e2e-mobile-layout', sttModel: 'whisper-large-v3-turbo', ttsModel: '', ttsVoice: '', ttsFormat: '' }),
      );
    },
    { token: options.token, language: options.language, recognizerUrl: options.recognizerUrl, authKey: AUTH_TOKEN_KEY },
  );
  await context.addInitScript(installWireDouble);
};

/** Delivers one running-state frame on the chat socket and reports how many open sockets took it. */
const injectStatusFrame = (page: Page, sessionId: string) =>
  page.evaluate(
    ({ id }: { id: string }) =>
      (window as unknown as { __injectFrame: (frame: unknown) => number }).__injectFrame({
        // The shape the server sends and the client's own `status` case reads: without `text` the frame is dropped
        // and without `canInterrupt` the interrupt control is not considered available.
        kind: 'status',
        id: `e2e-layout-status-${id}`,
        sessionId: id,
        timestamp: new Date().toISOString(),
        provider: 'claude',
        role: 'assistant',
        text: 'working on the layout matrix',
        canInterrupt: true,
      }),
    { id: sessionId },
  );

/* ------------------------------------------------------------------------------------------------------------
 * The reading
 * --------------------------------------------------------------------------------------------------------- */

type BoxRect = { top: number; bottom: number; left: number; right: number; width: number; height: number };
type Box = BoxRect | null;
type FooterBox = BoxRect & { clientWidth: number; scrollWidth: number };

type CellReading = {
  innerWidth: number;
  header: Box;
  headerPaddingTop: string | null;
  footer: FooterBox | null;
  tools: Box;
  right: Box;
  clipRow: Box;
  inlineActivity: Box;
  tabActivity: Box;
  clipButtons: { label: string | null; inClipRow: boolean; inTools: boolean; box: Box }[];
  stopNames: string[];
  tablists: number;
  collapsedTrigger: Box;
  collapsedText: string;
  modelTriggerText: string | null;
  modelTriggerBox: Box;
  footerText: string;
};

/** One reading of everything the cells assert on, taken in a single evaluate so the numbers describe one instant. */
const readCell = (page: Page): Promise<CellReading> =>
  page.evaluate(() => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right), width: round(r.width), height: round(r.height) };
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const header = document.querySelector('header.pwa-header-safe');
    const footer = document.querySelector('[data-slot="prompt-input-footer"]') as HTMLElement | null;
    const tools = document.querySelector('[data-slot="prompt-input-tools"]');
    const right = footer?.querySelector('div.ml-auto') ?? null;
    const clipRow = document.querySelector('[data-slot="prompt-input-clip-row"]');
    const collapsed = header?.querySelector('[aria-haspopup="dialog"]') ?? null;
    const modelButton = document.querySelector('button[aria-label="Select model and reasoning effort"]');
    const modelSpan = modelButton?.querySelector('span.truncate');
    const clipButtonList = [...document.querySelectorAll('button[data-clip-url]')];

    return {
      innerWidth: window.innerWidth,
      header: box(header),
      headerPaddingTop: header ? getComputedStyle(header).paddingTop : null,
      footer: footer
        ? { clientWidth: footer.clientWidth, scrollWidth: footer.scrollWidth, ...box(footer)! }
        : null,
      tools: box(tools),
      right: box(right),
      clipRow: box(clipRow),
      inlineActivity: box(document.querySelector('[data-slot="chat-activity-inline"]')),
      tabActivity: box(document.querySelector('.chat-activity-tab')),
      clipButtons: clipButtonList.map((b) => ({
        label: b.getAttribute('aria-label'),
        inClipRow: clipRow ? clipRow.contains(b) : false,
        inTools: tools ? tools.contains(b) : false,
        box: box(b),
      })),
      // Visible *and* named: a Stop inside a hidden branch is not an interrupt control, and one with no accessible
      // name is not one either — the whole point of the count is what a user can reach and read.
      stopNames: [...document.querySelectorAll('button[aria-label]')]
        .filter(visible)
        .map((b) => b.getAttribute('aria-label') ?? '')
        .filter((label) => ['Stop', 'Stoppen'].includes(label)),
      tablists: document.querySelectorAll('[role="tablist"]').length,
      collapsedTrigger: box(collapsed),
      collapsedText: (collapsed?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      modelTriggerText: modelSpan ? (modelSpan.textContent ?? '').trim() : null,
      modelTriggerBox: box(modelButton),
      footerText: (footer?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });

/**
 * The reading, formatted for a failure message.
 *
 * Every geometry assertion below goes through this: a criterion that failed with `expect(false).toBe(true)` would
 * say a cell is wrong and nothing about *how* wrong, and the numbers are the only thing that says whether a bound
 * is off by a rounding error or by a row.
 */
const describeReading = (label: string, cell: CellReading): string =>
  `${label}\n  header=${JSON.stringify(cell.header)} (max ${MOBILE_HEADER_MAX}) padTop=${cell.headerPaddingTop} (mobile ${MOBILE_HEADER_PADDING_TOP} / desktop ${DESKTOP_HEADER_PADDING_TOP})` +
  `\n  footer=${JSON.stringify(cell.footer)} (max height ${MOBILE_FOOTER_MAX})` +
  `\n  tools=${JSON.stringify(cell.tools)} right=${JSON.stringify(cell.right)}` +
  `\n  clipRow=${JSON.stringify(cell.clipRow)} inlineActivity=${JSON.stringify(cell.inlineActivity)} tabActivity=${JSON.stringify(cell.tabActivity)}` +
  `\n  clipButtons=${JSON.stringify(cell.clipButtons)}` +
  `\n  visible stop names=${JSON.stringify(cell.stopNames)} tablists=${cell.tablists}` +
  `\n  collapsed=${JSON.stringify(cell.collapsedTrigger)} ${JSON.stringify(cell.collapsedText)}` +
  `\n  modelTrigger=${JSON.stringify(cell.modelTriggerText)} ${JSON.stringify(cell.modelTriggerBox)}` +
  `\n  innerWidth=${cell.innerWidth} footerText=${JSON.stringify(cell.footerText)}`;

/** One geometry assertion: passes silently, and on failure prints the whole reading rather than a bare `false`. */
const expectReading = (ok: boolean, label: string, cell: CellReading) =>
  expect(ok, describeReading(label, cell)).toBe(true);

/**
 * The breakpoint criterion: every mobile width's header has to carry the mobile CSS branch's padding, every desktop
 * width's the desktop branch's.
 *
 * The JS tier boundary is 768 — that is what decides which markup is rendered and is asserted all over this file. This
 * is the other half of the same requirement: the *CSS* boundary has to sit there too, or a width just below it gets
 * desktop padding on mobile markup. Nothing else in the matrix can see that, because every other header assertion is a
 * bound (see `MOBILE_HEADER_PADDING_TOP`).
 */
const expectHeaderBranch = (width: number, cell: CellReading) => {
  const mobile = MOBILE_VIEWPORTS.some((viewport) => viewport.width === width);
  const expected = mobile ? MOBILE_HEADER_PADDING_TOP : DESKTOP_HEADER_PADDING_TOP;
  expectReading(
    cell.headerPaddingTop === expected,
    `@${width}: the header must carry the ${mobile ? 'mobile' : 'desktop'} CSS branch's top padding (${expected}), ` +
      `so that the CSS breakpoint sits at 768 where the JS tier boundary is — read ${cell.headerPaddingTop}`,
    cell,
  );
};

/** The desktop footer's arrangement, at the one width where its content fits on a line and at the one where it wraps. */
const expectDesktopFooterRow = (width: number, cell: CellReading) =>
  expectReading(
    width === ONE_LINE_DESKTOP_WIDTH ? oneRow(cell) : stacked(cell),
    `@${width}: the desktop footer's two control groups must ${
      width === ONE_LINE_DESKTOP_WIDTH ? 'be one row' : 'stack — the desktop footer is allowed to wrap at this width'
    }`,
    cell,
  );

/** The premise every cell asserts before it reads: the viewport really is the width the case declares. */
const expectDeclaredWidth = (cell: CellReading, width: number) =>
  expect(cell.innerWidth, `the case declares ${width}px; the page reports ${cell.innerWidth}px`).toBe(width);

/**
 * The desktop footer's sideways reading: asserted at the one desktop width the criterion pins, printed at every other.
 *
 * `scrollWidth === clientWidth` is a bound this matrix is given for the *mobile* cells, where the footer is one row
 * inside a 302-374px box. From `md` up the composer keeps its original wrapping footer, and at 768 — the narrowest
 * desktop width, with the sidebar open, so the composer is handed ~445px — a replay pair in the tool group pushes the
 * footer's content 25px past its own box, on the baseline commit as much as after the four implementation tasks (both
 * readings are in Evidence). Asserting the mobile bound there would fail the baseline too, which is a criterion that
 * cannot tell the change apart from the state it started in. The desktop's own criterion is "unchanged from the
 * baseline", so the assertion lives at 1280, whose baseline footer is a single non-scrolling row, and the wider
 * reading is still printed for every desktop cell — an observation, labelled as one.
 */
const expectDesktopFooterOverflow = (width: number, cell: CellReading): void => {
  if (cell.footer && cell.footer.scrollWidth > cell.footer.clientWidth) {
    console.log(
      `[layout] NOTE @${width}: the composer footer scrolls sideways by ${cell.footer.scrollWidth - cell.footer.clientWidth}px` +
        ' — a desktop-side observation, not a mobile-criterion failure: the baseline read in Evidence carries the same' +
        ' number, so it is not a change the four implementation tasks made.',
    );
  }
  if (width === ONE_LINE_DESKTOP_WIDTH) {
    expectReading(noOverflow(cell), `@${width}: the one-line desktop footer must not scroll sideways`, cell);
  }
};

/** The single-row reading: both footer groups are present, their vertical ranges overlap, and their tops are close. */
const oneRow = (cell: CellReading): boolean => {
  const { tools, right } = cell;
  if (!tools || !right) return false;
  const overlaps = tools.top < right.bottom && right.top < tools.bottom;
  return overlaps && Math.abs(tools.top - right.top) <= SAME_ROW_TOP_TOLERANCE;
};

/**
 * The wrapped reading, for the desktop width whose footer is *meant* to wrap.
 *
 * From `md` up the footer keeps its original `flex-wrap gap-y-1`, so at 768 its own content does not fit on one line
 * and the two groups stack 36px apart — asserting `oneRow` there would assert a shape the desktop never had. At 1280
 * the same footer is one line, and `oneRow` is the reading. Both are printed by every cell.
 */
const stacked = (cell: CellReading): boolean => {
  const { tools, right } = cell;
  if (!tools || !right) return false;
  return tools.bottom <= right.top || right.bottom <= tools.top;
};

/** The footer's own overflow reading: it scrolls sideways exactly as far as it is wide. */
const noOverflow = (cell: CellReading): boolean =>
  cell.footer !== null && cell.footer.scrollWidth === cell.footer.clientWidth;

/**
 * The per-cell reading line, printed for every cell whether it passes or fails.
 *
 * This is the matrix's own output: the criteria ask for a reading table — header height, footer overflow, the
 * same-row reading, footer height, the visible interrupt count — for every viewport and state, and cells that only
 * print when they fail cannot produce one.
 */
const logCell = (label: string, cell: CellReading): void => {
  const gap = cell.tools && cell.right ? Math.round(Math.abs(cell.tools.top - cell.right.top) * 100) / 100 : null;
  console.log(
    `[layout] READING ${label}: header=${cell.header?.height ?? 'none'}px padTop=${cell.headerPaddingTop ?? 'none'}` +
      ` footer=${cell.footer ? `${cell.footer.scrollWidth}/${cell.footer.clientWidth}` : 'none'}` +
      ` (h-overflow=${cell.footer ? cell.footer.scrollWidth - cell.footer.clientWidth : 'n/a'}, h=${cell.footer?.height ?? 'none'}px)` +
      ` groups tools.top=${cell.tools?.top ?? 'none'} right.top=${cell.right?.top ?? 'none'} diff=${gap}` +
      ` sameRow=${oneRow(cell)} stacked=${stacked(cell)}` +
      ` stops=${cell.stopNames.length}${JSON.stringify(cell.stopNames)}` +
      ` clipRow=${cell.clipRow ? `${cell.clipRow.top}..${cell.clipRow.bottom}` : 'none'}` +
      ` tablists=${cell.tablists} innerWidth=${cell.innerWidth}`,
  );
};

/** The replay pair's own reading, counted in the accessibility tree so "two sets of controls" cannot pass as one pair. */
const replayCounts = async (page: Page) => {
  const snapshot = await page.locator('body').ariaSnapshot();
  const lines = snapshot.split('\n');
  return {
    original: lines.filter((line) => REPLAY_ORIGINAL.test(line)).length,
    trimmed: lines.filter((line) => REPLAY_TRIMMED.test(line)).length,
    excerpt: lines.filter((line) => /Replay/.test(line)),
  };
};

/**
 * The workspace dialog's entries, measured on each entry's own box.
 *
 * The poll below and the assertion after it both read through this, so the numbers being waited for are the numbers
 * being asserted on — and both are rounded the same way, which matters at a boundary of exactly 44.
 */
const dialogEntries = (page: Page) =>
  page.getByRole('dialog').locator('button').evaluateAll((buttons) =>
    buttons.map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(), width: Math.round(r.width), height: Math.round(r.height) };
    }),
  );

/* ------------------------------------------------------------------------------------------------------------
 * Recording, and the long model
 * --------------------------------------------------------------------------------------------------------- */

/** The composer's textarea — where a transcript lands, and the surface whose row the replay pair must not disturb. */
const textarea = (page: Page) => page.locator('[data-slot="prompt-input-textarea"]');

/** The microphone, whose accessible name is English at both languages (the German bundle has no `voice.*` entries). */
const mic = (page: Page) => page.getByRole('button', { name: 'Voice input' });
const stopRecording = (page: Page) => page.getByRole('button', { name: 'Stop recording' });

/**
 * Records one pass of the fixture through the app's own button and waits for the clip to exist.
 *
 * Waits on the clip *control*, not on the clip row: the row exists only below the breakpoint, so waiting for it would
 * make every desktop cell time out here. The pair itself — one button per track, each carrying its own clip URL — is
 * what a recording produces at either width. Timed rather than merely awaited: the recording is the expensive part
 * of a cell, and the criteria have to report what the run cost.
 */
const recordOnce = async (page: Page, label: string): Promise<number> => {
  const started = Date.now();
  await mic(page).click();
  await expect(stopRecording(page)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(CAPTURE_MS);
  await stopRecording(page).click();
  await expect(page.locator('button[data-clip-url]').first()).toBeVisible({ timeout: 30_000 });
  const cost = Date.now() - started;
  console.log(`[layout] ${label}: one recording in ${cost}ms`);
  return cost;
};

/**
 * Selects the long model through the composer's own menu, the way a user does.
 *
 * Seeding `localStorage['claude-model']` would not do: the catalog is fetched on mount, and a stored value that is
 * not in it is discarded — so the value has to be picked after the load, from the menu the app renders.
 */
const selectLongModel = async (page: Page, width: number): Promise<void> => {
  const trigger = page.getByRole('button', { name: 'Select model and reasoning effort' });
  await expect(trigger, `@${width}: the model trigger has to exist before the long name can be picked`).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  // The model row is a collapsible menuitem; the options are the radios inside it once it is open.
  await page.getByRole('menuitem').first().click();
  await page.getByRole('menuitemradio', { name: LONG_MODEL_LABEL }).click();
  await expect(trigger).toContainText(LONG_MODEL_LABEL);
};

/* ------------------------------------------------------------------------------------------------------------
 * The matrix
 * --------------------------------------------------------------------------------------------------------- */

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

let authToken = '';
let recognizer: http.Server;
let recognizerUrl = '';
let longModelRecordId = '';

test.beforeAll(async ({ browser, request }) => {
  test.setTimeout(120_000);
  recognizer = await startRecognizer();
  recognizerUrl = `http://127.0.0.1:${(recognizer.address() as AddressInfo).port}`;
  authToken = await bootstrapAuth(browser);

  const created = await request.post('/api/providers/claude/models', {
    headers: { authorization: `Bearer ${authToken}` },
    data: { id: LONG_MODEL_ID, model: LONG_MODEL_LABEL },
  });
  expect(
    created.status(),
    `creating the long model has to answer 201; it answered ${created.status()} ${await created.text()}`,
  ).toBe(201);
  longModelRecordId = ((await created.json()) as { data: { model: { recordId: string } } }).data.model.recordId;
  console.log(`[layout] long model ${LONG_MODEL_LABEL} created as ${longModelRecordId}; recogniser at ${recognizerUrl}`);
});

test.afterAll(async ({ request }) => {
  // The model library spec asserts how many rows it finds, so the row this file added has to be gone before any
  // other file runs. The recogniser is this run's own process and would die with it, but a run that closed it
  // explicitly is a run whose port is released for the next one.
  if (longModelRecordId) {
    const removed = await request.delete(`/api/providers/claude/models/${longModelRecordId}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(removed.status(), `deleting the long model has to answer 2xx; it answered ${removed.status()}`).toBeLessThan(300);
  }
  await new Promise<void>((resolve) => recognizer.close(() => resolve()));
});

/** Opens a document with everything the cell needs, at the width the case declares. */
const openCell = async (
  browser: Browser,
  options: { width: number; height: number; touch: boolean; language: string; session: string; query?: string },
) => {
  const context = await browser.newContext({
    baseURL: CLIENT_URL,
    viewport: { width: options.width, height: options.height },
    hasTouch: options.touch,
    isMobile: options.touch,
    permissions: ['microphone'],
  });
  await seedContext(context, { token: authToken, language: options.language, recognizerUrl });
  const page = await context.newPage();
  await page.goto(`/session/${options.session}${options.query ?? ''}`);
  return { context, page };
};

/* ------------------------------------------------------------------------------------------------------------
 * Mobile cells: four widths, four states
 * --------------------------------------------------------------------------------------------------------- */

for (const viewport of MOBILE_VIEWPORTS) {
  const { width, height } = viewport;

  test.describe(`mobile workspace and composer @${width}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });

    test(`@${width} idle — one header row, one footer row, everything else behind the more menu`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: true, language: MOBILE_LANGUAGE, session: MOBILE_SESSION });
      try {
        await expect(page.locator('[data-slot="prompt-input-footer"]')).toBeVisible({ timeout: 30_000 });
        await expectDeclaredWidth(await readCell(page), width);

        await selectLongModel(page, width);
        await page.waitForTimeout(250);
        const cell = await readCell(page);
        logCell(`@${width} idle`, cell);

        expectReading(cell.header !== null && cell.header.height <= MOBILE_HEADER_MAX, `@${width} idle: the header must be a single row of at most ${MOBILE_HEADER_MAX}px`, cell);
        expectHeaderBranch(width, cell);
        expectReading(noOverflow(cell), `@${width} idle: the footer must not scroll sideways`, cell);
        expectReading(oneRow(cell), `@${width} idle: the footer's two control groups must be one row`, cell);
        expectReading(cell.tablists === 0, `@${width} idle: no tablist may survive below the breakpoint`, cell);
        expectReading(cell.collapsedTrigger !== null && cell.collapsedTrigger.height > 0, `@${width} idle: the workspace selector must be there instead`, cell);
        // The long model label is the whole reason this cell picks one: the footer that has to hold it is the one
        // whose overflow is asserted above, and a short default label would have hidden that requirement.
        expectReading(cell.modelTriggerText === LONG_MODEL_LABEL, `@${width} idle: the composer must be showing the long model name`, cell);

        // Token usage, commands and scheduling are not in the footer any more, and the "more" menu is where they
        // went: one click, which is the "within two clicks" the criterion asks for.
        const footer = page.locator('[data-slot="prompt-input-footer"]');
        for (const name of FOOTER_ONLY_CONTROLS) {
          expectReading(
            (await footer.getByRole('button', { name }).count()) === 0,
            `@${width} idle: ${name} must not be in the footer`,
            cell,
          );
        }
        const more = footer.getByRole('button', { name: /More tools|Weitere Tools/ });
        expectReading((await more.count()) === 1, `@${width} idle: the more menu's trigger must be in the footer`, cell);
        await more.click();
        const menu = page.locator('[role="menu"]');
        await expect(menu).toBeVisible({ timeout: 5_000 });
        const items = (await menu.locator('[role="menuitem"]').allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim());
        console.log(`[layout] @${width} idle more menu: ${JSON.stringify(items)}`);
        for (const fragment of ['Alle Befehle', 'Token', 'Nachricht planen']) {
          expectReading(
            items.some((item) => item.toLowerCase().includes(fragment.toLowerCase())),
            `@${width} idle: the more menu must offer ${fragment}; it offered ${JSON.stringify(items)}`,
            cell,
          );
        }
        await page.keyboard.press('Escape');

        // The workspace selector's own dialog: every entry has to be a touch target, and picking one has to close
        // the dialog and land on that workspace.
        await page.locator('header [aria-haspopup="dialog"]').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        // The dialog scales in, so its first visible frame is smaller than its layout: poll until every entry has
        // settled at its declared minimum rather than measuring the animation (see the header comment).
        await expect
          .poll(
            async () =>
              (await dialogEntries(page)).filter((entry) => entry.width < MIN_TOUCH_TARGET || entry.height < MIN_TOUCH_TARGET).length,
            { message: `@${width} idle: the dialog entries must settle at ${MIN_TOUCH_TARGET}x${MIN_TOUCH_TARGET}` },
          )
          .toBe(0);
        const entries = await dialogEntries(page);
        console.log(`[layout] @${width} idle dialog entries: ${JSON.stringify(entries)}`);
        const small = entries.filter((entry) => entry.width < MIN_TOUCH_TARGET || entry.height < MIN_TOUCH_TARGET);
        expectReading(
          entries.length > 1 && small.length === 0,
          `@${width} idle: every dialog entry must be at least ${MIN_TOUCH_TARGET}x${MIN_TOUCH_TARGET}; the small ones read ${JSON.stringify(small)}`,
          cell,
        );
        await dialog.locator('button', { hasText: /Files|Dateien/ }).first().click();
        await expect(dialog).toBeHidden({ timeout: 5_000 });
        const switched = await readCell(page);
        expectReading(
          /Files|Dateien/.test(switched.collapsedText),
          `@${width} idle: the selector must name the workspace that was picked`,
          switched,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} single playback — one clip, its own row above the footer, footer height unchanged`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, {
        ...viewport,
        touch: true,
        language: MOBILE_LANGUAGE,
        session: MOBILE_SESSION,
        // Trim off is what makes this the *single* clip case: the original is uploaded as it was recorded, so the
        // pair the trimmed recording produces never exists.
        query: '?voiceTrim=off',
      });
      try {
        await expect(page.locator('[data-slot="prompt-input-footer"]')).toBeVisible({ timeout: 30_000 });
        await expectDeclaredWidth(await readCell(page), width);
        await selectLongModel(page, width);
        const before = await readCell(page);
        // The premise the footer-height comparison rests on: without it, "unchanged" could be two different
        // failures cancelling out.
        expectReading(before.footer !== null, `@${width} single: the footer has to exist before a recording is made`, before);

        await recordOnce(page, `@${width} single`);
        const cell = await readCell(page);
        const counts = await replayCounts(page);
        console.log(`[layout] @${width} single aria replay lines: ${JSON.stringify(counts.excerpt)}`);
        logCell(`@${width} single playback`, cell);

        expectReading(counts.original === 1 && counts.trimmed === 0, `@${width} single: exactly one replay control, and it is the original's`, cell);
        expectReading(cell.clipButtons.length === 1 && cell.clipButtons.every((b) => b.inClipRow), `@${width} single: the one clip control must live in the clip row`, cell);
        expectReading(cell.clipRow !== null && cell.footer !== null && cell.clipRow.top < cell.footer.top, `@${width} single: the replay row must sit above the footer`, cell);
        expectReading(cell.footer !== null && cell.footer.height <= MOBILE_FOOTER_MAX, `@${width} single: the footer must not grow around the replay row`, cell);
        expectReading(noOverflow(cell), `@${width} single: the footer must not scroll sideways`, cell);
        expectReading(oneRow(cell), `@${width} single: the footer's two control groups must still be one row`, cell);
        expectReading(
          cell.footer !== null && before.footer !== null && cell.footer.height === before.footer.height,
          `@${width} single: the footer height must be identical before and after the clip appears (${before.footer?.height} → ${cell.footer?.height})`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} double playback — the pair is one row above the footer, footer height unchanged`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: true, language: MOBILE_LANGUAGE, session: MOBILE_SESSION });
      try {
        await expect(page.locator('[data-slot="prompt-input-footer"]')).toBeVisible({ timeout: 30_000 });
        await expectDeclaredWidth(await readCell(page), width);
        await selectLongModel(page, width);
        const before = await readCell(page);
        expectReading(before.footer !== null, `@${width} double: the footer has to exist before a recording is made`, before);

        await recordOnce(page, `@${width} double`);
        const cell = await readCell(page);
        const counts = await replayCounts(page);
        console.log(`[layout] @${width} double aria replay lines: ${JSON.stringify(counts.excerpt)}`);
        logCell(`@${width} double playback`, cell);

        // The premise: the trimmed pair is what this cell is about, and a recording that produced only the
        // original would satisfy every geometry assertion below while testing the single case again.
        expectReading(counts.original === 1 && counts.trimmed === 1, `@${width} double: exactly one original and one trimmed replay control`, cell);
        expectReading(cell.clipButtons.length === 2, `@${width} double: both clip controls must be in the composer`, cell);
        expectReading(cell.clipRow !== null && cell.footer !== null && cell.clipRow.top < cell.footer.top, `@${width} double: the clip row must sit above the footer`, cell);
        expectReading(cell.footer !== null && cell.footer.height <= MOBILE_FOOTER_MAX, `@${width} double: the footer must not grow around the clip row`, cell);
        expectReading(noOverflow(cell), `@${width} double: the footer must not scroll sideways`, cell);
        expectReading(oneRow(cell), `@${width} double: the footer's two control groups must still be one row`, cell);
        expectReading(
          cell.footer !== null && before.footer !== null && cell.footer.height === before.footer.height,
          `@${width} double: the footer height must be identical before and after the clips appear (${before.footer?.height} → ${cell.footer?.height})`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} running — exactly one accessible interrupt control`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: true, language: MOBILE_LANGUAGE, session: MOBILE_SESSION });
      try {
        await expect(page.locator('[data-slot="prompt-input-footer"]')).toBeVisible({ timeout: 30_000 });
        await expectDeclaredWidth(await readCell(page), width);
        await selectLongModel(page, width);

        const delivered = await injectStatusFrame(page, MOBILE_SESSION);
        console.log(`[layout] @${width} running: status frame delivered to ${delivered} chat socket(s)`);
        // The premise: the frame was delivered *and* the app acted on it. A frame that never arrived looks exactly
        // like a state that was never entered, and every assertion below would then be read off an idle page.
        expect(delivered, `@${width} running: the status frame has to reach an open chat socket`).toBeGreaterThan(0);
        await expect(page.locator('[data-slot="chat-activity-inline"]')).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);

        const cell = await readCell(page);
        logCell(`@${width} running`, cell);
        expectReading(cell.stopNames.length === 1, `@${width} running: exactly one visible and named interrupt control`, cell);
        expectReading(
          cell.tabActivity === null || cell.tabActivity.width === 0,
          `@${width} running: the desktop tab-status control must not be rendered at this width`,
          cell,
        );
        expectReading(cell.inlineActivity !== null && cell.inlineActivity.height > 0, `@${width} running: the inline activity row must be the one that is shown`, cell);
        expectReading(noOverflow(cell), `@${width} running: the footer must not scroll sideways`, cell);
        expectReading(oneRow(cell), `@${width} running: the footer's two control groups must still be one row`, cell);
      } finally {
        await context.close();
      }
    });
  });
}

/* ------------------------------------------------------------------------------------------------------------
 * Desktop cells: the breakpoint's other side, where nothing may have moved
 * --------------------------------------------------------------------------------------------------------- */

for (const viewport of DESKTOP_VIEWPORTS) {
  const { width, height } = viewport;

  test.describe(`desktop workspace and composer @${width}`, () => {
    test.use({ viewport: { width, height }, hasTouch: false, isMobile: false });

    test(`@${width} idle — the full tablist, no collapsed selector, the composer unchanged`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: false, language: MOBILE_LANGUAGE, session: DESKTOP_SESSION });
      try {
        await expect(page.locator('[data-slot="prompt-input-footer"]')).toBeVisible({ timeout: 30_000 });
        await expectDeclaredWidth(await readCell(page), width);
        await page.waitForTimeout(250);
        const cell = await readCell(page);
        logCell(`@${width} idle`, cell);

        expectReading(cell.tablists >= 1, `@${width} idle: the full tablist has to be there at and above the breakpoint`, cell);
        expectHeaderBranch(width, cell);
        expectReading(cell.collapsedTrigger === null, `@${width} idle: no collapsed workspace selector may be rendered here`, cell);
        expectDesktopFooterOverflow(width, cell);
        expectDesktopFooterRow(width, cell);
        // Where the desktop keeps things: token usage, commands and scheduling are in the footer itself, not
        // behind a menu — the mobile cells assert the opposite, and this is the reading that keeps the two honest.
        const footer = page.locator('[data-slot="prompt-input-footer"]');
        for (const name of FOOTER_ONLY_CONTROLS) {
          expectReading(
            (await footer.getByRole('button', { name }).count()) === 1,
            `@${width} idle: ${name} must still be in the desktop footer`,
            cell,
          );
        }
        // The mobile layout's escape hatch must not exist here: nothing is behind a "more" menu at desktop widths.
        expectReading(
          (await footer.getByRole('button', { name: /More tools|Weitere Tools/ }).count()) === 0,
          `@${width} idle: the more menu's trigger must not be rendered at desktop widths`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} double playback — the pair stays in the footer, which does not grow`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: false, language: MOBILE_LANGUAGE, session: DESKTOP_SESSION });
      try {
        await expect(page.locator('[data-slot="prompt-input-footer"]')).toBeVisible({ timeout: 30_000 });
        await expectDeclaredWidth(await readCell(page), width);
        const before = await readCell(page);
        expectReading(before.footer !== null, `@${width} double: the footer has to exist before a recording is made`, before);

        await recordOnce(page, `@${width} double`);
        const cell = await readCell(page);
        const counts = await replayCounts(page);
        console.log(`[layout] @${width} double aria replay lines: ${JSON.stringify(counts.excerpt)}`);
        logCell(`@${width} double playback`, cell);

        expectReading(counts.original === 1 && counts.trimmed === 1, `@${width} double: exactly one original and one trimmed replay control`, cell);
        expectReading(
          cell.clipButtons.length === 2 && cell.clipButtons.every((b) => b.inTools),
          `@${width} double: the replay pair must live in the footer's tool group, where it has always been`,
          cell,
        );
        expectReading(cell.clipRow === null, `@${width} double: no separate clip row may be rendered above the breakpoint`, cell);
        expectDesktopFooterOverflow(width, cell);
        expectDesktopFooterRow(width, cell);
        expectReading(
          cell.footer !== null && before.footer !== null && cell.footer.height === before.footer.height,
          `@${width} double: the footer height must be identical before and after the clips appear (${before.footer?.height} → ${cell.footer?.height})`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} running — the tab status and the composer's Stop, both where they belong`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: false, language: MOBILE_LANGUAGE, session: DESKTOP_SESSION });
      try {
        await expect(page.locator('[data-slot="prompt-input-footer"]')).toBeVisible({ timeout: 30_000 });
        await expectDeclaredWidth(await readCell(page), width);

        const delivered = await injectStatusFrame(page, DESKTOP_SESSION);
        console.log(`[layout] @${width} running: status frame delivered to ${delivered} chat socket(s)`);
        expect(delivered, `@${width} running: the status frame has to reach an open chat socket`).toBeGreaterThan(0);
        // `.first()` on purpose: the reading below is `querySelector('.chat-activity-tab')`, the first match, so
        // the premise and the reading address the same element (the baseline's markup put the class on the tab's
        // Stop as well, where a strict locator fails on a duplicate instead of measuring the surface).
        await expect(page.locator('.chat-activity-tab').first()).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);

        const cell = await readCell(page);
        logCell(`@${width} running`, cell);
        expectReading(cell.inlineActivity === null, `@${width} running: the inline activity row the mobile layout uses must not appear here`, cell);
        expectReading(cell.tabActivity !== null && cell.tabActivity.width > 0, `@${width} running: the tab status must be the running indicator here`, cell);
        // The desktop keeps both controls: the tab's own Stop and the composer's. The mobile cells assert the
        // opposite count, and this is the reading that keeps the two widths honest about each other.
        expectReading(cell.stopNames.length === 2, `@${width} running: the desktop keeps the tab's Stop and the composer's`, cell);
        expectDesktopFooterOverflow(width, cell);
        expectDesktopFooterRow(width, cell);
      } finally {
        await context.close();
      }
    });
  });
}
