import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, launchProfilesDb } from '@/modules/database/index.js';
import { resolveLaunchSpec } from '@/modules/launch-profiles/launch-profiles.service.js';

async function withDatabase(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launch-profiles-config-env-'));
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

function insertProfile(id: string, env: unknown) {
  // Written straight to the DB, bypassing the service write-path allowlist.
  launchProfilesDb.create({
    id,
    provider: 'claude',
    name: id,
    description: null,
    deployment: 'gateway',
    isDefault: false,
    config: { baseUrl: 'https://gw.example.test', env },
  });
}

test('allowlisted config.env keys reach spec.env', async () => {
  await withDatabase(async () => {
    insertProfile('ok', {
      CLAUDE_CODE_DISABLE_MOUSE: '1',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    });
    const spec = resolveLaunchSpec('ok', 'claude');
    assert.equal(spec.env.CLAUDE_CODE_DISABLE_MOUSE, '1');
    assert.equal(spec.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, '1');
    assert.equal(spec.env.ANTHROPIC_BASE_URL, 'https://gw.example.test');
  });
});

test('denied config.env key written around the service is dropped with a warning', async () => {
  await withDatabase(async () => {
    insertProfile('bad', { LD_PRELOAD: '/tmp/evil.so', CLAUDE_CODE_DISABLE_MOUSE: '1' });
    const spec = resolveLaunchSpec('bad', 'claude');
    assert.equal('LD_PRELOAD' in spec.env, false);
    assert.equal(spec.env.CLAUDE_CODE_DISABLE_MOUSE, '1');
    assert.ok(spec.warnings.some((w) => w.includes('LD_PRELOAD')));
  });
});

test('non-string config.env values are dropped with a warning', async () => {
  await withDatabase(async () => {
    insertProfile('nonstr', { CLAUDE_CODE_DISABLE_MOUSE: 1, CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' });
    const spec = resolveLaunchSpec('nonstr', 'claude');
    assert.equal('CLAUDE_CODE_DISABLE_MOUSE' in spec.env, false);
    assert.equal(spec.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, '1');
    assert.ok(spec.warnings.some((w) => w.includes('CLAUDE_CODE_DISABLE_MOUSE')));
  });
});

test('typed fields win over a same-named config.env key', async () => {
  await withDatabase(async () => {
    insertProfile('conflict', { ANTHROPIC_BASE_URL: 'https://other.example.test' });
    const spec = resolveLaunchSpec('conflict', 'claude');
    assert.equal(spec.env.ANTHROPIC_BASE_URL, 'https://gw.example.test');
    assert.ok(spec.warnings.some((w) => w.includes('ANTHROPIC_BASE_URL')));
  });
});
