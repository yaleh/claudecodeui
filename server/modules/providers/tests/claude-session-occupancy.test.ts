import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ClaudeSessionOccupiedError,
  findBackgroundSessionOwner,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';

/**
 * A conversation a Claude Code background job is running cannot be resumed, so
 * the resident launch asks the CLI's registry first.
 *
 * Each negative is paired with the positive control it is a one-field edit of —
 * the same row with `kind: "bg"`, a live pid and the matching session id — so a
 * `null` answer says which field made the row not count, and "no owner" can never
 * be satisfied by a reader that finds nothing at all.
 */
const SESSION_ID = '04fda72d-fe9a-4e39-8746-16a221a8301a';

async function withRegistry(
  run: (input: { configDir: string; write: (name: string, row: unknown) => Promise<void>; livePid: number; liveProcStart: string }) => Promise<void>,
): Promise<void> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-occupancy-'));
  await mkdir(path.join(configDir, 'sessions'));
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const pid = child.pid as number;
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const liveProcStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    await run({
      configDir,
      livePid: pid,
      liveProcStart,
      write: (name, row) =>
        writeFile(path.join(configDir, 'sessions', name), typeof row === 'string' ? row : JSON.stringify(row)),
    });
  } finally {
    child.kill('SIGKILL');
    await rm(configDir, { recursive: true, force: true });
  }
}

test('a live background job holding the session is reported with the handle `claude stop` takes', async () => {
  await withRegistry(async ({ configDir, write, livePid, liveProcStart }) => {
    await write(`${livePid}.json`, {
      pid: livePid,
      sessionId: SESSION_ID,
      kind: 'bg',
      jobId: '04fda72d',
      procStart: liveProcStart,
      name: 'Meta-cc version check',
    });

    const owner = findBackgroundSessionOwner(configDir, SESSION_ID);
    assert.deepEqual(owner, { pid: livePid, jobId: '04fda72d', name: 'Meta-cc version check' });

    const message = new ClaudeSessionOccupiedError(owner!).message;
    assert.match(message, /claude stop 04fda72d/);
    assert.match(message, /fork/);
  });
});

test('rows that are not a live background job on this session do not count', async () => {
  await withRegistry(async ({ configDir, write, livePid, liveProcStart }) => {
    const base = { pid: livePid, sessionId: SESSION_ID, kind: 'bg', jobId: '04fda72d', procStart: liveProcStart };

    // This app's own resident processes register as `interactive`.
    await write('a.json', { ...base, kind: 'interactive' });
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID), null, 'interactive row');

    // Another conversation's job.
    await write('a.json', { ...base, sessionId: 'someone-else' });
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID), null, 'other session');

    // A pid that was recycled: alive, but not the process that wrote the row.
    await write('a.json', { ...base, procStart: `${liveProcStart}0` });
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID), null, 'recycled pid');

    // A row left by a process that is gone.
    await write('a.json', { ...base, pid: 2 ** 22 + 12345 });
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID), null, 'dead pid');

    // A malformed row must not hide a real owner written beside it.
    await write('a.json', '{not json');
    await write('b.json', base);
    assert.equal(findBackgroundSessionOwner(configDir, SESSION_ID)?.pid, livePid, 'malformed neighbour');

    // No provider session id (a brand-new conversation) and no registry at all.
    assert.equal(findBackgroundSessionOwner(configDir, null), null, 'no session id');
    assert.equal(findBackgroundSessionOwner(path.join(configDir, 'missing'), SESSION_ID), null, 'no registry');
  });
});
