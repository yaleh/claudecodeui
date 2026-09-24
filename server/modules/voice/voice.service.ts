import type {
  VoiceRequestOverrides,
  VoiceService,
  VoiceServiceResult,
  VoiceSettings,
  VoiceSettingsService,
  VoiceSettingsStore,
  VoiceSpeechPayload,
} from '@/shared/types.js';

// The provider address book AND the dispatch. The health payload republishes what this module
// exports, the request paths ask it whether an id exists at all, and `transcribe` asks it for the
// ADAPTER the selected id names and hands that adapter the audio (see the dispatch comment in
// `transcribe`). So a provider is added by registering it there, and the wire a provider speaks is
// the adapter's to know rather than this module's.
// The container rule is read from a declaration for the same reason: the browser's direct path asks
// the same function of the same declaration, which is what makes one refusal code mean one thing on
// both paths.
import {
  baseMimeType,
  declaredAcceptsMime,
  listProviders,
  tryResolve,
} from '../../../shared/asr/asrRegistry.js';
import type { AsrCapabilities, AsrErrorCode, AsrFailure } from '../../../shared/asr/asrRegistry.js';
// The wire's own vocabulary for how much of an upstream answer is allowed to be malformed, which
// this path names below. A TYPE import deliberately: what the wire implements — the request it
// builds, the answer it parses — is reached through the adapter now, so the only thing left for
// this module to name from that file is the reading it asks the adapter for.
import type { TranscriptionTolerance } from '../../../shared/asr/transcriptionWire.js';

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
 * The seam's semantic vocabulary, mapped to the status this service owes the caller.
 *
 * WHY IT IS A TABLE AND NOT THE BRANCHES IT REPLACED. The statuses on this path used to be decided
 * in four separate places — a literal in each of the two gates, an `if` on 401/403 inside
 * `backendFailure`, a literal in the timeout branch — so which number a caller saw depended on
 * which branch happened to produce the failure, and the set of statuses this path could answer was
 * not readable from anywhere. Every code in the vocabulary now has exactly one row, and each is
 * reachable from the proxy path: the adapters translate a transport-level failure into a code, and
 * this table is the only place a code becomes HTTP.
 *
 * WHY THESE NUMBERS, stated once instead of per site:
 *   · 503 / 400 — no backend is configured, or the configured URL could never be called. The
 *     distinction is whose value was wrong: the deployment's own environment (503, not the
 *     caller's to fix) against a URL that arrived in the request (400).
 *   · 502 — the upstream refused the credential, or answered something unreadable. Neither is
 *     fixable from here, and 502 is what this path has always answered a rejected key with.
 *   · 429 — the upstream's own rate limit, reported as itself: it is the one upstream status whose
 *     meaning a client changes behaviour on, and folding it into 502 would hide that.
 *   · 504 / 413 / 415 / 422 — timed out, too large, wrong container, no speech. Four different user
 *     remedies, four numbers; the two upload ones are also the codes the result itself republishes.
 *
 * WHAT IT DECIDES, AND WHAT IT DOES NOT. It decides the STATUS of every failure this path returns.
 * Whether a failure also republishes its code in the result body is a separate and narrower
 * question (`VoiceServiceResult.code`) and this task leaves that reading exactly as it was: the two
 * pre-upstream refusals carry their codes, and the rest do not.
 *
 * Exported for `server/modules/voice/tests/voice-provider-dispatch.test.ts`, which is the criterion
 * that reads the table row by row and then drives each code through this service to the status it
 * names.
 */
export const PROVIDER_ERROR_STATUS: Readonly<Record<AsrErrorCode, number>> = {
  NOT_CONFIGURED: 503,
  INVALID_BASE_URL: 400,
  UNAUTHORIZED: 502,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  UNREACHABLE: 502,
  OVERSIZE: 413,
  UNSUPPORTED_MIME: 415,
  NO_SPEECH_DETECTED: 422,
  UPSTREAM_ERROR: 502,
};

/**
 * The status one adapter failure is owed.
 *
 * The table holds every code, and one cell of it is deliberately not the last word: an
 * `UPSTREAM_ERROR` that carries the status its adapter read off the transport is answered with that
 * status instead of the table's 502. That is the reading this path has always had — a 404 from the
 * recogniser reached the client as 404 — and it is the only code for which the status is DATA
 * rather than a constant: every other code is a meaning an adapter derived, and a meaning has one
 * number. The clause is "carries a status" rather than "is a non-2xx answer" because both adapters
 * set the field when they read the transport and leave it unset when they do not, so the presence
 * of the field is exactly the difference between "the upstream said this" and "we interpreted
 * this".
 */
