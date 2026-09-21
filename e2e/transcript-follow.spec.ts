import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

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

/**
 * Records every frame the app's websocket receives, before the app's first script runs.
 *
 * The streaming kinds are the transport's own vocabulary — `stream_delta` for one piece of
 * the reply, `stream_end` for the end of a content block — and how many of each the client
 * was handed is not visible from the DOM. Wrapping the constructor is the only way to see
 * them without touching the app.
 */
const instrumentStreamFrames = () => {
  const page = window as unknown as { __streamFrames: { kind: string; t: number }[] };
  page.__streamFrames = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event) => {
        try {
          const frame = JSON.parse(String((event as MessageEvent).data)) as { kind?: string };
          if (frame?.kind) {
            page.__streamFrames.push({ kind: frame.kind, t: Math.round(performance.now()) });
          }
        } catch {
          // Not a JSON frame; nothing to record.
        }
      });
    }
  } as unknown as typeof WebSocket;
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
/**
 * The seeded session's own transcript file, as the backend reads it — the same path
 * playwright.config.ts seeded it at.
 */
const sessionTranscriptFile = () => path.join(
  process.env.QUAY_E2E_DATA_DIR!,
  '.claude',
  'projects',
  'transcript-follow-workspace',
  `${SESSION_ID}.jsonl`,
);

/** One transcript file under the run's isolated HOME, with the lines it holds. */
type TranscriptFile = { file: string; mtimeMs: number; lines: string[] };

/**
 * Every transcript file the run's isolated HOME holds, newest first.
 *
 * AC-108's conversation is not the seeded one: it is created by the app on send and owned by
 * the CLI, so its transcript has no path the spec can name in advance — the CLI writes under
 * the cwd it was spawned in, and that path is the CLI's to choose. What is knowable is that
 * the file is a `.jsonl` under this run's HOME and is not the seeded conversation, so the
 * scan is how the case names it without guessing where the CLI put it.
 */
const transcriptsUnderHome = (): TranscriptFile[] => {
  const root = path.join(process.env.QUAY_E2E_DATA_DIR!, '.claude', 'projects');
  const files: TranscriptFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) {
        continue;
      }
      files.push({
        file: full,
        mtimeMs: fs.statSync(full).mtimeMs,
        lines: fs.readFileSync(full, 'utf8').trim().split('\n').filter(Boolean),
      });
    }
  };
  if (fs.existsSync(root)) {
    walk(root);
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
};

const seededTranscriptEndsAt = () => {
  const records = fs.readFileSync(sessionTranscriptFile(), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
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

/* ────────────────────── AC-108: a reply that really streams ────────────────────── */

/**
 * Viewport the streaming case runs at.
 *
 * A desktop chat, and the window every threshold below is stated against: the wide layout
 * keeps the pane beside the sidebar, and 720px of height makes "more than one screen" a
 * bound one reply can really cross.
 */
const AC108_VIEWPORT = { width: 1280, height: 720 };

/**
 * How many text deltas the gateway streams, and how far apart.
 *
 * 22 × 250 ms ≈ 5.5s — the criterion's own floor (≥20 deltas over ≥5s) with a delta of
 * margin, which costs less than a longer test. The spacing is what makes the steps
 * countable at all: the client buffers deltas for 100ms before flushing one in-place
 * update, so two deltas inside that window arrive as one growth instead of two.
 */
const AC108_DELTA_COUNT = 22;
const AC108_DELTA_INTERVAL_MS = 250;

/**
 * How long the gateway thinks before its first token, in milliseconds.
 *
 * A real reply is not the only thing on the wire: the prompt reaches the pane as a row of its
 * own before the answer starts, and the sampler has to be watching the reply's row rather than
 * the prompt's. This is the gap that lets the case wait for the prompt's row to land and settle
 * without eating into the stream it is measuring — the same shape a gateway has anyway, since
 * nothing answers a prompt in the same millisecond it arrives.
 */
const AC108_STREAM_LEAD_MS = 1_500;

/** The whole stream must outlast this, in milliseconds — the criterion's own floor. */
const AC108_MIN_STREAM_MS = 5_000;

/** The gap the pane may show at a frame where no growth just landed, in CSS pixels. */
const AC108_GAP_PX = 1;

/**
 * How long after the last delta its own growth may still be painted, in milliseconds.
 *
 * The client buffers deltas for 100ms before flushing one, so the frame that carries the last
 * delta is a flush plus a frame behind the frame that delivered it. Used to bound the window
 * the criterion measures, together with the pane-shrink test below.
 */
const AC108_STREAM_SETTLE_MS = 250;

/**
 * The prompt the case types, and the whole of the gateway's selection rule.
 *
 * The Agent SDK names the session through this same base URL with its own cheap model, so a
 * URL test would pick the wrong request; what the user typed is the only thing that
 * separates the request carrying the reply from that one.
 */
const AC108_PROMPT_MARKER = 'AC108STREAMPROMPT';
/** Carried by the last delta, so the case can wait for the reply to have fully arrived. */
const AC108_COMPLETION_MARKER = 'AC108STREAMDONE';
/** The prompt itself. Prose, so nothing in it is read as a composer command. */
const AC108_PROMPT = `${AC108_PROMPT_MARKER} describe what this pane does while a reply is still arriving`;

/**
 * The custom model the gateway is wired into. Its env rows are the only thing pointing the
 * CLI at the spec's socket, which is why the reply can be timed at all.
 */
const AC108_MODEL = { name: 'E2E Streaming Gateway', id: 'e2e-streaming-gateway' };
const AC108_TOKEN = 'sk-e2e-streaming-gateway-2b7d41';

/**
 * The text the gateway streams, one string per delta.
 *
 * Plain prose on purpose: the reply goes through the app's markdown renderer, and a
 * construct whose layout can jump backwards — a table, a fence that opens before it closes,
 * a list that renumbers — would make "the last row grew" a claim about the renderer rather
 * than about the follow. Four sentences is comfortably more than a line, so every flush is
 * a visible step rather than a sub-pixel nudge.
 */
const AC108_DELTAS = Array.from({ length: AC108_DELTA_COUNT }, (_, index) => {
  const body = `Delta ${index}. ${'The transcript pane keeps the newest line in view while a reply arrives one piece at a time. '.repeat(4)}`;
  return index === AC108_DELTA_COUNT - 1 ? `${body} ${AC108_COMPLETION_MARKER}` : body;
});

/** One request the mock gateway saw, kept so the selection rule can be checked afterwards. */
type GatewayHit = {
  url: string;
  body: string;
  /** True for the one request answered with the slow delta stream. */
  streamed: boolean;
};

/** Writes one Anthropic SSE frame. */
const sseFrame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Reads and answers one request.
 *
 * The request body is what selects the reply — the SDK's own session-naming call reaches
 * this gateway too, and it must not be the one that gets streamed. Every body is kept, so
 * "the right request was picked" is checkable from the recording rather than asserted from
 * the spec's belief about it.
 */
const answerGatewayRequest = (
  hits: GatewayHit[],
  request: http.IncomingMessage,
  response: http.ServerResponse,
  onStreamStart: () => void,
  onStreamEnd: () => void,
) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let asked: { model?: string } = {};
    try {
      asked = JSON.parse(body) as { model?: string };
    } catch {
      // Not a JSON body; nothing below can select it.
    }
    // Both selectors matter. The SDK names the session through this same base URL and puts
    // the prompt in that request's own body, so the text alone picks two requests; the model
    // is what separates them, because the naming call runs on the SDK's own cheap model and
    // only the turn runs on the model the case selected.
    const isContentRequest = body.includes(AC108_PROMPT_MARKER) && asked.model === AC108_MODEL.id;
    hits.push({ url: request.url ?? '', body, streamed: isContentRequest });
    if (isContentRequest) {
      onStreamStart();
      respondWithSseStream(response, AC108_DELTAS, AC108_DELTA_INTERVAL_MS, AC108_STREAM_LEAD_MS, onStreamEnd);
      return;
    }
    // Not the measured request: answered at once, because the CLI waits on it and a
    // refusal would end the turn the case is watching arrive.
    respondImmediately(response, body.includes('"stream":true'), 'e2e');
  });
  request.on('error', () => response.destroy());
};

