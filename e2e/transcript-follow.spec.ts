import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-106: a transcript sitting at the bottom follows content that grows in place — the last row getting
// taller with no new row and no store write — while a transcript the user has scrolled away from is left
// exactly where the user put it.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
// Nothing here stubs a request: the transcript is a real Claude transcript seeded into the run's isolated
// HOME before the server booted and indexed by the backend's own synchronizer, the session is opened through
// the sidebar, and the viewport is moved in both directions by real wheel gestures.
//
// The two growths are direct DOM mutations, deliberately: no row is added and no store flush reaches the code
// under test, so only an implementation driven by the content's own geometry can see them. That is the whole
// point of the criterion — a version that waited on a React signal satisfies nothing here.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-transcript-follow';
/** Display name of that session, as the sidebar renders it. */
const SESSION_NAME = 'transcript-follow';
/** Height each growth adds, in CSS pixels — comfortably past any tolerance a follow could justify. */
const GROWTH_PX = 480;
/** How far the control half moves away from the bottom, in CSS pixels. */
const AWAY_PX = 400;
/**
 * One wheel tick, in CSS pixels.
 *
 * Kept well under LazyMessageRow's 1200px viewport margin: a row outside that band is unmounted and replaced
 * by a placeholder, and the growths below have to land on a row whose real content is in the DOM.
 */
const WHEEL_STEP_PX = 700;
/** A gap at or below this is "at the bottom"; the criterion's own bound is 1px. */
const AT_BOTTOM_PX = 1;
/** Height the boxes above the viewport lose, in CSS pixels — AC-111's M. */
const SHRINK_PX = 240;
/** The scroll-to-bottom control, located the way the app labels it. */
const SCROLL_BUTTON = '[aria-label="Scroll to bottom"], [title="Scroll to bottom"]';

/**
 * The page-side instruments AC-111 reads, installed before the app's first script runs.
 *
 * Nothing here changes what the page does. The scrollTop setter keeps its original descriptor and
 * only appends the value it was handed to a list, so a write is counted without being altered, and
 * every listener is a passive recorder. What the three counters separate is the *source* of a
 * scroll: an input event (wheel, touch, key, pointer press) means the user asked for it, a write
 * through the setter means the app placed the viewport, and a scroll with neither behind it is the
 * browser's own scroll anchoring or clamping.
 */
const instrumentScrollSources = () => {
  const state = {
    scrollEvents: [] as { target: string; t: number }[],
    scrollWrites: [] as { value: number; t: number }[],
    inputEvents: [] as { type: string; t: number }[],
    buttonAppearances: 0,
  };
  (window as unknown as { __transcriptScroll: typeof state }).__transcriptScroll = state;

  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(this: Element, value: number) {
        state.scrollWrites.push({ value, t: performance.now() });
        descriptor.set!.call(this, value);
      },
    });
  }

  window.addEventListener('scroll', (event) => {
    const target = event.target;
    state.scrollEvents.push({
      target: target instanceof Element ? target.className : '',
      t: performance.now(),
    });
  }, true);

  for (const type of ['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown']) {
    window.addEventListener(type, () => {
      state.inputEvents.push({ type, t: performance.now() });
    }, true);
  }

  // The button is mounted and unmounted, so counting what appears is the only
  // way to see one that lived for less than a sample interval.
  const selector = '[aria-label="Scroll to bottom"], [title="Scroll to bottom"]';
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.matches(selector) || node.querySelector(selector)) {
          state.buttonAppearances += 1;
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
};

type ScrollInstruments = {
  scrollEvents: { target: string; t: number }[];
  scrollWrites: { value: number; t: number }[];
  inputEvents: { type: string; t: number }[];
  buttonAppearances: number;
};

/** Whatever the instruments have recorded since they were last cleared. */
const readInstruments = (page: Page) =>
  page.evaluate(
    () => JSON.parse(
      JSON.stringify((window as unknown as { __transcriptScroll: ScrollInstruments }).__transcriptScroll),
    ) as ScrollInstruments,
  );

