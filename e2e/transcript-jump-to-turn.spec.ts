import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-213: the turn navigation rail — clicking any user turn (including one the
// client has never loaded) places that turn's message fully inside the scroll
// container's viewport and highlights it, without a blank viewport in between;
// the window then continues front and back without gaps or duplicates; and
// "back to latest" returns to the tail, where a newly arrived realtime row
// re-pins. The rail and the sidebar search share one id-addressed jump, so the
// jump resolves a same-millisecond tie by id, not by timestamp.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir). The session is the shared long
// fixture seeded by `seedTranscriptJumpTranscript` in playwright.config.ts —
// 1200 user turns, 4800 drawn rows, the 600th and 601st sharing one millisecond
// — opened through the sidebar's own link. Nothing is stubbed: the outline the
// rail indexes comes from `GET /api/providers/sessions/:id/outline`.

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
/** The first of the two turns that share one millisecond (the 601st reuses it). */
const TIE_TURN = 600;
/** The turn "near the earliest" the criterion clicks: ~10% of the conversation. */
const EARLY_TURN = 121;
/** Fixed desktop viewport, so the rail lays out and the pane is a known size. */
const VIEWPORT = { width: 1280, height: 1200 };
/** The criterion's own ceiling: the target is on screen within this long of the click. */
const TARGET_VISIBLE_MS = 3_000;
/** A gap at or below this is "at the bottom", in CSS pixels. */
const AT_BOTTOM_PX = 2;
/** One wheel tick for the continuation gestures, in CSS pixels. */
const WHEEL_STEP_PX = 700;
/** The scroll-to-bottom control, located the way the app labels it. */
const SCROLL_BUTTON = '[aria-label="Scroll to bottom"], [title="Scroll to bottom"]';

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
 * the page so it carries the token the UI stored. This is the same index the
 * rail reads, so the ticks the case clicks are the turns the endpoint named.
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

/**
 * Clicks the rail at a tick's own position with a real mouse.
 *
 * The rail resolves a click by proportional position (its ticks are a fraction
 * of a pixel apart), so the click is aimed at the tick's box centre — the same
 * point the reader aims at — and the rail picks the nearest turn from it.
 */
const clickTick = async (page: Page, turnId: string) => {
  const box = await tickFor(page, turnId).boundingBox();
  if (!box) throw new Error(`the rail has no tick for ${turnId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** The transcript row for a turn, addressed by the id the outline reported. */
const rowFor = (page: Page, turnId: string) => page.locator(`[data-message-anchor-id="${turnId}"]`);

type TargetReading = {
  present: boolean;
  fully: boolean;
  highlighted: boolean;
  /** The turn number drawn in the target row, for the tie discriminator. */
  turnNumber: number | null;
  offsetFromPaneTop: number | null;
};

/**
 * Reads the target row against the scroll container's box: whether its whole
 * height is inside the pane, whether it carries the highlight, and what turn
 * number it draws. The turn number is how a same-millisecond tie is told apart
 * from its twin — two rows can share an instant, not a number.
 */
const readTarget = (page: Page, turnId: string): Promise<TargetReading> =>
  page.evaluate((id) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    const row = document.querySelector(`[data-message-anchor-id="${id}"]`) as HTMLElement | null;
    if (!pane || !row) {
      return { present: Boolean(row), fully: false, highlighted: false, turnNumber: null, offsetFromPaneTop: null };
    }
    const paneRect = pane.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const match = /Turn (\d+)\./.exec(row.textContent ?? '');
    return {
      present: true,
      fully: rowRect.top >= paneRect.top - 1 && rowRect.bottom <= paneRect.bottom + 1,
      highlighted: row.classList.contains('search-highlight-flash'),
      turnNumber: match ? Number(match[1]) : null,
      offsetFromPaneTop: Math.round(rowRect.top - paneRect.top),
    };
  }, turnId);

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

/**
 * Records, once a frame's rendering steps have run, how many transcript rows
 * intersect the pane's box. Sampling stops when told; the minimum over the run
 * is the "blank viewport" reading — a single frame with no row on screen is the
 * failure, so the witness has to be per-frame rather than per-assertion.
 */
const startBlankSampler = (page: Page) =>
  page.evaluate(() => {
    interface BlankState { samples: number[]; running: boolean }
    const state: BlankState = { samples: [], running: true };
    (window as unknown as { __ac213blank: BlankState }).__ac213blank = state;
    const tick = () => {
      if (!state.running) return;
      requestAnimationFrame(() => {
        setTimeout(() => {
          const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
          if (pane) {
            const paneRect = pane.getBoundingClientRect();
            let visible = 0;
            for (const node of Array.from(pane.querySelectorAll('[data-message-timestamp]'))) {
              const rect = (node as HTMLElement).getBoundingClientRect();
              if (rect.bottom > paneRect.top && rect.top < paneRect.bottom) visible += 1;
            }
            state.samples.push(visible);
          }
          tick();
        }, 0);
      });
    };
    tick();
  });

/** Stops the blank sampler and returns every frame's reading. */
const stopBlankSampler = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __ac213blank?: { running: boolean; samples: number[] } }).__ac213blank;
    if (!state) return [] as number[];
    state.running = false;
    return state.samples;
  });

/**
 * The user-turn numbers drawn in the pane right now, in document order.
 *
 * Only a user turn draws the text "Turn N." — the assistant rows carry
 * "Reply N." — so this is the rail's own sequence as the DOM currently holds it.
 */
const drawnTurnNumbers = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.chat-messages-pane .chat-message.user'))
      .map((row) => /Turn (\d+)\./.exec(row.textContent ?? '')?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number),
  );

/** Records every frame a chat socket receives and lets a frame be handed to the app through it. */
const installWireDouble = () => {
  const page = window as unknown as {
    __wireSockets: { url: string; socket: WebSocket }[];
    __injectStreamFrame: (frame: unknown) => number;
  };
  page.__wireSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      const socket = this as WebSocket;
      page.__wireSockets.push({ url: String(args[0]), socket });
    }
  } as unknown as typeof WebSocket;

  page.__injectStreamFrame = (frame: unknown) => {
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

/**
 * Hands the app one realtime delta on its own chat socket, the way a reply arrives.
 *
 * The frame's timestamp is deliberately far in the future: the seed stamps its
 * turns forward from the run's boot (one a minute, 4800 rows), so a row stamped
 * with `Date.now()` would sort *into* the middle of the transcript rather than
 * after it, and the case could not then read whether the pane re-pinned under a
 * row that arrived at the end. A block key is carried so the store uses this
 * timestamp for the row it creates.
 */
const injectRealtimeDelta = (page: Page, sessionId: string, content: string) =>
  page.evaluate(
    (payload) =>
      (window as unknown as { __injectStreamFrame: (frame: unknown) => number }).__injectStreamFrame({
        kind: 'stream_delta',
        sessionId: payload.sessionId,
        content: payload.content,
        blockKey: 'e2e-ac213-realtime',
        id: 'e2e-ac213-wire',
        timestamp: '2099-01-01T00:00:00.000Z',
        provider: 'claude',
        role: 'assistant',
      }),
    { sessionId, content },
  );

test.describe.configure({ mode: 'serial', timeout: 240_000 });

test.describe('turn rail jump in a real browser', () => {
  let page: Page;
  let turns: OutlineTurn[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    await page.addInitScript(installWireDouble);
    await page.bringToFront();
    await page.setViewportSize(VIEWPORT);

    await ensureSignedIn(page);
    await settleServiceWorker(page);
    await openSeededSession(page);
    await waitForSettledPane(page);
    await pointAtPane(page);

    const outline = await readOutline(page, SESSION_ID);
    expect(outline.status, `GET /outline did not answer: ${outline.body.slice(0, 400)}`).toBe(200);
    turns = (JSON.parse(outline.body) as { data?: { turns?: OutlineTurn[] } }).data?.turns ?? [];
    expect(turns.length, 'the outline must carry every user turn of the seeded session').toBe(TOTAL_TURNS);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('AC-213 a rail tick jumps any turn into the viewport, the window continues, and "back to latest" re-pins', async () => {
    // ── The rail exists and offers the whole conversation ──────────────────
    await expect(tickFor(page, turnFor(turns, 1).id), 'the rail must offer the first turn').toBeAttached({ timeout: 15_000 });
    const earlyTurn = turnFor(turns, EARLY_TURN);
    const earlyTick = tickFor(page, earlyTurn.id);
    await expect(earlyTick, 'the rail must offer a turn near the earliest').toBeAttached();

    // ── (b) the target is not in the DOM before the click ───────────────────
    expect(
      await rowFor(page, earlyTurn.id).count(),
      `turn ${EARLY_TURN} must not be in the DOM before its tick is clicked`,
    ).toBe(0);

    // ── (a) + (c): click, then read the viewport every frame until the row is
    // fully inside it, highlighted, with no blank frame in between ──────────
    await startBlankSampler(page);
    const clickedAt = await page.evaluate(() => performance.now());
    await clickTick(page, earlyTurn.id);

    let reading: TargetReading | null = null;
    const deadline = Date.now() + TARGET_VISIBLE_MS;
    while (Date.now() < deadline) {
      const current = await readTarget(page, earlyTurn.id);
      if (current.fully) {
        reading = current;
        break;
      }
      await page.waitForTimeout(50);
    }
    const blankSamples = await stopBlankSampler(page);
    const elapsed = await page.evaluate((startedAt) => Math.round(performance.now() - startedAt), clickedAt);
    const diagnostic = await page.evaluate((targetId) => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      const targetRow = document.querySelector(`[data-message-anchor-id="${targetId}"]`) as HTMLElement | null;
      const flash = document.querySelector('.search-highlight-flash') as HTMLElement | null;
      const turnNumbers = Array.from(pane?.querySelectorAll('.chat-message.user') ?? [])
        .map((row) => /Turn (\d+)\./.exec((row as HTMLElement).textContent ?? '')?.[1])
        .filter((value): value is string => Boolean(value));
      return {
        targetPresent: Boolean(targetRow),
        targetRect: targetRow ? { top: Math.round(targetRow.getBoundingClientRect().top), bottom: Math.round(targetRow.getBoundingClientRect().bottom) } : null,
        paneRect: pane ? { top: Math.round(pane.getBoundingClientRect().top), bottom: Math.round(pane.getBoundingClientRect().bottom), scrollTop: Math.round(pane.scrollTop), scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight } : null,
        flashTurn: /Turn (\d+)\./.exec(flash?.textContent ?? '')?.[1] ?? null,
        anchors: Array.from(document.querySelectorAll('[data-message-anchor-id]')).length,
        turnNumbers: [turnNumbers[0], turnNumbers[turnNumbers.length - 1], turnNumbers.length],
      };
    }, earlyTurn.id);

    expect(
      reading,
      `turn ${EARLY_TURN} was not fully in the viewport within ${TARGET_VISIBLE_MS}ms of its tick being clicked (${JSON.stringify(diagnostic)})`,
    ).not.toBeNull();
    expect(reading!.turnNumber, 'the row landed in must be the turn that was clicked').toBe(EARLY_TURN);
    expect(reading!.highlighted, 'the jumped-to row must be highlighted').toBe(true);
    expect(elapsed, `the target had to be on screen within ${TARGET_VISIBLE_MS}ms`).toBeLessThanOrEqual(TARGET_VISIBLE_MS);
    expect(blankSamples.length, 'the blank sampler must have watched the jump').toBeGreaterThan(0);
    expect(
      Math.min(...blankSamples),
      `no frame during the jump may show a blank viewport; fewest rows seen was ${Math.min(...blankSamples)} of ${blankSamples.length} frames`,
    ).toBeGreaterThanOrEqual(1);

    // ── the jump detached from the follow: the pane now knows it sits away
    // from the tail, which is what stops the next arriving row from dragging
    // the reader back down. The visible consequence is the way back — the
    // back-to-latest control — being offered. A jump that leaves the follow
    // engaged still centres the target, so "the target is in view" alone would
    // not catch it; this reading does.
    await expect(
      page.locator(SCROLL_BUTTON).first(),
      'after jumping away from the tail the pane must offer the way back to it (the jump must detach the follow)',
    ).toBeVisible({ timeout: 5_000 });

    // ── (d) the window continues front and back without gaps or duplicates ──
    for (let screen = 0; screen < 3; screen += 1) {
      await page.mouse.wheel(0, -WHEEL_STEP_PX);
      await waitForSettledPane(page);
    }
    for (let screen = 0; screen < 3; screen += 1) {
      await page.mouse.wheel(0, WHEEL_STEP_PX);
      await waitForSettledPane(page);
    }
    const drawn = await drawnTurnNumbers(page);
    expect(drawn.length, 'the wheel gestures must have left user turns on screen').toBeGreaterThan(1);
    const unique = new Set(drawn);
    expect(unique.size, `no user turn may be drawn twice after the wheel gestures: ${JSON.stringify(drawn)}`).toBe(drawn.length);
    for (let index = 1; index < drawn.length; index += 1) {
      expect(
        drawn[index] - drawn[index - 1],
        `consecutive drawn user turns must be adjacent, so the window has no missing rows: ${JSON.stringify(drawn)}`,
      ).toBe(1);
    }

    // ── (e) "back to latest" returns to the tail ────────────────────────────
    await page.locator(SCROLL_BUTTON).first().click({ timeout: 15_000 });
    const lastTurn = turnFor(turns, TOTAL_TURNS);
    await expect(rowFor(page, lastTurn.id), 'the tail must be back after "back to latest"').toBeAttached({ timeout: 15_000 });
    await expect
      .poll(async () => Math.abs((await readGeometry(page)).gap), {
        timeout: 10_000,
        message: '"back to latest" never settled the pane on the bottom',
      })
      .toBeLessThanOrEqual(AT_BOTTOM_PX);

    // ...and a realtime row arriving afterwards re-pins the pane.
    const delivered = await injectRealtimeDelta(page, SESSION_ID, 'AC213 realtime row after returning to the tail.');
    expect(delivered, 'the realtime frame was never delivered to a chat socket').toBeGreaterThan(0);
    await expect
      .poll(async () => (await page.locator(PANE).textContent())?.includes('AC213 realtime row') ?? false, {
        timeout: 10_000,
        message: 'the injected realtime row never appeared in the transcript',
      })
      .toBe(true);
    expect(
      Math.abs((await readGeometry(page)).gap),
      'a realtime row arriving after "back to latest" must keep the pane pinned to the bottom',
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // ── The tie: the 601st turn shares the 600th's millisecond, and its tick
    // must land on the 601st — the discriminator a timestamp lookup fails ───
    const tiedFirst = turnFor(turns, TIE_TURN);
    const tiedSecond = turnFor(turns, TIE_TURN + 1);
    expect(tiedFirst.timestamp, 'the fixture must give the tie pair one millisecond').toBe(tiedSecond.timestamp);
    expect(tiedFirst.id, 'the tied turns must still be two ids').not.toBe(tiedSecond.id);
    await clickTick(page, tiedSecond.id);
    let tieReading: TargetReading | null = null;
    const tieDeadline = Date.now() + TARGET_VISIBLE_MS;
    while (Date.now() < tieDeadline) {
      const current = await readTarget(page, tiedSecond.id);
      if (current.fully) {
        tieReading = current;
        break;
      }
      await page.waitForTimeout(50);
    }
    const tieDiagnostic = await page.evaluate((targetId) => {
      const flash = document.querySelector('.search-highlight-flash') as HTMLElement | null;
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      const turnNumbers = Array.from(pane?.querySelectorAll('.chat-message.user') ?? [])
        .map((row) => /Turn (\d+)\./.exec((row as HTMLElement).textContent ?? '')?.[1])
        .filter((value): value is string => Boolean(value));
      return {
        targetPresent: Boolean(document.querySelector(`[data-message-anchor-id="${targetId}"]`)),
        flashTurn: /Turn (\d+)\./.exec(flash?.textContent ?? '')?.[1] ?? null,
        turnNumbers: [turnNumbers[0], turnNumbers[turnNumbers.length - 1], turnNumbers.length],
      };
    }, tiedSecond.id);
    expect(
      tieReading,
      `the tick for turn ${TIE_TURN + 1} never placed its row in the viewport (${JSON.stringify(tieDiagnostic)})`,
    ).not.toBeNull();
    expect(
      tieReading!.turnNumber,
      `clicking turn ${TIE_TURN + 1}'s tick must land on turn ${TIE_TURN + 1}, not the tied ${TIE_TURN}`,
    ).toBe(TIE_TURN + 1);
    // "Turn 601's row is visible" is not by itself a discriminator: a timestamp
    // lookup finds the *first* row that shares the instant (turn 600) and
    // centres/highlights that one, and the clicked turn 601 is drawn right
    // beside it, still inside the viewport. What tells the two apart is *which
    // row the jump acted on* — the clicked turn's row must carry the highlight,
    // and its same-millisecond twin must not. A jump addressed by timestamp
    // fails exactly here.
    expect(
      tieReading!.highlighted,
      `the jump must highlight turn ${TIE_TURN + 1}'s own row, not the same-millisecond turn ${TIE_TURN}'s (${JSON.stringify(tieDiagnostic)})`,
    ).toBe(true);
    expect(
      (await readTarget(page, tiedFirst.id)).highlighted,
      `the tied turn ${TIE_TURN} must not be the row the jump actually addressed`,
    ).toBe(false);

    // ── Control: the first and the last turn are clicks too ─────────────────
    const firstTurn = turnFor(turns, 1);
    expect(await rowFor(page, firstTurn.id).count(), 'turn 1 must not be in the DOM before its tick is clicked').toBe(0);
    await clickTick(page, firstTurn.id);
    await expect
      .poll(async () => (await readTarget(page, firstTurn.id)).fully, {
        timeout: TARGET_VISIBLE_MS,
        message: 'the first turn never landed in the viewport',
      })
      .toBe(true);

    await clickTick(page, lastTurn.id);
    let lastReading: TargetReading | null = null;
    const lastDeadline = Date.now() + TARGET_VISIBLE_MS;
    while (Date.now() < lastDeadline) {
      const current = await readTarget(page, lastTurn.id);
      if (current.fully) {
        lastReading = current;
        break;
      }
      await page.waitForTimeout(50);
    }
    const lastDiagnostic = await page.evaluate((targetId) => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      const row = document.querySelector(`[data-message-anchor-id="${targetId}"]`) as HTMLElement | null;
      const paneRect = pane?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      return {
        targetPresent: Boolean(row),
        row: rowRect ? { top: Math.round(rowRect.top), bottom: Math.round(rowRect.bottom) } : null,
        pane: paneRect ? { top: Math.round(paneRect.top), bottom: Math.round(paneRect.bottom) } : null,
      };
    }, lastTurn.id);
    expect(
      lastReading,
      `the last turn never landed in the viewport (${JSON.stringify(lastDiagnostic)})`,
    ).not.toBeNull();
    expect(lastReading!.turnNumber).toBe(TOTAL_TURNS);
  });
});
