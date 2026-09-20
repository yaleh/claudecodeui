/**
 * Real-data landing criterion for the per-project session-name filter (GOAL-002 / AC-102).
 *
 * Unlike the neighbouring `projects-session-filter.integration.test.ts`, which drives a
 * hand-built 30-row fixture, this file runs against a **read-only copy of this machine's
 * real store** (`~/.cloudcli/auth.db`). The original file is never opened: the copy is
 * made first and `DATABASE_PATH` is pointed at it, so the real store stays untouched even
 * though the test writes a project rule through the production PUT route.
 *
 * Every expected number is derived from that same copy at run time (the real store grows
 * while the fleet works, so a hard-coded reading would rot within minutes). What is
 * pinned is the *contract*: the three read paths must agree with the independently
 * recomputed hidden/visible split — exactly, not merely approximately — because hiding a
 * human's own session is as much a failure as leaking an auto session.
 *
 * Missing real store => hard failure, never `skip`: the criterion is worthless if it
 * silently passes where the data it claims to measure does not exist.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { searchConversations, sessionsService } from '@/modules/providers/index.js';
import projectsRoutes from '@/modules/projects/projects.routes.js';

/** The rule the operator sets for the claudecodeui project in the real app. */
const HIDE_RULE = '-(task-worker|selector|fix-worker)$';
/** Same rule, recompiled here so the expectation never borrows the code under test. */
const AUTO_SESSION_REGEX = /-(?:task-worker|selector|fix-worker)$/i;
const REAL_DATABASE_PATH = path.join(homedir(), '.cloudcli', 'auth.db');
const SIDECAR_SUFFIXES = ['-wal', '-shm'];
const PAGE_SIZE = 5;
const MAX_TITLE_RESULTS = 200;
const PAGINATION_GUARD = 10_000;

type SessionRow = { session_id: string; custom_name?: string | null };

type SessionSummary = { id: string; provider: string; summary: string; lastActivity: string };

type Page = {
  sessions: SessionSummary[];
  sessionMeta: { total: number; hasMore: boolean; hiddenCount: number };
  hiddenCount: number;
};

type Expectation = {
  projectPath: string;
  projectId: string;
  /** Every non-archived session of the project, ordered exactly as the SQL reader orders it. */
  allIds: string[];
  hiddenIds: string[];
  visibleIds: string[];
};

type RealDataContext = {
  baseUrl: string;
  expectation: Expectation;
  projectId: string;
  /** Re-opens the SQLite connection against the same copy, simulating an app restart. */
  reopenDatabase: () => Promise<void>;
};

function resolveRealProjectPath(): string {
  const override = process.env.SESSION_FILTER_REALDATA_PROJECT_PATH?.trim();
  if (override) {
    return override;
  }

  const rows = projectsDb.getProjectPaths() as Array<{ project_path: string }>;
  const match = rows.find((row) => /\/claudecodeui\/?$/.test(row.project_path.trim()));
  assert.ok(
    match,
    `no project row ending in "/claudecodeui" in the copied real store; set SESSION_FILTER_REALDATA_PROJECT_PATH to pick another one`,
  );
  return match.project_path;
}

/** Copies the real store (plus WAL sidecars) into a temp dir. Fails closed when absent. */
async function copyRealDatabase(): Promise<{ directory: string; databasePath: string }> {
  try {
    const info = await stat(REAL_DATABASE_PATH);
    assert.ok(info.isFile() && info.size > 0, `${REAL_DATABASE_PATH} is not a non-empty file`);
  } catch (error) {
    throw new Error(
      `real store unavailable at ${REAL_DATABASE_PATH}: ${error instanceof Error ? error.message : String(error)} — this criterion must run on a read-only copy of the real database and deliberately fails closed instead of skipping`,
    );
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'session-filter-realdata-'));
  const databasePath = path.join(directory, 'auth.db');
  await copyFile(REAL_DATABASE_PATH, databasePath);
  for (const suffix of SIDECAR_SUFFIXES) {
    try {
      await copyFile(`${REAL_DATABASE_PATH}${suffix}`, `${databasePath}${suffix}`);
    } catch {
      // No journal sidecar to carry over — the main file alone is a valid snapshot.
    }
  }

  return { directory, databasePath };
}

/**
 * Recomputes the hidden/visible split straight from the copy, using an independently
 * compiled regex over the session names. This is the number the three read paths must
 * reproduce; it shares no code with the SQL visibility clause under test.
 */
function deriveExpectation(projectId: string, projectPath: string): Expectation {
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    Number.MAX_SAFE_INTEGER,
    0,
  ) as SessionRow[];
  const allIds = rows.map((row) => row.session_id);
  const hiddenIds = rows
    .filter((row) => AUTO_SESSION_REGEX.test(row.custom_name ?? ''))
    .map((row) => row.session_id);
  const visibleIds = rows
    .filter((row) => !AUTO_SESSION_REGEX.test(row.custom_name ?? ''))
    .map((row) => row.session_id);

  assert.ok(allIds.length > 0, `the real store holds no sessions for ${projectPath}`);
  assert.ok(hiddenIds.length > 0, `no session of ${projectPath} matches ${HIDE_RULE}; the criterion would be vacuous`);
  assert.ok(visibleIds.length > 0, `every session of ${projectPath} matches ${HIDE_RULE}; the rule would be over-broad`);

  return { projectPath, projectId, allIds, hiddenIds, visibleIds };
}

