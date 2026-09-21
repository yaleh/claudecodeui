import fs from 'node:fs';
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
  interface Instruments {
    /** Every `scroll` the page saw, capture phase, with the element it came from. */
    __scrollEvents: { target: string; t: number }[];
    /** Every assignment to `scrollTop`, recorded without altering it. */
    __scrollWrites: { value: number; t: number }[];
    /** Every input event that could have moved a viewport. */
    __scrollInputs: { type: string; t: number }[];
    /** Every mount of the scroll-to-bottom control, which lives for less than a sample. */
    __scrollButtonAppearances: { t: number }[];
  }
  const page = window as unknown as Instruments;
  page.__scrollEvents = [];
  page.__scrollWrites = [];
  page.__scrollInputs = [];
  page.__scrollButtonAppearances = [];

  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(this: Element, value: number) {
        page.__scrollWrites.push({ value, t: performance.now() });
        descriptor.set!.call(this, value);
      },
    });
  }

  window.addEventListener('scroll', (event) => {
    const target = event.target;
    page.__scrollEvents.push({
      target: target instanceof Element ? target.className : '',
      t: performance.now(),
    });
  }, true);

  for (const type of ['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown']) {
    window.addEventListener(type, () => {
      page.__scrollInputs.push({ type, t: performance.now() });
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
          page.__scrollButtonAppearances.push({ t: performance.now() });
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
};

type ScrollInstruments = {
  __scrollEvents: { target: string; t: number }[];
  __scrollWrites: { value: number; t: number }[];
  __scrollInputs: { type: string; t: number }[];
  __scrollButtonAppearances: { t: number }[];
};

/** Whatever the instruments have recorded since they were last cleared. */
const readInstruments = (page: Page) =>
  page.evaluate(() => {
    const read = window as unknown as ScrollInstruments;
    return JSON.parse(JSON.stringify({
      __scrollEvents: read.__scrollEvents,
      __scrollWrites: read.__scrollWrites,
      __scrollInputs: read.__scrollInputs,
      __scrollButtonAppearances: read.__scrollButtonAppearances,
    })) as ScrollInstruments;
  });

/** Clears the counters, so the window that follows is measured on its own. */
const clearInstruments = (page: Page) =>
  page.evaluate(() => {
    const read = window as unknown as {
      __scrollEvents: unknown[];
      __scrollWrites: unknown[];
      __scrollInputs: unknown[];
      __scrollButtonAppearances: unknown[];
    };
    read.__scrollEvents.length = 0;
    read.__scrollWrites.length = 0;
    read.__scrollInputs.length = 0;
    read.__scrollButtonAppearances.length = 0;
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
 * Puts the pointer over the middle of the pane, so the wheel gestures land on the transcript.
 *
 * A wheel is aimed at whatever is under the pointer, and where that is depends on the viewport: the
 * sidebar is beside the pane on a desktop and over it on a phone, so a coordinate that reached the
 * transcript at one width can land on the sidebar at another. Every gesture below therefore aims
 * before it scrolls rather than inheriting a position from somewhere else in the run.
 */
const pointAtPane = async (page: Page) => {
  const box = await page.locator(PANE).boundingBox();
  if (!box) {
    throw new Error('the transcript pane has no box to aim a gesture at');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};

/**
 * Scrolls the pane with real wheel gestures until `reached` holds.
 *
 * Chromium animates wheel scrolling, so each tick is followed by a wait for the pane to settle; the loop
 * exists because one tick's travel is the browser's to decide, not the spec's.
 */
const wheelUntil = async (page: Page, deltaY: number, reached: (geometry: Geometry) => boolean) => {
  await pointAtPane(page);
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

/**
 * AC-107's viewports: a phone-sized pane, and the same pane after a software
 * keyboard would have taken half of it.
 *
 * The two differ in height only, and that is the point of the case: what shrinks
 * is the scroll container's own box, while the content column inside it keeps
 * exactly the box it had. The keyboard is not simulated — the shell is `fixed
 * inset-0` and the pane is `flex-1` inside it, so moving the viewport moves the
 * pane by the same amount through the layout the app already has.
 */
const AC107_VIEWPORT = { width: 390, height: 844 };
const AC107_SHRUNK_VIEWPORT = { width: 390, height: 420 };

/**
 * AC-110's viewport: wide enough to lay the transcript out as a desktop chat, and
 * tall enough that the seeded transcript's first page has no scrollbar at all.
 *
 * The height is the fixture, not a convenience. The pane counts `scrollTop < 100`
 * as "the user is at the top", and on this transcript `scrollTop` starts at 0 and
 * cannot move: the content is shorter than the pane, so no wheel can raise a
 * scroll. The gesture is therefore invisible to anything that reads offsets, and
 * the only evidence it happened is the wheel itself.
 */
const AC110_VIEWPORT = { width: 1440, height: 6000 };
/** Rows the first page holds; SESSION_MESSAGES_PAGE_SIZE's own value. */
const AC110_FIRST_PAGE_ROWS = 20;
/** How long the window under test stays open, in milliseconds. */
const AC110_SAMPLE_WINDOW_MS = 2_000;
/** How long the sample waits for a resize that never comes before reading anyway. */
const AC110_SAMPLE_FALLBACK_MS = 120;
/** The anchored row's offset may move by at most this, in CSS pixels. */
const AC110_DRIFT_PX = 2;
/** The content column: the pane's last child, the box whose growth the follow watches. */
const CONTENT_COLUMN = `${PANE} > div:last-child`;

/**
 * When the seeded transcript's own turns stop, in epoch milliseconds.
 *
 * playwright.config.ts stamps the seeded turns forward from the run's boot, one a
 * minute, so a message the app stamps with `Date.now()` while this case runs would
 * sort *into* the middle of the transcript — computeMerged interleaves server and
 * realtime messages by timestamp. The growth this case measures has to land below
 * the row the restore anchored to: a row inserted above it moves that row through
 * the browser's own scroll anchoring, which is a different mechanism from the one
 * being discriminated. Read from the seeded file rather than assumed, so the clock
 * and the fixture cannot drift apart.
 */
const seededTranscriptEndsAt = () => {
  const file = path.join(
    process.env.QUAY_E2E_DATA_DIR!,
    '.claude',
    'projects',
    'transcript-follow-workspace',
    `${SESSION_ID}.jsonl`,
  );
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return Math.max(...records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite));
};

type PaneFixture = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  gap: number;
  /** How many message rows are on screen. */
  rows: number;
  /** The first row's own timestamp, which is how the row is found again later. */
  firstStamp: string | null;
  /** True while the pane still offers an older page. */
  hasMore: boolean;
};

/**
 * Reads the pane's fixture state: geometry, row count, the first row's identity,
 * and whether the transcript has an older page left.
 *
 * The rows are the outermost elements carrying a timestamp — the lazy row wrapper —
 * so a row is one element here whether or not its content is mounted. The pagination
 * banner is matched on the string the app renders rather than on a class, and it is
 * the same string the criterion's precondition names.
 */
const readFixture = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const rows = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
      .filter((row) => !row.parentElement?.closest('[data-message-timestamp]'));
    return {
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      scrollTop: pane.scrollTop,
      gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
      rows: pane.querySelectorAll('.chat-message').length,
      firstStamp: rows[0]?.getAttribute('data-message-timestamp') ?? null,
      hasMore: (pane.textContent ?? '').includes('Scroll up to load more'),
    };
  });

/** Wheels up over the pane until the transcript has prepended an older page. */
const wheelUntilPrepended = async (page: Page, originalFirst: string, previousRows: number) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.mouse.wheel(0, -WHEEL_STEP_PX);
    await waitForSettledPane(page);
    const fixture = await readFixture(page);
    if (fixture.rows > previousRows && fixture.firstStamp !== originalFirst) {
      return fixture;
    }
  }
  throw new Error('the wheel over the pane never made the transcript prepend an older page');
};

