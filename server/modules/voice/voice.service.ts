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
// The provider address book. The health payload republishes what this exports and the two
// request paths ask it whether an id exists at all, so a provider is added by registering it
// there rather than by editing anything in this module.
// The container rule itself, which is a property of a declaration rather than of this module: the
// browser's direct path asks the same function of the same declaration, which is what makes one
// refusal code mean one thing on both paths.
import {
  baseMimeType,
  declaredAcceptsMime,
  listProviders,
  tryResolve,
} from '../../../shared/asr/asrRegistry.js';
import type { AsrCapabilities } from '../../../shared/asr/asrRegistry.js';

type VoiceServiceDependencies = {
  defaults: {
    baseUrl: string;
    apiKey: string;
    sttModel: string;
    ttsModel: string;
    ttsVoice: string;
    /**
     * The provider id the deployment prefers, from the server's environment.
     *
     * It is only a *default*: the id a request uses can be overridden per request, and an id
     * that no adapter claims is refused rather than replaced by this one. Empty means "the
     * first registered adapter", which is how a deployment that never sets the variable gets
     * the registry's own order instead of a hardcoded id that could be renamed.
     */
    providerId: string;
  };
  timeoutMs: number;
  fetchBackend(url: string, options: RequestInit): Promise<Response>;
};

