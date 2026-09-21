import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { defineConfig } from '@playwright/test';

// Everything the servers persist lives under one throwaway directory so the run never touches real user data.
// Exported through the environment so worker processes (which re-evaluate this file) share the directory and the spec can put a project workspace inside it.
const dataDir = process.env.QUAY_E2E_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'quay-e2e-'));
/** True only in the process that created the directory: workers re-evaluate this file with it already set. */
const isDataDirOwner = !process.env.QUAY_E2E_DATA_DIR;
process.env.QUAY_E2E_DATA_DIR = dataDir;

/**
 * Asks the kernel for two free TCP ports, held at the same time so it cannot hand back the same one twice,
 * and releases them on the way out.
 *
 * The ports cannot be literals. A port is a machine-wide resource, not a checkout-wide one: with two fixed
 * numbers, any second e2e run — another spec in a sibling worktree, another agent, the fleet's own re-runs —
 * races this one for the same pair, and the loser dies during server boot with "is already used" instead of
 * reporting anything about the code under test. One kernel-assigned pair per run gives each run its own.
 *
 * `listen(0)` is asynchronous and Playwright evaluates this file synchronously, so the lookup runs in a
 * short-lived child process. Closing before the webServer binds leaves a window that is small and, without
 * handing Playwright a listening socket it cannot accept, unavoidable.
 */
const freePortPair = (): [number, number] => {
  const stdout = execFileSync(
    process.execPath,
    [
      '-e',
      `const net = require('node:net');
const listen = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
(async () => {
  const first = await listen();
  const second = await listen();
  process.stdout.write([first.address().port, second.address().port].join(' '));
  await Promise.all([first, second].map((server) => new Promise((done) => server.close(done))));
})().catch((error) => { console.error(error.message); process.exit(1); });`,
    ],
    { encoding: 'utf8' },
  );
  const [serverPort, clientPort] = stdout.trim().split(/\s+/).map(Number);
  return [serverPort, clientPort];
};

/**
 * Workers re-evaluate this file, and `baseURL` is read there — so the pair has to travel through the
 * environment like `dataDir` does, or a worker would address a server nobody started. Only the process that
 * allocated publishes it, and only that process announces it.
 */
const chosePorts = process.env.QUAY_E2E_SERVER_PORT === undefined;
const [serverPort, clientPort] = chosePorts
  ? freePortPair()
  : [Number(process.env.QUAY_E2E_SERVER_PORT), Number(process.env.QUAY_E2E_CLIENT_PORT)];
process.env.QUAY_E2E_SERVER_PORT = String(serverPort);
process.env.QUAY_E2E_CLIENT_PORT = String(clientPort);
if (chosePorts) {
  // On stdout rather than in a log file: it lands in the run's own captured output, so a red recorded from
  // this run can be read back as "which pair did it hold", which the stderr-head excerpt cannot answer.
  console.log(`[e2e] server=${serverPort} client=${clientPort}`);
}

/**
 * Reports which of `ports` cannot be bound right now. Runs in a child process for the same reason
 * `freePortPair` does: `listen` is asynchronous and this file is evaluated synchronously.
 */
const findTakenPorts = (ports: number[]): number[] => {
  const stdout = execFileSync(
    process.execPath,
    [
      '-e',
      `const net = require('node:net');
const probe = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(port));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(0)));
});
(async () => {
  const taken = (await Promise.all([${ports.join(', ')}].map(probe))).filter(Boolean);
  process.stdout.write(taken.join(' '));
})().catch((error) => { console.error(error.message); process.exit(1); });`,
    ],
    { encoding: 'utf8' },
  );
  return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
};

/**
 * Refuses to hand Playwright ports this run cannot bind, before it is given them.
 *
 * Playwright asks each webServer URL whether something is already serving it *before* it spawns the command,
 * and that probe has no deadline and no timeout of its own: a listener that accepts the connection but never
 * answers makes the check wait forever. The run then never reaches `webServer.timeout` below, never exits, and
 * a watchdog that caps the criterion at 60s kills it as an unattributable timeout — leaving the servers it did
 * start holding their ports into the next run. Binding each port once here turns the same condition into an
 * immediate failure that names the port, which is what a red run has to say to be actionable.
 *
 * Only the process that is about to start the servers probes. Workers re-evaluate this file long after both
 * are listening, so a probe there would report the run's own servers as the conflict; the flag rides the same
 * environment channel as `dataDir` and the port pair, which workers are already known to inherit.
 */
