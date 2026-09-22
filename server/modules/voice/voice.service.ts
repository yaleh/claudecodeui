import type {
  VoiceRequestOverrides,
  VoiceService,
  VoiceServiceResult,
  VoiceSettings,
  VoiceSettingsService,
  VoiceSettingsStore,
  VoiceSpeechPayload,
} from '@/shared/types.js';

// The proxy path's request construction and response parsing live in the repository-root
// shared tree, the same module the browser and the CLI compile — see
// shared/asr/transcriptionWire.ts. A second copy here is what this import exists to prevent.
import { createTranscriptionRequest, parseTranscriptionResponse } from '../../../shared/asr/transcriptionWire.js';

type VoiceServiceDependencies = {
  defaults: {
    baseUrl: string;
    apiKey: string;
    sttModel: string;
    ttsModel: string;
    ttsVoice: string;
  };
  timeoutMs: number;
  fetchBackend(url: string, options: RequestInit): Promise<Response>;
};

type ResolvedVoiceConfig = VoiceServiceDependencies['defaults'] & {
  ttsFormat: string;
};

function resolveVoiceConfig(
  defaults: VoiceServiceDependencies['defaults'],
  overrides: VoiceRequestOverrides,
): ResolvedVoiceConfig {
  return {
    baseUrl: defaults.baseUrl,
    apiKey: overrides.apiKey || defaults.apiKey,
    sttModel: overrides.sttModel || defaults.sttModel,
    ttsModel: overrides.ttsModel || defaults.ttsModel,
    ttsVoice: overrides.ttsVoice || defaults.ttsVoice,
    ttsFormat: overrides.ttsFormat?.trim() ?? '',
  };
}

function validateBackendBaseUrl(baseUrl: string): boolean {
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return false;
    }

    // Local and private backends are supported intentionally. Only link-local
    // metadata addresses remain blocked as a defense in depth measure.
    return parsedUrl.hostname !== '169.254.169.254'
      && !parsedUrl.hostname.startsWith('169.254.');
  } catch {
    return false;
  }
}

function authorizationHeader(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function backendFailure(status: number, responseText?: string): VoiceServiceResult<never> {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status: 502,
      error: 'Voice backend rejected the request (check the API key).',
    };
  }

  return {
    ok: false,
    status,
    error: responseText || 'voice backend error',
  };
}

function unreachableBackendFailure(error: unknown, timeoutMs: number): VoiceServiceResult<never> {
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      ok: false,
      status: 504,
      error: `Voice backend timed out after ${Math.round(timeoutMs / 1000)}s. Check your voice backend.`,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    status: 502,
    error: `Voice backend unreachable: ${message}`,
  };
}

function validateConfiguredBackend(config: ResolvedVoiceConfig): VoiceServiceResult<never> | null {
  if (!config.baseUrl) {
    return { ok: false, status: 503, error: 'No voice backend configured' };
  }

  if (!validateBackendBaseUrl(config.baseUrl)) {
    return { ok: false, status: 400, error: 'Invalid voice backend URL.' };
  }

  return null;
}

/**
 * Creates the Voice application service used by the Voice composition root and
 * its unit tests. The outbound request function and server configuration are
 * required so the service never reads globals or creates production defaults.
 */
export function createVoiceService(dependencies: VoiceServiceDependencies): VoiceService {
  return {
    getHealth: () => ({ configured: Boolean(dependencies.defaults.baseUrl) }),

    async transcribe(input) {
      const config = resolveVoiceConfig(dependencies.defaults, input.overrides);
      const configurationFailure = validateConfiguredBackend(config);
      if (configurationFailure) {
        return configurationFailure;
      }

      try {
        // The bytes arrive as a Buffer; the wire takes a Blob, so the container and the
        // bytes are handed over together, exactly as the browser hands over its recording.
        const request = createTranscriptionRequest(
          { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.sttModel },
          {
            audio: new Blob([input.audio.bytes], { type: input.audio.mimeType }),
            fileName: input.audio.fileName,
          },
        );
        const response = await dependencies.fetchBackend(request.url, request.init);
        if (!response.ok) {
          return backendFailure(response.status, await response.text());
        }

        // Lenient on purpose, and named here rather than implied by living in this file:
        // the proxy path hands an unparseable body back as the transcript instead of
        // failing, which is the tolerance it had before this module existed. The body is
        // read once, here or in the branch above, never twice.
        return {
          ok: true,
          value: { text: await parseTranscriptionResponse(response, 'lenient') },
        };
      } catch (error) {
        return unreachableBackendFailure(error, dependencies.timeoutMs);
      }
    },

    async synthesizeSpeech(input) {
      const config = resolveVoiceConfig(dependencies.defaults, input.overrides);
      const configurationFailure = validateConfiguredBackend(config);
      if (configurationFailure) {
        return configurationFailure;
      }

      try {
        const response = await dependencies.fetchBackend(`${config.baseUrl}/audio/speech`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authorizationHeader(config.apiKey),
          },
          body: JSON.stringify({
            model: config.ttsModel,
            voice: config.ttsVoice,
            input: input.text,
            ...(config.ttsFormat ? { response_format: config.ttsFormat } : {}),
          }),
        });

        if (!response.ok) {
          const responseText = await response.text().catch(() => 'tts failed');
          return backendFailure(response.status, responseText);
        }

        const value: VoiceSpeechPayload = {
          contentType: response.headers.get('content-type') || 'audio/mpeg',
          body: response.body,
        };
        return { ok: true, value };
      } catch (error) {
        return unreachableBackendFailure(error, dependencies.timeoutMs);
      }
    },
  };
}