/**
 * Answers one request with a whole Anthropic message stream, one delta per `intervalMs`.
 *
 * The frames around the deltas matter as much as the deltas: the CLI ends the turn on
 * `message_stop`, so a stream that stopped after the last `content_block_delta` would leave
 * the case waiting for a reply that is, as far as the app can tell, still arriving. `onEnd`
 * fires when the last delta is on the wire, which is the span the criterion times.
 */
const respondWithSseStream = (
  response: http.ServerResponse,
  texts: string[],
  intervalMs: number,
  leadMs: number,
  onEnd: () => void,
) => {
  let stopped = false;
  response.on('close', () => { stopped = true; });
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.write(sseFrame('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_e2e_stream',
      type: 'message',
      role: 'assistant',
      model: 'claude-e2e-stream',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 64, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
    },
  }));
  response.write(sseFrame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }));

  let next = 0;
  const writeNext = () => {
    if (stopped) return;
    if (next < texts.length) {
      response.write(sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: texts[next] },
      }));
      next += 1;
      if (next === texts.length) onEnd();
      setTimeout(writeNext, intervalMs);
      return;
    }
    response.write(sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }));
    response.write(sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 512 },
    }));
    response.write(sseFrame('message_stop', { type: 'message_stop' }));
    response.end();
  };
  setTimeout(writeNext, leadMs);
};

/** Answers a request the case is not measuring, in whatever shape it asked for. */
const respondImmediately = (response: http.ServerResponse, wantsStream: boolean, text: string) => {
  const message = {
    id: 'msg_e2e_instant',
    type: 'message',
    role: 'assistant',
    model: 'claude-e2e-instant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
  };
  if (!wantsStream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  response.write(sseFrame('message_start', { type: 'message_start', message: { ...message, content: [] } }));
  response.write(sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  response.write(sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
  response.write(sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }));
  response.write(sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }));
  response.write(sseFrame('message_stop', { type: 'message_stop' }));
  response.end();
};

/**
 * Creates the gateway model through the app's own REST route, as a fixture.
 *
 * The catalog entry is setup, not subject: the case is about what happens after a message
 * is sent, and this is the same POST the Models page makes. It is issued from inside the
 * page so it carries the session the UI just created — the app keeps its token in storage
 * rather than in a cookie, so the same request from the test process would be anonymous.
 */
const createGatewayModel = (page: Page, gatewayUrl: string) =>
  page.evaluate(async (input) => {
    const response = await fetch('/api/providers/claude/models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}`,
      },
      body: JSON.stringify({
        id: input.id,
        model: input.name,
        config: {
          env: [
            { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: input.url },
            { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: input.token },
          ],
        },
      }),
    });
    return { status: response.status, body: await response.text() };
  }, { id: AC108_MODEL.id, name: AC108_MODEL.name, url: gatewayUrl, token: AC108_TOKEN });

/** One frame's reading of the pane while a reply streams. */
type FollowSample = {
  /** Milliseconds since the page's time origin. */
  t: number;
  /** `scrollHeight − scrollTop − clientHeight`: 0 means the last line is on screen. */
  gap: number;
  /** Rows in the transcript. One per message, mounted or not. */
  rows: number;
  /** The last assistant row's own height, in CSS pixels — what a flush grows. */
  lastRowHeight: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Which `.chat-messages-pane` this was, and how many the document had — a pane that is
   * replaced mid-stream starts life at offset zero, which is a different event from a pane
   * that was placed back there. */
  pane: number;
  panes: number;
  /** Characters in the last assistant row and in the whole pane: a box that keeps its text and
   * loses its height was re-laid out, one that loses its text was unmounted. */
  lastRowText: number;
  paneText: number;
  /**
   * The identity of the last assistant row's own DOM node, numbered as each node is first seen.
   *
   * A React key change is an unmount followed by a mount, so the node the row is drawn with is
   * replaced rather than reconciled — and the replacement is invisible in every other field here,
   * because the new node carries the same text and, a frame later, the same height. The number is
   * what makes the replacement itself readable: the same number means the row kept its node.
   */
  lastRowNode: number;
  /**
   * The lazy wrapper's inline height while it is standing in for the row's content, in CSS pixels,
   * and `null` while the content itself is mounted.
   *
   * `LazyMessageRow` writes `height: measuredHeight ?? 100` on the wrapper exactly when it is NOT
   * rendering `children`, so a non-null reading is the placeholder state and the value is the box
   * the pane's geometry was computed against.
   */
  lastRowPlaceholder: number | null;
  /**
   * The last assistant row's own `data-message-timestamp`, which is the row's identity as the
   * app re-projects it: the store re-mints the live row's timestamp on every flush and again
   * when the turn settles, and the wrapper carries whatever the current one is.
   *
   * Read next to `lastRowNode` it is what separates "the row was re-rendered" from "the row was
   * replaced": a stamp that changes while the node does not is one row re-projected in place,
   * which is the pair every delta used to produce as a re-key. A run in which the stamp never
   * changes never re-projected the row at all, so it cannot say anything about the remount.
   */
  lastRowStamp: string | null;
  /** The content column's own laid-out height — what the rows add up to, independent of the pane. */
  contentHeight: number;
};

/** One sample as a single line, for the readings that have to fit in a gate's excerpt. */
const describeSample = (sample: FollowSample, index: number, marked = false) =>
  `${index}${marked ? '*' : ''}@t${sample.t}:top${Math.round(sample.scrollTop)}/h${Math.round(sample.scrollHeight)}-c${Math.round(sample.clientHeight)}`
  + `=gap${Math.round(sample.gap)},row${Math.round(sample.lastRowHeight)},n${sample.rows},pane${sample.pane}/${sample.panes}`
  + `,text${sample.lastRowText}/${sample.paneText}`
  + `,col${Math.round(sample.contentHeight)},node${sample.lastRowNode}`
  + `,stamp${sample.lastRowStamp === null ? '-' : sample.lastRowStamp.slice(11, 23)}`
  + (sample.lastRowPlaceholder === null ? '' : `,ph${sample.lastRowPlaceholder}`);

