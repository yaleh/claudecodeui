import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The seven sessions this spec filters on are real Claude transcripts seeded into the run's isolated HOME by
// playwright.config.ts and indexed by the backend's own session synchronizer — the same mechanism that
// indexes a developer's ~/.claude/projects. They are seeded before the server boots on purpose: transcripts
// written mid-test are discovered by the file watcher, and every upsert it broadcasts flags its session as
// needing attention, which the filter deliberately keeps visible. Nothing here stubs a request: every
// assertion is about what the UI really rendered, what the browser really requested, or what the backend
// really persisted.
//
// The rule is entered through the sidebar's own filter editor and saved through the app's own PUT; the spec
// never creates a rule over the API, because the value of this test is that the entry point really works.

const RULE = '-(task-worker|selector|fix-worker)$';
/** Session names the rule matches. */
const MATCHING = ['role-1-task-worker', 'role-2-selector', 'role-3-fix-worker', 'role-4-task-worker'];
/** Session names the rule leaves alone. */
const UNMATCHED = ['human-alpha', 'human-beta', 'human-gamma'];
const ALL_SESSIONS = [...MATCHING, ...UNMATCHED];
/** Rule "hide similar" derives from an identifier-style name: the name as an unanchored literal. */
const DERIVED_FROM_HUMAN_ALPHA = 'human-alpha';

// Namespaced i18n keys leak into the UI as literals like "sidebar.sessionFilter" when a translation is missing.
const UNTRANSLATED_KEY = /\b(?:mainTabs|launchProfiles|launchProfile|settings|chat|common|sidebar)\.[a-z][A-Za-z]+\b/;

const sessionIdOf = (name: string) => `e2e-${name}`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds a seeded transcript on disk by scanning the isolated HOME the way the backend's scan does, rather
 * than by rebuilding playwright.config.ts's path from a second copy of its directory name.
 */
const findTranscript = (dataDir: string, name: string): string => {
  const projectsRoot = path.join(dataDir, '.claude', 'projects');
  const fileName = `${sessionIdOf(name)}.jsonl`;
  const match = fs
    .readdirSync(projectsRoot, { recursive: true })
    .map((entry) => path.join(projectsRoot, entry.toString()))
    .find((entry) => entry.endsWith(fileName) && fs.statSync(entry).isFile());
  if (!match) {
    throw new Error(`Seeded transcript ${fileName} is missing under ${projectsRoot} — playwright.config.ts seeds it.`);
  }
  return match;
};

/** Appends a turn to a transcript: the file watcher sees a change and the server broadcasts the upsert. */
const appendTurn = (filePath: string, workspace: string, name: string): void => {
  fs.appendFileSync(
    filePath,
    `${JSON.stringify({
      type: 'assistant',
      sessionId: sessionIdOf(name),
      cwd: workspace,
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: `reply for ${name}` }] },
    })}\n`,
    'utf8',
  );
};

