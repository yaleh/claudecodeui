import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-214: the transcript's drawn global scrollbar. Its thumb sits at the current
// turn's absolute-message-subscript fraction of the whole conversation — never at
// the loaded window's pixel ratio — so a window prepended above the viewport, or a
// row whose height is measured late, cannot move it. It is a real `role="scrollbar"`
// control: draggable, clickable and keyboard-operable, and a drag fetches nothing
// until it comes to rest, then exactly one page for the position it rested at.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir). The session is the shared long fixture
// seeded by `seedTranscriptJumpTranscript` — 1200 user turns, 4800 drawn rows — opened
// through the sidebar's own link. The outline the rail indexes comes from
// `GET /api/providers/sessions/:id/outline`; nothing is stubbed.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-transcript-jump';
/** Display name the sidebar renders for it. */
const SESSION_NAME = 'transcript-jump';
/** The project row's accessible name starts with the workspace's basename. */
const PROJECT_NAME = 'transcript-jump-workspace';
/** User turns the fixture carries. */
const TOTAL_TURNS = 1200;
/** Normalized rows the fixture carries (four drawn rows per turn). */
const TOTAL_MESSAGES = 4800;
/** The turn "near the earliest" the criterion jumps to: ~10% of the conversation. */
const EARLY_TURN = 121;
/** Fixed desktop viewport, so the rail lays out and the pane is a known size. */
const VIEWPORT = { width: 1280, height: 1200 };
/** The criterion's own ceiling: the target is on screen within this long of the click. */
const TARGET_VISIBLE_MS = 3_000;
/** A gap at or below this is "at the bottom", in CSS pixels. */
const AT_BOTTOM_PX = 2;
/** One wheel tick for the monotonic-scroll gesture, in CSS pixels. */
const WHEEL_STEP_PX = 700;
/** A reading must not move the thumb backwards by more than this share of the track, per frame. */
const BACKWARD_JUMP_TOLERANCE = 0.005;

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

/**
 * Reads the seeded session's outline over the app's own REST route, from inside
 * the page so it carries the token the UI stored. `index` is the turn's absolute
 * message subscript in the full normalized history — the same scale the drawn
 * scrollbar is measured on, and the one the criterion reads positions from.
 */
