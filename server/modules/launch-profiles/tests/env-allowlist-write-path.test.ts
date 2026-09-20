import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { launchProfilesRoutes } from '@/modules/launch-profiles/index.js';
import { launchProfilesService } from '@/modules/launch-profiles/launch-profiles.service.js';
import { AppError } from '@/shared/utils.js';

const DENIED_KEYS = ['LD_PRELOAD', 'PATH', 'NODE_OPTIONS'];

async function withDatabase(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launch-profiles-envwrite-'));
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

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/launch-profiles', launchProfilesRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/launch-profiles`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function payload(id: string, env?: unknown) {
  return {
    id,
    provider: 'claude',
    name: `Profile ${id}`,
    description: null,
    deployment: 'gateway',
    isDefault: false,
    config: { baseUrl: 'https://gw.example.test', authMode: 'envVar', authEnvVarName: 'GW_KEY', env },
  };
}

function send(method: string, url: string, body: unknown): Promise<Response> {
  return fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Counts stored rows, across every column, that mention the key name. */
function countKeyHits(key: string): number {
  const rows = getConnection().prepare('SELECT * FROM launch_profiles').all() as Array<Record<string, unknown>>;
  return rows.filter((row) => Object.values(row).some((value) => String(value).includes(key))).length;
}

function assertNoDeniedKeyStored(): void {
  for (const key of DENIED_KEYS) {
    assert.strictEqual(countKeyHits(key), 0, `${key} must not be persisted`);
  }
}

test('POST with a denied config.env key is rejected 4xx and never persisted', async () => {
  await withDatabase(() => withServer(async (base) => {
    for (const key of DENIED_KEYS) {
      const res = await send('POST', base, payload(`deny-${key}`, { [key]: 'x' }));
      assert.ok(res.status >= 400 && res.status < 500, `${key} -> ${res.status}`);
    }
    const list = JSON.stringify(await (await fetch(base)).json());
    for (const key of DENIED_KEYS) {
      assert.ok(!list.includes(key));
    }
    assertNoDeniedKeyStored();
  }));
});

test('PUT with a denied config.env key is rejected 4xx and leaves the record unchanged', async () => {
  await withDatabase(() => withServer(async (base) => {
    assert.equal((await send('POST', base, payload('keep-1', { ANTHROPIC_BASE_URL: 'https://a.test' }))).status, 201);
    const before = JSON.stringify(getConnection().prepare('SELECT * FROM launch_profiles WHERE id = ?').get('keep-1'));
    const { id: _id, ...rest } = payload('keep-1', { LD_PRELOAD: '/tmp/evil.so' });
    const res = await send('PUT', `${base}/keep-1`, rest);
    assert.ok(res.status >= 400 && res.status < 500, `PUT -> ${res.status}`);
    const after = JSON.stringify(getConnection().prepare('SELECT * FROM launch_profiles WHERE id = ?').get('keep-1'));
    assert.strictEqual(after, before);
    assertNoDeniedKeyStored();
  }));
});

test('a non-object config.env is rejected 4xx', async () => {
  await withDatabase(() => withServer(async (base) => {
    const res = await send('POST', base, payload('bad-env', 'LD_PRELOAD=/x'));
    assert.ok(res.status >= 400 && res.status < 500);
    assertNoDeniedKeyStored();
  }));
});

test('an allowed config.env key still creates the profile (201)', async () => {
  await withDatabase(() => withServer(async (base) => {
    const res = await send('POST', base, payload('ok-1', { ANTHROPIC_BASE_URL: 'https://a.test' }));
    assert.equal(res.status, 201);
  }));
});

test('falsification: a write path that allows every key is caught by the same assertion', async () => {
  await withDatabase(async () => {
    launchProfilesService.createProfile(payload('leaky', { LD_PRELOAD: '/tmp/evil.so' }), { isAllowedKey: () => true });
    assert.throws(() => assertNoDeniedKeyStored(), /LD_PRELOAD must not be persisted/);
  });
});
