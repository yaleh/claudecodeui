import fs from 'node:fs';

import { projectsDb } from '@/modules/database/index.js';

import { QUAY_COMMAND_TIMEOUT_MS, createQuayProcessRunner } from './quay-process.js';
import { createQuayRouter } from './quay.routes.js';
import { createQuayService, type QuayFileReader } from './quay.service.js';

/** How long a fetched snapshot stays fresh before a panel reopen spawns the CLI again. */
const SNAPSHOT_TTL_MS = 30_000;

/**
 * Production read-only filesystem adapter for the `.quay/` carrier files. Only
 * byte-range/whole-file reads are exposed; paths are joined under the project
 * root by the service, so a request can never name an arbitrary file.
 */
const quayFileReader: QuayFileReader = {
  size: async (filePath) => {
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  },
  readChunk: async (filePath, position, length) => {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  },
  readText: (filePath) => fs.promises.readFile(filePath, 'utf8'),
};

/** The single quay display service instance; also used by the projects module for Tier-1 detection. */
export const quayService = createQuayService({
  fileExists: (filePath) => fs.existsSync(filePath),
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  runCommand: createQuayProcessRunner(),
  readFile: quayFileReader,
  now: () => Date.now(),
  snapshotTtlMs: SNAPSHOT_TTL_MS,
  commandTimeoutMs: QUAY_COMMAND_TIMEOUT_MS,
});

/** Used by the server entrypoint to mount the authenticated read-only Quay endpoints. */
export const quayRoutes = createQuayRouter({ quayService });
