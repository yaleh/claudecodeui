import { getConnection } from '@/modules/database/connection.js';
import type { VoiceSettings } from '@/shared/types.js';

type VoiceSettingsRow = {
  settings_json: string;
};

/**
 * Every field of a settings document, in one place so readers and writers agree.
 *
 * WHY THE FOUR PROVIDER-OWNED FIELDS ARE LISTED HERE TOO. This array is what `decodeSettings` reads
 * a stored document through, so a field missing from it is silently DROPPED on the way back out —
 * a user would save a workspace address and their key, read the document back, and find both gone,
 * with nothing anywhere reporting it. The list is therefore exhaustive over `VoiceSettings` and not
 * over "the fields this module happens to care about", and adding a field to the type without
 * adding it here is a bug this file is arranged to make visible rather than quiet.
 */
const VOICE_SETTINGS_FIELDS = [
  'baseUrl',
  'apiKey',
  'sttModel',
  'ttsModel',
  'ttsVoice',
  'ttsFormat',
  'providerId',
  'dashscopeEndpoint',
  'dashscopeApiKey',
  'dashscopeModel',
] as const satisfies readonly (keyof VoiceSettings)[];

/**
 * What a user who has never saved voice settings reads back as.
 *
 * The provider-owned fields are present and empty here for the same reason the six are: a document
 * that omits them and one that carries the empty string mean the same thing to every reader, and
 * having exactly one shape cross the wire is what lets a client compare whole documents.
 */
const EMPTY_VOICE_SETTINGS: VoiceSettings = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
};

/**
 * Coerces one stored document into a complete `VoiceSettings`.
 *
 * A row written by an older or newer build may be missing fields or hold
 * non-strings; both are read as "unset" rather than failing the request, so a
 * single bad field can never cost the user the rest of their configuration.
 */
function decodeSettings(raw: string): VoiceSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[VoiceSettings] Dropping unreadable settings document');
    return { ...EMPTY_VOICE_SETTINGS };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...EMPTY_VOICE_SETTINGS };
  }

  const source = parsed as Record<string, unknown>;
  const settings = { ...EMPTY_VOICE_SETTINGS };
  for (const field of VOICE_SETTINGS_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') {
      settings[field] = value;
    }
  }

  return settings;
}

/**
 * Reads and writes the per-user Voice backend settings table.
 *
 * Used by the Voice module to serve `GET`/`PUT /api/voice/config`; the values it
 * returns are the ones the browser later calls its own backend with, so this
 * repository never sends a request of its own.
 */
export const voiceSettingsDb = {
  /** Returns the user's stored settings, or the all-empty set when none are stored. */
  getSettings(userId: number): VoiceSettings {
    const row = getConnection()
      .prepare('SELECT settings_json FROM user_voice_settings WHERE user_id = ?')
      .get(userId) as VoiceSettingsRow | undefined;

    return row ? decodeSettings(row.settings_json) : { ...EMPTY_VOICE_SETTINGS };
  },

  /**
   * Replaces the user's settings document as a whole.
   *
   * One row per user, so this is a plain upsert: there is no partial-update
   * shape to reconcile, and a caller that intends to change one field reads the
   * document first and writes the whole of it back.
   */
  saveSettings(userId: number, settings: VoiceSettings): void {
    getConnection()
      .prepare(
        `INSERT INTO user_voice_settings (user_id, settings_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           settings_json = excluded.settings_json,
           updated_at = CURRENT_TIMESTAMP`
      )
      .run(userId, JSON.stringify(settings));
  },
};
