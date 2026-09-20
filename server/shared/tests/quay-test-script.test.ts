import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function runScript(args: string[]) {
  return spawnSync('bash', ['scripts/test.sh', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, QUAY_TEST_DRY: '1' },
  });
}

test('value-taking quay flags are consumed together with their values', () => {
  const result = runScript([
    '--buckets', 'x', '--root', '.', '--state-dir', '.quay', '--runner', 'inner',
    '--log-file', '/tmp/l', '--run-id', 'r', '--test-concurrency=2', '--unknown-flag',
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /concurrency=2, files=0/);
  assert.doesNotMatch(result.stderr, /Could not find/);
});

test('a positional test file that does not exist is an error, not a skip', () => {
  const result = runScript(['nonexistent.test.ts']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /test file not found/);
});

test('an existing positional test file is accepted', () => {
  const result = runScript(['server/shared/tests/quay-test-script.test.ts']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /files=1/);
});
