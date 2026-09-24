/**
 * The user's voice backend settings, loaded from and saved to the server.
 *
 * These were plain localStorage readers, which meant the API key sat in
 * plaintext browser storage and — because localStorage is per origin — was lost
 * the moment the app was opened on another port, device or profile. The server
 * is now the source of truth and this module keeps the single in-memory copy
 * that `shared/api.ts` and the Settings tab read synchronously.
 *
 * It is deliberately still synchronous to read: `transcribeVoice` and
 * `useVoiceAvailable` decide "call the user's own backend, or fall back to the
 * proxy" from `readVoiceConfig()`, and a promise they could not await would
 * make that decision from a half-loaded copy. Callers that are about to *send*
 * something wait on `whenVoiceConfigReady()` first.
 *
 * The key is still handed to the browser at runtime — the user's own backend is
 * called directly, so the browser has to hold the credential. What this module
 * removes is the key persisting in browser storage and the settings dying with
 * the origin.
 */

import { getStoredAuthToken } from '@/shared/authToken';
import { api } from '@/shared/api';

export type VoiceConfig = {
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  /**
   * The recogniser the user selected, and the fields that recogniser declared as its own.
   *
   * THEY ARE PART OF THIS DOCUMENT RATHER THAN A STORE OF THEIR OWN, and that is the whole
   * point: the settings are saved as ONE document (`flushServerWrite` sends the whole thing,
   * never a patch), so a field the client does not know about is a field the next save deletes —
   * the server reads an absent one as the empty string. Listing them here is what makes the
   * settings page's own writes preserve them, and it is the same reason the client has to know
   * the names at all: the form is what a user types them into.
   *
   * The three `dashscope*` names are the ones the recogniser in this checkout declares (see the
   * health payload's `credentialFields`), not a table the client keeps: which of them the form
   * shows is decided by the selected provider's own declaration. The names are fixed here because
   * the STORAGE is fixed here — one document, one set of columns — while the form is not.
   */
  providerId: string;
  dashscopeEndpoint: string;
  dashscopeApiKey: string;
  dashscopeModel: string;
};

/** The localStorage key the six fields lived under before they moved server-side. */
export const VOICE_CONFIG_STORAGE_KEY = 'voiceConfig';

/** Emitted on write, so open voice consumers re-read in the same tab. */
export const VOICE_CONFIG_SYNC_EVENT = 'voice-config:sync';

export const VOICE_CONFIG_DEFAULTS: VoiceConfig = {
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

const VOICE_CONFIG_FIELDS: readonly (keyof VoiceConfig)[] = [
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
];

/**
 * Long enough to collapse typing in the settings fields into one request,
 * short enough that closing the tab right after an edit rarely loses it.
 */
const SERVER_WRITE_DEBOUNCE_MS = 400;

let config: VoiceConfig = { ...VOICE_CONFIG_DEFAULTS };
let hasHydrated = false;
let hydrationRequest: Promise<void> | null = null;
/** Which session the in-memory copy belongs to, so a user switch can be noticed. */
let hydratedForToken: string | null = null;
let pendingWriteTimer: ReturnType<typeof setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/** Reads any loose value as a complete config, treating non-strings as unset. */
function coerceConfig(value: unknown): VoiceConfig {
  if (!isRecord(value)) {
    return { ...VOICE_CONFIG_DEFAULTS };
  }

  const next = { ...VOICE_CONFIG_DEFAULTS };
  for (const field of VOICE_CONFIG_FIELDS) {
    if (typeof value[field] === 'string') {
      next[field] = value[field];
    }
  }
  return next;
}

/** True when every field is blank — the shape a user who never saved anything sees. */
function isEmptyConfig(candidate: VoiceConfig): boolean {
  return VOICE_CONFIG_FIELDS.every((field) => !candidate[field].trim());
}

function readCurrentToken(): string | null {
  try {
    return getStoredAuthToken();
  } catch {
    // No localStorage (or an unreadable one): treat the session as unknown and
    // let hydration run; the request itself will decide what it gets.
    return null;
  }
}

function applyConfig(next: VoiceConfig): void {
  config = { ...next };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
  }
}

/**
 * Reads the pre-server `voiceConfig` key, or null when it is not there.
 *
 * A migration *source* only: this module never writes it back, which is what
 * guarantees no API key survives in browser storage once a load has succeeded.
 * A key holding anything other than an object is reported as present-but-empty
 * so the caller can delete it rather than keep re-reading it.
 */
