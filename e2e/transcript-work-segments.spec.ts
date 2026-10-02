import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-207: in a real browser, the default collapsed transcript is under half its unmerged density, and a search
// hit that lands on a member of a collapsed work segment opens that segment and puts the member on screen.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
// Nothing here stubs a request: the fixture session is a real Claude transcript seeded into the run's isolated
// HOME before the server booted and indexed by the backend's own synchronizer (see `seedWorkSegmentTranscript`
// in playwright.config.ts), opened over the app's own routing, and searched through the sidebar's real
// conversation search — the SSE-backed one — whose click is the only source of `__searchTargetSnippet`.
//
// ── Fixture provenance, recorded because the criterion asks for it (AC7). ──────────────────────────────────
// The fixture comes from the seed's plain-claude JSONL above, NOT from the debug-agent seam this spec is also
// registered under in `DEBUG_AGENT_SPEC_FILES`. The debug seam's scenario dialect is a closed set whose `row`
// carries only `{role, text}` (server/modules/debug-agent/debug-agent.scenario.ts), and it cannot write a
// thinking or tool-use row — precisely the rows a work segment is made of (AC-202's membership rule). So
// neither reading below may be attributed to that gate; the registration exists only to pin that fact.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** The row class `MessageComponent` draws (and `WorkSegmentRecord`'s header reuses). */
const ROW = '.chat-message';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-work-segment';
/** Display name the sidebar renders for it. */
const SESSION_NAME = 'work-segment';
/** The one phrase the fixture plants; see the seed for why it lives in two rows. */
const HIT_PHRASE =
  'The quick brown fox jumps over the lazy dog near the riverbank at dawn while the beacon glows amber';
/** Fixed viewport, so the height readings below are reproducible run to run. */
const VIEWPORT = { width: 1280, height: 1200 };

/**
 * The unmerged density of the fixture's one turn, from playwright.config.ts's own seed.
 *
 * Baseline provenance: one turn of 24 rows — 20 work rows (8 thinking at ~36px, 6 tool calls at ~60px, plus
 * the remainder) across three runs, and 4 text rows — measuring 1112px before any merging. These four numbers
 * are the AC's own constants; the assertions below are floors (`<` the limit for the collapsed reading, `>=`
 * the baseline for its positive control), so the fixture only has to clear them, not equal them.
 */
const PRE_MERGE_BASELINE_ROWS = 24;
const PRE_MERGE_BASELINE_PX = 1112;
/** Half the baseline, rounded down: what "under half the unmerged density" means in rows. */
const ROW_LIMIT = 12;
/** Half the baseline, rounded down, in CSS pixels. */
const PX_LIMIT = 556;

/** Signs in, creating the account on the first run of the fixture database. */
const ensureSignedIn = async (page: Page) => {
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible({ timeout: 30_000 });
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

type Density = { rows: number; heightPx: number };

/**
 * Counts the mounted transcript rows and measures the turn's total height, after layout has settled.
 *
 * The height is the span from the first row's top to the last row's bottom: nested rows (a segment's members
 * live inside its header's box) make a sum of the rectangles double-count, while the span is the box the
 * transcript actually occupies. Read a frame on, so a write deferred to its own frame lands first — the same
 * rAF-then-timeout discipline e2e/transcript-follow.spec.ts uses for its geometry.
 */
const readDensity = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Density>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            const rows = Array.from(document.querySelectorAll('.chat-message'));
            if (rows.length === 0) {
              resolve({ rows: 0, heightPx: 0 });
              return;
            }
            const first = rows[0].getBoundingClientRect();
            const last = rows[rows.length - 1].getBoundingClientRect();
            resolve({ rows: rows.length, heightPx: Math.round(last.bottom - first.top) });
          }, 0);
        });
      }),
  );

/** Reads until two consecutive samples agree, so a late reflow cannot be mistaken for the settled height. */
const settledDensity = async (page: Page): Promise<Density> => {
  let previous: Density | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await readDensity(page);
    if (
      previous
      && current.rows === previous.rows
      && Math.abs(current.heightPx - previous.heightPx) <= 1
    ) {
      return current;
    }
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error('the transcript density never settled');
};

