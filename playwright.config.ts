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

/** Workspace e2e/transcript-follow.spec.ts opens; its own directory so no other spec picks this session up. */
const TRANSCRIPT_FOLLOW_WORKSPACE = path.join(dataDir, 'transcript-follow-workspace');
/** Session id that spec addresses, and the display name it looks its sidebar row up by. */
const TRANSCRIPT_FOLLOW_SESSION_ID = 'e2e-transcript-follow';
const TRANSCRIPT_FOLLOW_SESSION_NAME = 'transcript-follow';
/**
 * Turns the seeded transcript carries. Long enough to be many screens tall — the spec scrolls it for real in
 * both directions — and within ChatMessagesPane's 30-row initial-mount band, so every row starts with its
 * real height instead of a placeholder estimate and the geometry does not settle underneath the test.
 */
const TRANSCRIPT_FOLLOW_TURNS = 24;

/**
 * Seeds the transcript e2e/transcript-follow.spec.ts measures, here rather than from the spec itself.
 *
 * Same reason as the filter spec's: the backend scans ~/.claude/projects at boot and only then starts its
 * file watcher with `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher
 * and broadcast as a session_upserted instead.
 *
 * The bodies are plain paragraphs on purpose — no code blocks, no images, nothing that highlights or loads
 * asynchronously — because that spec asserts on pixel geometry, and a late reflow would move it.
 */
const seedTranscriptFollowTranscript = () => {
  fs.mkdirSync(TRANSCRIPT_FOLLOW_WORKSPACE, { recursive: true });
  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'transcript-follow-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });

  const startedAt = Date.now();
  const records: Record<string, unknown>[] = [];
  let parentUuid: string | null = null;
  for (let turn = 0; turn < TRANSCRIPT_FOLLOW_TURNS; turn += 1) {
    // Even counts of turns, so the last message row is an assistant row.
    const role = turn % 2 === 0 ? 'user' : 'assistant';
    const uuid = `e2e-transcript-follow-turn-${turn}`;
    records.push({
      type: role,
      uuid,
      parentUuid,
      sessionId: TRANSCRIPT_FOLLOW_SESSION_ID,
      cwd: TRANSCRIPT_FOLLOW_WORKSPACE,
      timestamp: new Date(startedAt + turn * 60_000).toISOString(),
      message: {
        role,
        content: [{
          type: 'text',
          text: `Turn ${turn}. ${'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt. '.repeat(8)}`,
        }],
      },
    });
    parentUuid = uuid;
  }
  records.push({
    type: 'custom-title',
    sessionId: TRANSCRIPT_FOLLOW_SESSION_ID,
    cwd: TRANSCRIPT_FOLLOW_WORKSPACE,
    timestamp: new Date(startedAt + TRANSCRIPT_FOLLOW_TURNS * 60_000).toISOString(),
    customTitle: TRANSCRIPT_FOLLOW_SESSION_NAME,
  });

  fs.writeFileSync(
    path.join(transcriptDir, `${TRANSCRIPT_FOLLOW_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

if (isDataDirOwner) {
  seedSessionFilterTranscripts();
  seedTranscriptFollowTranscript();
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