function readLegacyVoiceConfig(): VoiceConfig | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(VOICE_CONFIG_STORAGE_KEY);
  } catch {
    return null;
  }

  if (raw === null) {
    return null;
  }

  try {
    return coerceConfig(JSON.parse(raw));
  } catch {
    return { ...VOICE_CONFIG_DEFAULTS };
  }
}

/** Removes the legacy key. Called only once its contents are safely on the server. */
function clearLegacyVoiceConfig(): void {
  try {
    localStorage.removeItem(VOICE_CONFIG_STORAGE_KEY);
  } catch {
    // The setting itself is already server-side; a locked-down localStorage must
    // not turn that into a failed request.
  }
}

/**
 * Reads the current settings.
 *
 * Returns its own object every time, because callers treat it as a value and a
 * shared reference would let one of them edit the live configuration.
 */
export function readVoiceConfig(): VoiceConfig {
  return { ...config };
}

/**
 * Whether `field` is one of the names this module stores.
 *
 * Exposed for the settings form, whose field names come from a provider's declaration rather than
 * from this type: a server whose registry declares a field this build does not store has to be
 * told apart from one declaring a field it does, because rendering an input whose edits are
 * dropped by the whole-document save is worse than not rendering it — the user would watch their
 * key disappear on the next reload with nothing to explain it.
 */
export function isVoiceConfigField(field: string): field is keyof VoiceConfig {
  return (VOICE_CONFIG_FIELDS as readonly string[]).includes(field);
}

/**
 * Reads one named field, for a caller whose field name came from a declaration.
 *
 * A name this module does not store reads as the empty string rather than as undefined, so a form
 * binding it renders an empty input instead of an uncontrolled one.
 */