/** The offset of a row's top from the pane's top, in CSS pixels — the row's place in the viewport. */
const readRowOffset = (page: Page, stamp: string) =>
  page.evaluate((target) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const row = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
      .find((node) => node.getAttribute('data-message-timestamp') === target);
    return row ? row.getBoundingClientRect().top - pane.getBoundingClientRect().top : null;
  }, stamp);

type AnchorSample = { offset: number | null; scrollTop: number; gap: number };

/**
 * Samples the anchored row's offset, the offset and the gap on the far side of
 * layout and of the ResizeObserver callbacks a growth raises.
 *
 * The observer is created here and observes the content column, so it is called
 * after the app's own and the follow has already written by the time this one is
 * notified; the frame and the timeout after it put the read after that frame's
 * rendering steps. Reading scrollHeight in the same evaluation that grew the box
 * would report a layout nobody ever saw. A fallback keeps a quiet window — the
 * samples after the growth, when nothing resizes — from reading as a hang.
 */
const sampleAnchor = (page: Page, stamp: string) =>
  page.evaluate(
    ({ target, fallbackMs }) => new Promise<AnchorSample>((resolve) => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
      const content = document.querySelector('.chat-messages-pane > div:last-child');
      let settled = false;
      const read = () => {
        if (settled) return;
        settled = true;
        const row = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
          .find((node) => node.getAttribute('data-message-timestamp') === target);
        resolve({
          offset: row ? row.getBoundingClientRect().top - pane.getBoundingClientRect().top : null,
          scrollTop: pane.scrollTop,
          gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
        });
      };
      const afterLayout = () => requestAnimationFrame(() => setTimeout(read, 0));
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        afterLayout();
      });
      if (content) observer.observe(content);
      setTimeout(() => {
        observer.disconnect();
        afterLayout();
      }, fallbackMs);
    }),
    { target: stamp, fallbackMs: AC110_SAMPLE_FALLBACK_MS },
  );

