import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, launchProfilesDb, sessionsDb } from '@/modules/database/index.js';
import {
  createLaunchProfilesService,
  type LaunchProfilesGuards,
} from '@/modules/launch-profiles/launch-profiles.service.js';
import {
  resolveLaunchSpec,
  type LaunchSpecGuards,
} from '@/modules/launch-profiles/launch-spec.service.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';

const DENIED_KEYS = [
  'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'BASH_ENV', 'ENV', 'SHELL', 'IFS', 'PYTHONPATH', 'CLAUDE_CLI_PATH', 'CLAUDE_CONFIG_DIR',
];
const SESSION_ID = 'env-injection-session';

async function withDatabase(run: (directory: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'env-injection-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await run(directory);
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

/** Write path: every denied key must be refused by the profile service. Returns the keys that slipped through. */
function writePathLeaks(guards?: LaunchProfilesGuards): string[] {
  const service = createLaunchProfilesService(guards);
  return DENIED_KEYS.filter((key, index) => {
    try {
      service.create({ id: `write-${index}`, name: key, env: { [key]: 'x' } });
      return true;
    } catch {
      return false;
    }
  });
}

/** Compile path: rows written around the service must not yield denied keys. Returns leaked keys. */
function compilePathLeaks(guards?: LaunchSpecGuards): string[] {
  return DENIED_KEYS.filter((key, index) => {
    const id = `compile-${index}`;
    getConnection()
      .prepare('INSERT INTO launch_profiles (id, name, config_json) VALUES (?, ?, ?)')
      .run(id, key, JSON.stringify({ env: { [key]: 'x', ANTHROPIC_BASE_URL: 'https://example.test' } }));
    const spec = resolveLaunchSpec(launchProfilesDb.get(id)!, guards);
    assert.equal(spec.env.ANTHROPIC_BASE_URL, 'https://example.test');
    return key in spec.env;
  });
}

/** WebSocket path: forged options.env sent through the real dispatchRun. Returns the env the runtime received. */
async function envSeenByRuntime(
  dropClientEnv?: (options: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  let seen: Record<string, unknown> | undefined;
  await withDatabase(async (directory) => {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', directory, 'Env session', now, now, path.join(directory, 't.jsonl'));
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send: () => void };
    socket.readyState = 1;
    socket.send = () => {};
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, _command: string, options: Record<string, unknown>) => {
          seen = options.env as Record<string, unknown> | undefined;
        },
      } as never,
      dropClientEnv,
    });
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'hi',
      options: { env: { NODE_OPTIONS: '--require /evil.js', LD_PRELOAD: '/evil.so' } },
    }));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  });
  return seen;
}

const forgedKeysSeen = (env: Record<string, unknown> | undefined): string[] =>
  ['NODE_OPTIONS', 'LD_PRELOAD'].filter((key) => env !== undefined && key in env);

test('write path rejects every denied env key', async () => {
  await withDatabase(async () => {
    assert.deepEqual(writePathLeaks(), []);
  });
});

test('write path accepts allowlisted keys', async () => {
  await withDatabase(async () => {
    createLaunchProfilesService().create({
      id: 'ok',
      name: 'ok',
      env: { ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_X: '1', HTTPS_PROXY: 'p', DISABLE_TELEMETRY: '1' },
    });
    assert.ok(launchProfilesDb.get('ok'));
  });
});

test('compile path drops every denied env key written around the service', async () => {
  await withDatabase(async () => {
    assert.deepEqual(compilePathLeaks(), []);
  });
});

test('forged options.env never reaches the runtime through dispatchRun', async () => {
  assert.deepEqual(forgedKeysSeen(await envSeenByRuntime()), []);
});

test('negative controls: relaxing any single path turns the same assertions red', async () => {
  await withDatabase(async () => {
    assert.notDeepEqual(writePathLeaks({ assertEnv: () => {} }), [], 'lax write path must be caught');
  });
  await withDatabase(async () => {
    assert.notDeepEqual(
      compilePathLeaks({ filterEnv: (env) => env as Record<string, string> }),
      [],
      'lax compile path must be caught',
    );
  });
  assert.notDeepEqual(
    forgedKeysSeen(await envSeenByRuntime((options) => options)),
    [],
    'adopting client env must be caught',
  );
});