const readOutline = (page: Page, sessionId: string): Promise<{ status: number; body: string }> =>
  page.evaluate(async (id) => {
    const response = await fetch(`/api/providers/sessions/${encodeURIComponent(id)}/outline`, {
      headers: { Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}` },
    });
    return { status: response.status, body: await response.text() };
  }, sessionId);

/** The outline turn for a 1-indexed displayed turn number, matched on its own preview text. */
const turnFor = (turns: OutlineTurn[], displayTurn: number): OutlineTurn => {
  const turn = turns.find((entry) => entry.preview.startsWith(`Turn ${displayTurn}.`))
    ?? turns[displayTurn - 1];
  if (!turn) throw new Error(`no outline turn for turn ${displayTurn}`);
  return turn;
};

/** The sidebar row for the seeded session. */
const sessionLink = (page: Page) => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

/** Opens the seeded session through the sidebar's own link. */
const openSeededSession = async (page: Page) => {
  const projectRow = () => page.getByRole('button', { name: new RegExp(`^${PROJECT_NAME}`) }).first();
  await expect(projectRow(), 'indexing the seeded transcript must register its project').toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await sessionLink(page).isVisible().catch(() => false)) break;
    await projectRow().click();
    try {
      await expect(sessionLink(page)).toBeVisible({ timeout: 10_000 });
      break;
    } catch {
      // Collapsed again (or the click missed); the loop clicks once more.
    }
  }
  await expect(sessionLink(page)).toBeVisible({ timeout: 30_000 });
  await sessionLink(page).click({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
};

/** The rail tick for a turn, addressed by the id the outline reported. */
const tickFor = (page: Page, turnId: string) => page.locator(`[data-turn-id="${turnId}"]`);

/** Clicks the rail at a tick's own position with a real mouse. */
const clickTick = async (page: Page, turnId: string) => {
  const box = await tickFor(page, turnId).boundingBox();
  if (!box) throw new Error(`the rail has no tick for ${turnId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** The transcript row for a turn, addressed by the id the outline reported. */
const rowFor = (page: Page, turnId: string) => page.locator(`[data-message-anchor-id="${turnId}"]`);

type ThumbReading = {
  /** The thumb's own fraction of the track, derived from its laid-out geometry. */
  progress: number;
  /** The pane's distance from its bottom, in CSS pixels. */
  gap: number;
  role: string | null;
  orientation: string | null;
  valueNow: number | null;
  valueMin: number | null;
  valueMax: number | null;
};

const readThumb = (page: Page): Promise<ThumbReading> =>
  page.evaluate(() => {
    const track = document.querySelector('[data-scrollbar-track]') as HTMLElement | null;
    const thumbEl = document.querySelector('[data-scrollbar-thumb]') as HTMLElement | null;
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    const empty = {
      progress: Number.NaN, gap: Number.NaN,
      role: null, orientation: null, valueNow: null, valueMin: null, valueMax: null,
    };
    if (!track || !thumbEl || !pane) return empty;
    const t = track.getBoundingClientRect();
    const b = thumbEl.getBoundingClientRect();
    const span = t.height - b.height;
    return {
      progress: span > 0 ? (b.top - t.top) / span : Number.NaN,
      gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
      role: thumbEl.getAttribute('role'),
      orientation: thumbEl.getAttribute('aria-orientation'),
      valueNow: Number(thumbEl.getAttribute('aria-valuenow')),
      valueMin: Number(thumbEl.getAttribute('aria-valuemin')),
      valueMax: Number(thumbEl.getAttribute('aria-valuemax')),
    };
  });

/** The loaded window's pixel ratio — the reading the drawn thumb must not be. */
const readPanePixelFraction = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const travel = pane.scrollHeight - pane.clientHeight;
    return travel > 0 ? pane.scrollTop / travel : 0;
  });

/**
 * The first anchored row of the loaded window, as a fraction of the conversation.
 *
 * The wrapper keeps `data-message-anchor-id` whether or not the row's content is
 * mounted, so the first such element in document order is the window's own first
 * turn — the row the window was read around — not merely the first one on screen.
 */
const windowFirstRowFraction = async (
  page: Page,
  turns: OutlineTurn[],
  totalMessages: number,
): Promise<number | null> => {
  const id = await page.evaluate(() => {
    const el = document.querySelector('.chat-messages-pane [data-message-anchor-id]');
    return el ? el.getAttribute('data-message-anchor-id') : null;
  });
  if (!id) return null;
  const turn = turns.find((entry) => entry.id === id);
  return turn ? turn.index / totalMessages : null;
};

/** Records every `/messages` request the app makes, with the page-time it was issued at. */
const installFetchLog = () => {
  const w = window as unknown as { __messageFetches: { url: string; t: number }[] };
  w.__messageFetches = [];
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/messages')) w.__messageFetches.push({ url, t: performance.now() });
    return original(input, init);
  }) as typeof window.fetch;
};

const readFetches = (page: Page) =>
  page.evaluate(() => (window as unknown as { __messageFetches: { url: string; t: number }[] }).__messageFetches);

/** The `around` id of a messages request, or null for a tail page. */
const aroundOf = (url: string): string | null => new URL(url, 'http://localhost').searchParams.get('around');

/** Samples the thumb's fraction once a frame until told to stop. */
const startProgressSampler = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pSamples: number[]; __pSampling: boolean };
    w.__pSamples = [];
    w.__pSampling = true;
    const tick = () => {
      if (!w.__pSampling) return;
      const track = document.querySelector('[data-scrollbar-track]');
      const thumb = document.querySelector('[data-scrollbar-thumb]');
      if (track && thumb) {
        const t = track.getBoundingClientRect();
        const b = thumb.getBoundingClientRect();
        const span = t.height - b.height;
        if (span > 0) w.__pSamples.push((b.top - t.top) / span);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const stopProgressSampler = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pSamples: number[]; __pSampling: boolean };
    w.__pSampling = false;
    return w.__pSamples;
  });

type PaneGeometry = { scrollTop: number; scrollHeight: number; clientHeight: number; gap: number };

/** Reads the pane's geometry once a frame's layout has settled. */
const readGeometry = (page: Page): Promise<PaneGeometry> =>
  page.evaluate(
    () =>
      new Promise<PaneGeometry>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
            resolve({
              scrollTop: pane.scrollTop,
              scrollHeight: pane.scrollHeight,
              clientHeight: pane.clientHeight,
              gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
            });
          }, 0);
        });
      }),
  );

