// Scope: launch-profile credentials only (env-var-name references, never values).
// Model-library secrets are governed by ADR-002 (stored write-only in
// provider_models.config_json) and covered by
// providers/tests/model-secret-write-only.test.ts; the two rules do not overlap.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { launchProfilesService } from '@/modules/launch-profiles/index.js';

const SENTINEL = `sk-test-SENTINEL-${randomBytes(6).toString('hex')}`;

async function withDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launch-profiles-secret-'));
  const databasePath = path.join(dir, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  try {
    await run(databasePath);
  } finally {
    closeConnection();
    if (previous === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/** Counts sentinel hits across every column of every table plus raw db/WAL file bytes. */
async function countSentinelHits(databasePath: string): Promise<number> {
  const db = getConnection();
  let hits = 0;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    for (const column of columns) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE CAST("${column.name}" AS TEXT) LIKE ?`)
        .get(`%${SENTINEL}%`) as { n: number };
      hits += row.n;
    }
  }
  const dir = path.dirname(databasePath);
  for (const file of await readdir(dir)) {
    if (file.startsWith(path.basename(databasePath))) {
      const bytes = await readFile(path.join(dir, file));
      if (bytes.includes(Buffer.from(SENTINEL))) {
        hits += 1;
      }
    }
  }
  return hits;
}

test('credential value is never persisted anywhere in the database', async () => {
  await withDatabase(async (databasePath) => {
    // Env-var-name reference is the only allowed credential form.
    launchProfilesService.createProfile({
      id: 'p1',
      provider: 'claude',
      name: 'gateway',
      description: null,
      deployment: 'gateway',
      isDefault: false,
      config: { baseUrl: 'https://gw.example', authEnvVarName: 'MY_GATEWAY_KEY' },
    });
    // Inline credential values are rejected before reaching storage.
    assert.throws(() =>
      launchProfilesService.createProfile({
        id: 'p2',
        provider: 'claude',
        name: 'leaky',
        description: null,
        deployment: 'gateway',
        isDefault: false,
        config: { authEnvVarName: 'X', apiKey: SENTINEL },
      }),
    );
    const hits = await countSentinelHits(databasePath);
    assert.strictEqual(hits, 0);
  });
});

test('fake-shape: sentinel written into any launch_profiles column is detected', async () => {
  for (const column of ['name', 'description', 'config_json']) {
    await withDatabase(async (databasePath) => {
      launchProfilesService.createProfile({
        id: 'p1',
        provider: 'claude',
        name: 'gateway',
        description: 'd',
        deployment: 'gateway',
        isDefault: false,
        config: {},
      });
      getConnection().prepare(`UPDATE launch_profiles SET ${column} = ? WHERE id = 'p1'`).run(SENTINEL);
      const hits = await countSentinelHits(databasePath);
      assert.ok(hits > 0, `column ${column} should be detected`);
    });
  }
});
