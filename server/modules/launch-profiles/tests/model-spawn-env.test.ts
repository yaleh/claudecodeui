import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, providerModelsDb } from '@/modules/database/index.js';
import { resolveModelLaunchSpec } from '@/modules/launch-profiles/index.js';
import { mapCliOptionsToSDK } from '@/modules/providers/index.js';
import { handleShellConnection } from '@/modules/websocket/index.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

type Env = Record<string, string | undefined>;

// Reference: the historical claude-fjdac launch. Known non-equivalences with it (registered honestly):
//  - the original used a shell wrapper exporting these vars; here they are compiled from library rows;
//  - CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (SDK path) and TERM/COLORTERM/FORCE_COLOR (pty path) are added by the app;
//  - the credential value is asserted only for presence/source, never printed.
const SECRET = 'sk-fjdac-SENTINEL';
const FJDAC_ROWS: ProviderModelEnvRow[] = [
  { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://fjdac.example' },
  { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: SECRET },
  { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', kind: 'value', value: 'fj-opus' },
  { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', kind: 'value', value: 'fj-sonnet' },
  { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', kind: 'value', value: 'fj-haiku' },
  { key: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', kind: 'value', value: '400000' },
  { key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', kind: 'value', value: '300000' },
  { key: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', kind: 'value', value: '80' },
  { key: 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN', kind: 'value', value: '1' },
  { key: 'CLAUDE_CODE_DISABLE_MOUSE', kind: 'value', value: '1' },
  { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
];
const FJDAC_KEYS = FJDAC_ROWS.filter((row) => row.kind !== 'unset').map((row) => row.key);

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (d: string) => void };
  socket.readyState = WebSocket.OPEN;
  socket.send = () => undefined;
  return socket;
}

function capturePtyEnv(model: string): Env {
  let captured: Env | null = null;
  const fakePty = {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write() {}, resize() {}, kill() {},
  };
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => null,
    spawnPty: ((_s: string, _a: string[], opts: { env: Env }) => {
      captured = opts.env;
      return fakePty;
    }) as never,
  });
  socket.emit('message', JSON.stringify({
    type: 'init', projectPath: process.cwd(), sessionId: `spawn-env-${Date.now()}`, hasSession: false,
    provider: 'plain-shell', isPlainShell: true, initialCommand: 'true', model,
  }));
  assert.ok(captured, 'spawnPty was called');
  return captured;
}

/** The contract every final spawn env must meet for the fjdac fixture. */
function assertFjdacEnv(env: Env, label: string): void {
  assert.ok(!('ANTHROPIC_API_KEY' in env), `${label}: unset key must be absent from the final env`);
  for (const key of FJDAC_KEYS) {
    assert.ok(typeof env[key] === 'string' && env[key], `${label}: ${key} present`);
  }
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://fjdac.example');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN === SECRET, true, `${label}: credential sourced from the library secret`);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '400000');
}

async function withFixture(run: () => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-spawn-env-'));
  const previousDb = process.env.DATABASE_PATH;
  const saved = process.env;
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  try {
    await initializeDatabase();
    providerModelsDb.createCustomProviderModel('claude', { id: 'fjdac', model: 'fjdac', config: { env: FJDAC_ROWS } });
    // The host env carries the credential the unset row must strip.
    process.env.ANTHROPIC_API_KEY = 'sk-host-inherited';
    await run();
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    process.env = saved;
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    await rm(dir, { recursive: true, force: true });
  }
}

test('SDK path: sdkOptions.env for a persisted model matches the fjdac reference and drops the unset key', async () => {
  await withFixture(() => {
    assertFjdacEnv(mapCliOptionsToSDK({ model: 'fjdac' }).env as Env, 'sdk');
    // Same set of keys as host env + fjdac rows + the app-added bg ceiling, minus the unset key.
    const keys = Object.keys(mapCliOptionsToSDK({ model: 'fjdac' }).env as Env);
    const expected = new Set([...Object.keys(process.env).filter((k) => k !== 'ANTHROPIC_API_KEY'), ...FJDAC_KEYS, 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']);
    assert.deepStrictEqual(new Set(keys), expected);
  });
});

test('pty path: spawned env for a persisted model matches the fjdac reference and drops the unset key', async () => {
  await withFixture(() => {
    assertFjdacEnv(capturePtyEnv('fjdac'), 'pty');
  });
});

test('built-in model keeps the inherited env untouched on both paths', async () => {
  await withFixture(() => {
    assert.equal((mapCliOptionsToSDK({ model: 'opus' }).env as Env).ANTHROPIC_API_KEY, 'sk-host-inherited');
    assert.equal(capturePtyEnv('opus').ANTHROPIC_API_KEY, 'sk-host-inherited');
  });
});

test('fake variant: a compile that omits the unset removal is caught by the contract', async () => {
  await withFixture(() => {
    const real = resolveModelLaunchSpec('claude', 'fjdac');
    const noRemoval = { ...process.env, ...real.env } as Env; // spec without applying unsetEnv
    assert.throws(() => assertFjdacEnv(noRemoval, 'fake'));
  });
});

test('envref missing surfaces a warning through the compile entry used by both paths', async () => {
  await withFixture(() => {
    delete process.env.MODEL_SPAWN_ENV_MISSING;
    providerModelsDb.createCustomProviderModel('claude', {
      id: 'ref', model: 'ref', config: { env: [{ key: 'ANTHROPIC_AUTH_TOKEN', kind: 'envref', value: 'MODEL_SPAWN_ENV_MISSING' }] },
    });
    const spec = resolveModelLaunchSpec('claude', 'ref');
    assert.equal(spec.warnings.length, 1);
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in (mapCliOptionsToSDK({ model: 'ref' }).env as Env)), 'no silent fallback to an inherited value');
  });
});