/** Waits for the pane to stop moving and returns where it stopped. */
const waitForSettledPane = async (page: Page): Promise<PaneGeometry> => {
  let previous: PaneGeometry | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await readGeometry(page);
    if (previous && Math.abs(current.scrollTop - previous.scrollTop) < 0.5 && Math.abs(current.gap - previous.gap) < 0.5) {
      stable += 1;
      if (stable >= 3) return current;
    } else {
      stable = 0;
    }
    previous = current;
    await page.waitForTimeout(80);
  }
  throw new Error('the transcript pane never stopped moving');
};

/** Puts the pointer over the middle of the pane, so a wheel gesture lands on the transcript. */
const pointAtPane = async (page: Page) => {
  const box = await page.locator(PANE).boundingBox();
  if (!box) throw new Error('the transcript pane has no box to aim a gesture at');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};

test.describe.configure({ mode: 'serial', timeout: 240_000 });

test.describe('drawn global scrollbar in a real browser', () => {
  let page: Page;
  let turns: OutlineTurn[] = [];
  let totalMessages = TOTAL_MESSAGES;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    await page.addInitScript(installFetchLog);
    await page.bringToFront();
    await page.setViewportSize(VIEWPORT);

    await ensureSignedIn(page);
    await settleServiceWorker(page);
    await openSeededSession(page);
    await waitForSettledPane(page);
    await pointAtPane(page);

    const outline = await readOutline(page, SESSION_ID);
    expect(outline.status, `GET /outline did not answer: ${outline.body.slice(0, 400)}`).toBe(200);
    const data = (JSON.parse(outline.body) as { data?: { total?: number; turns?: OutlineTurn[] } }).data;
    turns = data?.turns ?? [];
    totalMessages = data?.total ?? TOTAL_MESSAGES;
    expect(turns.length, 'the outline must carry every user turn of the seeded session').toBe(TOTAL_TURNS);
    expect(totalMessages, 'the outline must count every normalized row of the seeded session').toBe(TOTAL_MESSAGES);
    // The scale the rail measures on: a turn's `index` is its absolute message
    // subscript, so the fixture's turns sit four rows apart.
    expect(turns[1].index, 'outline indices must be absolute message subscripts').toBe(4);
  });

  test.afterAll(async () => {
    await page.close().catch(() => undefined);
  });

  test('AC-214 the drawn scrollbar thumb is ordinal, draggable, clickable and keyboard-operable', async () => {
    const track = page.locator('[data-scrollbar-track]');
    const thumb = page.locator('[data-scrollbar-thumb]');
    await expect(track, 'the transcript must draw its own scrollbar track').toBeVisible({ timeout: 20_000 });
    await expect(thumb, 'the track must carry a thumb').toBeVisible();

    // ── (a) first screen pinned at the tail: the thumb sits at the far end, and
    // it is a real scrollbar to assistive tech ────────────────────────────────
    const atTail = await readThumb(page);
    expect(atTail.role, 'the thumb must be a scrollbar').toBe('scrollbar');
    expect(atTail.orientation, 'the thumb must be a vertical scrollbar').toBe('vertical');
    expect(atTail.valueMin).toBe(0);
    expect(atTail.valueMax).toBe(100);
    expect(atTail.valueNow, `aria-valuenow must read the position: ${JSON.stringify(atTail)}`).toBeGreaterThanOrEqual(97);
    expect(
      atTail.progress,
      `first screen at the tail must put the thumb at the far end: ${JSON.stringify(atTail)}`,
    ).toBeGreaterThanOrEqual(0.97);

    // ── (d) + DoD: a drag draws the chosen position and previews it, fetches
    // nothing for the intermediate positions, and reads exactly one page for
    // where it rests. While the thumb is dragged the loaded window is still the
    // tail — so a thumb at ~10% with the tail still loaded is the reading that
    // proves the position is the conversation's ordinal, not the window's pixels.
    const fetchesBeforeDrag = (await readFetches(page)).length;
    const trackBox = await track.boundingBox();
    const thumbBox = await thumb.boundingBox();
    if (!trackBox || !thumbBox) throw new Error('the scrollbar has no box to drag');
    const dragX = thumbBox.x + thumbBox.width / 2;
    const yAt = (fraction: number) => trackBox.y + fraction * trackBox.height;

    await page.mouse.move(dragX, thumbBox.y + thumbBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragX, yAt(0.1), { steps: 8 });
    await page.waitForTimeout(60);

    const midDrag = await readThumb(page);
    const midPreview = await page.locator('[data-scrollbar-preview]').textContent();
    expect(
      (await readFetches(page)).length - fetchesBeforeDrag,
      'a drag must not fetch a page for an intermediate position',
    ).toBe(0);
    expect(
      Math.abs(midDrag.gap),
      `the loaded window must still be pinned at the tail while the thumb is dragged: ${JSON.stringify(midDrag)}`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);
    expect(midDrag.progress, `dragging towards 10% must put the thumb near 0.10: ${JSON.stringify(midDrag)}`)
      .toBeGreaterThanOrEqual(0.07);
    expect(midDrag.progress, `dragging towards 10% must put the thumb near 0.10: ${JSON.stringify(midDrag)}`)
      .toBeLessThanOrEqual(0.13);
    expect(midPreview, 'the drag must float a preview of the turn under the thumb').toBeTruthy();
    expect(midPreview!, `the preview must name a turn and its time: ${JSON.stringify(midPreview)}`).toMatch(/Turn \d+\./);
    expect(midPreview!, `the preview must carry the turn's time: ${JSON.stringify(midPreview)}`).toMatch(/\d{1,2}:\d{2}/);
    const previewedTurn = turns.find((entry) => midPreview!.includes(entry.preview));
    expect(
      previewedTurn,
      `the drag preview must show the turn at that position, not an arbitrary one: ${JSON.stringify(midPreview)}`,
    ).toBeTruthy();
    expect(previewedTurn!.index / totalMessages).toBeGreaterThanOrEqual(0.04);
    expect(previewedTurn!.index / totalMessages).toBeLessThanOrEqual(0.18);

    // Release at the middle of the track: the one read a drag is allowed.
    await page.mouse.move(dragX, yAt(0.5), { steps: 8 });
    const releasedAt = await page.evaluate(() => performance.now());
    await page.mouse.up();

    await expect
      .poll(async () => (await readFetches(page)).filter((entry) => entry.t >= releasedAt).length, {
        timeout: 15_000,
        message: 'releasing the thumb must issue the one read for its final position',
      })
      .toBeGreaterThanOrEqual(1);
    const afterRelease = (await readFetches(page)).filter((entry) => entry.t >= releasedAt);
    const targetAround = aroundOf(afterRelease[0].url);
    expect(targetAround, 'the release must read a window around a turn').toBeTruthy();
    expect(
      afterRelease.filter((entry) => aroundOf(entry.url) === targetAround).length,
      `the released position must be read exactly once: ${JSON.stringify(afterRelease.map((entry) => aroundOf(entry.url)))}`,
    ).toBe(1);
    const finalFraction = (() => {
      const turn = turns.find((entry) => entry.id === targetAround);
      return turn ? turn.index / totalMessages : -1;
    })();
    expect(finalFraction, `the release must read the position it rested at: ${targetAround}`)
      .toBeGreaterThanOrEqual(0.44);
    expect(finalFraction, `the release must read the position it rested at: ${targetAround}`)
      .toBeLessThanOrEqual(0.56);
    expect(
      afterRelease.some((entry) => {
        const turn = turns.find((candidate) => candidate.id === aroundOf(entry.url));
        return turn ? turn.index / totalMessages >= 0.04 && turn.index / totalMessages <= 0.18 : false;
      }),
      'the drag must not have read the intermediate position it passed through',
    ).toBe(false);

    await waitForSettledPane(page);
    const afterDrag = await readThumb(page);
    expect(afterDrag.progress, `after resting at 50% the thumb must sit near 0.50: ${JSON.stringify(afterDrag)}`)
      .toBeGreaterThanOrEqual(0.47);
    expect(afterDrag.progress, `after resting at 50% the thumb must sit near 0.50: ${JSON.stringify(afterDrag)}`)
      .toBeLessThanOrEqual(0.53);
    const draggedFirstRow = await windowFirstRowFraction(page, turns, totalMessages);
    expect(draggedFirstRow, 'the loaded window must expose its first row').not.toBeNull();
    expect(
      draggedFirstRow!,
      'the window content after resting at 50% must start near 50% of the conversation',
    ).toBeGreaterThanOrEqual(0.47);
    expect(
      draggedFirstRow!,
      'the window content after resting at 50% must start near 50% of the conversation',
    ).toBeLessThanOrEqual(0.53);

    // ── (b) jump to ~10% of the conversation through a rail tick: the thumb
    // reports the ordinal position, which is not the loaded window's pixel ratio ─
    const earlyTurn = turnFor(turns, EARLY_TURN);
    await clickTick(page, earlyTurn.id);
    await expect
      .poll(async () => (await page.evaluate((id) => {
        const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
        const row = document.querySelector(`[data-message-anchor-id="${id}"]`) as HTMLElement | null;
        if (!pane || !row) return false;
        const paneRect = pane.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return rowRect.top >= paneRect.top - 1 && rowRect.bottom <= paneRect.bottom + 1;
      }, earlyTurn.id)), { timeout: TARGET_VISIBLE_MS, message: 'the early turn never landed in the viewport' })
      .toBe(true);
    await waitForSettledPane(page);

    const afterJump = await readThumb(page);
    const jumpedFirstRow = await windowFirstRowFraction(page, turns, totalMessages);
    expect(afterJump.progress, `turn ${EARLY_TURN} sits at ~10% of the conversation: ${JSON.stringify(afterJump)}`)
      .toBeGreaterThanOrEqual(0.07);
    expect(afterJump.progress, `turn ${EARLY_TURN} sits at ~10% of the conversation: ${JSON.stringify(afterJump)}`)
      .toBeLessThanOrEqual(0.13);
    expect(jumpedFirstRow, 'the loaded window must expose its first row').not.toBeNull();
    expect(jumpedFirstRow!).toBeGreaterThanOrEqual(0.07);
    expect(jumpedFirstRow!).toBeLessThanOrEqual(0.13);
    // The discriminator: a pixel-derived thumb would read the loaded window's own
    // scroll ratio, which after centring the target is near the middle.
    const pixelFraction = await readPanePixelFraction(page);
    expect(
      Math.abs(afterJump.progress - pixelFraction),
      `the thumb must be the conversation's ordinal, not the loaded window's pixels: thumb=${afterJump.progress} pixel=${pixelFraction}`,
    ).toBeGreaterThan(0.2);

    // ── (c) wheeling up inside the window, including across a prepend, never
    // moves the thumb backwards by more than a fraction of the track ───────────
    await startProgressSampler(page);
    for (let step = 0; step < 5; step += 1) {
      await page.mouse.wheel(0, -WHEEL_STEP_PX);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(300);
    const samples = await stopProgressSampler(page);
    expect(samples.length, 'the monotonic sampler must have watched the wheel gesture').toBeGreaterThan(10);
    for (let index = 1; index < samples.length; index += 1) {
      expect(
        samples[index] - samples[index - 1],
        `wheeling up may not move the thumb backwards: ${JSON.stringify(samples.slice(Math.max(0, index - 3), index + 1))}`,
      ).toBeLessThanOrEqual(BACKWARD_JUMP_TOLERANCE);
    }
    expect(
      samples[samples.length - 1],
      `wheeling up must have moved the thumb towards the start: ${JSON.stringify(samples)}`,
    ).toBeLessThan(samples[0]);

    // ── (e) a click on the blank track and the keyboard both move the thumb ────
    const clickTrack = await track.boundingBox();
    if (!clickTrack) throw new Error('the scrollbar track has no box to click');
    await page.mouse.click(clickTrack.x + clickTrack.width / 2, clickTrack.y + 0.75 * clickTrack.height);
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'clicking the track must move the thumb' })
      .toBeGreaterThan(0.6);

    await thumb.focus();
    await page.keyboard.press('End');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'End must move the thumb to the far end' })
      .toBeGreaterThanOrEqual(0.9);
    // The far end of the track is the newest turn's row, which the jump loaded.
    const lastTurn = turnFor(turns, TOTAL_TURNS);
    await expect(rowFor(page, lastTurn.id), 'the newest turn must be reachable through the drawn scrollbar')
      .toBeAttached({ timeout: 15_000 });

    await page.keyboard.press('PageUp');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'PageUp must move the thumb back' })
      .toBeLessThanOrEqual(0.92);
    const pageUp = await readThumb(page);
    expect(pageUp.progress, 'PageUp must land a page before the far end').toBeGreaterThanOrEqual(0.85);

    await page.keyboard.press('Home');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'Home must move the thumb to the start' })
      .toBeLessThanOrEqual(0.1);

    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'PageDown must move the thumb forward' })
      .toBeGreaterThanOrEqual(0.08);
    const pageDown = await readThumb(page);
    expect(pageDown.progress, 'PageDown must land a page after the start').toBeLessThanOrEqual(0.12);

    await page.keyboard.press('ArrowUp');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'ArrowUp must move the thumb' })
      .toBeLessThan(pageDown.progress);
  });
});
