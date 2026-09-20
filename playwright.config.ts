import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { defineConfig } from '@playwright/test';

// Everything the servers persist lives under one throwaway directory so the run never touches real user data.
// Exported through the environment so worker processes (which re-evaluate this file) share the directory and the spec can put a project workspace inside it.
const dataDir = process.env.QUAY_E2E_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'quay-e2e-'));
process.env.QUAY_E2E_DATA_DIR = dataDir;
const serverPort = 47101;
const clientPort = 47173;

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
