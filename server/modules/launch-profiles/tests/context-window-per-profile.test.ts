import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCumulativeTokenBudget, extractTokenBudget } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { summarizeClaudeTokenUsage } from '@/modules/providers/services/provider-token-usage.service.js';

const assistant = { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } };
const result = { type: 'result', usage: { input_tokens: 10, output_tokens: 5 } };
const modelUsageResult = { type: 'result', modelUsage: { m: { inputTokens: 10, outputTokens: 5 } } };
const entries = [{ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }];

// Runs `fn` with CONTEXT_WINDOW set (or deleted) and restores it afterwards.
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.CONTEXT_WINDOW;
  if (value === undefined) delete process.env.CONTEXT_WINDOW; else process.env.CONTEXT_WINDOW = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.CONTEXT_WINDOW; else process.env.CONTEXT_WINDOW = previous;
  }
}

function totals(profileContextWindow?: number, env?: string): number[] {
  return withEnv(env, () => [
    extractTokenBudget(assistant, profileContextWindow)?.total,
    extractCumulativeTokenBudget(result, profileContextWindow)?.total,
    extractCumulativeTokenBudget(modelUsageResult, profileContextWindow)?.total,
    summarizeClaudeTokenUsage(entries, process.env.CONTEXT_WINDOW, profileContextWindow).total,
  ] as number[]);
}

test('profile.contextWindow wins over CONTEXT_WINDOW on every usage path', () => {
  assert.deepEqual(totals(12345, '99999'), [12345, 12345, 12345, 12345]);
});

test('unset profile contextWindow falls back to CONTEXT_WINDOW', () => {
  assert.deepEqual(totals(undefined, '54321'), [54321, 54321, 54321, 54321]);
});

test('no profile value and unset/invalid env falls back to 160000', () => {
  assert.deepEqual(totals(undefined, undefined), [160000, 160000, 160000, 160000]);
  assert.deepEqual(totals(undefined, 'abc'), [160000, 160000, 160000, 160000]);
});

test('fake-detection: a hard-read implementation (ignoring profile) fails the profile assertion', () => {
  const hardRead = (_profile: number | undefined, env: string | undefined) => Number.parseInt(env ?? '', 10) || 160000;
  const real = totals(12345, '99999')[0];
  assert.equal(real, 12345);
  assert.notEqual(hardRead(12345, '99999'), 12345);
});
