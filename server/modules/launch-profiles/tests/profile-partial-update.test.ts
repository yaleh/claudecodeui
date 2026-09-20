import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { launchProfilesRoutes } from '@/modules/launch-profiles/index.js';
import { AppError } from '@/shared/utils.js';

async function withDatabase(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launch-profiles-rest-'));
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

/** Serves the real router (or nothing, for the falsification case) over real HTTP. */
async function withServer(mount: boolean, run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  if (mount) {
    app.use('/api/launch-profiles', launchProfilesRoutes);
  }
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

const base0 = {
  id: 'partial-1',
  provider: 'claude',
  name: 'Gateway A',
  description: 'desc',
  deployment: 'direct',
  isDefault: true,
  sortOrder: 7,
  config: { baseUrl: 'https://gw.example.test', authMode: 'envVar', authEnvVarName: 'GW_KEY' },
};

function send(method: string, url: string, body: unknown): Promise<Response> {
  return fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('PUT with only {name} preserves isDefault/description/sortOrder/deployment/config', async () => {
  await withDatabase(() => withServer(true, async (base) => {
    assert.equal((await send('POST', base, base0)).status, 201);
    const before = (await (await fetch(`${base}/${base0.id}`)).json()) as Record<string, unknown>;
    assert.equal((await send('PUT', `${base}/${base0.id}`, { name: 'Renamed' })).status, 200);
    const after = (await (await fetch(`${base}/${base0.id}`)).json()) as Record<string, unknown>;
    assert.equal(after.name, 'Renamed');
    const pick = (r: Record<string, unknown>) => ({
      isDefault: r.isDefault, description: r.description, sortOrder: r.sortOrder, deployment: r.deployment, config: r.config,
    });
    assert.deepStrictEqual(pick(after), pick(before));
    assert.equal(after.isDefault, true);
  }));
});

test('PUT with config replaces config; other fields stay; bad types and unknown ids fail', async () => {
  await withDatabase(() => withServer(true, async (base) => {
    await send('POST', base, base0);
    const config = { ...base0.config, baseUrl: 'https://other.example.test' };
    assert.equal((await send('PUT', `${base}/${base0.id}`, { config })).status, 200);
    const after = (await (await fetch(`${base}/${base0.id}`)).json()) as Record<string, unknown>;
    assert.deepStrictEqual(after.config, config);
    assert.equal(after.isDefault, true);
    assert.equal(after.deployment, 'direct');
    assert.equal((await send('PUT', `${base}/${base0.id}`, { isDefault: 'yes' })).status, 400);
    assert.equal((await send('PUT', `${base}/${base0.id}`, { config: { apiKey: 'x' } })).status, 400);
    assert.equal((await send('PUT', `${base}/missing`, { name: 'x' })).status, 404);
  }));
});