async function withRealDatabase(run: (context: RealDataContext) => Promise<void>): Promise<void> {
  const { directory, databasePath } = await copyRealDatabase();
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const projectPath = resolveRealProjectPath();
  const project = projectsDb.getProjectPath(projectPath);
  assert.ok(project, `project row missing for ${projectPath} in the copied real store`);
  const expectation = deriveExpectation(project.project_id, projectPath);

  console.log(
    `__REALDATA__ project=${projectPath} total=${expectation.allIds.length} hidden=${expectation.hiddenIds.length} visible=${expectation.visibleIds.length}`,
  );

  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRoutes);
  app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: { message: error.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      expectation,
      projectId: project.project_id,
      reopenDatabase: async () => {
        closeConnection();
        await initializeDatabase();
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

async function putFilter(baseUrl: string, projectId: string, hide: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/projects/${projectId}/session-filter`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hide }),
  });
}

async function getPage(baseUrl: string, projectId: string, query: string): Promise<Page> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/sessions?${query}`);
  assert.equal(response.status, 200, `GET sessions?${query} answered ${response.status}`);
  return response.json() as Promise<Page>;
}

/** Walks every page of a query and returns the collected ids in stream order. */
async function readAllPages(
  baseUrl: string,
  projectId: string,
  query: string,
  expectedTotal: number,
): Promise<SessionSummary[]> {
  const collected: SessionSummary[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    assert.ok(offset < PAGINATION_GUARD, `pagination did not terminate after ${offset} rows`);
    const page = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=${offset}${query}`);
    assert.equal(page.sessionMeta.total, expectedTotal, 'total must stay constant across pages');
    assert.equal(page.hiddenCount, page.sessionMeta.hiddenCount, 'top-level hiddenCount must mirror sessionMeta');
    collected.push(...page.sessions);
    if (!page.sessionMeta.hasMore) break;
  }
  return collected;
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

test('real-data: the rule set through the PUT route hides exactly the auto sessions on every read path', async () => {
  await withRealDatabase(async ({ baseUrl, projectId, expectation, reopenDatabase }) => {
    const saved = await putFilter(baseUrl, projectId, [HIDE_RULE]);
    assert.equal(saved.status, 200, 'the real PUT route must accept the rule');

    // --- read path 1: paginated project session list over real HTTP ----------
    const visible = await readAllPages(baseUrl, projectId, '', expectation.visibleIds.length);
    const visibleIds = visible.map((session) => session.id);

    assert.deepEqual(
      sorted(visibleIds),
      sorted(expectation.visibleIds),
      'the visible page set must equal the independently recomputed visible set — no extra session, none dropped',
    );
    assert.equal(new Set(visibleIds).size, visibleIds.length, 'paging must not repeat a session');
    for (const session of visible) {
      assert.ok(
        !AUTO_SESSION_REGEX.test(session.summary),
        `auto session ${session.id} (${session.summary}) leaked into the visible list`,
      );
    }

    const firstPage = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0`);
    assert.equal(firstPage.sessionMeta.hiddenCount, expectation.hiddenIds.length);
    assert.equal(
      firstPage.sessionMeta.hasMore,
      PAGE_SIZE < expectation.visibleIds.length,
      'hasMore must describe the filtered stream, not the unfiltered one',
    );

    // --- includeHidden restores the full store ---------------------------------
    const unfiltered = await readAllPages(
      baseUrl,
      projectId,
      '&includeHidden=true',
      expectation.allIds.length,
    );
    assert.deepEqual(
      sorted(unfiltered.map((session) => session.id)),
      sorted(expectation.allIds),
      'includeHidden=true must return every real session of the project, hidden ones included',
    );
    const unfilteredFirstPage = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0&includeHidden=true`);
    assert.equal(unfilteredFirstPage.sessionMeta.hiddenCount, 0, 'nothing is hidden when includeHidden=true');
    assert.deepEqual(
      unfilteredFirstPage.sessions.map((session) => session.id),
      expectation.allIds.slice(0, PAGE_SIZE),
      'the unfiltered first page must be the newest real sessions, in the order the SQL reader produces',
    );

    // --- keepSessionIds: a running auto session stays visible ------------------
    const runningAutoSessionId = expectation.hiddenIds[0];
    const kept = await getPage(
      baseUrl,
      projectId,
      `limit=${PAGE_SIZE}&offset=0&keepSessionIds=${encodeURIComponent(runningAutoSessionId)}`,
    );
    assert.equal(kept.sessionMeta.total, expectation.visibleIds.length + 1, 'a kept session joins the visible total');
    assert.equal(kept.sessionMeta.hiddenCount, expectation.hiddenIds.length - 1, 'a kept session stops being counted hidden');
    const keptIds: string[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await getPage(
        baseUrl,
        projectId,
        `limit=${PAGE_SIZE}&offset=${offset}&keepSessionIds=${encodeURIComponent(runningAutoSessionId)}`,
      );
      keptIds.push(...page.sessions.map((session) => session.id));
      if (!page.sessionMeta.hasMore) break;
    }
    assert.deepEqual(
      sorted(keptIds),
      sorted([...expectation.visibleIds, runningAutoSessionId]),
      'keepSessionIds must add exactly the listed session and nothing else',
    );

    // --- read path 2: recent-session aggregation --------------------------------
    const recentProbe = sessionsService.listRecentSessions(1, 0);
    const recent = sessionsService.listRecentSessions(Math.max(recentProbe.total, 1), 0);
    const recentIds = new Set(recent.conversations.map((conversation) => conversation.sessionId));
    for (const hiddenId of expectation.hiddenIds) {
      assert.ok(!recentIds.has(hiddenId), `recent sessions leaked auto session ${hiddenId}`);
    }
    assert.equal(recent.conversations.length, recent.total, 'the recent window covers every visible session');
    for (const visibleId of expectation.visibleIds) {
      assert.ok(recentIds.has(visibleId), `recent sessions dropped the human session ${visibleId}`);
    }

    // --- read path 3: title search flags the hidden hits ------------------------
    const search = await searchConversations('task-worker', MAX_TITLE_RESULTS);
    const projectSessionIds = new Set(expectation.allIds);
    const projectTitleResults = search.titleResults.filter((result) => projectSessionIds.has(result.sessionId));
    assert.ok(projectTitleResults.length > 0, 'the title search must match the real auto sessions');
    for (const result of projectTitleResults) {
      const matchesRule = AUTO_SESSION_REGEX.test(result.sessionTitle);
      assert.equal(
        result.filtered,
        matchesRule,
        `title search flagged ${result.sessionId} (${result.sessionTitle}) filtered=${result.filtered}`,
      );
      const isHidden = expectation.hiddenIds.includes(result.sessionId);
      assert.equal(matchesRule, isHidden, 'a title match is hidden exactly when the independently recomputed set says so');
    }

    // --- the rule outlives a database restart -----------------------------------
    await reopenDatabase();
    assert.equal(
      projectsDb.getProjectSessionFilterById(projectId),
      JSON.stringify({ hide: [HIDE_RULE] }),
      'the rule must still be stored after the connection is reopened',
    );
    const afterRestart = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0`);
    assert.equal(afterRestart.sessionMeta.total, expectation.visibleIds.length);
    assert.equal(afterRestart.sessionMeta.hiddenCount, expectation.hiddenIds.length);
  });
});

