import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  isSelfAssignedSessionName,
  projectsDb,
  runMigrations,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  readTranscriptAgentName,
  residentPeerName,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

/**
 * Who owns a session's name: a human, Claude Code, or CloudCLI.
 *
 * The three cases here are the ones the app used to get wrong, and each is
 * stated as a *pair* so a passing run says which answer the row took rather than
 * only that it took one:
 *
 * - the address CloudCLI hands the CLI as `--name` must not outrank the
 *   `ai-title` of the session it was handed for — with the same fixture minus
 *   the `ai-title` as the positive control, so "the row shows the ai-title" can
 *   never be satisfied by a reader that simply always reads the ai-title;
 * - a name the user chose outranks both;
 * - the address itself must be a fixed point, because it is derived from a
 *   display name that the address is written back into.
 *
 * The fixtures are real transcript lines in a real temporary Claude home, driven
 * through the real synchronizer against a real temporary sqlite database, for
 * the reason `claude-session-title-mirror.test.ts` gives: a reader can agree
 * with the rule on a minimal object and still disagree on a file, and it is the
 * file that ships.
 */

const PROVIDER_SESSION_ID = 'claude-name-authority-1';
const TITLE = 'Archguard 架构分析';

/** One transcript line as Claude writes it: the id and cwd ride on every entry. */
const transcriptLine = (sessionId: string, cwd: string, event: Record<string, unknown>): string =>
  JSON.stringify({ sessionId, cwd, ...event });

/** The bookkeeping entries the CLI opens a transcript with, then the first prompt. */
const headLines = (sessionId: string, cwd: string, firstPrompt = 'first prompt'): string[] => [
  transcriptLine(sessionId, cwd, { type: 'mode', mode: 'normal' }),
  transcriptLine(sessionId, cwd, { type: 'permission-mode', permissionMode: 'default' }),
  transcriptLine(sessionId, cwd, {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: firstPrompt },
    uuid: 'msg-1',
    timestamp: '2026-07-10T00:00:00.000Z',
  }),
];

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-name-authority-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A temporary Claude home plus the workspace one transcript lives in. */
async function withClaudeHome(
  runTest: (context: { workspacePath: string; transcriptPath: string }) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-name-authority-home-'));
  const workspacePath = path.join(temporaryRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const claudeHome = path.join(temporaryRoot, '.claude');
  await mkdir(claudeHome, { recursive: true });
  // Empty, so the only naming source in play is the transcript under test.
  await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');
  const restoreHomeDir = patchHomeDir(temporaryRoot);

  try {
    await runTest({
      workspacePath,
      transcriptPath: path.join(workspacePath, `${PROVIDER_SESSION_ID}.jsonl`),
    });
  } finally {
    restoreHomeDir();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Registers the session the app is about to hand a transcript to, and answers
 * the id the app minted for it.
 *
 * That id is the anchor the address rule is built on — `--name` ends in its
 * first six characters — so every fixture below has to be built from the id the
 * row actually got rather than from a constant.
 */
const registerAppSession = (workspacePath: string, name?: string, nameSource?: 'manual'): string => {
  sessionsDb.createSession(
    PROVIDER_SESSION_ID,
    'claude',
    workspacePath,
    name,
    undefined,
    undefined,
    null,
    nameSource ?? 'derived',
  );
  const row = sessionsDb.getSessionByProviderSessionId(PROVIDER_SESSION_ID);
  assert.ok(row, 'the session the fixture registers must be readable back');
  return row.session_id;
};

/** The name the app would display for the session, and where it came from. */
const storedName = (): { name: string | null; source: string | null } => {
  const row = sessionsDb.getSessionByProviderSessionId(PROVIDER_SESSION_ID);
  return { name: row?.custom_name ?? null, source: row?.name_source ?? null };
};

// ---------------------------------------------------------------------------
// AC1: the ai-title outranks the address CloudCLI put on the session
// ---------------------------------------------------------------------------

test('a CloudCLI address does not outrank the ai-title of the session it was handed for', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      const appSessionId = registerAppSession(workspacePath);
      const address = `${residentPeerName(TITLE, appSessionId)}`;
      assert.ok(address, 'the fixture needs a derivable address');

      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          // The CLI writes `--name` back as the session's `agent-name`, so this
          // is exactly what a resident session's transcript holds after launch.
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'agent-name', agentName: address }),
          // A real title the session earned, which must win.
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: TITLE, source: 'ai' });
    });
  });
});