/**
 * One layout the content column went through, as the probe's own observer saw it.
 *
 * The app's follow is driven by exactly this signal, so this is the same evidence the follow had.
 * It is a *trace* rather than a per-frame sample because the excursion being pinned here can
 * begin and end inside one frame, where a once-a-frame read would never see it.
 */
type ContentHeightEntry = {
  /** Milliseconds since the page's time origin, as the observer delivered it. */
  t: number;
  /** The content column's border-box height, in CSS pixels. */
  height: number;
};

/**
 * One row added to or removed from the transcript, as the probe's own observer saw it.
 *
 * This is the only place a React unmount/mount is directly visible: the DOM node itself is
 * created or destroyed, which no per-frame geometry read can distinguish from a re-render.
 */
type RowMutationEntry = {
  t: number;
  kind: 'added' | 'removed';
  /** The row's own `data-message-timestamp`, present on the lazy wrapper for both kinds. */
  stamp: string | null;
};

/**
 * Starts sampling the pane once a frame, each reading taken after the frame's rendering
 * steps and after every ResizeObserver callback they ran.
 *
 * The frame-then-task placement is the whole instrument. A read taken inside a frame callback,
 * which is what the criterion forbids, reports a box the browser has not laid out yet — layout is
 * what a frame's own rendering steps end with, so a read before them measures the geometry the
 * previous frame left — and would say "pinned" no matter what the follow did. A read one frame
 * later sees the box that frame's rendering steps produced and the paint showed, and that is what
 * both the gap and the row height below are read from.
 *
 * Which frame the follow writes in is deliberately not assumed here. `followTranscriptGrowth`
 * writes from the resize callback that received the growth, but a sampler that only measured a
 * write whose timing it already knew would be measuring its own model of the follow instead of
 * the pane, so nothing below depends on that.
 */
const startFollowSampler = (page: Page) =>
  page.evaluate(() => {
    type Sample = {
      t: number;
      gap: number;
      rows: number;
      lastRowHeight: number;
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      pane: number;
      panes: number;
      lastRowText: number;
      paneText: number;
      lastRowNode: number;
      lastRowStamp: string | null;
      lastRowPlaceholder: number | null;
      contentHeight: number;
    };
    type HeightEntry = { t: number; height: number };
    type MutationEntry = { t: number; kind: 'added' | 'removed'; stamp: string | null };

    // A DOM node's identity, numbered on first sight. Weak, so it annotates the tree without
    // keeping any of it alive — including the nodes a remount throws away, whose numbers are
    // never reused.
    const nodeIds = new WeakMap<Element, number>();
    let nextNodeId = 0;
    const nodeId = (element: Element) => {
      let id = nodeIds.get(element);
      if (id === undefined) {
        id = (nextNodeId += 1);
        nodeIds.set(element, id);
      }
      return id;
    };

    const panes: Element[] = [];
    const contentHeightTrace: HeightEntry[] = [];
    const rowMutations: MutationEntry[] = [];
    let watchedContent: Element | null = null;
    let contentObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    /** The content column the rows live in: the pane's last child, as the follow's own observer is pointed. */
    const contentColumnOf = (pane: HTMLElement) =>
      (pane.querySelector(':scope > div:last-child') as HTMLElement | null);

    /**
     * Points both probes at whatever content column is current.
     *
     * Re-aimed on every read rather than installed once, because the pane and its column are
     * ordinary React output: a remount that replaced either would otherwise leave the probes
     * watching a detached node and quietly recording nothing.
     */
    const aimProbes = (pane: HTMLElement) => {
      const content = contentColumnOf(pane);
      if (!content || content === watchedContent) return;
      contentObserver?.disconnect();
      contentObserver = new ResizeObserver(() => {
        contentHeightTrace.push({ t: Math.round(performance.now()), height: Math.round(content.getBoundingClientRect().height) });
      });
      contentObserver.observe(content);

      // `subtree` because the wrappers are re-created inside the column, and the row's own node
      // is what is being watched: React removes the old one and inserts the new one, so both
      // halves of a remount are recorded rather than only the arrival.
      mutationObserver?.disconnect();
      mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof Element && node.matches('[data-message-timestamp]')) {
              rowMutations.push({ t: Math.round(performance.now()), kind: 'added', stamp: node.getAttribute('data-message-timestamp') });
            }
          }
          for (const node of Array.from(record.removedNodes)) {
            if (node instanceof Element && node.matches('[data-message-timestamp]')) {
              rowMutations.push({ t: Math.round(performance.now()), kind: 'removed', stamp: node.getAttribute('data-message-timestamp') });
            }
          }
        }
      });
      mutationObserver.observe(content, { childList: true, subtree: true });
      watchedContent = content;
      contentHeightTrace.push({ t: Math.round(performance.now()), height: Math.round(content.getBoundingClientRect().height) });
    };

    const read = (): Sample | null => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      if (!pane) return null;
      aimProbes(pane);
      const paneIndex = panes.indexOf(pane);
      if (paneIndex === -1) {
        panes.push(pane);
      }
      // The lazy row wrapper, not `.chat-message`: a row scrolled out of the viewport band
      // swaps its content for a placeholder of the same height, so counting the content
      // would report what the viewport holds rather than how many messages there are.
      const rows = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
        .filter((row) => !row.parentElement?.closest('[data-message-timestamp]'));
      const assistants = Array.from(pane.querySelectorAll('.chat-message.assistant')) as HTMLElement[];
      const last = assistants[assistants.length - 1];
      // The wrapper the row's content is drawn inside. Its inline height exists only while the
      // wrapper is standing in for that content, so reading it is how the placeholder state is
      // told from the mounted one.
      const wrapper = last?.closest('[data-message-timestamp]') as HTMLElement | null;
      const placeholder = wrapper && wrapper.style.height ? parseFloat(wrapper.style.height) : null;
      const content = contentColumnOf(pane);
      return {
        t: Math.round(performance.now()),
        gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
        rows: rows.length,
        lastRowHeight: last ? Math.round(last.getBoundingClientRect().height * 100) / 100 : 0,
        scrollTop: pane.scrollTop,
        scrollHeight: pane.scrollHeight,
        clientHeight: pane.clientHeight,
        pane: paneIndex === -1 ? panes.length - 1 : paneIndex,
        panes: document.querySelectorAll('.chat-messages-pane').length,
        lastRowText: last ? (last.textContent ?? '').length : 0,
        paneText: (pane.textContent ?? '').length,
        lastRowNode: last ? nodeId(last) : 0,
        lastRowStamp: wrapper?.getAttribute('data-message-timestamp') ?? null,
        lastRowPlaceholder: placeholder,
        contentHeight: content ? Math.round(content.getBoundingClientRect().height) : 0,
      };
    };
    const state = {
      samples: [] as Sample[],
      contentHeightTrace,
      rowMutations,
      running: true,
    };
    (window as unknown as { __ac108: typeof state }).__ac108 = state;
    const tick = () => {
      if (!state.running) return;
      requestAnimationFrame(() => {
        setTimeout(() => {
          const sample = read();
          if (sample) state.samples.push(sample);
          tick();
        }, 0);
      });
    };
    tick();
  });

