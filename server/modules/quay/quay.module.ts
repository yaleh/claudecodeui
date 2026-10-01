import { execFile } from 'node:child_process';
import fs from 'node:fs';

import { projectsDb } from '@/modules/database/index.js';

import { createQuayRouter } from './quay.routes.js';
import { createQuayService, type QuayCommandResult } from './quay.service.js';

/** How long a fetched snapshot stays fresh before a panel reopen spawns the CLI again. */
const SNAPSHOT_TTL_MS = 30_000;

/** Per-command subprocess bound; quay read commands are fast JSON printers. */
const COMMAND_TIMEOUT_MS = 8_000;

/** Cap on captured CLI output so a runaway command cannot exhaust the server's memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Production subprocess adapter. Uses `execFile` with an argument array and no
 * shell, so an argument can never be reinterpreted as shell syntax; the argv has
 * already been matched against the service's read-only whitelist before it gets
 * here.
 */
function runQuayProcess(
  cwd: string,
  args: readonly string[],
  { timeoutMs }: { timeoutMs: number },
): Promise<QuayCommandResult> {
  return new Promise((resolve) => {
    execFile(
      'quay',
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
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

/** The single quay display service instance; also used by the projects module for Tier-1 detection. */
export const quayService = createQuayService({
  fileExists: (filePath) => fs.existsSync(filePath),
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  runCommand: runQuayProcess,
  now: () => Date.now(),
  snapshotTtlMs: SNAPSHOT_TTL_MS,
  commandTimeoutMs: COMMAND_TIMEOUT_MS,
});

/** Used by the server entrypoint to mount the authenticated read-only Quay endpoints. */
export const quayRoutes = createQuayRouter({ quayService });