/** Clears the counters, so the window that follows is measured on its own. */
const clearInstruments = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __transcriptScroll: ScrollInstruments }).__transcriptScroll;
    state.scrollEvents.length = 0;
    state.scrollWrites.length = 0;
    state.inputEvents.length = 0;
    state.buttonAppearances = 0;
  });

/**
 * Removes `amount` CSS pixels of height from the boxes above the viewport, in place.
 *
 * The browser anchors on the topmost row it can see, so a box above that row shrinking has to move
 * the offset for the row to stay where the user is looking — which is the scroll this criterion is
 * about, and the reason the change is measured rather than assumed. Rows are taken from just above
 * the viewport upwards, because a single row can only lose the height it has.
 */
const shrinkRowsAboveViewport = (page: Page, amount: number) =>
  page.evaluate((shrink) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const paneTop = pane.getBoundingClientRect().top;
    // The outermost element carrying a row's timestamp — the lazy row wrapper —
    // so a row is one box here rather than the box and the row inside it. Every
    // row has one whether or not its content is currently mounted.
    const rows = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
      .filter((row) => !row.parentElement?.closest('[data-message-timestamp]'));
    const above = rows
      .filter((row) => row.getBoundingClientRect().bottom <= paneTop)
      .reverse();
    const shrunk: { before: number; after: number }[] = [];
    let remaining = shrink;
    for (const row of above) {
      if (remaining <= 0) break;
      const before = row.getBoundingClientRect().height;
      const after = Math.max(Math.round(before - remaining), 24);
      row.style.height = `${after}px`;
      // A row that only ever declared a minimum (a lazy placeholder's estimate)
      // would keep its old height under a bare `height`, since min-height wins.
      row.style.minHeight = '0px';
      row.style.overflow = 'hidden';
      shrunk.push({ before, after });
      remaining -= before - after;
    }
    return {
      shrunk,
      lost: shrunk.reduce((total, row) => total + (row.before - row.after), 0),
      scrollHeight: pane.scrollHeight,
    };
  }, amount);

/**
 * Arms a probe that resolves once the resize it is watching has been laid out, the observers the
 * app installed have run, and the frame they deferred their write to has passed.
 *
 * A ResizeObserver created after the app's is called after it, so by the time this one is
 * notified the follow has already decided; the frame and the timeout after it put the read on the
 * far side of a write the follow deferred, which is what makes the geometry a painted one rather
 * than the pre-pin state.
 */
const armLayoutProbe = (page: Page, selector: string) =>
  page.evaluate((probeSelector) => {
    (window as unknown as { __transcriptLayoutProbe: Promise<void> }).__transcriptLayoutProbe =
      new Promise<void>((resolve) => {
        const matches = document.querySelectorAll(probeSelector);
        const target = matches[matches.length - 1];
        if (!target) {
          resolve();
          return;
        }
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          requestAnimationFrame(() => setTimeout(() => resolve(), 0));
        });
        observer.observe(target);
      });
  }, selector);

const awaitLayoutProbe = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __transcriptLayoutProbe: Promise<void> }).__transcriptLayoutProbe,
  );

type Geometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  gap: number;
};

/**
 * Reads the pane's geometry once a frame's rendering steps have run.
 *
 * The frame is requested from inside the page, so a write deferred to a frame of its own lands first, and the
 * timeout puts this read after that frame's rendering steps. Reading scrollHeight in the same evaluation that
 * grew the box would report a layout the user never sees.
 */