if (process.env.QUAY_E2E_PORTS_VERIFIED === undefined) {
  const taken = findTakenPorts([serverPort, clientPort]);
  if (taken.length > 0) {
    throw new Error(
      `e2e port(s) ${taken.join(', ')} are already in use by another process, so this run's servers cannot bind them. `
        + 'Failing now, naming the port, rather than waiting on a health check that has no deadline.',
    );
  }
  process.env.QUAY_E2E_PORTS_VERIFIED = '1';
}

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

/** Workspace e2e/voice-identifier-repair.spec.ts records into; its own directory so no other spec picks this session up. */
const VOICE_IDENTIFIER_WORKSPACE = path.join(dataDir, 'voice-identifier-workspace');
/** Session id that spec opens the composer in, and the display name it looks its sidebar row up by. */
const VOICE_IDENTIFIER_SESSION_ID = 'e2e-voice-identifier';
const VOICE_IDENTIFIER_SESSION_NAME = 'voice-identifier';
/**
 * The project file the utterance names, written into the seeded workspace.
 *
 * The spec does not carry this name as a literal: it lists the workspace and takes the name it finds there, so
 * the identifier it asserts on is one the project really has. A `## Touches`-level constant on both sides
 * would agree with itself whether or not the file exists.
 */
const VOICE_IDENTIFIER_FILE = 'voice.service.ts';
/** What the fake microphone is saying. The recogniser stand-in the spec points the voice settings at answers with this same string. */
const VOICE_UTTERANCE = `please open ${VOICE_IDENTIFIER_FILE} and fix the proxy`;
/**
 * Where the fake microphone reads its samples from, published so the spec's launch args can name the file.
 * Written below, in the config, because Chromium opens it at browser launch — a spec that wrote it in
 * `beforeAll` would be writing it after the browser that is meant to play it already exists.
 */
const VOICE_AUDIO_FILE = path.join(dataDir, 'voice-utterance.wav');
process.env.QUAY_E2E_VOICE_UTTERANCE = VOICE_UTTERANCE;
process.env.QUAY_E2E_VOICE_AUDIO = VOICE_AUDIO_FILE;

/**
 * Writes the audio the fake microphone plays as a 16-bit PCM WAV.
 *
 * There is no offline speech-to-text in this checkout, so the utterance cannot be a recording of a person
 * saying the identifier; what can be real is the *path*. Chromium decodes this file and hands the samples to
 * `getUserMedia`, the app's own `MediaRecorder` encodes what it hears, and the browser uploads those bytes —
 * so the recording the recogniser stand-in receives is produced by the real capture chain, not by the test.
 *
 * The waveform is derived character by character from the text it stands for, so the spoken fixture and the
 * answer the stand-in gives are two encodings of one utterance rather than two unrelated constants. It is
 * deliberately not a single tone: `MediaRecorder` has to produce a container whose bytes are worth uploading,
 * and a file whose audio is one unbroken sine is the one signal a broken capture chain also produces.
 */
const writeVoiceUtterance = (filePath: string, text: string): void => {
  const sampleRate = 48_000;
  const samples: number[] = [];

  const silence = (ms: number) => {
    samples.push(...new Array<number>(Math.round((ms / 1000) * sampleRate)).fill(0));
  };
  const burst = (frequency: number, ms: number) => {
    const count = Math.round((ms / 1000) * sampleRate);
    for (let index = 0; index < count; index += 1) {
      // A raised-sine envelope at both ends: a burst that starts and stops at full amplitude clicks, and a
      // click is broadband noise the encoder has to spend bytes on.
      const envelope = Math.sin((Math.PI * index) / count);
      samples.push(Math.round(0.4 * envelope * Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 32767));
    }
  };

  for (const character of text) {
    if (character === ' ') {
      silence(70);
      continue;
    }
    // A per-character pitch, so the file's spectrum really depends on the utterance it stands for.
    burst(200 + ((character.codePointAt(0) ?? 0) % 18) * 24, 55);
    silence(6);
  }
  silence(200);

  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }

  fs.writeFileSync(filePath, buffer);
};

