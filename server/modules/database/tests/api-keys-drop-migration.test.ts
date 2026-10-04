import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

/**
 * The DDL the retired plaintext API-key feature created, verbatim.
 *
 * Reproducing it rather than a stand-in is the point: an install that ran that
 * release has exactly this table (and its `idx_api_keys_*` indexes) on disk,
 * and the upgrade has to clean them out and report how many rows it discarded.
 */
const LEGACY_API_KEYS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/** The three indexes the same release declared on top of that table. */
const LEGACY_API_KEYS_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key)',
  'CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)',
];

const LEGACY_API_KEYS_INDEX_NAMES = [
  'idx_api_keys_key',
  'idx_api_keys_user_id',
  'idx_api_keys_active',
];

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'api-keys-drop-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

const tableNames = (): string[] =>
  (
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((row) => row.name);

const indexNames = (): string[] =>
  (
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[]
  ).map((row) => row.name);

/** Row count per application table, so "the upgrade lost no row" is checkable. */
const rowCounts = (): Record<string, number> =>
  Object.fromEntries(
    tableNames()
      .filter((name) => !name.startsWith('sqlite_'))
      .map((name) => [
        name,
        (
          getConnection().prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {
            count: number;
          }
        ).count,
      ])
  );

const userRows = (): unknown[] =>
  getConnection().prepare('SELECT * FROM users ORDER BY id').all();

/** A node:test console.log mock, read back as whole log lines. */
type ConsoleLogMock = { mock: { calls: Array<{ arguments: unknown[] }> } };

const loggedLines = (logMock: ConsoleLogMock): string[] =>
  logMock.mock.calls.map((call) => call.arguments.map((arg) => String(arg)).join(' '));

test('a freshly created database carries no api_keys structure and never reports a drop', async (t) => {
  await withIsolatedDatabase(async () => {
    const logMock = t.mock.method(console, 'log');
    closeConnection();
    await initializeDatabase();

    assert.ok(
      !tableNames().includes('api_keys'),
      'a fresh database must not create the legacy api_keys table'
    );
    assert.deepEqual(
      indexNames().filter((name) => LEGACY_API_KEYS_INDEX_NAMES.includes(name)),
      [],
      'a fresh database must not create any idx_api_keys_* index'
    );
    assert.deepEqual(
      loggedLines(logMock).filter((line) => line.includes('api_keys')),
      [],
      'a database that never had api_keys must log no drop'
    );
  });
});

test('opening a database that still has the legacy api_keys table drops it, reports the row count, and keeps every row', async (t) => {
  await withIsolatedDatabase(async () => {
    const logMock = t.mock.method(console, 'log');

    // The user the two keys belong to — the row the upgrade must not touch.
    getConnection()
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run('legacy-user', 'hash');

    // The shape the previous release left behind: its table, its indexes, and
    // two keys actually issued to the user.
    const legacy = getConnection();
    legacy.exec(LEGACY_API_KEYS_TABLE_SQL);
    for (const statement of LEGACY_API_KEYS_INDEX_SQL) {
      legacy.exec(statement);
    }
    const insertKey = legacy.prepare(
      'INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)'
    );
    insertKey.run(1, 'first-key', 'ck_first');
    insertKey.run(1, 'second-key', 'ck_second');

    const usersBefore = userRows();
    const countsBefore = rowCounts();

    // The app starts again against that file; migrations run on open.
    closeConnection();
    await initializeDatabase();

    // (a) the legacy table and its three indexes are gone.
    assert.ok(!tableNames().includes('api_keys'), 'the upgrade must drop the api_keys table');
    assert.deepEqual(
      indexNames().filter((name) => LEGACY_API_KEYS_INDEX_NAMES.includes(name)),
      [],
      'the upgrade must drop every idx_api_keys_* index'
    );

    // (b) the hashed replacement store is in place.
    assert.ok(
      tableNames().includes('access_tokens'),
      'the upgrade must leave the access_tokens table in place'
    );

    // (c) the user row survives verbatim and no other table's count moves.
    assert.deepEqual(userRows(), usersBefore, 'the users row must survive the upgrade verbatim');
    const { api_keys: legacyRowCount, ...survivingCounts } = countsBefore;
    assert.equal(legacyRowCount, 2, 'the legacy table really held two rows before the upgrade');
    assert.deepEqual(
      rowCounts(),
      survivingCounts,
      'no other table may gain or lose a row across the upgrade'
    );

    // (d) the discarded row count is reported in the migration log.
    assert.ok(
      loggedLines(logMock).some((line) =>
        line.includes('Dropping the legacy api_keys table (2 rows removed)')
      ),
      'the migration must log the number of dropped rows'
    );

    // (e) reopening the upgraded database is a no-op: it does not throw and it
    // reports no further drop.
    const callsBeforeSecondOpen = logMock.mock.calls.length;
    closeConnection();
    await initializeDatabase();

    const secondOpenLines = loggedLines(logMock).slice(callsBeforeSecondOpen);
    assert.deepEqual(
      secondOpenLines.filter((line) => line.includes('api_keys')),
      [],
      'a second open must not report dropping api_keys again'
    );
    assert.ok(!tableNames().includes('api_keys'), 'a second open must leave the table absent');
  });
});