const readGeometry = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Geometry>((resolve) => {
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

/**
 * Waits for the pane to stop moving, and returns the geometry it stopped at.
 *
 * Waiting rather than reading once is what makes the measurement meaningful: the follow is allowed to land a
 * frame after the growth, and a scroll the browser animates arrives over several. Both a pinned and an
 * un-pinned implementation reach a steady state here, and the steady state is what gets asserted.
 */
const waitForSettledPane = async (page: Page): Promise<Geometry> => {
  let previous: Geometry | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await readGeometry(page);
    if (
      previous
      && Math.abs(current.scrollTop - previous.scrollTop) < 0.5
      && Math.abs(current.gap - previous.gap) < 0.5
    ) {
      stable += 1;
      if (stable >= 3) {
        return current;
      }
    } else {
      stable = 0;
    }
    previous = current;
    await page.waitForTimeout(80);
  }
  throw new Error('the transcript pane never stopped moving');
};

/**
 * Scrolls the pane with real wheel gestures until `reached` holds.
 *
 * Chromium animates wheel scrolling, so each tick is followed by a wait for the pane to settle; the loop
 * exists because one tick's travel is the browser's to decide, not the spec's.
 */
const wheelUntil = async (page: Page, deltaY: number, reached: (geometry: Geometry) => boolean) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.mouse.wheel(0, deltaY);
    const geometry = await waitForSettledPane(page);
    if (reached(geometry)) {
      return geometry;
    }
  }
  throw new Error(`the pane never reached the state this gesture was for (deltaY=${deltaY})`);
};

/**
 * Appends a block of exactly `height` CSS pixels to the last assistant row.
 *
 * This is the growth a streaming answer performs: the row already on screen gets taller, no message is added,
 * and no store write happens. Returns the pane's scrollHeight with the growth already laid out.
 */
const growLastAssistantRow = (page: Page, height: number) =>
  page.evaluate((growth) => {
    const rows = document.querySelectorAll('.chat-message.assistant');
    const row = rows[rows.length - 1] as HTMLElement | undefined;
    if (!row) {
      return null;
    }
    const spacer = document.createElement('div');
    spacer.dataset.ac106Growth = 'appended';
    spacer.style.height = `${growth}px`;
    row.appendChild(spacer);
    return (document.querySelector('.chat-messages-pane') as HTMLElement).scrollHeight;
  }, height);

/**
 * Replaces the last content block of the last assistant row with a taller one — the other way the same row
 * grows in place, and the one a markdown re-render takes.
 *
 * The block is a markdown paragraph as this app really renders one. `<Markdown>` overrides react-markdown's
 * `p` to a `div.mb-2` (transcript/Markdown.tsx), so a `p` selector would find nothing in a transcript whose
 * every paragraph went through it. `.prose` is the container StreamingMarkdown gives a reply, which keeps the
 * match inside the reply body rather than any chrome around it.
 */
