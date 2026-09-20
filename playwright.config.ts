import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { defineConfig } from '@playwright/test';

// Everything the servers persist lives under one throwaway directory so the run never touches real user data.
// Exported through the environment so worker processes (which re-evaluate this file) share the directory and the spec can put a project workspace inside it.
const dataDir = process.env.QUAY_E2E_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'quay-e2e-'));
/** True only in the process that created the directory: workers re-evaluate this file with it already set. */
const isDataDirOwner = !process.env.QUAY_E2E_DATA_DIR;
process.env.QUAY_E2E_DATA_DIR = dataDir;
const serverPort = 47101;
const clientPort = 47173;

/** Workspace e2e/session-filter.spec.ts creates its project in; its own directory so no other spec picks these sessions up. */
const SESSION_FILTER_WORKSPACE = path.join(dataDir, 'session-filter-workspace');
/** Names the filter spec's rule is written against — it re-declares them, and failing to see all of them is how a drift shows up. */
const SESSION_FILTER_SESSIONS = [
  'role-1-task-worker',
  'role-2-selector',
  'role-3-fix-worker',
  'role-4-task-worker',
  'human-alpha',
  'human-beta',
  'human-gamma',
];

/**
 * Seeds the transcripts e2e/session-filter.spec.ts filters on, here rather than from the spec itself.
 *
 * The backend scans ~/.claude/projects at boot and only then starts its file watcher with `ignoreInitial`.
 * Transcripts written while the test runs are therefore picked up by the watcher instead, which broadcasts a
 * session_upserted per file; each one lands on a session the browser is not viewing, which the sidebar
 * correctly reads as "needs attention" — and an attention-flagged session is deliberately kept visible under a
 * name filter. Writing them before the server boots means the boot scan indexes them and the watcher never
 * sees them at all, so the only session that earns an attention flag during the run is the one the spec flags
 * on purpose.
 *
 * Seeding must not happen in a worker: workers re-evaluate this file, so writing again there would land the
 * files on disk long after boot and hand the watcher exactly the storm this is avoiding.
 */
const seedSessionFilterTranscripts = () => {
  fs.mkdirSync(SESSION_FILTER_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'session-filter-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  for (const name of SESSION_FILTER_SESSIONS) {
    const sessionId = `e2e-${name}`;
    // The synchronizer reads sessionId and cwd from the first record it can parse and the display name from
    // the last custom-title event, so one transcript has to carry both.
    const records = [
      {
        type: 'user',
        sessionId,
        cwd: SESSION_FILTER_WORKSPACE,
        timestamp,
        message: { role: 'user', content: [{ type: 'text', text: `prompt for ${name}` }] },
      },
      { type: 'custom-title', sessionId, cwd: SESSION_FILTER_WORKSPACE, timestamp, customTitle: name },
    ];
    fs.writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
  }
};

if (isDataDirOwner) {
  seedSessionFilterTranscripts();
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx --tsconfig server/tsconfig.json server/index.ts',
      url: `http://127.0.0.1:${serverPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SERVER_PORT: String(serverPort),
        HOST: '127.0.0.1',
        DATABASE_PATH: path.join(dataDir, 'auth.db'),
        HOME: dataDir,
      },
    },
    {
      command: 'npx vite --host 127.0.0.1',
      url: `http://127.0.0.1:${clientPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SERVER_PORT: String(serverPort),
        VITE_PORT: String(clientPort),
        HOST: '127.0.0.1',
      },
    },
  ],
});
