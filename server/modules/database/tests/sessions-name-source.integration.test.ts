import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';

const PROJECT_PATH = '/workspace/name-source';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-name-source-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** One row's stored name and its provenance, read straight from the table. */
const storedName = (sessionId: string): { name: string | null; source: string | null } => {
  const row = getConnection()
    .prepare('SELECT custom_name AS name, name_source AS source FROM sessions WHERE session_id = ?')
    .get(sessionId) as { name: string | null; source: string | null } | undefined;
  assert.ok(row, `session ${sessionId} must exist`);
  return row;
};

/** A session discovered on disk: its provider id is its own id. */
const cliSession = (id: string, name: string | undefined, source?: 'derived' | 'ai' | 'manual') =>
  sessionsDb.createSession(id, 'claude', PROJECT_PATH, name, undefined, undefined, null, source);

/**
 * An app-allocated session that the provider has since claimed, which is the
 * shape `createSession` reads as app-owned (`session_id <> provider_session_id`).
 */
const appSession = (appId: string, nativeId: string, name: string): void => {
  sessionsDb.createAppSession(appId, 'claude', PROJECT_PATH, name);
  sessionsDb.assignProviderSessionId(appId, nativeId);
};

// ---------------------------------------------------------------------------
// Precedence: manual > ai > derived, on both session shapes
// ---------------------------------------------------------------------------

test('a disk-discovered session takes an ai-title over its inferred name', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'first prompt', 'derived');

    cliSession('cli-1', 'The Generated Title', 'ai');

    assert.deepEqual(storedName('cli-1'), { name: 'The Generated Title', source: 'ai' });
  });
});

test('an app session takes an ai-title over the name derived from its first message', async () => {
  await withIsolatedDatabase(() => {
    appSession('app-1', 'native-1', 'first message');

    // The watcher finds the app session's transcript and re-upserts it under
    // the provider id it now carries.
    sessionsDb.createSession('native-1', 'claude', PROJECT_PATH, 'The Generated Title', undefined, undefined, null, 'ai');

    assert.deepEqual(storedName('app-1'), { name: 'The Generated Title', source: 'ai' });
  });
});

test('an inferred name never replaces an ai or a manual one', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-ai', 'The Generated Title', 'ai');
    cliSession('cli-manual', 'Chosen By Hand', 'manual');

    // A later scan that only knows the first message must not undo either.
    cliSession('cli-ai', 'first prompt', 'derived');
    cliSession('cli-manual', 'first prompt', 'derived');

    assert.deepEqual(storedName('cli-ai'), { name: 'The Generated Title', source: 'ai' });
    assert.deepEqual(storedName('cli-manual'), { name: 'Chosen By Hand', source: 'manual' });
  });
});

test('an ai-title never replaces a manual name', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'Chosen By Hand', 'manual');

    cliSession('cli-1', 'The Generated Title', 'ai');

    assert.deepEqual(storedName('cli-1'), { name: 'Chosen By Hand', source: 'manual' });
  });
});

test('a later manual name replaces an earlier one', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'First Rename', 'manual');

    cliSession('cli-1', 'Second Rename', 'manual');

    assert.deepEqual(storedName('cli-1'), { name: 'Second Rename', source: 'manual' });
  });
});

test('createSession without a name source records the name as derived', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'first prompt');

    assert.deepEqual(storedName('cli-1'), { name: 'first prompt', source: 'derived' });
  });
});

test('updateSessionCustomName records a manual name', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'first prompt', 'derived');

    sessionsDb.updateSessionCustomName('cli-1', 'Renamed In The Sidebar');

    assert.deepEqual(storedName('cli-1'), { name: 'Renamed In The Sidebar', source: 'manual' });
  });
});

// ---------------------------------------------------------------------------
// Migration: a database from before `name_source` existed
// ---------------------------------------------------------------------------

test('opening a database without the name_source column adds it and classifies the names it finds', async () => {
  await withIsolatedDatabase(async () => {
    cliSession('named-by-user', 'A Name On An Old Row');
    cliSession('named-derived', 'Another Old Name');
    cliSession('never-named', undefined);
    sessionsDb.updateSessionCustomName('named-by-user', 'A Name On An Old Row');

    // The shape the previous release left behind: the same table, that column
    // absent, and therefore no record of where any name came from.
    closeConnection();
    await initializeDatabase();
    getConnection().exec('ALTER TABLE sessions DROP COLUMN name_source');
    assert.ok(
      !(getConnection().prepare('PRAGMA table_info(sessions)').all() as { name: string }[])
        .map((column) => column.name)
        .includes('name_source'),
      'the fixture must really be missing the column'
    );

    // The app starts again against that file; migrations run on open.
    closeConnection();
    await initializeDatabase();

    // A name that was already on the row can only have come from the user —
    // an inferred one would have been recomputed by the scan that follows.
    assert.deepEqual(storedName('named-by-user'), {
      name: 'A Name On An Old Row',
      source: 'manual',
    });
    assert.deepEqual(storedName('named-derived'), {
      name: 'Another Old Name',
      source: 'manual',
    });
    assert.deepEqual(storedName('never-named'), { name: null, source: 'derived' });

    // Reopening is a no-op, not a second backfill: a row that has since been
    // upgraded to an ai-title keeps it.
    getConnection()
      .prepare("UPDATE sessions SET name_source = 'ai' WHERE session_id = ?")
      .run('named-derived');

    closeConnection();
    await initializeDatabase();

    assert.deepEqual(storedName('named-derived'), {
      name: 'Another Old Name',
      source: 'ai',
    });
    assert.deepEqual(storedName('named-by-user'), {
      name: 'A Name On An Old Row',
      source: 'manual',
    });
    assert.deepEqual(storedName('never-named'), { name: null, source: 'derived' });
  });
});
