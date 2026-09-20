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

const submitted = {
  id: 'rest-profile-1',
  provider: 'claude',
  name: 'Gateway A',
  description: null,
  deployment: 'gateway',
  isDefault: false,
  config: { baseUrl: 'https://gw.example.test', authMode: 'envVar', authEnvVarName: 'GW_KEY' },
};

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('profile created over REST reads back via GET /:id and GET /', async () => {
  await withDatabase(() => withServer(true, async (base) => {
    const created = await postJson(base, submitted);
    assert.equal(created.status, 201);

    const one = (await (await fetch(`${base}/${submitted.id}`)).json()) as Record<string, unknown>;
    assert.deepStrictEqual(
      { name: one.name, provider: one.provider, config: one.config },
      { name: submitted.name, provider: submitted.provider, config: submitted.config },
    );

    const list = (await (await fetch(base)).json()) as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.deepStrictEqual(
      { name: list[0].name, provider: list[0].provider, config: list[0].config },
      { name: submitted.name, provider: submitted.provider, config: submitted.config },
    );

    assert.equal((await fetch(`${base}/missing`)).status, 404);
  }));
});

test('PUT updates and DELETE removes a profile', async () => {
  await withDatabase(() => withServer(true, async (base) => {
    await postJson(base, submitted);
    const put = await fetch(`${base}/${submitted.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...submitted, name: 'Renamed' }),
    });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { name: string }).name, 'Renamed');
    assert.equal((await fetch(`${base}/${submitted.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/${submitted.id}`)).status, 404);
  }));
});

test('POST carrying an inline credential returns 400 and persists nothing', async () => {
  await withDatabase(() => withServer(true, async (base) => {
    const res = await postJson(base, { ...submitted, config: { ...submitted.config, apiKey: 'sk-inline' } });
    assert.equal(res.status, 400);
    const row = getConnection().prepare('SELECT COUNT(*) AS n FROM launch_profiles').get() as { n: number };
    assert.equal(row.n, 0);
  }));
});

test('falsification: without the mounted router the same request is 404', async () => {
  await withDatabase(() => withServer(false, async (base) => {
    assert.equal((await postJson(base, submitted)).status, 404);
  }));
});
