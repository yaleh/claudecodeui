import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { launchProfilesService, resolveLaunchSpec } from '@/modules/launch-profiles/index.js';

const DEFAULT_MODEL = 'real-default-model';
const FALLBACK_MODEL = 'real-fallback-model';

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

function seed(id: string, extra: Record<string, unknown>): void {
  launchProfilesService.createProfile({
    id,
    provider: 'claude',
    name: id,
    description: null,
    deployment: 'gateway',
    isDefault: false,
    config: { baseUrl: 'http://127.0.0.1:1', defaultModel: DEFAULT_MODEL, fallbackModel: FALLBACK_MODEL, ...extra },
  });
}

/** Contract the real resolveLaunchSpec must satisfy; reused to prove fake variants go red. */
type Resolve = typeof resolveLaunchSpec;
function assertCompiles(resolve: Resolve): void {
  process.env.CONTEXT_WINDOW = '333000';
  const spec = resolve('with-window', 'claude');
  assert.ok(spec.argv.length > 0, 'argv must be non-empty');
  assert.equal(spec.argv[spec.argv.indexOf('--model') + 1], DEFAULT_MODEL);
  assert.equal(spec.argv[spec.argv.indexOf('--fallback-model') + 1], FALLBACK_MODEL);
  assert.equal(spec.contextWindow, 917000);
}

test('real persisted profile compiles to non-empty argv and profile contextWindow', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'launch-spec-real-'));
  const previousDb = process.env.DATABASE_PATH;
  const previousWindow = process.env.CONTEXT_WINDOW;
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  try {
    await initializeDatabase();
    seed('with-window', { contextWindow: 917000 });
    seed('no-window', {});

    assertCompiles(resolveLaunchSpec);
    assert.ok(!resolveLaunchSpec('with-window', 'claude').argv.join(' ').includes('127.0.0.1'), 'no endpoint/secret in argv');

    // Fallback tiers: profile unset -> CONTEXT_WINDOW -> 160000.
    process.env.CONTEXT_WINDOW = '333000';
    assert.equal(resolveLaunchSpec('no-window', 'claude').contextWindow, 333000);
    delete process.env.CONTEXT_WINDOW;
    assert.equal(resolveLaunchSpec('no-window', 'claude').contextWindow, 160000);

    // Passthrough stays empty.
    assert.deepEqual(resolveLaunchSpec(null, 'claude').argv, []);

    // Fake-detection: constant-empty-argv and env-only-contextWindow variants must fail the contract.
    const emptyArgv: Resolve = (id, provider) => ({ ...resolveLaunchSpec(id, provider), argv: [] });
    const envOnly: Resolve = (id, provider) => ({
      ...resolveLaunchSpec(id, provider),
      contextWindow: parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || 160000,
    });
    assert.throws(() => assertCompiles(emptyArgv));
    assert.throws(() => assertCompiles(envOnly));
  } finally {
    closeConnection();
    restore('DATABASE_PATH', previousDb);
    restore('CONTEXT_WINDOW', previousWindow);
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