// The provider id is not part of the outbound request's configuration: it selects which
// adapter would serve the request, which happens before this shape is built.
type ResolvedVoiceConfig = Omit<VoiceServiceDependencies['defaults'], 'providerId'> & {
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

/**
 * The provider id a request will actually use.
 *
 * The request's own override wins, then the deployment's default, then the registry's first
 * entry. That last step is why this returns a resolved id rather than the raw input: when
 * neither the client nor the environment names a provider, "the default one" has to become a
 * concrete id before it can be checked, and taking it from the registry means a deployment
 * that never sets `VOICE_PROVIDER_ID` cannot be broken by a provider being renamed.
 */
function effectiveProviderId(requested: string | undefined, defaults: { providerId: string }): string {
  const explicit = (requested || defaults.providerId || '').trim();
  if (explicit) {
    return explicit;
  }

  return listProviders()[0]?.id ?? '';
}

/** The message both refusal paths return, naming the id that could not be served. */
function unknownProviderMessage(providerId: string): string {
  return providerId
    ? `Unknown voice provider id '${providerId}': no ASR adapter is registered for it.`
    : 'No ASR adapter is registered, so no provider id can be served.';
}

/**
 * The fail-closed refusal for an id nothing claims, in the shape the caller's transport needs.
 *
 * There is deliberately no third branch that quietly substitutes the default provider. The
 * worst case of a silent fallback is a user who believes they are transcribing with the
 * service they selected while the previous one answers, and nothing on screen says otherwise.
 *
 * The status distinguishes whose id was wrong: a request-carried override is the client's
 * (400), while an id that came from the server's own configuration is not something the caller
 * can fix (503).
 */
function unknownProviderFailure(providerId: string, status: number): VoiceServiceResult<never> {
  return { ok: false, status, error: unknownProviderMessage(providerId) };
}

/**
 * The container gate: the refusal owed an upload whose type `capabilities` does not declare.
 *
 * The whitelist is the DECLARATION, not a table of this module's own — a second list here would be
 * the very "two sources of truth" this gate exists to remove, and would go stale the day a
 * provider changes. Matched on the base type, so `audio/webm;codecs=opus` — the shipped recorder's
 * own output — is the `audio/webm` entry the service published, instead of a type nothing claims.
 *
 * The code is `UNSUPPORTED_MIME` and not the status number, because the browser's direct path
 * refuses the same upload in the same words: a client that branches on "is this a container I sent
 * wrongly or a recording that is too big" cannot answer that from `415` versus `413` across two
 * different transports, but can from the seam's own vocabulary.
 *
 * Exported for `scripts/asr-mime-size-gaps-check.mjs`, which drives it with a second declaration
 * to read that the whitelist follows the declaration rather than a constant.
 */
export function containerRefusal(
  capabilities: AsrCapabilities,
  providerId: string,
  mimeType: string,
): VoiceServiceResult<never> | null {
  if (declaredAcceptsMime(capabilities, mimeType)) {
    return null;
  }

  return {
    ok: false,
    status: 415,
    code: 'UNSUPPORTED_MIME',
    error:
      `provider '${providerId}' does not accept ${baseMimeType(mimeType)}; ` +
      `it accepts ${capabilities.acceptsMime.join(', ')}`,
  };
}

/**
 * The size gate: the per-provider half of the two-layer upload limit.
 *
 * There is a transport ceiling above this one — multer's, which runs before the handler and
 * therefore before any provider is known — and that ceiling is the largest budget any registered
 * provider declares. So the effective limit for a request is `min(ceiling, this provider's
 * budget)`, and because the ceiling is the maximum over the registry it can never be the smaller
 * term. What is left to enforce here is the selected provider's own figure, applied to bytes that
 * have already been buffered: an upload between the two figures is read in full and then refused,
 * which is the price of the ceiling not knowing which provider will serve it.
 *
 * `OVERSIZE` rather than the transport's `LIMIT_FILE_SIZE`, for the same reason the container gate
 * carries `UNSUPPORTED_MIME`: the caller's remedy is different (a shorter recording, not a
 * differently encoded one), and only the semantic code says which of the two layers refused.
 *
 * Exported for the same probe, which reads that the threshold is the declaration's.
 */
export function budgetRefusal(
  capabilities: AsrCapabilities,
  providerId: string,
  byteLength: number,
): VoiceServiceResult<never> | null {
  const budget = capabilities.maxInlineRequestBytes;
  if (byteLength <= budget) {
    return null;
  }

  return {
    ok: false,
    status: 413,
    code: 'OVERSIZE',
    error:
      `upload of ${byteLength} B exceeds provider '${providerId}' budget of ${budget} B ` +
      `(the budget is the provider's own declared maximum for one request)`,
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
  /**
   * Whether a recording would reach a recogniser with this configuration.
   *
   * The user's stored backend wins over the server's environment, so a user who configured
   * their own backend is configured even on a server that has no voice environment variables
   * set at all — the answer this used to give wrongly, because it only ever looked at the
   * environment.
   */
  function effectiveBackendConfigured(settings: VoiceSettings): boolean {
    return Boolean(settings.baseUrl.trim() || dependencies.defaults.baseUrl);
  }

  return {
    getHealth({ settings }) {
      const providerId = effectiveProviderId(undefined, dependencies.defaults);
      if (tryResolve(providerId) === null) {
        // The whole link is unavailable, not just one entry in the list: nothing in this
        // process can serve the id the configuration names.
        return unknownProviderFailure(providerId, 503);
      }

      const configured = effectiveBackendConfigured(settings);
      return {
        ok: true,
        value: {
          configured,
          provider: providerId,
          // Straight from the registry, capabilities object and all. The client reads the
          // container, the inline budget and the hint switches from here, so a provider that
          // changes its declaration changes the client's behaviour without a second edit.
          providers: listProviders().map((adapter) => ({
            id: adapter.id,
            label: adapter.id,
            capabilities: adapter.capabilities,
            configured,
          })),
        },
      };
    },

    async transcribe(input) {
      const requestedProviderId = input.overrides.providerId?.trim();
      const providerId = effectiveProviderId(requestedProviderId, dependencies.defaults);
      const adapter = tryResolve(providerId);
      if (adapter === null) {
        // Refused before the configuration is even resolved and before any request is built:
        // nothing about the user's backend can make an unregistered id serveable.
        return unknownProviderFailure(providerId, requestedProviderId ? 400 : 503);
      }

      // The two gates the SELECTED provider's declaration decides, both before the configuration
      // is resolved and before a request exists: an upload this provider does not accept, or one
      // past its own declared budget, is refused here and costs no upstream request at all. The
      // order is deliberate — a container the provider cannot read is refused before the size is
      // even considered, so "too big" is only ever reported about audio that could have been sent.
      const containerFailure = containerRefusal(
        adapter.capabilities,
        providerId,
        input.audio.mimeType,
      );
      if (containerFailure) {
        return containerFailure;
      }

      const budgetFailure = budgetRefusal(
        adapter.capabilities,
        providerId,
        input.audio.bytes.length,
      );
      if (budgetFailure) {
        return budgetFailure;
      }

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
