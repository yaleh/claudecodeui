import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

// AC-217: the transcript's right-edge chrome is three columns that never cover
// each other — the text, a window of fixed-size turn ticks, and a drawn
// scrollbar — and the quick-settings handle keeps out of all of them.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir), on fixtures that file seeds: the
// long transcript (1200 user turns) for the windowed readings, the short one
// (`transcript-follow`, 12 user turns) for the un-windowed reading, and the
// session-filter fixture's one-turn sessions for the hidden state. Every reading
// is taken from elements this app draws — the native scrollbar is hidden by
// `scrollbar-width: none`, so its layout is zero at every width and could not be
// evidence of anything.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** The long, 1200-turn fixture and the sidebar names it is reached by. */
const LONG_SESSION_ID = 'e2e-transcript-jump';
const LONG_SESSION_NAME = 'transcript-jump';
const LONG_PROJECT_NAME = 'transcript-jump-workspace';
/** The short fixture: 24 records, 12 of them user turns — a conversation shorter than any window. */
const SHORT_SESSION_ID = 'e2e-transcript-follow';
const SHORT_SESSION_NAME = 'transcript-follow';
const SHORT_PROJECT_NAME = 'transcript-follow-workspace';
/**
 * A one-turn session, from the fixtures `e2e/session-filter.spec.ts` seeds.
 *
 * The transcript chrome stands down below three turns, so the hidden-state
 * reading needs a conversation that short; no transcript fixture is, and this
 * one already exists with exactly one user turn.
 */
const TINY_SESSION_ID = 'e2e-human-alpha';
const TINY_SESSION_NAME = 'human-alpha';
const TINY_PROJECT_NAME = 'session-filter-workspace';

/** The three viewports the criterion names. */
const DESKTOP = { name: 'desktop 1440x900', size: { width: 1440, height: 900 } } as const;
const SHORT_VIEWPORT = { name: 'short 1024x700', size: { width: 1024, height: 700 } } as const;
const NARROW = { name: 'narrow 390x844', size: { width: 390, height: 844 } } as const;

// ── The geometry the criterion fixes, restated on the reading side ───────────
/** A normal tick, and the current turn's, in CSS pixels (each ±1). */
const TICK_W = 8;
const TICK_H = 2;
const CURRENT_TICK_W = 12;
const CURRENT_TICK_H = 3;
/** Distance between two adjacent ticks' centres. */
const TICK_PITCH = 30;
const TICK_PITCH_TOLERANCE = 4;
const TICK_PITCH_SPREAD = 2;
/** The column never draws more than this many ticks, nor stands taller than this. */
const MAX_TICKS = 11;
const MAX_COLUMN_HEIGHT = 300;
/**
 * The most ticks the column can hold, derived from the criterion's own two
 * numbers: it never stands taller than its ceiling, and its ticks are one pitch
 * apart. Eleven 30px ticks would be 330px, so ten is the cap.
 */
const TICK_CAPACITY = Math.floor(MAX_COLUMN_HEIGHT / TICK_PITCH);
/** The clearance the three columns keep from one another. */
const COLUMN_GAP = 16;
/** How far the column's centre may sit from the transcript's own centre. */
const CENTER_OFFSET_SHARE = 0.1;
/** The handle's clearances: from the export control above it, the ticks below it, and the scrollbar beside it. */
const HANDLE_BAND_MARGIN = 8;
const HANDLE_SCROLLBAR_GAP = 4;

/** Signs in, creating the account on the first run of the fixture database. */
const ensureSignedIn = async (page: Page) => {
  const shellReady = () =>
    page
      .locator('button:has-text("Create Account"), button:has-text("Settings"), #username')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true, () => false);

  await page.goto('/');
  let ready = await shellReady();
  for (let attempt = 0; !ready && attempt < 3; attempt += 1) {
    await page.reload().catch(() => undefined);
    ready = await shellReady();
  }
  if (!ready) throw new Error('the app shell never rendered; the page had no Create Account / Settings / #username');

  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  if (await createAccount.count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').first().fill('e2epassword');
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  }
};