/**
 * Anti-fake guard, executable rather than narrated: the unfiltered stream is what a
 * client that filtered *after* pagination would see. Its first page is drawn from every
 * session and its total is the full store, so the assertions above (total == visible
 * count, hasMore describing the filtered stream) cannot hold for that shape.
 */
test('real-data: server-side filtering is what makes total/hasMore describe the visible stream', async () => {
  await withRealDatabase(async ({ baseUrl, projectId, expectation }) => {
    assert.equal((await putFilter(baseUrl, projectId, [HIDE_RULE])).status, 200);

    const clientSideShape = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0&includeHidden=true`);
    const serverSideShape = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0`);

    console.log(
      `__REALDATA_ANTIFAKE__ client-shape total=${clientSideShape.sessionMeta.total} rows=${clientSideShape.sessions.length} | server-shape total=${serverSideShape.sessionMeta.total} rows=${serverSideShape.sessions.length}`,
    );

    assert.equal(clientSideShape.sessionMeta.total, expectation.allIds.length);
    assert.equal(serverSideShape.sessionMeta.total, expectation.visibleIds.length);
    assert.notEqual(
      serverSideShape.sessionMeta.total,
      clientSideShape.sessionMeta.total,
      'the filtered stream must report its own total, not the unfiltered one',
    );
    const newestOverall = expectation.allIds.slice(0, PAGE_SIZE);
    assert.deepEqual(
      clientSideShape.sessions.map((session) => session.id),
      newestOverall,
      'the client-side shape starts at the newest overall session, whatever its name',
    );
    assert.deepEqual(
      serverSideShape.sessions.map((session) => session.id),
      expectation.visibleIds.slice(0, PAGE_SIZE),
      'the server-side shape starts at the newest visible session',
    );

    // The row-level counterpart of the total/hasMore contrast: the newest real page is
    // a mix, so a client that filtered after pagination would render auto sessions here.
    const hiddenOnNewestPage = newestOverall.filter((id) => expectation.hiddenIds.includes(id)).length;
    console.log(
      `__REALDATA_ANTIFAKE__ newest page hidden=${hiddenOnNewestPage} visible=${PAGE_SIZE - hiddenOnNewestPage}`,
    );
    assert.ok(
      hiddenOnNewestPage > 0,
      'the newest real page holds no auto session, so this project no longer needs the rule',
    );
    assert.ok(
      serverSideShape.sessions.every((session) => !AUTO_SESSION_REGEX.test(session.summary)),
      'every row of the filtered first page must be a session the rule does not match',
    );
  });
});
