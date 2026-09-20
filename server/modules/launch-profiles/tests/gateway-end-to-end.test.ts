import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { launchProfilesService } from '@/modules/launch-profiles/index.js';
import { createProviderRuntimeService } from '@/modules/providers/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'gateway-e2e-session';
const KEY_VAR = 'FJDAC_API_KEY_E2E';
const PROFILE_ID = 'gateway-e2e-profile';

type Received = { url: string; authorization: string | undefined; apiKey: string | undefined };

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Minimal valid streaming `/v1/messages` reply. */
function messageStream(): string {
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

async function startMockAnthropic(): Promise<{ received: Received[]; baseUrl: string; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
      });
      if ((req.url ?? '').startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(messageStream());
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

/** Drives one real `chat.send` through the real Claude runtime and waits for the run to finish. */
let profileBaseUrl = '';

async function runChatSend(
  options: Record<string, unknown>,
  waitMs: number,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'gateway-e2e-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDirectory, 'claude-config');
  // The host default endpoint is a dead local port: a run that ignores the
  // profile can never reach the mock server.
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
  process.env.ANTHROPIC_API_KEY = 'host-default-key';
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  await initializeDatabase();
  const user = userDb.createUser('gateway-e2e', 'unused-hash');

  const socket = createFakeSocket();
  const runtime = createProviderRuntimeService();
  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Gateway session', now, now, null);
    // A brand-new conversation: the provider has not announced a native id yet, so the SDK starts fresh.
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(SESSION_ID);
    launchProfilesService.createProfile({
      id: PROFILE_ID,
      provider: 'claude',
      name: 'Gateway',
      description: null,
      deployment: 'gateway',
      isDefault: false,
      config: {
        baseUrl: profileBaseUrl,
        authMode: 'envVar',
        authEnvVarName: KEY_VAR,
        authEnvVarTarget: 'ANTHROPIC_AUTH_TOKEN',
        modelAliases: { haiku: 'mock-model', sonnet: 'mock-model', opus: 'mock-model' },
      },
    });

    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'hello',
      options: { cwd: tempDirectory, model: 'sonnet', permissionMode: 'default', ...options },
    }));

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !socket.frames.some((frame) => frame.kind === 'complete')) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  } finally {
    // A run that never reached an endpoint keeps retrying; stop it so no child outlives the test.
    await runtime.abort('claude', SESSION_ID).catch(() => false);
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    };
    restore('DATABASE_PATH', previousDatabasePath);
    restore('CLAUDE_CONFIG_DIR', previousConfigDir);
    restore('ANTHROPIC_BASE_URL', previousBaseUrl);
    restore('ANTHROPIC_AUTH_TOKEN', previousAuth);
    restore('ANTHROPIC_API_KEY', previousApiKey);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function messagesRequests(received: Received[]): Received[] {
  return received.filter((request) => request.url.startsWith('/v1/messages'));
}

test('gateway profile: chat.send reaches the mock endpoint with the env-var credential', { timeout: 180_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    for (const secret of ['test-secret-first', 'test-secret-second']) {
      process.env[KEY_VAR] = secret;
      mock.received.length = 0;
      profileBaseUrl = mock.baseUrl;
      await runChatSend({ launchProfileId: PROFILE_ID }, 60_000);

      const requests = messagesRequests(mock.received);
      assert.ok(requests.length >= 1, 'mock Anthropic server received at least one /v1/messages request');
      for (const request of requests) {
        assert.strictEqual(request.authorization, `Bearer ${secret}`);
      }
    }
  } finally {
    delete process.env[KEY_VAR];
    await mock.close();
  }
});

test('no profile: the mock receives nothing, proving the assertion goes red when the profile is not applied', { timeout: 180_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    process.env[KEY_VAR] = 'test-secret-unused';
    profileBaseUrl = mock.baseUrl;
    await runChatSend({}, 8_000);
    assert.strictEqual(mock.received.length, 0);
  } finally {
    delete process.env[KEY_VAR];
    await mock.close();
  }
});