/**
 * Adds a message row the way a user does — through the composer, as the app really
 * sends one — and reports whether the transcript grew.
 *
 * The row arrives as an ordinary React re-render of a real store change: no store
 * write from the spec, no DOM edit of ours, no style of ours. The suggestion menu
 * swallows Enter, so it is dismissed first; that is the composer's own behaviour,
 * not something this case is about.
 */
const appendRowThroughComposer = async (page: Page) => {
  const before = await page.locator(`${PANE} .chat-message`).count();
  const composer = page.locator('textarea').first();
  await composer.click();
  await composer.fill('/memory');
  await composer.press('Escape');
  await composer.press('Enter');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await page.locator(`${PANE} .chat-message`).count()) > before) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
};

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('transcript follow in a real browser', () => {
  let page: Page;
  let workspace = '';

  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });
  /** The project row is a toggle whose accessible name starts with the workspace's display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }).first();

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
    await pointAtPane(page);
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

  // AC-107: the pane the transcript scrolls in getting *shorter* is the other half of "the transcript
  // grew and the viewport followed". Nothing about the content changes here — the content column keeps the
  // box it had — so an implementation that watches only the content's geometry cannot see it at all. And
  // the shrink raises no `scroll` either: the scrollable range only gets longer, so scrollTop is never
  // clamped and the pane reports nothing. The only thing left to go on is the container's own box, and the
  // only thing that can say whether the viewport should follow is the user's intent — by the time any
  // observer runs, the gap the shrink opened is already there, so asking the geometry "are we at the
  // bottom?" answers no for exactly the case this exists for.
  test('AC-107 a pane that gets shorter is followed by a pinned transcript and left alone by one the user took over', async () => {
    // A phone-sized viewport, so the pane is a large fraction of the screen and the shrink below moves it by
    // hundreds of pixels rather than a few. The wheel gestures need the pointer over the pane at this size.
    await page.setViewportSize(AC107_VIEWPORT);
    await pointAtPane(page);

    // Arrive at the bottom by gesture rather than by assertion: leave it first, so the wheel below is what
    // really puts the viewport there.
    await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    const reachedBottom = await wheelUntil(page, WHEEL_STEP_PX, (geometry) => geometry.gap <= AT_BOTTOM_PX);
    expect(
      reachedBottom.gap,
      `a wheel gesture must be able to reach the bottom; stopped ${reachedBottom.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);
    await waitForSettledPane(page);

    // ── (a) the pinned half: the pane itself gets shorter ─────────────────────────────────────────────
    await clearInstruments(page);
    const beforeShrink = await readGeometry(page);
    // Armed before the change: the probe's observer is created after the app's, so it is notified after the
    // follow has decided, and it resolves on the far side of the frame the follow deferred its write to.
    await armLayoutProbe(page, PANE);
    await page.setViewportSize(AC107_SHRUNK_VIEWPORT);
    await awaitLayoutProbe(page);
    const afterShrink = await readGeometry(page);
    const paneLost = beforeShrink.clientHeight - afterShrink.clientHeight;

    expect(
      paneLost,
      `the shrink has to really shorten the pane, or this case measures nothing (clientHeight ${beforeShrink.clientHeight} → ${afterShrink.clientHeight})`,
    ).toBeGreaterThan(AWAY_PX);
    expect(
      afterShrink.scrollHeight,
      'the content itself must not have changed height — this half is about the container, not the column',
    ).toBe(beforeShrink.scrollHeight);

    // The readings first, so a failing run carries the numbers instead of only the verdict.
    console.log(`AC-107 pinned readings ${JSON.stringify({
      viewport: AC107_VIEWPORT,
      shrunkViewport: AC107_SHRUNK_VIEWPORT,
      paneClientHeightBefore: Math.round(beforeShrink.clientHeight),
      paneClientHeightAfter: Math.round(afterShrink.clientHeight),
      paneLostPx: Math.round(paneLost),
      scrollHeightBefore: Math.round(beforeShrink.scrollHeight),
      scrollHeightAfter: Math.round(afterShrink.scrollHeight),
      scrollTopBefore: Math.round(beforeShrink.scrollTop),
      scrollTopAfter: Math.round(afterShrink.scrollTop),
      gapBeforePx: Math.round(beforeShrink.gap),
      gapAfterPx: Math.round(afterShrink.gap),
    })}`);

    expect(
      afterShrink.gap,
      `a transcript that was on the bottom must be put back on it when the pane gets shorter; it sat ${afterShrink.gap}px above the bottom`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // ── (b) the control half: the user has taken the viewport over, and the same shrink leaves it alone ──
    // Back to the tall pane first: the same shrink is what the control half has to be measured against.
    await page.setViewportSize(AC107_VIEWPORT);
    await waitForSettledPane(page);
    await pointAtPane(page);
    const away = await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    expect(away.gap).toBeGreaterThan(AWAY_PX);
    await waitForSettledPane(page);

    await clearInstruments(page);
    const beforeControl = await readGeometry(page);
    await armLayoutProbe(page, PANE);
    await page.setViewportSize(AC107_SHRUNK_VIEWPORT);
    await awaitLayoutProbe(page);
    const afterControl = await readGeometry(page);
    const controlReadings = await readInstruments(page);
    const controlLost = beforeControl.clientHeight - afterControl.clientHeight;
    const paneScrolls = controlReadings.__scrollEvents
      .filter((event) => event.target.includes('chat-messages-pane'));

    console.log(`AC-107 control readings ${JSON.stringify({
      paneClientHeightBefore: Math.round(beforeControl.clientHeight),
      paneClientHeightAfter: Math.round(afterControl.clientHeight),
      paneLostPx: Math.round(controlLost),
      scrollTopBefore: Math.round(beforeControl.scrollTop),
      scrollTopAfter: Math.round(afterControl.scrollTop),
      gapBeforePx: Math.round(beforeControl.gap),
      gapAfterPx: Math.round(afterControl.gap),
      scrollWritesInWindow: controlReadings.__scrollWrites.map((write) => Math.round(write.value)),
      paneScrollEventsInWindow: paneScrolls.length,
    })}`);

    expect(
      controlLost,
      `the control half has to shrink the pane by the same amount as the pinned half (${controlLost}px)`,
    ).toBeGreaterThan(AWAY_PX);
    expect(
      controlReadings.__scrollWrites.length,
      `a shrink under a viewport the user moved must not be written to at all (${JSON.stringify(controlReadings.__scrollWrites)})`,
    ).toBe(0);
    expect(
      Math.abs(afterControl.scrollTop - beforeControl.scrollTop),
      `the shrink must not scroll a transcript the user took over (scrollTop ${beforeControl.scrollTop} → ${afterControl.scrollTop})`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((afterControl.gap - beforeControl.gap) - controlLost),
      `the gap must open by exactly what the pane lost and nothing else (${beforeControl.gap} → ${afterControl.gap}, lost ${controlLost})`,
    ).toBeLessThanOrEqual(1);
    expect(
      paneScrolls.length,
      `a shrink the browser never had to clamp must not be reported as a scroll (${JSON.stringify(paneScrolls)})`,
    ).toBe(0);
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
    const paneScrolls = shrinkReadings.__scrollEvents
      .filter((event) => event.target.includes('chat-messages-pane'));
    expect(
      paneScrolls.length,
      'the browser really did scroll the pane, or this scenario is empty and proves nothing',
    ).toBeGreaterThanOrEqual(1);
    expect(
      shrinkReadings.__scrollWrites.length,
      `that movement must not be the app writing the offset (${JSON.stringify(shrinkReadings.__scrollWrites)})`,
    ).toBe(0);
    expect(
      shrinkReadings.__scrollButtonAppearances.length,
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
      finalReadings.__scrollButtonAppearances.length,
      'the scroll button must not appear anywhere in the window the criterion covers',
    ).toBe(0);
    expect(await button(), 'and must not be on screen at the end of it').toBe(0);
    expect(
      finalReadings.__scrollInputs,
      `the window must contain no input at all (${JSON.stringify(finalReadings.__scrollInputs)})`,
    ).toEqual([]);

    // The readings themselves, so the run's own output carries them instead of
    // leaving them inferable only from a green check.
    console.log(`AC-111 readings ${JSON.stringify({
      shrinkLostPx: shrunk?.lost ?? 0,
      pannedPx: Math.round(panned),
      paneScrollEventsInShrinkWindow: paneScrolls.length,
      programmaticWritesInShrinkWindow: shrinkReadings.__scrollWrites.length,
      buttonAppearancesInWindow: finalReadings.__scrollButtonAppearances.length,
      inputEventsInWindow: finalReadings.__scrollInputs.length,
      gapAfterGrowthPx: afterGrowth.gap,
      gapAfterShrinkPx: afterShrink.gap,
    })}`);
  });

  // AC-110: a prepend the user's wheel asked for must not be handed back to the follow by the restore
  // that prepend itself ends with.
  //
  // The state this case is built on is a first screen with nothing to scroll. The restore a prepend runs
  // is `scrollTop += nextAnchorOffset - anchorOffset`, and a pane that had no scrollable height cannot
  // keep the anchor's offset: the browser clamps the write to the bottom — exactly where a user who
  // scrolled there sits. So where the restore *lands* says nothing about who wants the viewport there, and
  // anything that reads the offset (or the `scroll` report the write raises) reads the app's own write as
  // the user's intent. The only thing that can still tell the two apart is what the next growth does: a
  // follow moves the viewport for it, a transcript the user took over does not.
  //
  // (The clamp is not the defect and is not what this case asserts against — the restore is necessarily at
  // the bottom here. What is asserted is that a gesture the pane could not report still leaves the
  // viewport the user's.)
  test('AC-110 a prepend the wheel asked for stays the user\'s across the restore that lands at the bottom', async () => {
    // ── the fixture: the seeded transcript's first page, at a viewport tall enough to leave nothing to scroll ──
    await page.setViewportSize(AC110_VIEWPORT);
    // The app's clock is moved past the transcript's last turn so a row it adds now sorts *after* the
    // seeded ones. It is still running — this fixes the wall clock, not the timers the app waits on.
    await page.clock.setFixedTime(new Date(seededTranscriptEndsAt() + 3_600_000));
    await page.goto('/');
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
    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
    await waitForSettledPane(page);
    await pointAtPane(page);

    const fixture = await readFixture(page);
    expect(
      fixture.scrollHeight,
      `the first screen has to leave nothing to scroll, or the gesture would be reported by the pane itself (${fixture.scrollHeight} > ${fixture.clientHeight})`,
    ).toBeLessThanOrEqual(fixture.clientHeight);
    expect(
      fixture.rows,
      'the seeded transcript must open on exactly one page of rows, so the wheel has an older page to ask for',
    ).toBe(AC110_FIRST_PAGE_ROWS);
    expect(fixture.hasMore, 'the first page must not be the whole transcript').toBe(true);
    const originalFirst = fixture.firstStamp;
    expect(originalFirst, 'the first row must carry a timestamp to be found again by').not.toBeNull();

    // ── the prepend, from a real gesture over the pane and from nothing else ──
    await clearInstruments(page);
    const prepended = await wheelUntilPrepended(page, originalFirst!, fixture.rows);
    expect(
      prepended.rows,
      `the older page has to arrive as rows (${fixture.rows} → ${prepended.rows})`,
    ).toBeGreaterThan(fixture.rows);
    expect(
      Date.parse(prepended.firstStamp!),
      'the rows that arrived must be older than the ones that were there',
    ).toBeLessThan(Date.parse(originalFirst!));
    const gestureReadings = await readInstruments(page);
    expect(
      gestureReadings.__scrollInputs.some((event) => event.type === 'wheel'),
      'the prepend must be the wheel\'s doing — the criterion forbids reaching the pagination any other way',
    ).toBe(true);

    // The restore is a single write, and the settle is what says it has landed;
    // the offset below is read after it, because it is the offset the window under
    // test starts from.
    const restored = await waitForSettledPane(page);
    const offset0 = await readRowOffset(page, originalFirst!);
    expect(
      offset0,
      'the original first row has to be on screen for the window below to measure its place',
    ).not.toBeNull();
    const before = await readGeometry(page);
    await clearInstruments(page);

    // ── the growth: one real re-render adds a row below the anchored one ──
    await armLayoutProbe(page, CONTENT_COLUMN);
    expect(
      await appendRowThroughComposer(page),
      'the composer has to be able to add a row, or the window below measures nothing',
    ).toBe(true);
    // The probe resolves on the layout the growth caused; the race only keeps a
    // growth the app refused to render from hanging the case.
    await Promise.race([awaitLayoutProbe(page), page.waitForTimeout(5_000)]);

    // ── the window: ~2s of samples, each after layout and the observers' callbacks ──
    const samples: AnchorSample[] = [await sampleAnchor(page, originalFirst!)];
    const deadline = Date.now() + AC110_SAMPLE_WINDOW_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(160);
      samples.push(await sampleAnchor(page, originalFirst!));
    }

    const offsets = samples.map((sample) => sample.offset);
    expect(
      offsets.every((offset) => offset !== null),
      'the anchored row has to stay in the transcript for the window to be measurable',
    ).toBe(true);
    const drift = Math.max(...offsets.map((offset) => Math.abs(offset! - offset0!)));
    const highest = Math.max(...samples.map((sample) => sample.scrollTop));
    const smallestGap = Math.min(...samples.map((sample) => sample.gap));

    // The mechanism, read back: the app's own writes are the only thing that could
    // have moved the offset, and none of them went down.
    const readings = await readInstruments(page);
    const downwardWrites = readings.__scrollWrites.filter((write) => write.value > before.scrollTop + 1);

    // The readings, printed before the assertions so a run that fails still
    // carries the numbers that say which writer moved the viewport, and so the
    // green run's output is evidence rather than a bare check mark.
    console.log(`AC-110 readings ${JSON.stringify({
      viewport: AC110_VIEWPORT,
      rowsBeforePrepend: fixture.rows,
      rowsAfterPrepend: prepended.rows,
      scrollHeightBefore: Math.round(fixture.scrollHeight),
      scrollHeightAfterPrepend: Math.round(prepended.scrollHeight),
      paneClientHeight: Math.round(fixture.clientHeight),
      restoreWrite: gestureReadings.__scrollWrites.map((write) => Math.round(write.value)),
      gapAfterRestorePx: Math.round(restored.gap),
      scrollTopAfterRestore: Math.round(restored.scrollTop),
      offset0Px: Math.round(offset0!),
      samples: samples.length,
      offsets,
      scrollTops: samples.map((sample) => Math.round(sample.scrollTop)),
      gaps: samples.map((sample) => Math.round(sample.gap)),
      driftPx: Math.round(drift * 100) / 100,
      scrollTopRisePx: Math.round((highest - before.scrollTop) * 100) / 100,
      smallestGapPx: Math.round(smallestGap),
      scrollWritesInWindow: readings.__scrollWrites.map((write) => Math.round(write.value)),
      downwardWritesInWindow: downwardWrites.length,
    })}`);

    expect(
      drift,
      `a prepend the user asked for must leave the row where it was: the offset moved ${drift}px over the window (${JSON.stringify(offsets)})`,
    ).toBeLessThanOrEqual(AC110_DRIFT_PX);
    expect(
      highest - before.scrollTop,
      `the viewport must not be pulled back down by the growth (scrollTop ${before.scrollTop} → ${highest})`,
    ).toBeLessThanOrEqual(1);
    expect(
      smallestGap,
      `the transcript must stay off the bottom, where the restore left it on its own (smallest gap ${smallestGap}px)`,
    ).toBeGreaterThan(2);

    expect(
      downwardWrites,
      `nothing may write the offset towards the bottom in the window (${JSON.stringify(downwardWrites)})`,
    ).toEqual([]);
  });
});