function providerFailureStatus(failure: AsrFailure): number {
  if (failure.code === 'UPSTREAM_ERROR' && typeof failure.status === 'number') {
    return failure.status;
  }

  return PROVIDER_ERROR_STATUS[failure.code];
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
    status: PROVIDER_ERROR_STATUS.UNSUPPORTED_MIME,
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
    status: PROVIDER_ERROR_STATUS.OVERSIZE,
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

/**
 * The configuration gate: the two refusals owed a backend that is absent or unspeakable.
 *
 * Both statuses come from `PROVIDER_ERROR_STATUS` rather than being written here, so this gate is
 * the third reader of the one table instead of a third place a number is decided. The codes are not
 * republished in the result — see the table's comment — but the status is the table's.
 */
function validateConfiguredBackend(config: ResolvedVoiceConfig): VoiceServiceResult<never> | null {
  if (!config.baseUrl) {
    return {
      ok: false,
      status: PROVIDER_ERROR_STATUS.NOT_CONFIGURED,
      error: 'No voice backend configured',
    };
  }

  if (!validateBackendBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      status: PROVIDER_ERROR_STATUS.INVALID_BASE_URL,
      error: 'Invalid voice backend URL.',
    };
  }

  return null;
}

/**
 * How this path reads an upstream answer: the tolerance it has always had.
 *
 * A named constant rather than a literal at the call site, because `TranscriptionTolerance` is the
 * wire's own vocabulary and this is the one place in the server that names `'lenient'` — the
 * browser's direct path stays on the absent-means-`'strict'` default (`src/shared/api.ts`), so a
 * reader comparing the two paths finds each of them naming its own reading in exactly one place.
 *
 * `'lenient'` is a description of the behaviour this path must not change, not a licence: a body
 * that is not the transcription envelope is the transcript here (that is what the parity baseline
 * records, gateway error page and all), and an EMPTY transcript is a successful transcription of
 * silence rather than `NO_SPEECH_DETECTED`.
 */
const PROXY_ANSWER_TOLERANCE: TranscriptionTolerance = 'lenient';

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
      //
      // The adapter repeats both guards, and that is not a second rule: it asks the same two
      // functions of the same declaration, so it can only ever fire for a caller that did not come
      // through this module (the direct path, the CLI, the invariant board). They stay here as well
      // because a refusal that reaches no adapter costs nothing to explain — no configuration, no
      // transport, no invocation — and because these two exported functions are the symbols
      // `scripts/asr-mime-size-gaps-check.mjs` reads this module's behaviour through.
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
        // THE DISPATCH. Which endpoint, which verb, which headers, which body shape, which
        // envelope the answer comes back in — all of that is the ADAPTER's to know, and this module
        // no longer knows any of it: it hands over the audio and the environment, and reads back a
        // result. Before this the proxy path built the multipart request itself, so registering a
        // second provider changed nothing about what the app actually sent — the registry was a
        // DESCRIPTION of behaviour the app did not go through, and every reader of the seam (the
        // trim's declaration, the health payload, the invariant board) was reading a description of
        // a path nothing ran. That is also what makes this task's falsification possible at all:
        // hardcode one wire here and the other provider is silently unreachable.
        const result = await adapter.transcribe(
          {
            audio: {
              bytes: input.audio.bytes,
              mimeType: input.audio.mimeType,
              fileName: input.audio.fileName,
            },
          },
          {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.sttModel,
            timeoutMs: dependencies.timeoutMs,
            // The transport stays the injected port, so one place still owns every request that
            // leaves this process (its redirect policy, its abort controller and the test double
            // that replaces it). The adapter's `fetch` shape takes a `RequestInfo | URL` and an
            // optional init while the port takes a string and an init, hence the wrapper.
            fetchImpl: (url, init) => dependencies.fetchBackend(String(url), init ?? {}),
            // Named rather than inherited: how much of an answer is tolerable is a property of the
            // CALLER, and this path's reading is the one the parity baseline records.
            tolerance: PROXY_ANSWER_TOLERANCE,
          },
        );

        if (!result.ok) {
          // The status is the table's — or, for the one code whose adapter carries the upstream's
          // own status, the upstream's. The message is the adapter's, which names the provider the
          // way a seam with more than one provider has to. The code is deliberately not
          // republished here; see the table's comment.
          return { ok: false, status: providerFailureStatus(result), error: result.message };
        }

        // The payload stays `{ text }`. The seam's richer envelope (`style`, `transformations`,
        // the provider's own `meta`) belongs to the surfaces that consume it — the settings entry
        // point and the trim declarations of later tasks — not to this route's two fields.
        return { ok: true, value: { text: result.text } };
      } catch (error) {
        // Reachable only if an adapter throws where its contract says it answers: every documented
        // failure is a returned `AsrFailure`, and each adapter catches its own transport errors,
        // so this keeps the module's promise — `transcribe` answers with a result — for the bug
        // rather than for the design.
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