/** Fetches the client's entry and its pre-bundled dependency before the page does, so the first navigation does not race Vite's optimizer. */
const OPTIMIZED_DEP_IN_TEXT = /from\s+"(\/node_modules\/\.vite\/deps\/[^"]+)"/;
const warmClientStartup = async (clientUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const shell = await fetchWithin(new URL('/', clientUrl).href);
  await shell.text();
  const entry = await fetchWithin(new URL('/src/main.tsx', clientUrl).href);
  const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await entry.text())?.[1];
  if (specifier) {
    const dep = await fetchWithin(new URL(specifier, clientUrl).href);
    await dep.text().catch(() => undefined);
  }
};

/** Lets the app's service worker finish claiming the first document. */
const settleServiceWorker = (page: Page) =>
  page
    .waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 })
    .catch(() => undefined);

/** One turn of the session's outline, as the endpoint reports it. */
type OutlineTurn = { id: string; index: number; timestamp: string; preview: string };
type Outline = { turns: OutlineTurn[]; total: number };

/** Reads the seeded session's outline over the app's own REST route, from inside the page. */
const readOutline = (page: Page, sessionId: string): Promise<{ status: number; body: string }> =>
  page.evaluate(async (id) => {
    const response = await fetch(`/api/providers/sessions/${encodeURIComponent(id)}/outline`, {
      headers: { Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}` },
    });
    return { status: response.status, body: await response.text() };
  }, sessionId);

/** A box in viewport coordinates. */
type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** Everything one AC-217 reading compares. */
type RailReading = {
  pane: Box;
  content: Box;
  /** The tick column, or null when it is not laid out (hidden below the breakpoint). */
  column: Box | null;
  track: Box | null;
  thumb: Box | null;
  exportAnchor: Box | null;
  handle: Box | null;
  /** Every drawn tick's mark: its box, its computed colour, and whether it is the current turn's. */
  tickMarks: { box: Box; color: string; current: boolean }[];
  /** The thumb's computed background colour. */
  thumbColor: string | null;
  /** Every tick button in the DOM, whether or not its column is displayed. */
  tickButtonCount: number;
  /** The theme's primary colour triple, as `--primary` declares it. */
  primary: string;
};

const readRail = (page: Page): Promise<RailReading> =>
  page.evaluate(() => {
    const boxOf = (el: Element | null): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        width: r.width, height: r.height,
      };
    };
    const buttons = Array.from(document.querySelectorAll('[data-turn-tick]'));
    const marks = buttons
      .map((button) => button.querySelector('[data-turn-tick-mark]'))
      .filter((mark): mark is Element => mark !== null)
      .map((mark) => ({
        box: boxOf(mark)!,
        color: getComputedStyle(mark).backgroundColor,
        current: mark.closest('[data-turn-tick]')?.getAttribute('aria-current') === 'true',
      }));
    // A hidden column lays out as an empty box at the origin; that is not a
    // position, so it reads as "no column" here.
    const columnBox = boxOf(document.querySelector('[data-turn-ticks]'));
    const thumb = document.querySelector('[data-scrollbar-thumb]');
    return {
      pane: boxOf(document.querySelector('.chat-messages-pane'))!,
      content: boxOf(document.querySelector('[data-transcript-content]'))!,
      column: columnBox && columnBox.height > 0 ? columnBox : null,
      track: boxOf(document.querySelector('[data-scrollbar-track]')),
      thumb: boxOf(thumb),
      exportAnchor: boxOf(document.querySelector('[data-transcript-export-anchor]')),
      handle: boxOf(document.querySelector('[data-quick-settings-handle]')),
      tickMarks: marks,
      thumbColor: thumb ? getComputedStyle(thumb).backgroundColor : null,
      tickButtonCount: buttons.length,
      primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    };
  });

/** The same reading with the numbers rounded, for failure messages. */
const shown = (reading: RailReading): string =>
  JSON.stringify(reading, (_key, value) => (typeof value === 'number' ? Math.round(value) : value));

/** Two boxes share any area at all. */
const overlaps = (a: Box | null, b: Box | null): boolean => {
  if (!a || !b) return false;
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
};

/** `hsl(<h> <s>% <l>%)` — the form this app's theme colours are authored in — as an rgb triple. */
const themeColorToRgb = (declared: string): { r: number; g: number; b: number } => {
  const match = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(declared);
  if (!match) throw new Error(`--primary is not an hsl triple: ${JSON.stringify(declared)}`);
  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let shifted = t;
    if (shifted < 0) shifted += 1;
    if (shifted > 1) shifted -= 1;
    if (shifted < 1 / 6) return p + (q - p) * 6 * shifted;
    if (shifted < 1 / 2) return q;
    if (shifted < 2 / 3) return p + (q - p) * (2 / 3 - shifted) * 6;
    return p;
  };
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
  };
};

/** Whether a computed `rgb(...)` colour is the theme's primary one, read at full opacity. */
const isThemeColor = (computed: string | null, primary: { r: number; g: number; b: number }): boolean => {
  if (!computed) return false;
  const match = /^rgba?\(([^)]+)\)$/.exec(computed.trim());
  if (!match) return false;
  const parts = match[1].split(',').map((part) => Number.parseFloat(part));
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (alpha < 0.95) return false;
  return Math.abs(parts[0] - primary.r) <= 2
    && Math.abs(parts[1] - primary.g) <= 2
    && Math.abs(parts[2] - primary.b) <= 2;
};

/** Plants a handle position in storage, the way a reader who had moved it once left one behind. */
const writeHandlePosition = (page: Page, y: number) =>
  page.evaluate((share) => {
    window.localStorage.setItem('quickSettingsHandlePosition', JSON.stringify({ y: share }));
  }, y);

/** Waits for a freshly loaded transcript to be drawn and measured. */
const settleTranscript = async (page: Page) => {
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(900);
};

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.describe('the transcript rail is three columns and a handle that keeps out of them', () => {
  let browser: Browser;
  let origin: string;
  let authToken: string;

  test.beforeAll(async ({ browser: testBrowser }) => {
    test.setTimeout(300_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);
    browser = testBrowser;

    const seed = await browser.newPage({ baseURL: clientUrl });
    await ensureSignedIn(seed);
    origin = new URL(seed.url()).origin;
    authToken = await seed.evaluate(() => window.localStorage.getItem('auth-token') ?? '');
    await seed.close();
    if (!authToken) throw new Error('no auth token to seed the viewport contexts with');
  });

  /** A fresh, already-signed-in page at one viewport. */
  const openAt = async (
    viewport: { readonly name: string; readonly size: { width: number; height: number } },
  ): Promise<{ context: BrowserContext; page: Page }> => {
    const narrow = viewport.name === NARROW.name;
    const context = await browser.newContext({
      viewport: viewport.size,
      hasTouch: narrow,
      isMobile: narrow,
    });
    await context.addInitScript((token) => {
      window.localStorage.setItem('auth-token', token);
    }, authToken);
    const page = await context.newPage();
    return { context, page };
  };

  /** Opens a seeded session through the sidebar's own link, the way a reader would. */
  const openViaSidebar = async (page: Page, projectName: string, sessionName: string) => {
    const projectRow = () => page.getByRole('button', { name: new RegExp(`^${projectName}`) }).first();
    await expect(projectRow(), `indexing ${projectName} must register its project`).toBeVisible({ timeout: 30_000 });
    const link = page.locator('a[href^="/session/"]').filter({ hasText: sessionName });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await link.isVisible().catch(() => false)) break;
      await projectRow().click();
      try {
        await expect(link).toBeVisible({ timeout: 10_000 });
        break;
      } catch {
        // Collapsed again (or the click missed); the loop clicks once more.
      }
    }
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.click({ timeout: 15_000 });
  };

  test('AC-217 (a)(b)(c)(d)(e) the ticks are a fixed-size window and the scrollbar a column of its own', async () => {
    for (const viewport of [DESKTOP, SHORT_VIEWPORT]) {
      const { context, page } = await openAt(viewport);
      try {
        await page.goto(`${origin}/session/${LONG_SESSION_ID}`);
        await settleServiceWorker(page);
        await settleTranscript(page);
        const reading = await readRail(page);
        const where = `${viewport.name}: ${shown(reading)}`;

        // ── (a) the column draws a window, not one tick per turn ──────────────
        expect(reading.tickButtonCount, `the column must draw at most ${MAX_TICKS} ticks at ${where}`)
          .toBeLessThanOrEqual(MAX_TICKS);
        expect(reading.tickButtonCount, `the column must draw a tick at all at ${where}`)
          .toBeGreaterThan(0);
        expect(reading.tickMarks.length, `every drawn tick must have a mark at ${where}`)
          .toBe(reading.tickButtonCount);

        // ── (b) every tick is the same small size, and exactly one is current ──
        const current = reading.tickMarks.filter((mark) => mark.current);
        expect(current.length, `exactly one tick must be the current turn's at ${where}`).toBe(1);
        for (const mark of reading.tickMarks) {
          const wantW = mark.current ? CURRENT_TICK_W : TICK_W;
          const wantH = mark.current ? CURRENT_TICK_H : TICK_H;
          expect(
            Math.abs(mark.box.width - wantW) <= 1 && Math.abs(mark.box.height - wantH) <= 1,
            `a ${mark.current ? 'current' : 'normal'} tick must be ${wantW}x${wantH}, measured ${mark.box.width}x${mark.box.height} at ${where}`,
          ).toBe(true);
        }
        const centers = reading.tickMarks.map((mark) => mark.box.top + mark.box.height / 2);
        const pitches = centers.slice(1).map((center, index) => center - centers[index]);
        for (const pitch of pitches) {
          expect(Math.abs(pitch - TICK_PITCH), `adjacent ticks must be ${TICK_PITCH}px apart at ${where}`)
            .toBeLessThanOrEqual(TICK_PITCH_TOLERANCE);
        }
        if (pitches.length > 1) {
          expect(
            Math.max(...pitches) - Math.min(...pitches),
            `every gap between ticks must be the same at ${where}`,
          ).toBeLessThanOrEqual(TICK_PITCH_SPREAD);
        }

        // ── (c) the column is centred on the transcript and no taller than its ceiling ──
        expect(reading.column, `the tick column must be drawn at ${where}`).not.toBeNull();
        expect(reading.column!.height, `the column must not stand taller than ${MAX_COLUMN_HEIGHT}px at ${where}`)
          .toBeLessThanOrEqual(MAX_COLUMN_HEIGHT);
        const offset = Math.abs(
          (reading.column!.top + reading.column!.height / 2) - (reading.pane.top + reading.pane.height / 2),
        );
        expect(
          offset,
          `the column must be centred on the transcript within ${CENTER_OFFSET_SHARE * 100}% of the viewport height (offset ${Math.round(offset)}px of ${viewport.size.height}px) at ${where}`,
        ).toBeLessThanOrEqual(CENTER_OFFSET_SHARE * viewport.size.height);

        // ── (d) at rest exactly one thing in the region wears the theme colour ──
        const primary = themeColorToRgb(reading.primary);
        const themed = [
          ...reading.tickMarks.map((mark) => ({ color: mark.color, what: 'a tick' })),
          { color: reading.thumbColor, what: 'the scrollbar thumb' },
        ].filter((entry) => isThemeColor(entry.color, primary));
        expect(
          themed.length,
          `exactly the current tick may wear the theme colour at ${where}, but ${JSON.stringify(themed)} do`,
        ).toBe(1);
        expect(themed[0].what, `the themed element must be the current tick at ${where}`).toBe('a tick');
        expect(
          isThemeColor(current[0].color, primary),
          `the tick marked as the current turn must be the theme-coloured one at ${where}`,
        ).toBe(true);

        // ── (e) the three columns never cover each other ──────────────────────
        expect(reading.thumb, `the drawn scrollbar must exist at ${where}`).not.toBeNull();
        expect(
          reading.content.right + COLUMN_GAP,
          `the text column must clear the tick column by ${COLUMN_GAP}px at ${where}`,
        ).toBeLessThanOrEqual(reading.column!.left);
        expect(
          reading.column!.right + COLUMN_GAP,
          `the tick column must clear the scrollbar by ${COLUMN_GAP}px at ${where}`,
        ).toBeLessThanOrEqual(reading.thumb!.left);
        // The export control is a sticky overlay pinned to the pane's top; what it
        // must not do is reach the right-edge chrome, which is what this compares.
        expect(overlaps(reading.exportAnchor, reading.column), `the export control must not cover the ticks at ${where}`).toBe(false);
        expect(overlaps(reading.exportAnchor, reading.thumb), `the export control must not cover the scrollbar at ${where}`).toBe(false);
        expect(overlaps(reading.handle, reading.column), `the handle must not cover the ticks at ${where}`).toBe(false);
        expect(overlaps(reading.handle, reading.thumb), `the handle must not cover the scrollbar at ${where}`).toBe(false);
        expect(overlaps(reading.handle, reading.content), `the handle must not cover the text at ${where}`).toBe(false);
        expect(overlaps(reading.handle, reading.exportAnchor), `the handle must not cover the export control at ${where}`).toBe(false);
      } finally {
        await context.close();
      }
    }
  });

  test('AC-217 (a)(e)(g) the narrow viewport drops the tick column, keeps the scrollbar, and clears the handle', async () => {
    const { context, page } = await openAt(NARROW);
    try {
      await page.goto(`${origin}/session/${LONG_SESSION_ID}`);
      await settleServiceWorker(page);
      await settleTranscript(page);
      const reading = await readRail(page);
      const where = `${NARROW.name}: ${shown(reading)}`;

      // ── (a) no tick column, and the scrollbar is still there ──────────────
      expect(reading.column, `the tick column must not be laid out at ${where}`).toBeNull();
      for (const mark of reading.tickMarks) {
        expect(mark.box.width, `no tick may be laid out at ${where}`).toBe(0);
      }
      expect(reading.thumb, `the scrollbar must still be drawn at ${where}`).not.toBeNull();

      // ── (e) the two columns left at this width still clear each other ─────
      expect(reading.content.right, `the text must clear the scrollbar at ${where}`)
        .toBeLessThan(reading.thumb!.left);
      expect(overlaps(reading.handle, reading.thumb), `the handle must not cover the scrollbar at ${where}`).toBe(false);
      expect(overlaps(reading.handle, reading.exportAnchor), `the handle must not cover the export control at ${where}`).toBe(false);

      // ── (g) the handle, placed from the bottom at this width, is inside its band ──
      expect(reading.handle, `the handle must be drawn at ${where}`).not.toBeNull();
      expect(reading.exportAnchor, `the export control must be drawn at ${where}`).not.toBeNull();
      expect(
        reading.handle!.top,
        `the handle must sit at least ${HANDLE_BAND_MARGIN}px below the export control at ${where}`,
      ).toBeGreaterThanOrEqual(reading.exportAnchor!.bottom + HANDLE_BAND_MARGIN - 1);
      expect(
        reading.handle!.right,
        `the handle must clear the scrollbar by ${HANDLE_SCROLLBAR_GAP}px at ${where}`,
      ).toBeLessThanOrEqual(reading.thumb!.left - HANDLE_SCROLLBAR_GAP + 1);
    } finally {
      await context.close();
    }
  });

  test('AC-217 (f)(g) the handle is clamped into its band, however it was placed', async () => {
    const { context, page } = await openAt(DESKTOP);
    try {
      await page.goto(`${origin}/session/${LONG_SESSION_ID}`);
      await settleServiceWorker(page);

      /** Asserts the handle's box against the three bounds the criterion names. */
      const expectInBand = (reading: RailReading, label: string) => {
        expect(reading.handle, `the handle must be drawn ${label}`).not.toBeNull();
        expect(reading.column, `the tick column must be drawn ${label}: ${shown(reading)}`).not.toBeNull();
        expect(reading.exportAnchor, `the export control must be drawn ${label}`).not.toBeNull();
        expect(reading.thumb, `the scrollbar must be drawn ${label}`).not.toBeNull();
        expect(
          reading.handle!.top,
          `the handle must sit at least ${HANDLE_BAND_MARGIN}px below the export control ${label}: ${shown(reading)}`,
        ).toBeGreaterThanOrEqual(reading.exportAnchor!.bottom + HANDLE_BAND_MARGIN - 1);
        expect(
          reading.handle!.bottom,
          `the handle must end at least ${HANDLE_BAND_MARGIN}px above the tick column ${label}: ${shown(reading)}`,
        ).toBeLessThanOrEqual(reading.column!.top - HANDLE_BAND_MARGIN + 1);
        expect(
          reading.handle!.right,
          `the handle must clear the scrollbar by ${HANDLE_SCROLLBAR_GAP}px ${label}: ${shown(reading)}`,
        ).toBeLessThanOrEqual(reading.thumb!.left - HANDLE_SCROLLBAR_GAP + 1);
      };

      // ── (f) a reader who has never moved the handle: it goes to the band's top ──
      await page.evaluate(() => window.localStorage.removeItem('quickSettingsHandlePosition'));
      await page.reload();
      await settleTranscript(page);
      const byDefault = await readRail(page);
      expectInBand(byDefault, 'when nothing was saved');

      // ── (g) a position saved before the band existed is pulled back into it ──
      for (const saved of [60, 90]) {
        await writeHandlePosition(page, saved);
        await page.reload();
        await settleTranscript(page);
        expectInBand(await readRail(page), `after a saved y=${saved} was loaded`);
        const stored = await page.evaluate(() =>
          window.localStorage.getItem('quickSettingsHandlePosition'));
        expect(stored, `the clamped position must be written back after a saved y=${saved}`).toBeTruthy();
        const parsed = JSON.parse(stored!) as { y: number };
        expect(
          parsed.y,
          `the stored position must have been rewritten into the band after a saved y=${saved}, but still reads ${parsed.y}`,
        ).not.toBe(saved);
      }

      // ── (g) dragged out of the band with a real pointer, it is clamped back ──
      const grab = async () => {
        const reading = await readRail(page);
        const box = reading.handle!;
        await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
        await page.mouse.down();
        return { x: box.left + box.width / 2, reading };
      };

      const downLeg = await grab();
      await page.mouse.move(downLeg.x, downLeg.reading.column!.bottom + 60, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      expectInBand(await readRail(page), 'after being dragged down past the tick column');

      const upLeg = await grab();
      await page.mouse.move(upLeg.x, upLeg.reading.pane.top + 4, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      expectInBand(await readRail(page), 'after being dragged up past the export control');

      // ── (g) the open drawer keeps its own berth, unchanged ─────────────────
      await page.reload();
      await settleTranscript(page);
      const beforeOpen = await readRail(page);
      await page.mouse.click(
        beforeOpen.handle!.left + beforeOpen.handle!.width / 2,
        beforeOpen.handle!.top + beforeOpen.handle!.height / 2,
      );
      await expect
        .poll(async () => (await readRail(page)).handle!.right, {
          timeout: 5_000,
          message: 'opening the drawer must move the handle off the transcript edge',
        })
        .toBeLessThanOrEqual(beforeOpen.handle!.right - 100);
    } finally {
      await context.close();
    }
  });

  test('AC-217 (a)(h) a short conversation draws every turn it can hold, and under three turns nothing is drawn', async () => {
    const { context, page } = await openAt(DESKTOP);
    try {
      await page.goto(`${origin}/`);
      await openViaSidebar(page, SHORT_PROJECT_NAME, SHORT_SESSION_NAME);
      await settleTranscript(page);
      const outline = await readOutline(page, SHORT_SESSION_ID);
      expect(outline.status, `GET /outline did not answer: ${outline.body.slice(0, 400)}`).toBe(200);
      const turns = (JSON.parse(outline.body) as { data?: Outline }).data?.turns ?? [];
      expect(turns.length, 'the short fixture must carry its user turns').toBeGreaterThan(2);

      const reading = await readRail(page);
      const where = `short fixture: ${shown(reading)}`;
      expect(reading.tickButtonCount, `the column must draw at most ${MAX_TICKS} ticks at ${where}`)
        .toBeLessThanOrEqual(MAX_TICKS);
      // A conversation no longer than the column can hold is drawn whole: the
      // window is a cap, not a fixed size.
      expect(
        reading.tickButtonCount,
        `a ${turns.length}-turn conversation must draw min(${turns.length}, ${TICK_CAPACITY}) ticks at ${where}`,
      ).toBe(Math.min(turns.length, TICK_CAPACITY));

      // ── (h) under three turns both columns stand down, and the handle does not care ──
      await page.goto(`${origin}/`);
      await openViaSidebar(page, TINY_PROJECT_NAME, TINY_SESSION_NAME);
      await settleTranscript(page);
      const tiny = await readRail(page);
      expect(tiny.tickButtonCount, `a one-turn transcript must draw no ticks: ${shown(tiny)}`).toBe(0);
      expect(tiny.thumb, `a one-turn transcript must draw no scrollbar: ${shown(tiny)}`).toBeNull();
      expect(tiny.track, `a one-turn transcript must draw no scrollbar track: ${shown(tiny)}`).toBeNull();
      expect(tiny.handle, `the handle must still be drawn on a one-turn transcript: ${shown(tiny)}`).not.toBeNull();
      expect(
        tiny.handle!.bottom,
        `the handle must stay on screen without the rail: ${shown(tiny)}`,
      ).toBeLessThanOrEqual(tiny.pane.bottom);
      expect(
        tiny.handle!.top,
        `the handle must stay clear of the export control without the rail: ${shown(tiny)}`,
      ).toBeGreaterThanOrEqual((tiny.exportAnchor?.bottom ?? tiny.pane.top) + HANDLE_BAND_MARGIN - 1);
    } finally {
      await context.close();
    }
  });
});
