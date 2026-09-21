import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
import { userPreferencesDb } from '@/modules/database/repositories/user-preferences.db.js';
import { voiceSettingsDb } from '@/modules/database/repositories/voice-settings.db.js';
import type { VoiceSettings } from '@/shared/types.js';

/**
 * The settings a user saved against their own OpenAI-compatible backend. These
 * used to live in browser localStorage, so the upgrade path matters as much as
 * the fresh-install path: an install that predates this table has to gain it on
 * the next start without disturbing anything else it already holds.
 */

const SAMPLE_SETTINGS: VoiceSettings = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'sk-sentinel-groq-key',
  sttModel: 'whisper-large-v3',
  ttsModel: 'playai-tts',
  ttsVoice: 'Arista-PlayAI',
  ttsFormat: 'mp3',
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'voice-settings-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

function tableNames(): string[] {
  return (
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

/** Row count per application table, so "the upgrade did not disturb anything" is checkable. */
function rowCounts(): Record<string, number> {
  return Object.fromEntries(
    tableNames()
      .filter((name) => !name.startsWith('sqlite_'))
      .map((name) => [
        name,
        (
          getConnection().prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {
            count: number;
          }
        ).count,
      ])
  );
}

function createUser(id: number, username: string): void {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
}

test('a freshly created database carries an empty user_voice_settings table', async () => {
  await withIsolatedDatabase(() => {
    assert.ok(
      tableNames().includes('user_voice_settings'),
      'a fresh database must create the user_voice_settings table'
    );

    createUser(1, 'tester');
    assert.deepEqual(voiceSettingsDb.getSettings(1), {
      baseUrl: '',
      apiKey: '',
      sttModel: '',
      ttsModel: '',
      ttsVoice: '',
      ttsFormat: '',
    });
  });
});

test('an existing database gains the table on the next start without disturbing its rows', async () => {
  await withIsolatedDatabase(async () => {
    createUser(1, 'tester');
    userPreferencesDb.savePreferences(1, { theme: 'dark' });
    sessionDraftsDb.saveDraft(1, 'session-a', { text: 'half typed', queuedMessage: null });

    // Take the baseline after a second open, so nothing reset by an ordinary
    // start-up (row ids, timestamps) reads as damage done by this migration.
    closeConnection();
    await initializeDatabase();

    // The shape an install that predates the feature has on disk: no table.
    // Dropping it reproduces that state exactly, rather than approximating it.
    getConnection().exec('DROP TABLE user_voice_settings');
    assert.ok(!tableNames().includes('user_voice_settings'));

    const countsBefore = rowCounts();
    const preferencesBefore = userPreferencesDb.getPreferences(1);
    const draftsBefore = sessionDraftsDb.getDrafts(1);

    // The app starts again against that file; migrations run on open.
    closeConnection();
    await initializeDatabase();

    assert.ok(
      tableNames().includes('user_voice_settings'),
      'the upgrade must create the user_voice_settings table'
    );
    assert.deepEqual(
      rowCounts(),
      { ...countsBefore, user_voice_settings: 0 },
      'no other table may gain or lose a row across the upgrade'
    );
    assert.deepEqual(userPreferencesDb.getPreferences(1), preferencesBefore);
    assert.deepEqual(sessionDraftsDb.getDrafts(1), draftsBefore);

    // Reopening the upgraded database is a no-op, not a second rewrite.
    closeConnection();
    await initializeDatabase();

    assert.deepEqual(rowCounts(), { ...countsBefore, user_voice_settings: 0 });
    assert.ok(tableNames().includes('user_voice_settings'));
  });
});

test('saving settings twice for one user upserts rather than appending', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'tester');

    voiceSettingsDb.saveSettings(1, SAMPLE_SETTINGS);
    voiceSettingsDb.saveSettings(1, { ...SAMPLE_SETTINGS, apiKey: 'sk-rotated', ttsVoice: 'alloy' });

    assert.deepEqual(voiceSettingsDb.getSettings(1), {
      ...SAMPLE_SETTINGS,
      apiKey: 'sk-rotated',
      ttsVoice: 'alloy',
    });
    assert.equal(
      (
        getConnection()
          .prepare('SELECT COUNT(*) AS count FROM user_voice_settings WHERE user_id = 1')
          .get() as { count: number }
      ).count,
      1,
      'a second save must replace the row, not add one'
    );
  });
});

test('a field the stored document does not carry reads back as unset', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'tester');

    // Simulates a row written by an older build with fewer fields, or one whose
    // JSON has been edited by hand: neither may take the other five away.
    getConnection()
      .prepare("INSERT INTO user_voice_settings (user_id, settings_json) VALUES (?, ?)")
      .run(1, JSON.stringify({ baseUrl: 'https://voice.example/v1', apiKey: 12 }));

    assert.deepEqual(voiceSettingsDb.getSettings(1), {
      baseUrl: 'https://voice.example/v1',
      apiKey: '',
      sttModel: '',
      ttsModel: '',
      ttsVoice: '',
      ttsFormat: '',
    });
  });
});

test('deleting a user cascades to their voice settings', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'tester');
    voiceSettingsDb.saveSettings(1, SAMPLE_SETTINGS);

    getConnection().prepare('DELETE FROM users WHERE id = ?').run(1);

    assert.equal(
      (
        getConnection()
          .prepare('SELECT COUNT(*) AS count FROM user_voice_settings WHERE user_id = 1')
          .get() as { count: number }
      ).count,
      0,
      'the settings row must not outlive the user it belongs to'
    );
  });
});

test('two users never see each other’s settings', async () => {
  await withIsolatedDatabase(() => {
    createUser(1, 'first');
    createUser(2, 'second');

    voiceSettingsDb.saveSettings(1, SAMPLE_SETTINGS);

    assert.deepEqual(voiceSettingsDb.getSettings(2), {
      baseUrl: '',
      apiKey: '',
      sttModel: '',
      ttsModel: '',
      ttsVoice: '',
      ttsFormat: '',
    });

    voiceSettingsDb.saveSettings(2, { ...SAMPLE_SETTINGS, baseUrl: '', apiKey: 'sk-second' });

    assert.deepEqual(voiceSettingsDb.getSettings(1), SAMPLE_SETTINGS);
    assert.equal(voiceSettingsDb.getSettings(2).apiKey, 'sk-second');
    assert.equal(voiceSettingsDb.getSettings(2).baseUrl, '');
  });
});
