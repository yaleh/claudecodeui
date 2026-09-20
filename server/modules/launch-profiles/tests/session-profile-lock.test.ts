import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { resolveSessionProfileLock } from '@/modules/launch-profiles/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'profile-lock-session';

type Frame = Record<string, unknown>;

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Frame[];
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Frame);
  return socket;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

/** Drives the real chat gateway over a temp sqlite; the stub runtime records options and completes. */
async function withGateway(
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: Array<Record<string, unknown>>;
    completed: () => number;
    send: (launchProfileId?: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'profile-lock-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: Array<Record<string, unknown>> = [];
  let completes = 0;
  const socket = createFakeSocket();
  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Lock session', now, now, null as never);
    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async (
            _provider: string,
            _command: string,
            options: Record<string, unknown>,
            writer: { send: (message: unknown) => void },
          ) => {
            runs.push(options);
            writer.send({ kind: 'complete', sessionId: SESSION_ID, exitCode: 0 });
            completes += 1;
          },
        } as never,
      },
    );

    const send = async (launchProfileId?: string) => {
      socket.emit('message', JSON.stringify({
        type: 'chat.send',
        sessionId: SESSION_ID,
        content: 'hi',
        options: launchProfileId === undefined ? {} : { launchProfileId },
      }));
      await settle();
    };
    await runTest({ socket, runs, completed: () => completes, send });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('a locked session keeps its stored profile and reports profileLocked without erroring', async () => {
  await withGateway(async ({ socket, runs, completed, send }) => {
    await send('profile-a');
    assert.strictEqual(sessionsDb.getSessionLaunchProfileId(SESSION_ID), 'profile-a');
    assert.strictEqual(socket.frames.some((frame) => frame.profileLocked === true), false);

    await send('profile-b');

    assert.strictEqual(runs.length, 2);
    assert.strictEqual(runs[0].launchProfileId, 'profile-a');
    assert.strictEqual(runs[1].launchProfileId, 'profile-a');
    assert.strictEqual(sessionsDb.getSessionLaunchProfileId(SESSION_ID), 'profile-a');

    const lockedFrames = socket.frames.filter((frame) => frame.profileLocked === true);
    assert.strictEqual(lockedFrames.length, 1);
    assert.strictEqual(lockedFrames[0].launchProfileId, 'profile-a');

    assert.strictEqual(socket.frames.filter((frame) => frame.kind === 'protocol_error').length, 0);
    assert.strictEqual(socket.frames.filter((frame) => frame.kind === 'error').length, 0);
    assert.strictEqual(completed(), 2);
    assert.strictEqual(socket.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('the same id or no id does not report profileLocked', async () => {
  await withGateway(async ({ socket, runs, send }) => {
    await send('profile-a');
    await send('profile-a');
    await send();

    assert.strictEqual(runs.length, 3);
    assert.deepStrictEqual(runs.map((options) => options.launchProfileId), ['profile-a', 'profile-a', 'profile-a']);
    assert.strictEqual(socket.frames.some((frame) => frame.profileLocked === true), false);
  });
});

test('resolveSessionProfileLock never throws and locks first', () => {
  assert.deepStrictEqual(resolveSessionProfileLock(null, 'a'), {
    effectiveId: 'a', shouldPersist: true, profileLocked: false,
  });
  assert.deepStrictEqual(resolveSessionProfileLock('a', 'b'), {
    effectiveId: 'a', shouldPersist: false, profileLocked: true,
  });
  assert.deepStrictEqual(resolveSessionProfileLock('a', undefined), {
    effectiveId: 'a', shouldPersist: false, profileLocked: false,
  });
  assert.doesNotThrow(() => resolveSessionProfileLock({}, 42));
});
