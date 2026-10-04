import { execFile } from 'node:child_process';

import type { QuayCommandResult, QuayCommandRunner } from './quay.service.js';

/**
 * Per-command subprocess bound. quay's read commands are JSON printers, but
 * `quay task list --json` is linear in the store size (it prints every task's
 * whole body): ~3 s against this bound on this workspace's own store.
 */
export const QUAY_COMMAND_TIMEOUT_MS = 8_000;

/**
 * Cap on captured CLI stdout, so one runaway command cannot exhaust the server's
 * memory.
 *
 * It has to sit well above the largest *real* payload rather than at it.
 * `quay task list --json` carries every task's full body (~10 KB per task), so
 * this workspace's own quay store (2,531 tasks) prints ~26 MB. Under the previous
 * 8 MiB cap `execFile` killed the child mid-string, `JSON.parse` failed on the
 * torn tail, and the service degraded the Task ledger to `null` — which the panel
 * then rendered as "0 tasks". The cap is therefore sized for a store an order of
 * magnitude larger than the one that broke it, not for the one that fits today.
 */
export const QUAY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Production subprocess adapter: runs one already-whitelisted quay argv and
 * captures its output. It uses `execFile` with an argument array and no shell, so
 * an argument can never be reinterpreted as shell syntax; the argv has been
 * matched against the service's read-only whitelist before it gets here.
 *
 * `command` and `leadingArgs` are the seam that lets
 * `server/modules/quay/tests/quay-process.test.ts` drive this adapter against a
 * stub emitter instead of the real CLI, so the buffer policy is asserted against
 * a payload the size of a production one. The composition root (`quay.module.ts`)
 * calls it with no arguments.
 */
export function createQuayProcessRunner(
  command = 'quay',
  leadingArgs: readonly string[] = [],
): QuayCommandRunner {
  return (cwd, args, { timeoutMs }) =>
    new Promise<QuayCommandResult>((resolve) => {
      execFile(
        command,
        [...leadingArgs, ...args],
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: QUAY_MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              ok: false,
              code: typeof error.code === 'number' ? error.code : null,
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              error: error.message,
            });
            return;
          }

          resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
}
