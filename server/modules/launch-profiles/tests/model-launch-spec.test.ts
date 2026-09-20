import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, providerModelsDb } from '@/modules/database/index.js';
import { resolveModelLaunchSpec } from '@/modules/launch-profiles/index.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

async function withDb(run: () => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-launch-spec-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  try {
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const seed = (id: string, env: ProviderModelEnvRow[] | null) =>
  providerModelsDb.createCustomProviderModel('claude', { id, model: id, config: env ? { env } : null });

test('built-in and unconfigured custom models compile to the passthrough spec', async () => {
  await withDb(() => {
    seed('plain-custom', null);
    for (const id of ['opus', 'sonnet', 'not-a-model', 'plain-custom', undefined, null]) {
      const spec = resolveModelLaunchSpec('claude', id);
      assert.deepStrictEqual(spec.env, {});
      assert.deepStrictEqual(spec.unsetEnv, []);
      assert.deepStrictEqual(spec.argv, []);
      assert.deepStrictEqual(spec.warnings, []);
    }
  });
});

test('value/secret/envref/unset rows compile with the documented semantics', async () => {
  await withDb(() => {
    const previous = process.env.MODEL_SPEC_TEST_REF;
    process.env.MODEL_SPEC_TEST_REF = 'from-host';
    try {
      seed('gw', [
        { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
        { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-secret' },
        { key: 'CLAUDE_CODE_DISABLE_MOUSE', kind: 'envref', value: 'MODEL_SPEC_TEST_REF' },
        { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
        { key: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', kind: 'value', value: '400000' },
        { key: 'PATH', kind: 'value', value: '/evil' },
      ]);
      const spec = resolveModelLaunchSpec('claude', 'gw');
      assert.equal(spec.env.ANTHROPIC_BASE_URL, 'https://gw.example');
      assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, 'sk-secret');
      assert.equal(spec.env.CLAUDE_CODE_DISABLE_MOUSE, 'from-host');
      assert.deepStrictEqual(spec.unsetEnv, ['ANTHROPIC_API_KEY']);
      assert.equal(spec.contextWindow, 400000);
      assert.ok(!('PATH' in spec.env), 'denied key never compiled');
      assert.ok(spec.warnings.some((w) => w.includes('PATH')));
    } finally {
      if (previous === undefined) delete process.env.MODEL_SPEC_TEST_REF;
      else process.env.MODEL_SPEC_TEST_REF = previous;
    }
  });
});

test('envref to a missing host variable warns and does not export the key', async () => {
  await withDb(() => {
    delete process.env.MODEL_SPEC_TEST_MISSING;
    seed('gw', [{ key: 'ANTHROPIC_AUTH_TOKEN', kind: 'envref', value: 'MODEL_SPEC_TEST_MISSING' }]);
    const spec = resolveModelLaunchSpec('claude', 'gw');
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in spec.env));
    assert.equal(spec.warnings.length, 1);
    assert.match(spec.warnings[0], /MODEL_SPEC_TEST_MISSING/);
  });
});