/** Every per-project session page request the browser really made, oldest first. */
type SessionRequest = { includeHidden: boolean; keepSessionIds: string[] };

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('session name filter in a real browser', () => {
  let page: Page;
  let workspace = '';
  const transcriptPaths = new Map<string, string>();
  const sessionRequests: SessionRequest[] = [];
  const filterWrites: string[] = [];

  const sessionLink = (name: string) => page.locator('a[href^="/session/"]').filter({ hasText: name });

  /** The project row is a toggle whose accessible name starts with the workspace's display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }).first();

  const lastRequest = (): SessionRequest => sessionRequests[sessionRequests.length - 1];

  const requestsMatching = (includeHidden: boolean): SessionRequest[] =>
    sessionRequests.filter((request) => request.includeHidden === includeHidden);

  /**
   * Expands the project's session list. The row is a toggle, so a click that lands while the sidebar is still
   * re-rendering (right after a reload) would leave it collapsed — retry until the rows are really on screen.
   */
  const expandProject = async () => {
    const firstSession = sessionLink(ALL_SESSIONS[0]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await firstSession.isVisible().catch(() => false)) {
        return;
      }
      await projectRow().click();
      try {
        await expect(firstSession).toBeVisible({ timeout: 10_000 });
        return;
      } catch {
        // Collapsed again (or the click missed); the loop clicks once more.
      }
    }
    await expect(firstSession).toBeVisible({ timeout: 15_000 });
  };

  const openFilterEditor = async () => {
    await page.getByTitle('Session filter…').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
  };

  const acceptRules = async () => {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  };

  test.beforeAll(async ({ browser }) => {
    // Onboarding plus the first project load outlasts the default per-test budget.
    test.setTimeout(120_000);
    const dataDir = process.env.QUAY_E2E_DATA_DIR!;
    // Seeded (with its transcripts) by playwright.config.ts before the server booted.
    workspace = path.join(dataDir, 'session-filter-workspace');
    for (const name of ALL_SESSIONS) {
      transcriptPaths.set(name, findTranscript(dataDir, name));
    }

    page = await browser.newPage();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/^\/api\/projects\/[^/]+\/sessions$/.test(url.pathname)) {
        sessionRequests.push({
          includeHidden: url.searchParams.get('includeHidden') === 'true',
          keepSessionIds: (url.searchParams.get('keepSessionIds') ?? '').split(',').filter(Boolean),
        });
      }
      if (request.method() === 'PUT' && url.pathname.endsWith('/session-filter')) {
        filterWrites.push(request.url());
      }
    });

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

    // Indexing a session auto-registers its project, so the seeded workspace is already a project here —
    // no project is created over the API or through the UI, and the sidebar is the proof.
    await expect(projectRow()).toBeVisible({ timeout: 30_000 });

    // Loading the app re-reads /api/projects, which synchronizes sessions before it answers.
    await page.reload();
    await expandProject();
    await expect(sessionLink(ALL_SESSIONS[0])).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('the editor previews the rule, saving converges the list, and Show/Hide survive a reload', async () => {
    for (const name of ALL_SESSIONS) {
      await expect(sessionLink(name)).toBeVisible();
    }

    await openFilterEditor();
    await page.getByRole('textbox', { name: 'Session filter' }).fill(RULE);

    // The preview is the server's own answer about this project's sessions.
    const preview = page.getByTestId('session-filter-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Hidden: 4');
    await expect(preview).toContainText('Visible: 3');
    for (const name of MATCHING) {
      await expect(preview).toContainText(name);
    }
    for (const name of UNMATCHED) {
      await expect(preview).toContainText(name);
    }

    await acceptRules();

    // The list really converged: the four matching rows left the DOM.
    for (const name of MATCHING) {
      await expect(sessionLink(name)).toHaveCount(0);
    }
    for (const name of UNMATCHED) {
      await expect(sessionLink(name)).toBeVisible();
    }

    const bar = page.getByTestId('session-filter-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('4 hidden');
    await expect(bar).toContainText('Edit rules');

    // "Show" asks the server again, this time including the hidden sessions.
    await bar.getByRole('button', { name: 'Show', exact: true }).click();
    await expect.poll(() => lastRequest().includeHidden).toBe(true);
    for (const name of ALL_SESSIONS) {
      await expect(sessionLink(name)).toBeVisible();
    }
    // The bar keeps the filtered count: the server reports hiddenCount 0 while includeHidden is set.
    await expect(bar).toContainText('4 hidden');
    const hideButton = bar.getByRole('button', { name: 'Hide', exact: true });
    await expect(hideButton).toBeVisible();

    // Showing hidden sessions is remembered by this browser across a reload.
    await page.reload();
    await expandProject();
    await expect(bar.getByRole('button', { name: 'Hide', exact: true })).toBeVisible({ timeout: 30_000 });
    for (const name of ALL_SESSIONS) {
      await expect(sessionLink(name)).toBeVisible();
    }

    // "Hide" collapses again, requesting without includeHidden.
    await bar.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect.poll(() => lastRequest().includeHidden).toBe(false);
    for (const name of MATCHING) {
      await expect(sessionLink(name)).toHaveCount(0);
    }
    for (const name of UNMATCHED) {
      await expect(sessionLink(name)).toBeVisible();
    }
  });

  test('a matching session that is currently selected stays visible under the rule', async () => {
    const bar = page.getByTestId('session-filter-bar');
    const selected = MATCHING[0];

    // Reveal the hidden rows so the matching session can be opened, then select it for real.
    await bar.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(sessionLink(selected)).toBeVisible();
    await sessionLink(selected).click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionIdOf(selected)}`));

    const before = sessionRequests.length;
    await bar.getByRole('button', { name: 'Hide', exact: true }).click();

    // The collapse really carried the selection as a keep id on the filtered request.
    await expect.poll(() => requestsMatching(false).length).toBeGreaterThan(
      sessionRequests.slice(0, before).filter((request) => !request.includeHidden).length,
    );
    const filtered = requestsMatching(false)[requestsMatching(false).length - 1];
    expect(filtered.keepSessionIds).toContain(sessionIdOf(selected));

    // ... and the selected session is still on screen while its matching siblings are gone.
    await expect(sessionLink(selected)).toBeVisible();
    for (const name of MATCHING.slice(1)) {
      await expect(sessionLink(name)).toHaveCount(0);
    }
    for (const name of UNMATCHED) {
      await expect(sessionLink(name)).toBeVisible();
    }
    await expect(bar).toContainText('3 hidden');
  });

  test('a session flagged for attention stays visible under the rule', async () => {
    const bar = page.getByTestId('session-filter-bar');
    const attentionSession = MATCHING[1];

    await bar.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(sessionLink(attentionSession)).toBeVisible();

    // A real transcript change on disk: the watcher indexes it and the server broadcasts the upsert to this
    // browser, which is not viewing that session — the sidebar's own path for "needs attention".
    const attentionIndicator = sessionLink(attentionSession)
      .locator('xpath=../..')
      .locator('[role="status"][aria-label="Session needs attention"]');
    appendTurn(transcriptPaths.get(attentionSession)!, workspace, attentionSession);
    // The watcher polls on a 6s interval, so the broadcast this waits for cannot be expected any sooner.
    await expect(attentionIndicator).toHaveCount(1, { timeout: 30_000 });

    const before = requestsMatching(false).length;
    await bar.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect.poll(() => requestsMatching(false).length).toBeGreaterThan(before);

    // The kept set is exactly the selected session plus the flagged one: the remaining matching sessions are
    // neither, so this one is kept by the attention flag it just earned and not by the selection.
    const filtered = requestsMatching(false)[requestsMatching(false).length - 1];
    expect(filtered.keepSessionIds).toContain(sessionIdOf(attentionSession));
    for (const name of [MATCHING[2], MATCHING[3]]) {
      expect(filtered.keepSessionIds).not.toContain(sessionIdOf(name));
    }

    await expect(sessionLink(attentionSession)).toBeVisible();
    await expect(sessionLink(MATCHING[0])).toBeVisible();
    for (const name of [MATCHING[2], MATCHING[3]]) {
      await expect(sessionLink(name)).toHaveCount(0);
    }
    await expect(bar).toContainText('2 hidden');
  });

  test('a hidden session found by title search is marked as filtered', async () => {
    await page.getByRole('button', { name: 'Conversations', exact: true }).click();

    // The nav renders a compact and a full-width search input; only one of them is on screen.
    const search = page.locator('input.nav-search-input:visible');
    await search.fill('fix-worker');

    const titles = page.locator('section[aria-labelledby="session-title-results-heading"]');
    const hiddenResult = titles.locator('button').filter({ hasText: MATCHING[2] });
    await expect(hiddenResult).toContainText('Filtered');

    await search.fill('human-alpha');
    const shownResult = titles.locator('button').filter({ hasText: UNMATCHED[0] });
    await expect(shownResult).toBeVisible();
    await expect(shownResult).not.toContainText('Filtered');

    // Back to the plain project list for the remaining assertions.
    await search.fill('');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
  });

  test('"hide similar" prefills the derived rule and writes nothing', async () => {
    const target = UNMATCHED[0];
    await expect(sessionLink(target)).toBeVisible();

    const writesBefore = filterWrites.length;
    await page.getByRole('button', { name: `Session options for ${target}` }).click();
    await page.getByRole('menuitem', { name: 'Hide similar' }).click();

    const textarea = page.getByRole('textbox', { name: 'Session filter' });
    await expect(page.getByRole('dialog')).toBeVisible();
    // The draft is the project's stored rules with the derived one appended, for the user to confirm.
    await expect(textarea).toHaveValue(`${RULE}\n${DERIVED_FROM_HUMAN_ALPHA}`);
    // The rule is a draft for the user to confirm, and the dialog is still open — nothing was saved.
    expect(filterWrites.length).toBe(writesBefore);

    // No untranslated i18n literal anywhere on the page — filter editor, filter bar and sidebar row included.
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Nothing was persisted: the draft rule never reached the stored filter.
    expect(filterWrites.length).toBe(writesBefore);
    await expect(sessionLink(target)).toBeVisible();
  });
});
