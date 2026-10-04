import assert from 'node:assert/strict';
import test from 'node:test';

import { createQuayProcessRunner } from '../quay-process.js';

/**
 * The failure this guards, measured against the real Quay panel (2026-10-04):
 * `quay task list --json` prints every task's whole body, so its payload is
 * linear in the store — this workspace's own quay store (2,531 tasks) prints
 * ~26 MB. At the adapter's previous 8 MiB `maxBuffer` the child was killed
 * mid-string, the service got a stdout torn in the middle of a JSON string,
 * `JSON.parse` threw, and the Task ledger degraded to `null` — which the panel
 * rendered as "0 tasks · 0 ready · 0 needs human · 0 done".
 *
 * The emitter prints a little more than that old cap, so a buffer policy lowered
 * back below a real store's payload fails here instead of silently in the panel.
 */
const OVER_OLD_CAP_BYTES = 9 * 1024 * 1024;

/** A stub CLI: emits one JSON document whose payload exceeds the old 8 MiB cap. */
const LARGE_PAYLOAD_EMITTER =
  `process.stdout.write(JSON.stringify({ pad: 'x'.repeat(${OVER_OLD_CAP_BYTES}) }))`;

test('the quay process adapter captures a payload larger than the old 8 MiB cap', async () => {
  // `leadingArgs` turns `node` into the stub CLI; the whitelisted argv the service
  // would pass is appended after it, exactly as it is for the real command.
  const runner = createQuayProcessRunner(process.execPath, ['-e', LARGE_PAYLOAD_EMITTER]);

  const result = await runner(process.cwd(), ['task', 'list', '--json'], { timeoutMs: 30_000 });

  assert.equal(result.error, undefined, `expected a clean run, got: ${result.error ?? ''}`);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  // Not merely "untruncated by luck": the payload round-trips through JSON.parse,
  // which is the step that failed on the torn stdout.
  const parsed = JSON.parse(result.stdout) as { pad: string };
  assert.equal(parsed.pad.length, OVER_OLD_CAP_BYTES);
});
