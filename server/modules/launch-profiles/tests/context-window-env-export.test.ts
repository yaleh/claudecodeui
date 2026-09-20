import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, launchProfilesDb } from '@/modules/database/index.js';
import { resolveLaunchSpec } from '@/modules/launch-profiles/launch-profiles.service.js';

async function withDatabase(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launch-profiles-ctx-env-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await run();
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

function insertProfile(id: string, config: Record<string, unknown>) {
  launchProfilesDb.create({
    id,
    provider: 'claude',
    name: id,
    description: null,
    deployment: 'gateway',
    isDefault: false,
    config: { baseUrl: 'https://gw.example.test', ...config },
  });
}

const KEYS = ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'];

test('three typed fields export their CLI variables as strings', async () => {
  await withDatabase(async () => {
    insertProfile('p', { contextWindow: 917000, autoCompactWindow: 917000, autoCompactPct: 80 });
    const spec = resolveLaunchSpec('p', 'claude');
    assert.equal(spec.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '917000');
    assert.equal(spec.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '917000');
    assert.equal(spec.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80');
    assert.equal(spec.contextWindow, 917000);
  });
});

test('unset fields export nothing', async () => {
  await withDatabase(async () => {
    insertProfile('p', {});
    const spec = resolveLaunchSpec('p', 'claude');
    for (const key of KEYS) {
      assert.equal(key in spec.env, false);
    }
    assert.deepEqual(spec.warnings, []);
  });
});

test('invalid values are dropped with a warning', async () => {
  await withDatabase(async () => {
    const bad: unknown[] = [0, -5, 101, 'abc', 1.5];
    for (const [i, value] of bad.entries()) {
      insertProfile(`b${i}`, { contextWindow: value, autoCompactWindow: value, autoCompactPct: value });
      const spec = resolveLaunchSpec(`b${i}`, 'claude');
      const pctOnly = value === 101;
      for (const key of KEYS) {
        // 101 is a valid window but an invalid percentage.
        if (pctOnly && key !== 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE') {
          assert.equal(spec.env[key], '101');
        } else {
          assert.equal(key in spec.env, false, `${key} for ${String(value)}`);
        }
      }
      assert.ok(spec.warnings.length >= 1);
    }
  });
});

test('typed field wins over same-key config.env with a warning', async () => {
  await withDatabase(async () => {
    insertProfile('c', { autoCompactPct: 80, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } });
    const spec = resolveLaunchSpec('c', 'claude');
    assert.equal(spec.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80');
    assert.ok(spec.warnings.some((w) => w.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')));
  });
});