type SegmentState = {
  key: string | null;
  /** The member rows actually in the DOM — zero for a collapsed segment. */
  members: { timestamp: string | null; text: string }[];
};

/** Reads every work segment's expanded state from the DOM, members and all. */
const readSegments = (page: Page) =>
  page.evaluate((): SegmentState[] =>
    Array.from(document.querySelectorAll('[data-work-segment-key]')).map((seg) => {
      // The header is itself a `.chat-message`; the members are its descendants that match too.
      const all = Array.from(seg.querySelectorAll('.chat-message'));
      const members = all.slice(1).map((row) => ({
        timestamp: row.getAttribute('data-message-timestamp'),
        text: row.textContent || '',
      }));
      return { key: seg.getAttribute('data-work-segment-key'), members };
    }),
  );

test.describe.configure({ timeout: 120_000 });

test.describe('work segment density and search expand', () => {
  // Both readings live in one case so the run boots its server and Vite client once; a second case would pay
  // a second boot and, worse, a second sign-in on a fresh context — the flakiest part of the fixture.
  test('AC-207 collapsed density is under half the unmerged baseline, and a sidebar search hit opens its segment', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await ensureSignedIn(page);
    await page.goto(`/session/${SESSION_ID}`);
    await page.locator(`${PANE} ${ROW}`).first().waitFor({ state: 'visible', timeout: 30_000 });

    // The segment's own header button — a direct child of the header record. Scoped this tightly because an
    // expanded member's own reasoning block exposes an `aria-expanded` trigger of its own, and an unscoped
    // `[aria-expanded]` locator would toggle those instead of opening the next segment.
    const headers = page.locator(`${PANE} [data-work-segment-key] > .chat-message.work-segment > button[aria-expanded]`);
    const headerCount = await headers.count();
    expect(headerCount, 'the fixture draws three work segments').toBe(3);

    // ── Reading (i): the default, nothing expanded. ──────────────────────────────────────────────────────
    const collapsed = await settledDensity(page);
    expect(
      collapsed.rows,
      `the collapsed transcript drew ${collapsed.rows} rows at height ${collapsed.heightPx}px`,
    ).toBeLessThan(ROW_LIMIT);
    expect(
      collapsed.heightPx,
      `the collapsed transcript measured ${collapsed.heightPx}px over ${collapsed.rows} rows`,
    ).toBeLessThan(PX_LIMIT);

    // (i)'s positive control: open every segment, so the member rows merging withheld are all on screen. A
    // member draws the same height open as it would unmerged, so this is the unmerged density — and it is what
    // proves the two thresholds separate collapsed from unmerged rather than holding for any input.
    const toggleAll = async (expected: 'true' | 'false') => {
      for (let index = 0; index < headerCount; index += 1) {
        const button = headers.nth(index);
        await button.scrollIntoViewIfNeeded();
        await button.click();
        await expect(button, `header ${index} of ${headerCount}`).toHaveAttribute('aria-expanded', expected);
        await page.waitForTimeout(120);
      }
    };

    await toggleAll('true');
    const expanded = await settledDensity(page);
    console.log('[AC-207] collapsed', JSON.stringify(collapsed), 'expanded-positive-control', JSON.stringify(expanded));
    expect(
      expanded.rows,
      `with every segment open the transcript drew ${expanded.rows} rows`,
    ).toBeGreaterThanOrEqual(PRE_MERGE_BASELINE_ROWS);
    expect(
      expanded.heightPx,
      `with every segment open the transcript measured ${expanded.heightPx}px`,
    ).toBeGreaterThanOrEqual(PRE_MERGE_BASELINE_PX);
    expect(expanded.rows, 'the control really is the denser state').toBeGreaterThan(collapsed.rows);

    // Back to the default a user arrives at, so reading (ii) starts from the collapsed transcript.
    await toggleAll('false');
    const recollapsed = await settledDensity(page);
    expect(recollapsed.rows, 'collapsing restores the default density').toBe(collapsed.rows);
    expect((await readSegments(page)).every((segment) => segment.members.length === 0), 'all segments start collapsed').toBe(true);

    // ── Reading (ii): a real sidebar search whose hit lands on a collapsed member. ───────────────────────
    // Typing the phrase streams results over SSE; the click hands the app the snippet and timestamp — there is
    // no other source of `__searchTargetSnippet` in this run.
    await page.locator('button:visible', { hasText: 'Conversations' }).first().click();
    await page.locator('input.nav-search-input:visible').first().fill(HIT_PHRASE);

    const result = page.getByRole('button').filter({ hasText: SESSION_NAME }).first();
    await result.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(result, 'the search result carries the hit snippet').toContainText('quick brown fox');
    await result.click();

    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`), { timeout: 20_000 });

    // Wait for the hit segment to open — the behaviour under test. Nothing here clicks a segment header.
    const hitSegmentKey = 'message-assistant-seg-tool-4';
    await expect
      .poll(async () => (await readSegments(page)).find((seg) => seg.key === hitSegmentKey)?.members.length ?? 0, {
        timeout: 20_000,
        message: 'the segment holding the search hit never opened',
      })
      .toBeGreaterThan(0);

    const segments = await readSegments(page);
    const opened = segments.filter((seg) => seg.members.length > 0);

    // (c) driven by the hit, not "expand everything": exactly the hit's segment is open, the others are not.
    for (const seg of segments) {
      if (seg.key === hitSegmentKey) {
        expect(seg.members.length, 'the hit segment is the open one').toBeGreaterThan(0);
      } else {
        expect(seg.members.length, `segment ${seg.key} must stay collapsed`).toBe(0);
      }
    }
    expect(opened, 'only one segment is open, and it is driven by the hit').toHaveLength(1);

    const hitSegment = segments.find((seg) => seg.key === hitSegmentKey);
    if (!hitSegment) throw new Error(`the hit segment ${hitSegmentKey} was not rendered`);

    // (AC5) The phrase sits on a non-first member of a run of at least three, so the "scroll to the segment
    // row and leave the content collapsed" pathology is genuinely reachable.
    const hitMemberIndex = hitSegment.members.findIndex((member) => member.text.includes(HIT_PHRASE));
    expect(hitMemberIndex, 'the phrase is a member of the hit segment').toBeGreaterThanOrEqual(0);
    expect(hitMemberIndex, 'the phrase is NOT the segment’s first member').toBeGreaterThanOrEqual(1);
    expect(hitSegment.members.length, 'the hit segment holds at least three members').toBeGreaterThanOrEqual(3);

    // (a)+(b) The member's own row is in the DOM and its rect lies wholly inside the pane's viewport. The row
    // is named positionally inside the hit segment, because the same phrase also closes the turn as a text row
    // — that row is a boundary, not a member, and must not be mistaken for the hit.
    const memberRows = page.locator(
      `${PANE} [data-work-segment-key="${hitSegmentKey}"] .chat-message[data-message-timestamp]`,
    );
    await expect(memberRows, 'the hit segment draws one row per member').toHaveCount(hitSegment.members.length);
    const hitRow = memberRows.nth(hitMemberIndex);
    await expect(hitRow).toContainText('quick brown fox');
    const geometry = await hitRow.evaluate((row) => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
      const rowRect = row.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      return {
        top: rowRect.top,
        bottom: rowRect.bottom,
        paneTop: paneRect.top,
        paneBottom: paneRect.bottom,
      };
    });
    expect(
      geometry.top,
      `hit row top ${geometry.top} vs pane top ${geometry.paneTop}`,
    ).toBeGreaterThanOrEqual(geometry.paneTop);
    expect(
      geometry.bottom,
      `hit row bottom ${geometry.bottom} vs pane bottom ${geometry.paneBottom}`,
    ).toBeLessThanOrEqual(geometry.paneBottom);
  });
});