/**
 * Seeds the workspace e2e/voice-identifier-repair.spec.ts records in.
 *
 * Same reason as the two above: the backend scans ~/.claude/projects at boot and only then starts its file
 * watcher with `ignoreInitial`, so a transcript written while the test runs is picked up by the watcher and
 * broadcast as a session_upserted instead — which the sidebar correctly reads as "needs attention".
 *
 * It also writes the file the utterance names. That is what makes "the project's real file name" checkable:
 * the spec reads the name back off the disk rather than restating it, so a fixture that stopped writing this
 * file would fail the criterion instead of quietly agreeing with it.
 *
 * The WAV is written here too, and for the same class of reason: it has to exist before the browser that
 * plays it is launched, and this function runs once, in the process that owns the data directory, before
 * `webServer` starts anything.
 */
const seedVoiceIdentifierWorkspace = () => {
  fs.mkdirSync(VOICE_IDENTIFIER_WORKSPACE, { recursive: true });
  fs.writeFileSync(
    path.join(VOICE_IDENTIFIER_WORKSPACE, VOICE_IDENTIFIER_FILE),
    '// Seeded by playwright.config.ts so the voice spec has a real project file to assert against.\n',
    'utf8',
  );
  writeVoiceUtterance(VOICE_AUDIO_FILE, VOICE_UTTERANCE);

  const transcriptDir = path.join(dataDir, '.claude', 'projects', 'voice-identifier-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  // The synchronizer reads the session id and cwd from the first record it can parse, so one transcript has to
  // carry both a turn and a title.
  const records = [
    {
      type: 'user',
      sessionId: VOICE_IDENTIFIER_SESSION_ID,
      cwd: VOICE_IDENTIFIER_WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the composer for the voice check' }] },
    },
    {
      type: 'custom-title',
      sessionId: VOICE_IDENTIFIER_SESSION_ID,
      cwd: VOICE_IDENTIFIER_WORKSPACE,
      timestamp,
      customTitle: VOICE_IDENTIFIER_SESSION_NAME,
    },
  ];

  fs.writeFileSync(
    path.join(transcriptDir, `${VOICE_IDENTIFIER_SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

if (isDataDirOwner) {
  seedSessionFilterTranscripts();
  seedTranscriptFollowTranscript();
  seedVoiceIdentifierWorkspace();
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  // Traces and failure contexts are written here. Under this run's own throwaway directory rather than the
  // shared `test-results/`, so two runs in one checkout stop overwriting each other's evidence (the loser of
  // that race used to fail at teardown on a directory the winner had already replaced).
  outputDir: path.join(dataDir, 'test-results'),
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  // Both ceilings are deliberately under the 60s a criterion may take: the goal gate that runs this command
  // kills it at 60s, and a run killed from outside reports nothing about why. A server that is spawned but
  // never answers therefore has to be given up on here, where the failure is still this run's to explain.
  // Boot costs ~8s on a loaded machine, so 30s is ~3x the observed worst case rather than a tight fit.
  webServer: [
    {
      command: 'npx tsx --tsconfig server/tsconfig.json server/index.ts',
      url: `http://127.0.0.1:${serverPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        SERVER_PORT: String(serverPort),
        HOST: '127.0.0.1',
        DATABASE_PATH: path.join(dataDir, 'auth.db'),
        HOME: dataDir,
      },
    },
    {
      // `--strictPort`: without it vite treats a taken port as a hint and silently serves on the next free one,
      // so the url checked below — the port the browser is sent to — would never answer and the run would sit
      // here until the ceiling instead of reporting the port. Strict, it fails at once and says which port.
      command: 'npx vite --host 127.0.0.1 --strictPort',
      url: `http://127.0.0.1:${clientPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        SERVER_PORT: String(serverPort),
        VITE_PORT: String(clientPort),
        HOST: '127.0.0.1',
      },
    },
  ],
});