test('with no ai-title the address is what the session is called', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      const appSessionId = registerAppSession(workspacePath);
      const address = residentPeerName(TITLE, appSessionId);
      assert.ok(address, 'the fixture needs a derivable address');

      // The positive control for the case above: same fixture, no `ai-title`.
      // The reading has to move, or the first case was passing for a reason that
      // has nothing to do with the ladder.
      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'agent-name', agentName: address }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: address, source: 'self-assigned' });
    });
  });
});

test('an agent-name a real agent chose is still the top rung', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      registerAppSession(workspacePath);

      // The guard on the rule above: an `agent-name` that is not an address this
      // app minted must keep the rank it has always had. Without this the
      // simplest way to pass the two cases above would be to drop the `agent`
      // rung altogether.
      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, {
            type: 'agent-name',
            agentName: 'The Agent That Owns This',
          }),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: 'The Agent That Owns This', source: 'agent' });
    });
  });
});

// ---------------------------------------------------------------------------
// AC2: the name the user chose is not displaced
// ---------------------------------------------------------------------------

test('a name the user chose outranks both an agent-name and an ai-title', async () => {
  await withClaudeHome(async ({ workspacePath, transcriptPath }) => {
    await withIsolatedDatabase(async () => {
      registerAppSession(workspacePath, 'Restart Web Server', 'manual');

      await writeFile(
        transcriptPath,
        [
          ...headLines(PROVIDER_SESSION_ID, workspacePath),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, {
            type: 'agent-name',
            agentName: 'The Agent That Owns This',
          }),
          transcriptLine(PROVIDER_SESSION_ID, workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );

      await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.deepEqual(storedName(), { name: 'Restart Web Server', source: 'manual' });
    });
  });
});

// ---------------------------------------------------------------------------
// AC3: the address is a fixed point
// ---------------------------------------------------------------------------

test('the address is byte-identical however many launches folded into it', () => {
  const appSessionId = 'edb5ead0-1111-4222-8333-444455556666';
  const first = residentPeerName(TITLE, appSessionId);
  assert.strictEqual(first, 'archguard-架构分析-edb5ea');

  // A relaunch is handed the display name the previous launch produced. The
  // address it derives has to be the same string, or every restart grows the
  // name by another suffix — which is what the app used to do.
  assert.strictEqual(residentPeerName(first, appSessionId), first);
  assert.strictEqual(residentPeerName(`${first}-edb5ea`, appSessionId), first);
  assert.strictEqual(residentPeerName(`${first}-edb5ea-edb5ea`, appSessionId), first);
  assert.strictEqual(
    first!.split('edb5ea').length - 1,
    1,
    'the session id must appear exactly once in the address',
  );
});

test('a title that merely ends in six hex-looking letters is not peeled', () => {
  const appSessionId = 'aaaaaaaa-1111-2222-3333-444455556666';
  // `facade` is six hex-looking letters, so a shape-only peel would eat it and
  // hand two different sessions the same address.
  assert.strictEqual(residentPeerName('Fix the facade', appSessionId), 'fix-the-facade-aaaaaa');
});

// ---------------------------------------------------------------------------
// AC4: the readback is the newest registration, not the oldest
// ---------------------------------------------------------------------------

test('the agent-name read back is the last one written, not the first', async () => {
  await withClaudeHome(async ({ workspacePath }) => {
    const claudeHome = path.join(path.dirname(workspacePath), '.claude');
    const bucket = path.join(claudeHome, 'projects', 'bucket-for-authority');
    await mkdir(bucket, { recursive: true });
    const transcriptPath = path.join(bucket, `${PROVIDER_SESSION_ID}.jsonl`);

    // Three launches of the same session, each registering its own address; a
    // restart is exactly what the guard used to misread.
    await writeFile(
      transcriptPath,
      [
        headLines(PROVIDER_SESSION_ID, workspacePath).join('\n'),
        transcriptLine(PROVIDER_SESSION_ID, workspacePath, {
          type: 'agent-name',
          agentName: 'first-launch-aaaaaa',
        }),
        transcriptLine(PROVIDER_SESSION_ID, workspacePath, {
          type: 'agent-name',
          agentName: 'second-launch-bbbbbb',
        }),
        transcriptLine(PROVIDER_SESSION_ID, workspacePath, {
          type: 'agent-name',
          agentName: 'third-launch-cccccc',
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    assert.strictEqual(readTranscriptAgentName(claudeHome, PROVIDER_SESSION_ID), 'third-launch-cccccc');
  });
});

// ---------------------------------------------------------------------------
// AC5: the migration re-files polluted rows, and running it twice changes nothing
// ---------------------------------------------------------------------------

test('the migration re-files rows named after an address, and its second run is a no-op', async () => {
  await withClaudeHome(async ({ workspacePath }) => {
    await withIsolatedDatabase(async () => {
      // Two polluted rows of the kind an older build left behind: the address
      // accumulated twice, filed on the top rung. One session still has an
      // ai-title in its transcript; the other never had one.
      const withTitle = 'aaaaaaaa-1111-4222-8333-444455556666';
      const withoutTitle = 'bbbbbbbb-1111-4222-8333-444455556666';
      const titledTranscript = path.join(workspacePath, 'titled.jsonl');
      const untitledTranscript = path.join(workspacePath, 'untitled.jsonl');

      await writeFile(
        titledTranscript,
        [
          ...headLines('titled', workspacePath),
          transcriptLine('titled', workspacePath, { type: 'ai-title', aiTitle: TITLE }),
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(untitledTranscript, `${headLines('untitled', workspacePath).join('\n')}\n`, 'utf8');

      // `sessions` carries a foreign key onto `projects`, so the workspace the
      // rows point at has to exist before the rows do.
      projectsDb.createProjectPath(workspacePath);

      const insert = getConnection().prepare(
        `INSERT INTO sessions (session_id, provider, project_path, transcript_name, transcript_name_source, jsonl_path, lifecycle_mode)
         VALUES (@sessionId, 'claude', @projectPath, @name, 'agent', @jsonlPath, 'per-run')`
      );
      insert.run({
        sessionId: withTitle,
        projectPath: workspacePath,
        name: `archguard-架构分析-aaaaaa-aaaaaa`,
        jsonlPath: titledTranscript,
      });
      insert.run({
        sessionId: withoutTitle,
        projectPath: workspacePath,
        name: `hello-there-bbbbbb-bbbbbb`,
        jsonlPath: untitledTranscript,
      });

      runMigrations(getConnection());

      const read = (sessionId: string) => {
        const row = getConnection()
          .prepare(`SELECT transcript_name AS name, transcript_name_source AS source FROM sessions WHERE session_id = ?`)
          .get(sessionId) as { name: string; source: string };
        return row;
      };

      // The title the transcript still carries is what the session was called;
      // the address is peeled back off, so it cannot seed the next launch.
      assert.deepEqual(read(withTitle), { name: 'archguard-架构分析', source: 'ai' });
      // No title to fall back on, so it belongs where an inferred name belongs.
      assert.deepEqual(read(withoutTitle), { name: 'hello-there', source: 'derived' });

      // Second run: every row has left the `agent`-plus-address combination the
      // predicate selects on, so this must change nothing at all.
      runMigrations(getConnection());

      assert.deepEqual(read(withTitle), { name: 'archguard-架构分析', source: 'ai' });
      assert.deepEqual(read(withoutTitle), { name: 'hello-there', source: 'derived' });
    });
  });
});

// ---------------------------------------------------------------------------
// The discriminator itself
// ---------------------------------------------------------------------------

test('the discriminator is anchored on the session it is asked about', () => {
  const appSessionId = 'edb5ead0-1111-2222-3333-444455556666';
  assert.strictEqual(isSelfAssignedSessionName('archguard-架构分析-edb5ea', appSessionId), true);
  assert.strictEqual(isSelfAssignedSessionName('archguard-架构分析-edb5ea-edb5ea', appSessionId), true);
  // An agent's own name, which happens to be six hex-looking letters but not
  // this session's id.
  assert.strictEqual(isSelfAssignedSessionName('Fix the facade', appSessionId), false);
  assert.strictEqual(isSelfAssignedSessionName('The Agent That Owns This', appSessionId), false);
});