/**
 * Stops the sampler and returns everything it read.
 *
 * The two traces ride along with the per-frame samples because they are the same evidence at a
 * finer grain: the growth the rows produce is what the frame samples count, and the column's own
 * height, recorded the moment the browser re-laid it out, is what says whether a frame's reading
 * was taken against the real content or against a box that had briefly been something else.
 */
const stopFollowSampler = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as {
      __ac108: {
        running: boolean;
        samples: FollowSample[];
        contentHeightTrace: ContentHeightEntry[];
        rowMutations: RowMutationEntry[];
      };
    }).__ac108;
    state.running = false;
    return {
      samples: state.samples,
      contentHeightTrace: state.contentHeightTrace,
      rowMutations: state.rowMutations,
    };
  });

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('transcript follow in a real browser', () => {
  let page: Page;
  let workspace = '';
  /** The mock Anthropic gateway AC-108 points a custom model at. Idle for the other cases. */
  let gateway: http.Server;
  const gatewayHits: GatewayHit[] = [];
  /** When the streamed request's first and last deltas went out; 0 until then. */
  let streamStartedAt = 0;
  let streamFinishedAt = 0;

  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });
  /** The project row is a toggle whose accessible name starts with the workspace's display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }).first();

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const dataDir = process.env.QUAY_E2E_DATA_DIR!;
    // Seeded (with its transcript) by playwright.config.ts before the server booted.
    workspace = path.join(dataDir, 'transcript-follow-workspace');

    // Up before the account exists, because the model AC-108 sends through has to point at
    // it and be in the catalog before the app reads that catalog.
    gateway = http.createServer((request, response) => {
      answerGatewayRequest(
        gatewayHits,
        request,
        response,
        () => { streamStartedAt = Date.now(); },
        () => { streamFinishedAt = Date.now(); },
      );
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));

    page = await browser.newPage();
    // Before the first script runs, so AC-111 counts every input and every
    // offset write the spec's own setup performs, not just the ones after it
    // remembered to start watching.
    await page.addInitScript(instrumentScrollSources);
    await page.addInitScript(instrumentStreamFrames);
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

    // The streaming case's model, before the app reads the catalog it will be selected
    // from. Created here rather than in that case because a custom model only reaches the
    // composer from the catalog the page loads with.
    const created = await createGatewayModel(page, `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`);
    expect(created.status, `creating the gateway model failed: ${created.body}`).toBeLessThan(300);

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
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
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

    // The clock this case fixed belongs to the context, not to the case: `setFixedTime` installs
    // the emulation for every page that follows in this file, and it changes what the cases after
    // this one can read. Two ways, both of them AC-108's instrument rather than its subject:
    //
    //   * a fixed wall clock never moves, so a row the app re-stamps on every flush carries one
    //     timestamp for the whole turn — and AC-108 reads the row's identity out of exactly that
    //     attribute, so a fixed clock makes "the row was re-projected once per delta"
    //     unobservable rather than false;
    //   * the emulated `requestAnimationFrame` fires from the clock's own timer queue instead of
    //     from a rendering update, so a reader sampling the pane from its own frame callback can
    //     land between a commit and the resize observer that answers it — a window a real frame
    //     callback cannot enter, and one that reads as a follow that arrived a frame late.
    //
    // Handing it back running from the real time is this case's teardown: nothing after it asks
    // for a fixed clock, and the emulation's frame clock is what AC-108 samples through.
    await page.clock.setSystemTime(new Date());
  });

  test('AC-108 a reply that streams in keeps the pane pinned while one row grows in place', async () => {
    // A conversation the CLI can actually run, opened the way a user opens one.
    //
    // The seeded conversation cannot be sent to: its id is not a UUID, and the CLI refuses
    // `--resume` for anything that is not, so a prompt typed into it never leaves the process
    // and nothing streams. The new conversation is allocated by the app on send and run by the
    // CLI under that id — which is also why the transcript asserted on at the end has no path
    // the spec can name in advance.
    await page.setViewportSize(AC108_VIEWPORT);
    const newSessionButton = page.getByRole('button', { name: 'New Session' }).first();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await newSessionButton.isVisible().catch(() => false)) {
        break;
      }
      await projectRow().click();
      await page.waitForTimeout(500);
    }
    await newSessionButton.click();
    // The composer is now composing a conversation that does not exist yet — which is the
    // state the send below is supposed to create one from, so it is asserted rather than
    // assumed. Without it the case would send into whatever session was still selected.
    await expect
      .poll(() => new URL(page.url()).pathname, { message: 'the sidebar never opened a new session' })
      .toBe('/');

    // The model the gateway is behind, picked through the composer's own menu — the same
    // two clicks a user makes, so the request carries the model's env rather than a stub.
    await page.getByRole('button', { name: 'Select model and reasoning effort' }).click();
    await page.getByRole('menuitem').first().click();
    await page.getByRole('menuitemradio', { name: AC108_MODEL.name }).click();
    await expect(
      page.getByRole('button', { name: 'Select model and reasoning effort' }),
    ).toContainText(AC108_MODEL.name);

    // The clock and the recording start here, before the request can reach the gateway:
    // resetting them once the send is in flight would wipe a timestamp the gateway had
    // already written, and leave the span measuring from epoch zero.
    const hitsBefore = gatewayHits.length;
    streamStartedAt = 0;
    streamFinishedAt = 0;

    // Sent through the composer, as a user sends one: no store write from the spec, no stub
    // of the backend, and nothing in the prompt that the composer would read as a command.
    await page.getByPlaceholder(/Type \/ for commands/).fill(AC108_PROMPT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // The prompt is a row of its own, and it lands before the reply can: the reply has no row
    // until the gateway's first token. Waiting for the prompt's row here is what makes every
    // sample below a reading of the reply rather than of the prompt arriving — and the
    // gateway's own lead time is what leaves room to wait without eating into the stream.
    await expect(page.locator(PANE)).toContainText(AC108_PROMPT_MARKER, { timeout: 30_000 });
    // The case measures a follow, so the pane has to be at the bottom before the reply starts:
    // the follow holds a viewport that is already there and deliberately leaves one that is
    // not. A new conversation opens at the bottom, and the prompt's own row does not move it.
    const start = await waitForSettledPane(page);
    expect(
      start.gap,
      `the streaming case must begin at the bottom; the pane settled ${start.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);
    // Non-vacuity of the window: the reply must not have started growing before the sampler
    // was watching. The lead time above is four times the wait for the prompt's row, so a
    // reply already on screen here means the fixture's timing, not the follow, is what failed.
    const assistantsAtStart = await page.locator(`${PANE} .chat-message.assistant`).count();
    expect(
      assistantsAtStart,
      'the sampler must be watching before the reply starts; the reply was already on screen',
    ).toBe(0);

    const before = await readFixture(page);

    await startFollowSampler(page);

    // Liveness of the fixture: the gateway really finished streaming the request that
    // carried the prompt before anything below is read.
    await expect
      .poll(() => streamFinishedAt, { timeout: 60_000, message: 'the gateway never streamed the reply' })
      .toBeGreaterThan(0);
    await expect(page.locator(PANE)).toContainText(AC108_COMPLETION_MARKER, { timeout: 30_000 });
    // Long enough that the samples cover the turn finalizing as well as the reply arriving:
    // the pane has to be back at the bottom once there is nothing left to arrive.
    await page.waitForTimeout(900);
    const { samples, contentHeightTrace, rowMutations } = await stopFollowSampler(page);
    // Every assignment to `scrollTop` the page made while the reply was arriving, as the
    // instrument installed before the app's first script recorded them.
    const scrollWrites = await page.evaluate(() =>
      ((window as unknown as { __scrollWrites?: { value: number; t: number }[] }).__scrollWrites ?? [])
        .map((write) => ({ value: Math.round(write.value), t: Math.round(write.t) })));
    const streamFrames = await page.evaluate(() =>
      (window as unknown as { __streamFrames?: { kind: string; t: number }[] }).__streamFrames ?? []);

    const streamMs = streamFinishedAt - streamStartedAt;
    const paneHeight = start.clientHeight;

    // A growth step is the last row getting taller — or appearing taller than nothing when
    // the first delta is what brought the row into being. Both are the same event to the
    // follow: a box it has to keep in view.
    const growth = samples.map((sample, index) => {
      if (index === 0) {
        return false;
      }
      const previous = samples[index - 1];
      if (sample.rows > previous.rows) {
        return sample.lastRowHeight > AC108_GAP_PX;
      }
      return sample.lastRowHeight > previous.lastRowHeight + AC108_GAP_PX;
    });
    const growthSteps = growth.filter(Boolean).length;
    const firstGrowth = growth.indexOf(true);
    const lastGrowth = growth.lastIndexOf(true);
    const growthOrigin = Math.max(firstGrowth, 0);

    // The span the criterion names — "流式全程" — is the reply's arrival, and the arrival is the
    // transport's: it ends with the last growth the last delta the gateway sent produced,
    // however long the turn then takes to settle. The clock is what says where that is: a
    // delta is painted a flush plus a frame after the frame that carried it, so its own growth
    // legitimately lands up to `AC108_STREAM_SETTLE_MS` late.
    const deltaTimes = streamFrames
      .filter((frame) => frame.kind === 'stream_delta')
      .map((frame) => frame.t);
    const lastDeltaAt = deltaTimes.length ? deltaTimes[deltaTimes.length - 1] : 0;
    // The first frame the reply's row lost its content on, read as the shape that failure has:
    // the pane stopped having anything to scroll, i.e. `scrollHeight` fell back to the pane's
    // own height on a frame the row had been taller than the pane. Text arriving only ever
    // *adds* height, so the only ways there are for that to happen are the row being re-created
    // under a new React key and measured at its `content-visibility` intrinsic height (which is
    // what this task fixed), or the row being dropped outright.
    //
    // A pane that merely loses height is not this: the turn settling drops the activity
    // indicator's padding, the pane's own content height follows it down, and the follow
    // re-pins in the same frame. That frame is a reading of the geometry working, not of the
    // reply collapsing, so it is deliberately not counted here.
    const firstCollapse = samples.findIndex((sample, index) => (
      index > growthOrigin
      && samples[index - 1].scrollHeight - sample.scrollHeight > AC108_GAP_PX
      && sample.scrollHeight <= sample.clientHeight + AC108_GAP_PX
    ));
    const lastStreamGrowth = samples.reduce((last, sample, index) => (
      growth[index] && sample.t <= lastDeltaAt + AC108_STREAM_SETTLE_MS ? index : last
    ), growthOrigin);
    const streamEnd = Math.max(growthOrigin, lastStreamGrowth + 1);
    const inStream = (index: number) => index >= firstGrowth && index <= streamEnd;
    const streamWindow = samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ index }) => inStream(index));
    const growthStepsInStream = growth.slice(growthOrigin, streamEnd + 1).filter(Boolean).length;

    // The turn's own end, told apart from the reply's: the client's terminal frames, and the
    // first sample taken after them. It is the frame the row stops being a stream and becomes a
    // settled message, which is the one that used to re-key it.
    const finalizeAt = streamFrames
      .filter((frame) => frame.kind === 'stream_end' || frame.kind === 'complete')
      .reduce((first: number, frame) => (first < 0 || frame.t < first ? frame.t : first), -1);
    const settleFrame = finalizeAt < 0 ? -1 : samples.findIndex((sample) => sample.t >= finalizeAt);

    // The rows the transcript held while the reply was arriving. One entry per message,
    // mounted or not, so this is the DOM's reading of `chatMessages.length`.
    const rowsDuringStream = samples.slice(growthOrigin, streamEnd + 1).map((sample) => sample.rows);
    const rowCountsSeen = Array.from(new Set(rowsDuringStream));

    // Every frame of the reply's span, with no exception carved out for the frame a growth
    // landed on: the criterion is "流式全程逐帧 gap ≤1px", and the two collapses that used to
    // make that unachievable — the row re-created under a new React key on every flush, and
    // again when the turn settled — are what this task fixed. Bounded on both sides, since a
    // pane placed *past* the bottom is as far from pinned as one left above it.
    const unpinned = samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ index }) => index >= firstGrowth)
      .filter(({ sample }) => Math.abs(sample.gap) > AC108_GAP_PX);
    // The same reading kept as its two halves, so a red run still says which shape the failure
    // had: frames with no growth on them that were left above the bottom (drift), and growth
    // frames the next frame did not repair (a lag rather than a jump).
    const offBottom = streamWindow
      .filter(({ sample, index }) => !growth[index] && Math.abs(sample.gap) > AC108_GAP_PX);
    const unrepaired = streamWindow
      .filter(({ sample, index }) => growth[index] && Math.abs(sample.gap) > AC108_GAP_PX)
      .filter(({ index }) => index + 1 >= samples.length || Math.abs(samples[index + 1].gap) > AC108_GAP_PX)
      .map(({ index }) => ({
        t: samples[index].t,
        gap: Math.round(samples[index].gap),
        nextGap: index + 1 < samples.length ? Math.round(samples[index + 1].gap) : null,
      }));
    // The mechanism, from the DOM's side: how many distinct nodes the last assistant row was
    // drawn into between the reply's first growth and the end of the sample, and in how many
    // frames the row's own identity changed under it. One node with the stamp moving is one row
    // re-projected in place, which is what a key that does not change buys; more than one node
    // is the unmount/mount that used to clamp the pane, and a stamp that never moves is a run
    // that never re-projected the row at all — and so cannot say the remount was survived.
    const nodeRuns = samples.slice(growthOrigin).reduce<number[]>((runs, sample) => {
      if (runs[runs.length - 1] !== sample.lastRowNode) runs.push(sample.lastRowNode);
      return runs;
    }, []);
    const stampChanges = samples
      .slice(growthOrigin)
      .reduce((changes, sample, index) => {
        const previous = index === 0 ? null : samples[growthOrigin + index - 1];
        return previous && previous.lastRowStamp !== sample.lastRowStamp ? changes + 1 : changes;
      }, 0);
    // How far the pane sits below the bottom at any frame — a follow that overshot would show
    // it, and an overshoot is the one excursion a deferral cannot explain. Its sign is the
    // whole assertion: the sampled gap is `scrollHeight - scrollTop - clientHeight`, so a
    // negative reading is an offset past the end, which no growth can produce.
    const minGap = Math.min(...streamWindow.map(({ sample }) => sample.gap));
    // How far it sits above it at a frame a growth landed on — the frames the criterion used to
    // have to exempt. Kept per-frame because they are what a regression would bring back, and
    // because their `top` is the reading that told the two failures apart: an offset left at the
    // previous bottom is a write that arrived a frame late, while an offset of 0 on a frame the
    // pane had 1671px of content is the browser's own clamp after the row was re-created.
    const growthFrameGaps = streamWindow
      .filter(({ index }) => growth[index])
      .map(({ sample, index }) => ({ t: sample.t, gap: Math.round(sample.gap), top: Math.round(sample.scrollTop) }));
    const maxGrowthFrameGap = growthFrameGaps.length ? Math.max(...growthFrameGaps.map((entry) => entry.gap)) : 0;
    const maxLastRowHeight = Math.max(...samples.map((sample) => sample.lastRowHeight));

    // What the pane does once the reply has fully arrived. It is inside the asserted span, so
    // this reading is what says how much of the settle the run actually covered.
    const postArrival = samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ sample, index }) => index > streamEnd && Math.abs(sample.gap) > AC108_GAP_PX);
    const recoveredAt = samples.findIndex((sample, index) => index > streamEnd && Math.abs(sample.gap) <= AC108_GAP_PX);

    // The request the gateway streamed, and everything else it saw: the selection is by
    // request body, because the SDK's own session-naming call lands on this same socket.
    const streamedHits = gatewayHits.filter((hit) => hit.streamed);
    const otherHits = gatewayHits.slice(hitsBefore).filter((hit) => !hit.streamed);

    // The conversation's transcript on disk, as the CLI wrote it. The file names itself: the
    // CLI chose where to put it, and the reply's own text is what says which file is this
    // turn's rather than some other conversation's.
    const findOwnTranscript = () => transcriptsUnderHome().find(
      (entry) => entry.file !== sessionTranscriptFile()
        && entry.lines.some((line) => line.includes(AC108_COMPLETION_MARKER)),
    ) ?? null;
    await expect
      .poll(
        () => findOwnTranscript()?.lines.length ?? 0,
        { timeout: 30_000, message: 'the streamed turn never reached a transcript on disk' },
      )
      .toBeGreaterThan(0);
    const ownTranscript = findOwnTranscript();
    expect(ownTranscript, 'the streamed turn never reached a transcript on disk').not.toBeNull();
    // The partial frames are transport, and a settled record is still the only thing a turn may
    // leave behind.
    const transcriptLines = ownTranscript!.lines;
    const polluted = transcriptLines.filter((line) => /stream_event|stream_delta|stream_end|content_block_delta/.test(line));

    // Printed before the assertions, so a red run still carries the readings that say which
    // one failed, and a green run's output is evidence rather than a check mark.
    console.log(`AC-108 readings ${JSON.stringify({
      viewport: AC108_VIEWPORT,
      paneClientHeight: Math.round(paneHeight),
      streamMs,
      deltasSent: AC108_DELTA_COUNT,
      deltaIntervalMs: AC108_DELTA_INTERVAL_MS,
      samples: samples.length,
      sampledSpanMs: samples.length ? samples[samples.length - 1].t - samples[0].t : 0,
      growthSteps,
      growthStepsInStream,
      maxLastRowHeightPx: Math.round(maxLastRowHeight),
      rowCountsDuringStream: rowCountsSeen,
      rowsBefore: before.rows,
      minGapPx: Math.round(minGap * 100) / 100,
      maxGrowthFrameGapPx: maxGrowthFrameGap,
      growthFrameGaps,
      // Where the reply's span was cut, and by which signature: the delta the gateway last sent,
      // the growth that came from it, and the first frame the pane lost height on.
      lastDeltaAt,
      lastStreamGrowth,
      firstCollapse,
      finalizeAt,
      settleFrame,
      streamSpanFrames: streamWindow.length,
      // ── the criterion itself: every frame from the reply's first growth on. ────────────────
      unpinnedFrames: unpinned.map(({ sample, index }) => ({
        index,
        t: sample.t,
        gap: Math.round(sample.gap),
        top: Math.round(sample.scrollTop),
        height: Math.round(sample.scrollHeight),
        grew: growth[index] === true,
      })),
      // One node and a stamp that moved: the row was re-projected in place rather than
      // replaced, over the frames where the old key would have replaced it once per flush.
      nodeRuns,
      stampChanges,
      offBottomFrames: offBottom.length,
      offBottomGaps: offBottom.map(({ sample }) => Math.round(sample.gap)),
      unrepairedFrames: unrepaired,
      // The turn ending, told apart from the reply arriving: how many frames the pane spent
      // off the bottom after the reply's span closed, how far, and which frame it was pinned
      // again on — or -1 if it was not, inside the sampled window. Recorded rather than
      // asserted: see the note at the assertions below.
      postArrivalFrames: postArrival.length,
      postArrivalMaxGap: postArrival.length ? Math.max(...postArrival.map(({ sample }) => Math.round(sample.gap))) : 0,
      postArrivalSpanMs: postArrival.length
        ? postArrival[postArrival.length - 1].sample.t - postArrival[0].sample.t
        : 0,
      postArrivalRecoveredAtFrame: recoveredAt,
      lastSampleGap: Math.round(samples[samples.length - 1].gap),
      // `index:+growth@gap` for every frame the last row grew on, and the frames around the
      // first few excursions, so a red run says which growth a gap belongs to rather than
      // only how large it was.
      growthTimeline: growth
        .map((grew, index) => ({ grew, index }))
        .filter(({ grew }) => grew)
        .map(({ index }) => {
          const before = index > 0 ? samples[index - 1].lastRowHeight : 0;
          return `${index}:+${Math.round(samples[index].lastRowHeight - before)}@gap${Math.round(samples[index].gap)}`;
        }),
      offBottomDetail: offBottom.slice(0, 3).map(({ index }) => {
        const from = Math.max(0, index - 3);
        return samples.slice(from, index + 3).map((sample, offset) => describeSample(sample, from + offset, from + offset === index));
      }),
      // The frames around the first and last growth, whole: the gap, the offset it was taken at,
      // and the box it was taken against, so a pane that is behind can be told from one that was
      // never placed.
      firstGrowthTrace: samples
        .slice(Math.max(0, firstGrowth - 2), firstGrowth + 14)
        .map((sample, offset) => describeSample(sample, Math.max(0, firstGrowth - 2) + offset)),
      postArrivalDetail: samples
        .slice(Math.max(0, streamEnd - 2), Math.min(samples.length, streamEnd + 10))
        .map((sample, offset) => describeSample(sample, Math.max(0, streamEnd - 2) + offset, Math.max(0, streamEnd - 2) + offset > streamEnd)),
      tailTrace: samples.slice(-8).map((sample, offset) => describeSample(sample, samples.length - 8 + offset)),
      // What the page wrote to `scrollTop`, restricted to the offsets the excursions were
      // sampled at — a pane that reads zero because something placed it there is a different
      // finding from one whose own follow never got there.
      writesAtExcursions: offBottom.flatMap(({ sample }) => scrollWrites
        .filter((write) => Math.abs(write.t - sample.t) < 60)
        .map((write) => `${sample.t}<-t${write.t}:${write.value}`)),
      zeroWrites: scrollWrites.filter((write) => write.value === 0).length,
      paneSwaps: Array.from(new Set(samples.map((sample) => `${sample.pane}/${sample.panes}`))),
      // ── the mechanism probe ────────────────────────────────────────────────────────────────
      // The last assistant row's DOM node, as numbered on first sight: a run of one number is a
      // row that kept its node, a new number is the unmount+mount a React key change produces.
      // Paired with the placeholder column, this separates the two ways the row can lose height —
      // a fresh node carrying the same content (re-keyed) from a wrapper standing in for it
      // (lazy placeholder) — which the geometry alone cannot tell apart.
      lastRowNodeRun: samples.reduce<{ node: number; from: number; to: number }[]>((runs, sample, index) => {
        const last = runs[runs.length - 1];
        if (last && last.node === sample.lastRowNode) {
          last.to = index;
        } else {
          runs.push({ node: sample.lastRowNode, from: index, to: index });
        }
        return runs;
      }, []).map((run) => `${run.node}:${run.from}-${run.to}`),
      // Every frame the row sat in the lazy placeholder rather than on its content.
      placeholderFrames: samples
        .map((sample, index) => ({ sample, index }))
        .filter(({ sample }) => sample.lastRowPlaceholder !== null)
        .map(({ sample, index }) => `${index}@t${sample.t}:h${sample.lastRowPlaceholder}`),
      // Every layout the content column went through, as the observer the follow itself is driven
      // by saw it. Printed as a delta from the previous entry so a dip that begins and ends inside
      // one frame is visible as an excursion rather than buried in an absolute list — and bounded
      // to the entries that actually moved, because the column re-lays out on every flush.
      contentHeightMoves: contentHeightTrace
        .map((entry, index) => ({ entry, index, previous: index > 0 ? contentHeightTrace[index - 1] : null }))
        .filter(({ entry, previous }) => !previous || previous.height !== entry.height)
        .map(({ entry, previous }) => `${entry.t}:${previous ? previous.height : 0}->${entry.height}`),
      // Every row added to or removed from the transcript, which is the DOM's own account of a
      // mount: nothing else in this file can see the node being created or destroyed.
      rowMutationCount: rowMutations.length,
      rowMutationTrace: rowMutations.map((entry) => `${entry.t}:${entry.kind}:${entry.stamp ?? '-'}`),
      // What the client was handed, and when, over the sampled window: the transport's own
      // account of the reply, next to the geometry it produced.
      frameKinds: streamFrames.reduce<Record<string, number>>((counts, frame) => {
        counts[frame.kind] = (counts[frame.kind] ?? 0) + 1;
        return counts;
      }, {}),
      streamEndTimes: streamFrames.filter((frame) => frame.kind === 'stream_end').map((frame) => frame.t),
      finalizeFrames: streamFrames
        .filter((frame) => ['stream_end', 'complete', 'session_created', 'assistant'].includes(frame.kind))
        .map((frame) => `${frame.t}:${frame.kind}`),
      gatewayRequests: gatewayHits.map((hit) => ({
        url: hit.url,
        carriedPrompt: hit.body.includes(AC108_PROMPT_MARKER),
        streamed: hit.streamed,
        bytes: hit.body.length,
      })),
      transcriptFile: path.relative(process.env.QUAY_E2E_DATA_DIR!, ownTranscript!.file),
      transcriptLines: transcriptLines.length,
      pollutedLines: polluted.length,
    })}`);

    // The stream really took the time it was supposed to: a gateway that answered at once
    // would make every geometry reading below a measurement of a still pane.
    expect(
      streamMs,
      `the gateway must take at least ${AC108_MIN_STREAM_MS}ms to send its deltas; it took ${streamMs}ms`,
    ).toBeGreaterThanOrEqual(AC108_MIN_STREAM_MS);

    // Non-vacuity: the reply arrived in one row that grew in place, in as many steps as the
    // gateway sent deltas. Without this a single settled render would pass every gap
    // assertion below by never changing anything. Counted over the reply's own span, so the
    // growth the turn's finalize contributes cannot stand in for a delta that never arrived.
    expect(
      growthStepsInStream,
      `the last row must grow once per delta (${AC108_DELTA_COUNT} deltas, ${growthStepsInStream} growth steps inside the reply's span of ${streamWindow.length} frames; ${growthSteps} in the whole sample)`,
    ).toBeGreaterThanOrEqual(AC108_DELTA_COUNT - 1);
    expect(
      lastGrowth,
      'the sampler must have watched the reply grow; it saw no growth at all',
    ).toBeGreaterThan(firstGrowth);
    expect(
      maxLastRowHeight,
      `the last row must outgrow one screen (${Math.round(maxLastRowHeight)}px against a ${Math.round(paneHeight)}px pane)`,
    ).toBeGreaterThan(paneHeight);
    expect(
      rowCountsSeen,
      `the reply must be one row rewritten in place, not rows appended; the row count moved through ${JSON.stringify(rowCountsSeen)} while it streamed`,
    ).toHaveLength(1);

    // The follow itself, in the form the criterion is written in now that the two collapses
    // are fixed: from the frame the reply's row first grew on until the sample ends, every
    // frame is at the bottom, with no exemption for the frame a growth landed on. The turn
    // settling is inside that span too — it no longer re-keys the row, so it no longer opens a
    // gap the span would have to exclude.
    expect(
      unpinned.map(({ index, t, gap, top, grew }) => ({ index, t, gap, top, grew })),
      `the pane must be at the bottom at every frame of the reply (${samples.length} frames sampled, ${unpinned.length} off it)`,
    ).toEqual([]);
    // The same reading as its two halves. Kept because they fail differently and a red run
    // should say which: `offBottom` is drift on frames nothing grew on, `unrepaired` is a
    // growth frame the next frame did not pin again.
    expect(
      offBottom.map(({ sample, index }) => ({ t: sample.t, index, gap: Math.round(sample.gap) })),
      'the pane must be at the bottom at every frame of the stream the last row did not just grow on',
    ).toEqual([]);
    expect(
      unrepaired,
      'a frame that received a growth must be pinned again by the next frame',
    ).toEqual([]);

    // ...and the mechanism behind that, asserted rather than left to the geometry, because the
    // geometry alone cannot tell a row that was re-projected from one that never was: a run in
    // which the reply arrived in a single settled render would show every frame pinned while
    // proving nothing about the remount.
    //
    // Two readings, and the pair is the point. The reply's row has to have been re-projected
    // over and over — its `data-message-timestamp` moves on every flush, and the transcript's
    // key used to be derived from exactly that plus the row's text, which is what re-keyed it
    // per delta — *while* the node it is drawn into stays the same one. A new node is the
    // unmount/mount whose fresh `content-visibility` box is laid out at its intrinsic height,
    // measured, for the frame the pane then has to survive.
    expect(
      stampChanges,
      `the reply's row must be re-projected once per delta (${stampChanges} identity changes over ${samples.length - growthOrigin} frames; ${AC108_DELTA_COUNT} deltas were sent)`,
    ).toBeGreaterThanOrEqual(AC108_DELTA_COUNT - 1);
    expect(
      nodeRuns,
      `the reply's row must keep the node it is drawn into while it is re-projected (node identities seen: ${JSON.stringify(nodeRuns)})`,
    ).toHaveLength(1);

    // The turn's own end has to be inside the sample, or "pinned from the settle on" is a
    // statement about a window in which nothing settled — the liveness half of the assertion
    // that the row stopped being a stream without being replaced.
    expect(
      finalizeAt,
      'the turn must settle inside the sampled window; the client reported no terminal frame',
    ).toBeGreaterThan(0);
    expect(
      settleFrame,
      `the sample must cover the frame the turn settled on (settled at t${finalizeAt}, last sample at t${samples[samples.length - 1].t})`,
    ).toBeGreaterThan(streamEnd);

    // And the one thing a deferral cannot explain: an offset *past* the end. The gap is
    // `scrollHeight - scrollTop - clientHeight`, so a negative reading means the pane was
    // placed beyond the bottom — a write that overshot, which no amount of arriving content
    // accounts for. Bounded on both sides rather than one, so "never off the bottom" is not
    // satisfied by a pane that is off it in the other direction.
    expect(
      minGap,
      `the pane may never be placed past the bottom (${Math.round(minGap)}px at the worst frame)`,
    ).toBeGreaterThanOrEqual(-AC108_GAP_PX);

    // What the two collapses were, and why the offsets they produced are no longer exempt
    // from the bound asserted above.
    //
    // Both had the same cause, and it is the row's React key rather than either observer. A
    // key change is an unmount followed by a mount, and the freshly inserted `.chat-message`
    // carries `content-visibility: auto` with `contain-intrinsic-size: auto 240px`, so for the
    // frame it is laid out in it is a 240px box standing where a 1671px row was: the pane's
    // content collapses under a viewport that is still on the bottom, the browser clamps the
    // offset to the top, and the row is back at its real height before anything can report it.
    // The follow then reads the clamped offset as a viewport the user moved and declines to
    // pin it, which is why the excursions were offsets of 0 rather than `bottom - step`.
    //
    // The key came from the row's own identity, which changed twice over:
    //
    //   * on every flush — `updateStreaming` re-mints the live row's timestamp and its text, and
    //     `getIntrinsicMessageKey` falls back to exactly that pair, so each delta re-keyed the
    //     row it was streaming into;
    //   * when the turn settled — `finalizeStreaming` re-keyed the row to a fresh id so the next
    //     turn could not overwrite the reply it had just settled.
    //
    // Both are fixed at the source rather than worked around: the live row is minted one id per
    // turn and keeps it across the settle (`liveRowIdentity.ts`, `useSessionStore`), the
    // transcript carries it onto the rendered message (`useChatMessages`), and the follow writes
    // its offset in the resize callback that received the growth rather than in a frame after it
    // (`useChatSessionState`). The readings above are the evidence that the cause is gone —
    // `nodeRuns` of length 1 with `stampChanges` at one per delta, and `firstCollapse` at -1,
    // where before the fix it fired on the settling frame with the pane sitting at exactly its
    // own height and the last row measured at 240px.
    //
    // There is a third identity change the first two hid, and it only became visible once the
    // row's key stopped being derived from its content: the transcript holds the reply twice —
    // the row this client streamed it into and the server's persisted echo of it, which the
    // reconciliation collapses into one. Which of the pair survives that collapse decides the
    // row's key, and it used to be whichever sorted first, so the row changed hands as the echo
    // arrived and again on the refresh `complete` triggers. `useSessionStore` now keeps the
    // client's row and folds the echo's fields into it
    // (`dedupeAdjacentAssistantEchoes`, `pruneRealtimeSupersededByServer`).
    //
    // `growthFrameGaps` and `postArrival*` are kept as readings: they are the shape the run had
    // when this criterion could not be written this way, and they are what a regression would
    // bring back. They are no longer exempt from anything.

    // The selection rule: exactly one request carried the prompt, and it is the one the
    // gateway streamed. The rest — the SDK's own naming call — are recorded above.
    expect(
      streamedHits,
      `exactly one request may be streamed; the gateway saw ${JSON.stringify(gatewayHits.map((hit) => hit.url))}`,
    ).toHaveLength(1);
    expect(streamedHits[0].body).toContain(AC108_PROMPT_MARKER);
    expect(streamedHits[0].url).toContain('/v1/messages');
    expect(
      otherHits.length >= 0,
      'the requests the gateway did not stream are kept in the readings above',
    ).toBe(true);

    // The turn really landed, so the check below is not a check of an untouched file...
    expect(
      transcriptLines.join('\n'),
      'the streamed turn has to reach the transcript, or the pollution check below proves nothing',
    ).toContain(AC108_COMPLETION_MARKER);
    // ...and it left no partial frame behind.
    expect(
      polluted,
      'the partial frames are transport only; the settled record is what lands on disk',
    ).toEqual([]);

    // The same two questions of the REST history, which is the other place a partial frame could
    // have leaked into — the endpoint serialises whatever the providers module normalized, so a
    // `stream_delta` row that survived into the store would surface here and nowhere else the
    // case has looked. Asked of the page rather than of a request context, so it carries the
    // session's own cookie and lands on the same origin the assertions above were made against.
    const sessionPath = new URL(page.url()).pathname;
    expect(
      sessionPath,
      'the new conversation has to be the one the pane is showing, or the history read below is of something else',
    ).toMatch(/^\/session\/.+/);
    const history = await page.evaluate(async (path: string) => {
      const res = await fetch(
        `/api/providers/sessions/${encodeURIComponent(path.replace('/session/', ''))}/messages`,
        // The same bearer header `authenticatedFetch` attaches: the endpoint is behind the
        // app's own auth, and the browser session is established by the signed-in page rather
        // than by a cookie, so a plain same-origin fetch would answer 401.
        { headers: { Authorization: `Bearer ${localStorage.getItem('auth-token') ?? ''}` } },
      );
      return { ok: res.ok, status: res.status, body: res.ok ? await res.text() : '' };
    }, sessionPath);
    expect(history.ok, `the persisted history must be readable (HTTP ${history.status})`).toBe(true);
    expect(
      history.body,
      'the streamed turn has to reach the REST history, or the pollution check below proves nothing',
    ).toContain(AC108_COMPLETION_MARKER);
    expect(
      /stream_event|"stream_delta"|"stream_end"|content_block_delta/.test(history.body),
      'the partial frames are transport only; the persisted history is what a reload reads',
    ).toBe(false);
  });
});