/** Every field of a settings document, so validation cannot miss one by accident. */
const VOICE_SETTINGS_FIELDS: readonly (keyof VoiceSettings)[] = [
  'baseUrl',
  'apiKey',
  'sttModel',
  'ttsModel',
  'ttsVoice',
  'ttsFormat',
];

/**
 * The longest value each field accepts. Generous for any real endpoint, key or
 * model name, and small enough that one request cannot park megabytes in the
 * settings row and have every later read pay for it.
 */
const VOICE_SETTINGS_MAX_LENGTHS: Record<keyof VoiceSettings, number> = {
  baseUrl: 2048,
  apiKey: 4096,
  sttModel: 256,
  ttsModel: 256,
  ttsVoice: 256,
  ttsFormat: 64,
};

/**
 * Reads one settings field from an untrusted body.
 *
 * Surrounding whitespace is stripped from every field including the key: a key
 * pasted with a trailing newline would otherwise be stored verbatim and fail
 * authentication later, with nothing on screen to explain why. A missing or
 * explicitly null field reads as the empty string, which is what the client
 * sends to clear a field.
 */
function readSettingsField(
  source: Record<string, unknown>,
  field: keyof VoiceSettings,
): VoiceServiceResult<string> {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    return { ok: true, value: '' };
  }

  if (typeof raw !== 'string') {
    return { ok: false, status: 400, error: `${field} must be a string.` };
  }

  const value = raw.trim();
  if (value.length > VOICE_SETTINGS_MAX_LENGTHS[field]) {
    return {
      ok: false,
      status: 400,
      error: `${field} is too long (max ${VOICE_SETTINGS_MAX_LENGTHS[field]} characters).`,
    };
  }

  return { ok: true, value };
}

/**
 * Validates a whole settings document and converts it to the stored shape.
 *
 * The base URL is checked with the same predicate the proxy path uses, so a
 * value that could never have been called is rejected at the door rather than
 * stored and discovered broken on the next recording. Note that the server
 * never issues a request to this URL — the browser calls it directly — so this
 * is a usability check, not an SSRF boundary.
 */
function parseVoiceSettingsInput(input: unknown): VoiceServiceResult<VoiceSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, error: 'Voice settings must be an object.' };
  }

  const source = input as Record<string, unknown>;
  const settings: VoiceSettings = {
    baseUrl: '',
    apiKey: '',
    sttModel: '',
    ttsModel: '',
    ttsVoice: '',
    ttsFormat: '',
  };

  for (const field of VOICE_SETTINGS_FIELDS) {
    const read = readSettingsField(source, field);
    if (!read.ok) {
      return read;
    }
    settings[field] = read.value;
  }

  if (settings.baseUrl && !validateBackendBaseUrl(settings.baseUrl)) {
    return { ok: false, status: 400, error: 'Invalid voice backend URL.' };
  }

  return { ok: true, value: settings };
}

/**
 * Creates the Voice settings service used by the Voice composition root and its
 * unit tests. Storage is injected as a narrow port so the validation rules can
 * be exercised without a database, and so the Voice module reaches the database
 * only through its public barrel.
 */
export function createVoiceSettingsService(store: VoiceSettingsStore): VoiceSettingsService {
  return {
    getSettings: (userId) => store.getSettings(userId),

    saveSettings(userId, input) {
      const parsed = parseVoiceSettingsInput(input);
      if (!parsed.ok) {
        return parsed;
      }

      store.saveSettings(userId, parsed.value);
      return { ok: true, value: parsed.value };
    },
  };
}