export function readVoiceConfigField(candidate: VoiceConfig, field: string): string {
  const value = (candidate as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

/**
 * True once the server's copy has been read at least one time this session.
 *
 * Exposed so a caller can tell "the user configured nothing" apart from "the
 * answer has not arrived yet" without awaiting.
 */
export function hasHydratedVoiceConfig(): boolean {
  return hasHydrated;
}

/** Makes `value` the settings, and pushes the whole document to the server. */
function writeAndPersist(next: VoiceConfig): void {
  applyConfig(next);
  queueServerWrite();
}

/**
 * Applies a patch from the Settings tab and schedules the save.
 *
 * Only string fields are accepted, so a stray `undefined` from a partially
 * built patch cannot blank a field the user did not touch.
 */
export function updateVoiceConfig(patch: Partial<VoiceConfig>): void {
  const next = { ...config };
  for (const field of VOICE_CONFIG_FIELDS) {
    const value = patch[field];
    if (typeof value === 'string') {
      next[field] = value;
    }
  }
  writeAndPersist(next);
}

function queueServerWrite(): void {
  if (pendingWriteTimer !== null) {
    clearTimeout(pendingWriteTimer);
  }
  pendingWriteTimer = setTimeout(() => {
    pendingWriteTimer = null;
    void flushServerWrite();
  }, SERVER_WRITE_DEBOUNCE_MS);
}

async function flushServerWrite(): Promise<void> {
  const snapshot = { ...config };
  try {
    const response = await api.voice.saveConfig(snapshot);
    if (!response.ok) {
      // A refused save is not a saved setting. The in-memory copy is right and
      // the legacy key — if this was the migration's own write — stays behind so
      // a later load can retry it.
      console.error(`Failed to save voice settings (${response.status}).`);
      return;
    }
    // The values are server-side now, so the migration source is spent.
    clearLegacyVoiceConfig();
  } catch (error) {
    // The in-memory copy is already right, and the next edit re-sends the whole
    // document, so a dropped save costs this change rather than the setting.
    console.error('Failed to save voice settings:', error);
  }
}

/** Reads the server's copy, or null when the request did not produce one. */
async function loadServerConfig(): Promise<VoiceConfig | null> {
  try {
    const response = await api.voice.config();
    if (!response.ok) {
      return null;
    }
    return coerceConfig(await response.json());
  } catch (error) {
    console.error('Failed to load voice settings:', error);
    return null;
  }
}

/**
 * Adopts the server's copy as the source of truth, importing the legacy
 * localStorage key on the one load where the server has nothing yet.
 *
 * Never rejects: a failed hydration must degrade to "no server configuration",
 * not to a rejected promise on the voice-call path.
 */
async function runHydration(): Promise<void> {
  const serverConfig = await loadServerConfig();
  if (serverConfig === null) {
    // The server never answered. Whatever is in memory stays; the legacy key is
    // left alone so the next load can retry importing it.
    return;
  }

  if (!isEmptyConfig(serverConfig)) {
    // The server already knows this user's settings, so they win — including
    // over a legacy key on this device, which would otherwise push this
    // profile's older values over the ones saved somewhere else.
    clearLegacyVoiceConfig();
    applyConfig(serverConfig);
    return;
  }

  const legacyConfig = readLegacyVoiceConfig();
  if (legacyConfig === null) {
    applyConfig(serverConfig);
    return;
  }

  if (isEmptyConfig(legacyConfig)) {
    // Present but unusable (blank, or JSON that is not a settings object).
    clearLegacyVoiceConfig();
    applyConfig(serverConfig);
    return;
  }

  try {
    const response = await api.voice.saveConfig(legacyConfig);
    if (!response.ok) {
      throw new Error(`the server answered ${response.status}`);
    }
    clearLegacyVoiceConfig();
  } catch (error) {
    // The key stays behind so a later load can retry the import. The values are
    // still adopted in memory, so voice keeps working in the meantime.
    console.error('Failed to import legacy voice settings:', error);
  }
  applyConfig(legacyConfig);
}

/**
 * Loads the settings for the current session, at most one request at a time.
 *
 * Safe to call from anywhere and more than once: concurrent callers share the
 * in-flight request, and once it has settled the copy is only re-fetched when
 * the session it belongs to changes.
 */
export function hydrateVoiceConfig(): Promise<void> {
  if (hydrationRequest) {
    return hydrationRequest;
  }

  const token = readCurrentToken();
  const request = runHydration()
    .then(
      () => undefined,
      (error: unknown) => {
        console.error('Failed to hydrate voice settings:', error);
      },
    )
    .finally(() => {
      hydrationRequest = null;
      hasHydrated = true;
      hydratedForToken = token;
    });

  hydrationRequest = request;
  return request;
}

/**
 * Resolves once the settings for the session that is active *now* are loaded.
 *
 * A voice call awaits this before choosing between the user's own backend and
 * the proxy: reading an un-hydrated copy would look exactly like "no backend
 * configured" and quietly route the recording through the server instead of the
 * endpoint the user set up.
 *
 * A session change — a second user signing in on this tab, or the first one
 * signing out — discards the in-memory copy first, so nothing can read or send
 * the previous user's key while the new fetch is in flight.
 */
export function whenVoiceConfigReady(): Promise<void> {
  const token = readCurrentToken();
  if (hasHydrated && hydratedForToken === token) {
    return Promise.resolve();
  }

  if (hasHydrated) {
    applyConfig({ ...VOICE_CONFIG_DEFAULTS });
    hasHydrated = false;
  }

  return hydrateVoiceConfig();
}

/**
 * Drops the in-memory copy, so a different user on this device never starts out
 * holding the previous user's key. Awaited by nothing: the next
 * `whenVoiceConfigReady()` re-fetches for whoever is signed in.
 */
export function resetVoiceConfig(): void {
  if (pendingWriteTimer !== null) {
    clearTimeout(pendingWriteTimer);
    pendingWriteTimer = null;
  }
  config = { ...VOICE_CONFIG_DEFAULTS };
  hasHydrated = false;
  hydratedForToken = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
  }
}

// Headers the voice proxy reads to target a per-user OpenAI-compatible backend.
// Empty fields are omitted so the server's env defaults apply.
export function voiceConfigHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const c = readVoiceConfig();
  const h: Record<string, string> = {};
  if (c.apiKey) h['x-voice-api-key'] = c.apiKey;
  if (c.sttModel) h['x-voice-stt-model'] = c.sttModel;
  if (c.ttsModel) h['x-voice-tts-model'] = c.ttsModel;
  if (c.ttsVoice) h['x-voice-tts-voice'] = c.ttsVoice;
  if (c.ttsFormat.trim()) h['x-voice-tts-format'] = c.ttsFormat.trim();
  return h;
}