const replaceLastAssistantSegment = (page: Page, height: number) =>
  page.evaluate((growth) => {
    const rows = document.querySelectorAll('.chat-message.assistant');
    const row = rows[rows.length - 1] as HTMLElement | undefined;
    if (!row) {
      return null;
    }
    const body = row.querySelector('.prose');
    if (!body) {
      return null;
    }
    const blocks = Array.from(body.querySelectorAll('.mb-2'));
    const target = blocks[blocks.length - 1] ?? body;
    if (!target) {
      return null;
    }
    const replacement = document.createElement('div');
    replacement.dataset.ac106Growth = 'replacement';
    replacement.style.height = `${growth}px`;
    replacement.textContent = 'replaced segment';
    target.replaceWith(replacement);
    return (document.querySelector('.chat-messages-pane') as HTMLElement).scrollHeight;
  }, height);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('transcript follow in a real browser', () => {
  let page: Page;
  let workspace = '';

  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });
  /** The project row is a toggle whose accessible name starts with the workspace's display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }).first();

  /** Puts the pointer over the middle of the pane, so the wheel gestures land on the transcript. */
  const pointAtPane = async () => {
    const box = await page.locator(PANE).boundingBox();
    if (!box) {
      throw new Error('the transcript pane has no box to aim a gesture at');
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const dataDir = process.env.QUAY_E2E_DATA_DIR!;
    // Seeded (with its transcript) by playwright.config.ts before the server booted.
    workspace = path.join(dataDir, 'transcript-follow-workspace');

    page = await browser.newPage();
    // Before the first script runs, so AC-111 counts every input and every
    // offset write the spec's own setup performs, not just the ones after it
    // remembered to start watching.
    await page.addInitScript(instrumentScrollSources);
    // A tab that loses focus pauses the scroll animation the gestures rely on.
    await page.bringToFront();

    // First run on a fresh database: create the single account, then finish onboarding.
    await page.goto('/');
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();

    // Indexing a session auto-registers its project, so the seeded workspace is already a project here — the
    // sidebar is the proof, and no project is created over the API or through the UI.
    await expect(projectRow()).toBeVisible({ timeout: 30_000 });

    // Signed in means the app shell is up. The "Choose Your Project" empty state never renders here (the
    // project above exists), so anchoring on that is a race; Settings is not.
    await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible({ timeout: 30_000 });

    // Loading the app re-reads /api/projects, which synchronizes sessions before it answers.
    await page.reload();

    // The row is a toggle, so a click that lands while the sidebar is still re-rendering would leave it
    // collapsed — retry until the rows are really on screen.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) {
        break;
      }
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        break;
      } catch {
        // Collapsed again (or the click missed); the loop clicks once more.
      }
    }
    await expect(sessionLink()).toBeVisible({ timeout: 30_000 });

    // Into the transcript through the sidebar's own link — never by writing the store or the URL.
    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
    // The initial scroll-to-bottom settles on its own; the gestures below have to start from rest.
    const initial = await waitForSettledPane(page);
    // Liveness: a transcript that does not scroll could not tell a follow from a no-op.
    expect(
      initial.scrollHeight - initial.clientHeight,
      'the seeded transcript must be taller than the pane for this spec to measure anything',
    ).toBeGreaterThan(AWAY_PX * 2);
    await pointAtPane();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('AC-106 a row that grows in place stays pinned at the bottom, and a scrolled-away transcript is left alone', async () => {
    // Arrive at the bottom by gesture rather than by assertion: leave it first, so the wheel below is what
    // really puts the viewport there.
    await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    const reachedBottom = await wheelUntil(page, WHEEL_STEP_PX, (geometry) => geometry.gap <= AT_BOTTOM_PX);
    expect(
      reachedBottom.gap,
      `a wheel gesture must be able to reach the bottom; stopped ${reachedBottom.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // (a) The row already on screen grows. No row is added and nothing is written to the store.
    const grownByAppending = await growLastAssistantRow(page, GROWTH_PX);
    expect(grownByAppending, 'the transcript needs a last assistant row to grow').not.toBeNull();
    expect(grownByAppending!).toBeGreaterThan(reachedBottom.scrollHeight);
    const afterAppend = await waitForSettledPane(page);
    expect(
      afterAppend.gap,
      `a pinned transcript must stay on the bottom when the last row grows; it sat ${afterAppend.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // (b) The same row grows by replacing its last block — the markdown-re-render shape of the same event.
    const grownByReplacing = await replaceLastAssistantSegment(page, GROWTH_PX);
    expect(grownByReplacing, 'the last assistant row needs a content block to replace').not.toBeNull();
    expect(grownByReplacing!).toBeGreaterThan(afterAppend.scrollHeight);
    const afterReplace = await waitForSettledPane(page);
    expect(
      afterReplace.gap,
      `a pinned transcript must stay on the bottom when the last row is replaced by a taller one; it sat ${afterReplace.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // Control half: the user leaves the bottom, and the very same growth must not move the viewport.
    const away = await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    expect(away.gap).toBeGreaterThan(AWAY_PX);
    const before = away;
    const scrollHeightAfterGrowth = await growLastAssistantRow(page, GROWTH_PX);
    expect(scrollHeightAfterGrowth, 'the control case needs a last assistant row to grow').not.toBeNull();
    const growth = scrollHeightAfterGrowth! - before.scrollHeight;
    expect(growth, 'the growth half of the control case must really have grown the content').toBeGreaterThan(0);
    const after = await waitForSettledPane(page);

    expect(
      Math.abs(after.scrollTop - before.scrollTop),
      `growth under a viewport the user moved must not scroll it (scrollTop ${before.scrollTop} → ${after.scrollTop})`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((after.gap - before.gap) - growth),
      `the gap must open by exactly the growth and nothing else (${before.gap} → ${after.gap}, growth ${growth})`,
    ).toBeLessThanOrEqual(1);
  });

  test('AC-111 a scroll the browser made on its own does not detach a pinned transcript', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // Arrive at the bottom by gesture, from away from it, so a wheel is what put
    // the viewport there rather than a position inherited from the case above.
    await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    const reachedBottom = await wheelUntil(page, WHEEL_STEP_PX, (geometry) => geometry.gap <= AT_BOTTOM_PX);
    expect(
      reachedBottom.gap,
      `a wheel gesture must be able to reach the bottom; stopped ${reachedBottom.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);
    // The gesture's own reports have to be over: a scroll still arriving from it
    // would be counted in the window below, and it belongs to the wheel.
    await waitForSettledPane(page);

    // From here to the end of the case the page receives no input of any kind.
    await clearInstruments(page);
    const button = () => page.locator(SCROLL_BUTTON).count();
    expect(
      await button(),
      'a transcript the user just wheeled to the bottom is following, and offers no way back',
    ).toBe(0);

    // (a) A box above the viewport collapses. The browser has to move the offset
    // itself — there is no input and no write from the app — for its anchor to
    // stay where the user is looking.
    const before = await readGeometry(page);
    const shrunk = await shrinkRowsAboveViewport(page, SHRINK_PX);
    expect(
      shrunk?.lost ?? 0,
      'the shrink half needs boxes above the viewport tall enough to lose the height the criterion names',
    ).toBeGreaterThanOrEqual(SHRINK_PX);
    const afterShrink = await waitForSettledPane(page);
    const panned = before.scrollTop - afterShrink.scrollTop;
    expect(
      panned,
      `the browser must have moved the offset by what the content lost (${before.scrollTop} → ${afterShrink.scrollTop})`,
    ).toBeGreaterThanOrEqual(SHRINK_PX - 1);

    const shrinkReadings = await readInstruments(page);
    const paneScrolls = shrinkReadings.scrollEvents.filter((event) => event.target.includes('chat-messages-pane'));
    expect(
      paneScrolls.length,
      'the browser really did scroll the pane, or this scenario is empty and proves nothing',
    ).toBeGreaterThanOrEqual(1);
    expect(
      shrinkReadings.scrollWrites.length,
      `that movement must not be the app writing the offset (${JSON.stringify(shrinkReadings.scrollWrites)})`,
    ).toBe(0);
    expect(
      shrinkReadings.buttonAppearances,
      'the scroll button must not appear for a scroll nobody asked for',
    ).toBe(0);
    expect(await button(), 'and must not be on screen when the shrink half is sampled').toBe(0);

    // (b) The last row then grows in place. The viewport never left the bottom,
    // so there is no gap for the growth to open.
    await armLayoutProbe(page, `${PANE} .chat-message.assistant`);
    const grown = await growLastAssistantRow(page, GROWTH_PX);
    expect(grown, 'the transcript needs a last assistant row to grow').not.toBeNull();
    expect(grown!).toBeGreaterThan(afterShrink.scrollHeight);
    await awaitLayoutProbe(page);
    const afterGrowth = await readGeometry(page);
    expect(
      afterGrowth.gap,
      `the growth must be followed: the pan was the browser's, never the user's (gap ${afterGrowth.gap}px)`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    const finalReadings = await readInstruments(page);
    expect(
      finalReadings.buttonAppearances,
      'the scroll button must not appear anywhere in the window the criterion covers',
    ).toBe(0);
    expect(await button(), 'and must not be on screen at the end of it').toBe(0);
    expect(
      finalReadings.inputEvents,
      `the window must contain no input at all (${JSON.stringify(finalReadings.inputEvents)})`,
    ).toEqual([]);
  });
});
