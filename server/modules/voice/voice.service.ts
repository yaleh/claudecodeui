import type {
  VoiceLogPort,
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
  extractUpstreamCode,
  listProviders,
  tryResolve,
} from '../../../shared/asr/asrRegistry.js';
import type { AsrAdapter, AsrCapabilities, AsrErrorCode, AsrFailure } from '../../../shared/asr/asrRegistry.js';
// The wire's own vocabulary for how much of an upstream answer is allowed to be malformed, which
// this path names below. A TYPE import deliberately: what the wire implements — the request it
// builds, the answer it parses — is reached through the adapter now, so the only thing left for
// this module to name from that file is the reading it asks the adapter for.
import type { TranscriptionTolerance } from '../../../shared/asr/transcriptionWire.js';
// The recording seam, as a TYPE only: this module never decides a mode and never builds a row. It is
// handed a port and either has one or does not, which is what keeps the environment, the row's shape
// and the audio write out of the transcription path itself. `VoiceCaptureRawReturn` is here because
// this is the side the request leaves from: the raw answer the attempt read is something only the
// transport can hand over, so the shape it is held in has to be nameable here even though the row
// that consumes it is built in the capture module.
import type { VoiceCapturePort, VoiceCaptureRawReturn } from './voice-capture.js';

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
  /**
   * Where a transcription attempt's structured reading goes. Absent means the process's own output
   * (`console`), which is what a deployment wiring no port gets — see `VoiceLogPort` for why the
   * default is resolved here rather than at the composition root.
   */
  logger?: VoiceLogPort;
  /**
   * Where an attempt is recorded, when this deployment records at all.
   *
   * IT CARRIES THE MODE, and that is what makes the gate below a reading rather than a convention: a
   * port built for `off` is a port the service holds and writes nothing through, so "the deployment
   * is off" and "the service records" cannot both be true. Absent means the same thing as an `off`
   * port — a caller that wires nothing records nothing — which is the shape every existing test and
   * probe keeps.
   *
   * It is a dependency rather than something this module reads, because the mode comes from the
   * deployment's environment while this service is constructed by whoever composes the server: the
   * composition root reads the variable once, and everything downstream of it sees a mode.
   */
  capture?: VoiceCapturePort;
};

// The provider id is not part of the outbound request's configuration: it selects which
// adapter would serve the request, which happens before this shape is built.
type ResolvedVoiceConfig = Omit<VoiceServiceDependencies['defaults'], 'providerId'> & {
  ttsFormat: string;
};

/**
 * The failure half of the service's result type.
 *
 * A refusal produced here is always a failure, and every one of the constructors below is written
 * to say so — but `VoiceServiceResult<never>` is a two-armed union, so a caller that wants the
 * status out of a refusal (the attempt log does) has to narrow a branch it already knows the answer
 * to. Naming the failure arm once, here, is what lets those constructors be read for their status
 * at the call site without a cast or a redundant guard.
 */
type VoiceRefusal = Extract<VoiceServiceResult<never>, { ok: false }>;

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
 * One stored settings field, read as a string.
 *
 * `VoiceSettings` names its six original fields and leaves the provider-owned ones to the
 * declaration that owns them, so the field arrives here as a NAME the adapter supplied rather than
 * as a key of the type. Both shapes are read through this one function, which is what keeps the two
 * readings identical: a field that is absent, null, or not a string reads as the empty string, and
 * surrounding whitespace comes off — a key pasted with a trailing newline would otherwise be
 * presented upstream verbatim and fail authentication with nothing on screen to explain it.
 *
 * THE `undefined` DOCUMENT IS A REAL ARGUMENT, not a defensive one: `transcribe` may be driven
 * without a user's settings at all, and that caller must read exactly as a user who has saved
 * nothing does. Absent and all-empty are the same reading, on purpose.
 */
function readStoredField(settings: VoiceSettings | undefined, field: string): string {
  if (settings === undefined) {
    return '';
  }

  const value = (settings as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Whether a recording would actually reach `adapter` with this user's stored settings.
 *
 * THE QUESTION IS PER PROVIDER, AND THAT IS THE WHOLE POINT OF THE FUNCTION. The answer used to be
 * one boolean computed from `baseUrl` alone and handed to every row of the health payload, which
 * was right while every registered recogniser was reached through the browser's own backend. A
 * provider whose credential is the USER'S OWN — an address and a key only they have — is not
 * configured by `baseUrl` at all, so a single boolean is wrong in both directions: it reports that
 * provider as ready when the user has never filled its fields, and — once the shared backend is
 * cleared — reports it as unready while the user's own address and key sit in the document.
 *
 * WHICH FIELDS ARE "ITS OWN" IS THE ADAPTER'S DECLARATION, never a list here. A provider that
 * declares `credentials` is configured by those fields and by nothing else: both the address and
 * the credential must be present, because an address without a key cannot authenticate and a key
 * without an address has nowhere to go. A provider that declares nothing is reached through the
 * deployment's own backend, and keeps the reading it has always had — the user's `baseUrl` if they
 * saved one, otherwise the server's. The model field is deliberately NOT required: an unset model
 * falls back to the deployment's name rather than making the link unusable.
 */
function providerConfigured(
  adapter: AsrAdapter,
  settings: VoiceSettings | undefined,
  defaults: VoiceServiceDependencies['defaults'],
): boolean {
  const fields = adapter.credentials;
  if (fields === undefined) {
    return Boolean(readStoredField(settings, 'baseUrl') || defaults.baseUrl);
  }

  return (
    readStoredField(settings, fields.endpointField) !== '' &&
    readStoredField(settings, fields.apiKeyField) !== ''
  );
}

/**
 * The address, credential and model ONE attempt uses, once its provider is known.
 *
 * WHY THIS IS NOT `resolveVoiceConfig`. That function answers "what did the request and the
 * deployment agree on", which is the right answer for the browser's own backend and for TTS. A
 * provider that declares credential fields of its own is reached with a DIFFERENT pair, and the
 * precedence is the user's stored value FIRST — the deployment's key is not a fallback for a
 * service that key cannot authenticate against, it is simply the wrong credential. So the stored
 * value wins when it is set, and the existing resolution stands when it is not: absent means unset,
 * and a caller driving this service with no user document (a probe, the invariant board) keeps
 * reading the deployment's configuration exactly as before.
 *
 * THE PER-REQUEST OVERRIDE IS BELOW THE STORED VALUE AND ABOVE THE DEPLOYMENT'S, which is the same
 * order `effectiveProviderId` applies for the provider itself: what the user saved is their
 * standing choice, and a request-carried override is a caller that has already looked at it.
 */
function resolveRecognitionConfig(
  adapter: AsrAdapter,
  defaults: VoiceServiceDependencies['defaults'],
  overrides: VoiceRequestOverrides,
  settings: VoiceSettings | undefined,
): { baseUrl: string; apiKey: string; model: string } {
  const resolved = resolveVoiceConfig(defaults, overrides);
  const fields = adapter.credentials;
  if (fields === undefined) {
    return { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.sttModel };
  }

  const storedModel = fields.modelField === undefined ? '' : readStoredField(settings, fields.modelField);
  return {
    baseUrl: readStoredField(settings, fields.endpointField) || resolved.baseUrl,
    apiKey: readStoredField(settings, fields.apiKeyField) || resolved.apiKey,
    // Precedence: the user's stored model, then the provider's declared default, and only then the
    // shared `sttModel`. `overrides.sttModel` is NOT consulted before the default: the settings page
    // sends the SHARED backend's model on every transcribe (`x-voice-stt-model`, a Whisper id for a
    // Groq/OpenAI user), so honouring it here sent that id to a provider that has its own model
    // field and got a 404 back. A provider with credentials of its own is configured through those
    // fields, not through the header that configures the shared backend.
    model: storedModel || fields.defaultModel || resolved.sttModel,
  };
}

/**
 * The fixed marker a masked credential carries.
 *
 * A CONSTANT AND NOTHING OF THE SECRET, deliberately. The obvious alternative — keep a prefix or a
 * suffix of the value so a user can recognise which key it is — is a partial disclosure of a
 * credential that this readback face has no use for: the browser's own `apiKey` is the one a client
 * re-uses, and the field this masks is one the server holds and presents upstream, so the mask's
 * only job is to say "something is stored here". Nothing of the value survives, which is also what
 * makes "the response does not contain the key" a structural property rather than a filter that
 * some later edit has to keep in step.
 */
const CREDENTIAL_MASK_MARKER = '••••••••';

/**
 * The value a stored credential is replaced with on its way back to a client; empty stays empty.
 *
 * The empty case is not a special case of the mask but the ABSENCE of one: a user who has not
 * filled the field must read back the empty string, and a mask there would turn "not filled" into
 * "filled with something you cannot see" — a state a client cannot tell from a real key, and one
 * that the settings tab would then have no way to clear.
 */
function maskCredential(value: string): string {
  return value === '' ? '' : CREDENTIAL_MASK_MARKER;
}

/**
 * One settings document as it may cross the HTTP boundary: provider-declared credentials masked,
 * everything else verbatim.
 *
 * The fields come from the registry's own declarations (`listProviders()` hands out the adapters,
 * each carrying its module's `credentials` object by reference), so a provider that declares a
 * credential field gets it masked without this file naming the provider or the field. That is the
 * same discipline `allowedBaseUrl` and the capability table follow, and it is what makes a second
 * provider with a server-held secret a declaration in its own module rather than an edit here.
 */
function maskSettingsForReadback(settings: VoiceSettings): VoiceSettings {
  const masked: VoiceSettings = { ...settings };
  const writable = masked as unknown as Record<string, unknown>;

  for (const adapter of listProviders()) {
    const fields = adapter.credentials;
    if (fields === undefined) {
      continue;
    }

    const value = writable[fields.apiKeyField];
    if (typeof value === 'string') {
      writable[fields.apiKeyField] = maskCredential(value);
    }
  }

  return masked;
}

/**
 * The provider id a request will actually use.
 *
 * The request's own override wins, then the user's stored selection, then the deployment's default,
 * then the registry's first entry. That last step is why this returns a resolved id rather than the
 * raw input: when none of the three names a provider, "the default one" has to become a concrete id
 * before it can be checked, and taking it from the registry means a deployment that never sets
 * `VOICE_PROVIDER_ID` cannot be broken by a provider being renamed.
 *
 * THE USER'S CHOICE SITS ABOVE THE DEPLOYMENT'S because it is the more specific statement: the
 * environment says which recogniser this installation prefers, and the stored document says which
 * one this user picked. It sits BELOW the request override because a caller that names a provider
 * for one request has already read the stored document and is choosing against it.
 */
function effectiveProviderId(
  requested: string | undefined,
  defaults: { providerId: string },
  settings?: VoiceSettings,
): string {
  const explicit = (requested || readStoredField(settings, 'providerId') || defaults.providerId || '').trim();
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
function unknownProviderFailure(providerId: string, status: number): VoiceRefusal {
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
 * Whether a failure also republishes its code in the result body is a separate question, and its
 * answer is now the wide one: EVERY failure that reaches this table was named in the vocabulary by
 * someone — a gate in this module, or the adapter that read the transport — so the code travels
 * with all of them rather than with the pre-upstream three alone. That is a change and not a
 * restatement: a failure read off the transport used to be answered message-only, on the reading
 * that its remedy was not a client's to choose between. The reading was wrong for the same reason
 * the vocabulary exists at all: `422` and `502` are each several different remedies, and a client
 * asked to write the sentence a user reads cannot pick between them from a number.
 *
 * WHAT IT STILL DOES NOT DO is name a code for a refusal that never becomes an attempt. The format
 * gate and an unregistered provider id are refused before any adapter is asked anything, and
 * neither has a vocabulary member to be named by — `VoiceServiceResult.code` states that scope once,
 * for the readers of the wire.
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
  ACCOUNT_ACCESS: 403,
  QUOTA_EXHAUSTED: 429,
  MODEL_NOT_FOUND: 404,
  AUDIO_REJECTED: 400,
  CONTENT_FLAGGED: 422,
  OVERSIZE: 413,
  UNSUPPORTED_MIME: 415,
  NO_SPEECH_DETECTED: 422,
  UPSTREAM_UNAVAILABLE: 502,
};

/**
 * The status one adapter failure is owed.
 *
 * The table holds every code, and one cell of it is deliberately not the last word: an
 * `UPSTREAM_UNAVAILABLE` that carries the status its adapter read off the transport is answered with
 * that status instead of the table's 502. That is the reading this path has always had — a 404 from the
 * recogniser reached the client as 404 — and it is the only code for which the status is DATA
 * rather than a constant: every other code is a meaning an adapter derived, and a meaning has one
 * number. The clause is "carries a status" rather than "is a non-2xx answer" because all three
 * adapters set the field when they read the transport and leave it unset when they do not, so the
 * presence of the field is exactly the difference between "the upstream said this" and "we
 * interpreted this".
 *
 * WHY THIS MEMBER AND NOT THE OLDER `UPSTREAM_ERROR`. The vocabulary merged the transport failures —
 * a 5xx, an aborted request, a transport that never connected — into `UPSTREAM_UNAVAILABLE`
 * (`AsrErrorCode`), so this clause follows the member rather than the old name. The set of answers
 * that pass through is unchanged: it is still "the upstream's own status, on the failures where the
 * upstream named one".
 */
function providerFailureStatus(failure: AsrFailure): number {
  if (failure.code === 'UPSTREAM_UNAVAILABLE' && typeof failure.status === 'number') {
    return failure.status;
  }

  return PROVIDER_ERROR_STATUS[failure.code];
}

/**
 * The upstream's own code string, read off the answer this attempt kept — or `undefined`.
 *
 * A NAMED FUNCTION RATHER THAN AN INLINE TERNARY, and not for style: the answer is recorded by the
 * instrumented transport, so at the point the failure branch reads it the compiler's flow analysis
 * has seen no assignment to it in that scope and narrows the variable to `null` — the inline form
 * would read `never` and neither compile nor describe what happens. Inside a function taking the
 * declared type, the same expression is what it says: a null answer is an answer that does not
 * exist, and everything else has a body to read a code out of.
 *
 * `null` is "there was no answer to read" — a transport that refused to connect — and a body with no
 * code-shaped string in it is the same absence one layer down (`extractUpstreamCode`'s `undefined`).
 * Both are answers to the same question, and the caller owes the field's ABSENCE for either, never a
 * placeholder and never the body itself.
 */
function upstreamCodeOf(answer: VoiceCaptureRawReturn | null): string | undefined {
  return answer === null ? undefined : extractUpstreamCode(answer.body);
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
): VoiceRefusal | null {
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
): VoiceRefusal | null {
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

function backendFailure(status: number, responseText?: string): VoiceRefusal {
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

function unreachableBackendFailure(error: unknown, timeoutMs: number): VoiceRefusal {
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
 * the third reader of the one table instead of a third place a number is decided. Neither code is
 * republished — see the table's comment on which failures carry a code — but the status is the
 * table's. This is the gate for a backend that is ABSENT or unparseable; whether a well-formed
 * address is one a particular provider may be reached at is `endpointRuleRefusal`'s question,
 * asked of the selected adapter rather than of the URL alone — and asked BEFORE this one, for the
 * ordering reason recorded at the call site.
 *
 * IT ASKS ABOUT ONE FIELD, so it takes one. The two callers hand it differently shaped
 * configurations — the transcription path resolves only the address, key and model one attempt
 * uses, while TTS resolves the whole six-field document — and widening either to satisfy the other
 * would be this function claiming an interest in fields it never reads.
 */
function validateConfiguredBackend(config: { baseUrl: string }): VoiceRefusal | null {
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
 * The endpoint rule: the refusal owed a `'proxy-only'` provider whose configured address its own
 * adapter does not accept.
 *
 * WHY THIS IS A PROVIDER RULE AND NOT A TABLE HERE. What counts as a service's address is a fact
 * about the service — its hostname shapes, the transport it speaks — and this module has no way to
 * keep a second copy of it in step with the provider that owns it. The rule therefore travels on
 * the adapter (`AsrAdapter.allowedBaseUrl`, which the registry hands out as the module's own
 * export), and this function only decides WHEN it is asked: exactly for the providers that declare
 * `transport: 'proxy-only'`.
 *
 * WHY ONLY THOSE, and this is the half a reader will otherwise read as an oversight. A `'direct'`
 * provider's address is the user's own OpenAI-compatible backend, and http and private hosts are
 * deliberately legal there (`validateBackendBaseUrl` says so in as many words — a local backend is
 * a supported deployment). Holding every provider to this service's hostname shape would refuse
 * exactly those deployments, so the rule's scope is the transport declaration: a provider a browser
 * cannot reach is one whose address this server, and only this server, will speak to, and that is
 * the provider whose address has to be the service's own.
 *
 * THE REFUSAL IS PRE-REQUEST, which is the property the code and the status rest on: it is decided
 * from the resolved configuration and the adapter's declaration alone, so it costs no `fetchBackend`
 * call. The status is the table's `INVALID_BASE_URL` row rather than a literal here, and — unlike
 * the two gates above it — the code IS republished, because the caller acts on it differently from
 * a generic 400: "the address you configured is not one this recogniser may be reached at" is a
 * remedy ("use the address the service gave you"), while a 400 with no code could be anything.
 *
 * An adapter that declares `'proxy-only'` and carries no rule is not refused here: this function
 * has nothing to ask, and inventing a rule would be the second source of truth it exists not to be.
 * What catches that pairing is the seam's own criterion, which reads the registry rather than this
 * call site.
 *
 * AN ABSENT ADDRESS IS NOT THIS FUNCTION'S QUESTION, and the guard below says so rather than
 * leaving it to call order. "No backend configured" is a property of the settings (503, and the
 * user's own to fix), while "this address is not this service's" is a property of what they typed;
 * a rule asked about the empty string would answer "no" and report the second failure for the
 * first condition. It is asked about a value, or not at all.
 *
 * Exported so the probe can drive the same gate the service runs, and so a reader of the service
 * can see the rule's scope stated once.
 */
export function endpointRuleRefusal(
  adapter: AsrAdapter,
  baseUrl: string,
): VoiceRefusal | null {
  if (!baseUrl) {
    return null;
  }

  if (adapter.capabilities.transport !== 'proxy-only') {
    return null;
  }

  const rule = adapter.allowedBaseUrl;
  if (rule === undefined || rule(baseUrl)) {
    return null;
  }

  return {
    ok: false,
    status: PROVIDER_ERROR_STATUS.INVALID_BASE_URL,
    code: 'INVALID_BASE_URL',
    error:
      `provider '${adapter.id}' cannot be reached at this address; ` +
      `the address must be one of the service's own.`,
  };
}

/**
 * The same rule, asked about a settings document that is about to be STORED.
 *
 * WHY THE SAVE PATH ASKS IT AT ALL. An address a provider's own rule refuses can never serve a
 * request — the transcription path above refuses it before the invocation is built — so storing one
 * is storing a value whose only future is a refusal at the next recording, with nothing at the time
 * of saving to say so. Asked here, the user learns at the moment they paste it, and the refusal
 * carries the same code (`INVALID_BASE_URL`) the transcription path would have produced later, so a
 * client has one thing to branch on rather than two.
 *
 * IT IS ASKED OF EVERY REGISTERED PROVIDER'S DECLARED ENDPOINT FIELD, not only of the effective
 * one, and the scope is deliberate: the field belongs to the provider whose declaration names it,
 * and a value stored while a DIFFERENT provider is selected is still that provider's address, held
 * for the day the user switches to it. Validating only the effective provider would let a foreign
 * address sit in the document until the switch, which is precisely when it would be discovered —
 * after the user has moved on and has no reason to connect the failure to what they typed.
 *
 * AN EMPTY FIELD IS NOT THIS FUNCTION'S QUESTION: `endpointRuleRefusal` answers `null` for one, so
 * clearing a field stays a legal save. The rule's own text lives on the adapter, so this file holds
 * no hostname and no provider id; it holds only the decision to ask.
 */
function declaredEndpointRefusal(settings: VoiceSettings): VoiceRefusal | null {
  for (const adapter of listProviders()) {
    const fields = adapter.credentials;
    if (fields === undefined) {
      continue;
    }

    const refusal = endpointRuleRefusal(adapter, readStoredField(settings, fields.endpointField));
    if (refusal) {
      return refusal;
    }
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
 * The raw answer one attempt read, taken off a CLONE of the response the adapter is about to get.
 *
 * THE CLONE IS LOAD-BEARING, in both directions. It is what makes reading the body here invisible to
 * the adapter — a `Response` body can only be read once, so instrumenting the response the adapter
 * receives would empty it and turn every successful transcription into a parse failure. And it is
 * read BEFORE the adapter is handed the response, because `clone()` on a body that has already been
 * consumed throws, so there is no later moment at which this could be done.
 *
 * A `null` RETURN MEANS "NO READABLE ANSWER", never "an empty one". A stream that errors mid-body, a
 * body that was already consumed by the stand-in that produced the response, a redirect stub with no
 * body at all — none of those is the upstream saying the empty string, and recording them as one would
 * put a false quotation in the row. The caller keeps `null` and reports the attempt as one whose
 * request went out without a usable answer.
 *
 * THE ANSWER IS BUFFERED WHOLE. The adapters already read the full body themselves, so this adds no
 * buffering that was not already there; what it does add is the copy the clone's tee produces, and it
 * is bounded by the same thing the adapter's own read is bounded by — the response the upstream sends.
 */
async function readUpstreamAnswer(response: Response): Promise<VoiceCaptureRawReturn | null> {
  try {
    return { status: response.status, body: await response.clone().text() };
  } catch {
    return null;
  }
}

/**
 * Creates the Voice application service used by the Voice composition root and
 * its unit tests. The outbound request function and server configuration are
 * required so the service never reads globals or creates production defaults.
 */
export function createVoiceService(dependencies: VoiceServiceDependencies): VoiceService {
  // The one place the port is resolved: the injected logger wins, and the process's own output is
  // the fallback. See `VoiceLogPort` — patching the global console is what this seam exists to
  // avoid, and resolving the default here is what keeps the composition root from having to know
  // this type at all.
  const log: VoiceLogPort = dependencies.logger ?? console;

  /**
   * THE GATE, and the only place a mode is consulted in this module.
   *
   * A port whose mode is `off` is READ AS ABSENT rather than written to and filtered: an `off`
   * deployment has to produce the same attempt lines it produced before this seam existed, byte for
   * byte, and the cheapest way for that to be true is for nothing on this path to run at all — no id
   * minted, no attempt object built, no file touched. An unrecognised `VOICE_CAPTURE` value resolved
   * to `off` at the composition root, so the fail-closed decision is already made by the time this
   * binding is read; what is here is only the mechanical consequence of it.
   *
   * The denial is deliberately ONE expression over `dependencies.capture`, so the seam either records
   * every attempt or none: a gate that could be true for some attempts and false for others (say,
   * only for failures) would make "the log does not carry the audio" a property of the attempt's
   * outcome instead of a property of the deployment.
   */
  const recording: VoiceCapturePort | null =
    dependencies.capture !== undefined && dependencies.capture.mode !== 'off'
      ? dependencies.capture
      : null;

  return {
    getHealth({ settings }) {
      // The user's own selection is the first step of the precedence (see `effectiveProviderId`):
      // a stored id is what the health reading is ABOUT, so a payload that reported the
      // deployment's preference here would be answering a question nobody asked.
      const providerId = effectiveProviderId(settings.providerId, dependencies.defaults);
      const effectiveAdapter = tryResolve(providerId);
      if (effectiveAdapter === null) {
        // The whole link is unavailable, not just one entry in the list: nothing in this
        // process can serve the id the configuration names.
        return unknownProviderFailure(providerId, 503);
      }

      // Every row is asked about ITSELF, so a provider whose credential is the user's own is not
      // reported through a backend it is never reached with (see `providerConfigured`), and the
      // top-level reading is the effective provider's own answer rather than a second computation
      // that could disagree with the row beside it.
      const configuredFor = (adapter: AsrAdapter): boolean =>
        providerConfigured(adapter, settings, dependencies.defaults);

      return {
        ok: true,
        value: {
          configured: configuredFor(effectiveAdapter),
          provider: providerId,
          // Straight from the registry, capabilities object and all. The client reads the
          // container, the inline budget and the hint switches from here, so a provider that
          // changes its declaration changes the client's behaviour without a second edit.
          //
          // THE CREDENTIAL DECLARATION IS REPUBLISHED THE SAME WAY, and for the same reason one
          // step further out: the settings form renders one input per declared field, so it needs
          // the declaration itself rather than a copy of the answer. Note what is NOT here — no
          // entry keyed by id, and no branch that names one: the map's argument is the adapter and
          // every field of a row comes off that adapter, which is what keeps a provider added to
          // the registry from needing a second edit on this side.
          providers: listProviders().map((adapter) => ({
            id: adapter.id,
            label: adapter.id,
            capabilities: adapter.capabilities,
            configured: configuredFor(adapter),
            credentialFields: adapter.credentials,
          })),
        },
      };
    },

    async transcribe(input) {
      const startedAt = Date.now();
      const settings = input.settings;
      const requestedProviderId = input.overrides.providerId?.trim();
      const providerId = effectiveProviderId(requestedProviderId, dependencies.defaults, settings);

      // WHAT THIS ATTEMPT READ OFF THE TRANSPORT, filled in by `captureTransport` below and read by
      // the row's payload. Attempt-scoped by construction: both are locals of this call, so an answer
      // read for one attempt cannot be attributed to another, and there is nothing on the service to
      // reset between attempts. `requestSent` is what tells a refusal that never left this process
      // apart from a request that went out and came back unusable — see the payload's `requestSent`.
      let upstreamAnswer: VoiceCaptureRawReturn | null = null;
      let requestSent = false;

      /**
       * THE INJECTED TRANSPORT, instrumented for THIS attempt only.
       *
       * It records the answer on its way past and hands the adapter the ORIGINAL response, so nothing
       * about what the adapter reads changes. What it does NOT look at is as deliberate as what it
       * does: the request's `init` is passed through untouched and none of it is kept, so the body and
       * every header this process sends are unreachable from the row — not filtered out of it, simply
       * never named here.
       *
       * A closure rather than a function on the dependencies because what it records belongs to one
       * attempt: on the service it would be shared state that the next attempt would have to clear.
       */
      const captureTransport = async (url: string, options: RequestInit): Promise<Response> => {
        requestSent = true;
        const response = await dependencies.fetchBackend(url, options);
        // Before the adapter is handed the response, because `clone()` on an already-read body throws.
        upstreamAnswer = await readUpstreamAnswer(response);
        return response;
      };

      /**
       * One structured line per attempt, written as the attempt is answered — followed, when this
       * deployment records, by that attempt's capture row.
       *
       * WHAT THE LINE DOES NOT CARRY IS THE POINT OF IT. Every field below is one this module
       * computed — an id, an outcome, a status, a duration — so there is no free text on the line
       * at all, and therefore no message, no transcript, no credential and no audio can reach it:
       * "the log has no key in it" is a property of the line's SHAPE rather than of a filter
       * someone has to remember to keep in step. The fields the client and the metrics select on
       * are the ones recorded, including the two facts only a written recogniser produces
       * (which prompt version answered, and whether it degraded to a transcription).
       *
       * RECORDED ATTEMPTS ADD EXACTLY ONE THING TO THE LINE: `captureId`, the id that names the row
       * written immediately after it. It is minted BEFORE the line for that reason, and it is the
       * same string in both places — a caller correlating the process's output with a recording has
       * only the id to join them on, so two ids that merely look alike would be worse than none. In
       * an `off` deployment none of this happens and the line is the one above, unchanged.
       *
       * `meta` CARRIES TWO KINDS OF FACT AND THEY GO TO TWO DIFFERENT PLACES. The first two are the
       * facts this line has always carried, and the line below still spells out exactly those — the
       * additions are not fields of the line. The last two are the adapter's own reading of the
       * attempt (the code it failed with, the text it returned), and they are read by the CAPTURE ROW,
       * where the branch and the returned text live. So the line's shape is untouched by any of this,
       * byte for byte, in every mode and whether or not the deployment records.
       */
      const logAttempt = (
        outcome: 'ok' | 'fail',
        status: number,
        meta?: {
          promptVersion?: string;
          writtenFallback?: number;
          /** The adapter's code for this failure, read for the row's branch. Never on the line. */
          code?: string;
          /** The text this attempt returned to its caller, read for the row. Never on the line. */
          text?: string;
        },
      ): void => {
        const line =
          `voice.transcribe providerId=${providerId} outcome=${outcome} status=${status} ` +
          `latencyMs=${Date.now() - startedAt}` +
          (meta?.promptVersion === undefined ? '' : ` promptVersion=${meta.promptVersion}`) +
          (meta?.writtenFallback === undefined ? '' : ` writtenFallback=${meta.writtenFallback}`);

        if (recording === null) {
          log.info(line);
          return;
        }

        const captureId = recording.newAttemptId();
        log.info(`${line} captureId=${captureId}`);
        // The row goes out AFTER its attempt line and through the same port, so a reader of the
        // process's own output sees the attempt first and what was recorded about it second. The
        // attempt object is built HERE, inside the gate: an `off` deployment constructs no record at
        // all, which is what keeps its output byte-identical to the one this seam never touched.
        //
        // WHAT CROSSES INTO THE PAYLOAD IS THE SHAPE OF IT. The resolved configuration is in hand here
        // and its `apiKey` is NOT part of the payload input at all — the address goes over and the key
        // does not, because the row has no field for a credential rather than a filter that removes
        // one. The same is true of the request: `captureTransport` kept the answer and dropped the
        // init, and no name for a header or a body exists on the input this is built from.
        const used = configForRow();
        recording.recordAttempt(captureId, {
          providerId,
          outcome,
          status,
          audio: input.audio,
          payload: {
            model: used.model,
            baseUrl: used.baseUrl,
            audio: input.audio,
            upstream: upstreamAnswer,
            requestSent,
            reading: {
              ok: outcome === 'ok',
              code: meta?.code,
              writtenFallback: meta?.writtenFallback,
              text: meta?.text ?? '',
            },
          },
        });
      };

      const adapter = tryResolve(providerId);
      if (adapter === null) {
        // Refused before any request is built: nothing about the user's backend can make an
        // unregistered id serveable. The row still names an address and a model — see `configForRow`,
        // which falls back to the shared backend's own resolution precisely because there is no
        // adapter here to declare either.
        const refusal = unknownProviderFailure(providerId, requestedProviderId ? 400 : 503);
        logAttempt('fail', refusal.status);
        return refusal;
      }

      /**
       * THE ADDRESS, KEY AND MODEL THIS ATTEMPT USES, resolved once and remembered.
       *
       * MEMOIZED SO THERE IS STILL EXACTLY ONE RESOLUTION, and so that the row, the gates and the
       * invocation cannot be looking at different addresses: whoever asks first resolves, everyone
       * after reads the same object. It is reached from the row as well as from the gates, which is
       * why it is callable before the invocation — a refused attempt still has to say which address,
       * model and host it would have used, and that is the same answer the refusal was made on.
       *
       * A PROVIDER WITH NO ADAPTER HAS NOTHING TO DECLARE, so there is no provider-declared address
       * and no declared default model to report; the row then names what the SHARED backend resolves
       * to, which is where this deployment would have sent had the id been one anything claimed.
       */
      let attemptConfig: { baseUrl: string; apiKey: string; model: string } | null = null;
      const configForRow = (): { baseUrl: string; apiKey: string; model: string } => {
        if (adapter === null) {
          const resolved = resolveVoiceConfig(dependencies.defaults, input.overrides);
          return { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.sttModel };
        }

        attemptConfig ??= resolveRecognitionConfig(
          adapter,
          dependencies.defaults,
          input.overrides,
          settings,
        );
        return attemptConfig;
      };

      // The two gates the SELECTED provider's declaration decides, both before a request exists: an
      // upload this provider does not accept, or one past its own declared budget, is refused here and
      // costs no upstream request at all. The order is deliberate — a container the provider cannot
      // read is refused before the size is even considered, so "too big" is only ever reported about
      // audio that could have been sent. (A recording deployment does resolve the address by the time
      // it writes this refusal's row — see `configForRow` — but resolving an address asks no upstream
      // anything, and no gate below is reordered by it.)
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
        logAttempt('fail', containerFailure.status);
        return containerFailure;
      }

      const budgetFailure = budgetRefusal(
        adapter.capabilities,
        providerId,
        input.audio.bytes.length,
      );
      if (budgetFailure) {
        logAttempt('fail', budgetFailure.status);
        return budgetFailure;
      }

      // THE ADDRESS, KEY AND MODEL THIS ATTEMPT USES: the same object the row and any refusal above
      // already read, since there is one resolution and not one per reader — see `configForRow`. For a
      // provider that declares credential fields of its own this is the user's stored pair, not the
      // deployment's; see `resolveRecognitionConfig`.
      const config = configForRow();

      // The third pre-request gate, and the only one that reads the SELECTED ADAPTER rather than
      // its capabilities alone: a proxy-only provider may only be addressed at its own service, so
      // an address its rule refuses is refused here — before the invocation below exists, and
      // therefore before any transport is reached. See `endpointRuleRefusal` for why the rule is
      // the adapter's and why it is asked only of proxy-only providers.
      //
      // IT IS ASKED BEFORE THE FORMAT GATE BELOW, and the order is load-bearing rather than
      // stylistic. The format gate answers "is this a URL at all" and answers it WITHOUT a code:
      // it guards a setting on its way to a fetch, where the address's shape is an implementation
      // detail. For a provider that may only be reached at its own service the shape is instead
      // part of the rule, and the rule's refusals all carry `INVALID_BASE_URL` — an answer that
      // arrived from the format gate first would report a well-formed address's problem as
      // unclassifiable, and the client would have no code to act on. Nothing is lost by asking the
      // narrower question first: an address this rule accepts is a URL, so the format gate below
      // can only be reached and pass.
      const endpointFailure = endpointRuleRefusal(adapter, config.baseUrl);
      if (endpointFailure) {
        logAttempt('fail', endpointFailure.status);
        return endpointFailure;
      }

      const configurationFailure = validateConfiguredBackend(config);
      if (configurationFailure) {
        logAttempt('fail', configurationFailure.status);
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
            model: config.model,
            timeoutMs: dependencies.timeoutMs,
            // The transport stays the injected port, so one place still owns every request that
            // leaves this process (its redirect policy, its abort controller and the test double
            // that replaces it). The adapter's `fetch` shape takes a `RequestInfo | URL` and an
            // optional init while the port takes a string and an init, hence the wrapper — and the
            // wrapper is this attempt's own `captureTransport`, which records the answer on its way
            // past without keeping one byte of the request.
            fetchImpl: (url, init) => captureTransport(String(url), init ?? {}),
            // Named rather than inherited: how much of an answer is tolerable is a property of the
            // CALLER, and this path's reading is the one the parity baseline records.
            tolerance: PROXY_ANSWER_TOLERANCE,
          },
        );

        if (!result.ok) {
          // The status is the table's — or, for the one code whose adapter carries the upstream's
          // own status, the upstream's. The message is the adapter's, which names the provider the
          // way a seam with more than one provider has to.
          //
          // THE CODE TRAVELS WITH THE FAILURE. An adapter has already named its upstream's refusal
          // in the seam's vocabulary — that is what `AsrFailure.code` IS — and dropping it here left
          // the client with a status number it cannot tell "you said nothing" from "we could not
          // reach the service" by. It is the same code `logAttempt` reads for the capture row, so
          // the line, the row and the response now agree on one word for one failure instead of the
          // first two knowing something the third did not.
          //
          // `upstreamCode` IS READ OFF THE ANSWER THIS ATTEMPT ALREADY KEPT, never re-asked for:
          // `captureTransport` recorded `{ status, body }` from a clone before the adapter touched
          // the response, for the row's sake and in every mode. The reading of it lives in
          // `upstreamCodeOf`, which is where the two ways an upstream can name nothing are decided:
          // no answer to read at all (a transport that refused to connect), or a body with no
          // code-shaped string in it. Either way the field is absent rather than empty.
          const status = providerFailureStatus(result);
          const upstreamCode = upstreamCodeOf(upstreamAnswer);
          logAttempt('fail', status, { code: result.code });
          return { ok: false, status, code: result.code, upstreamCode, error: result.message };
        }

        // The two facts this path can read off a successful answer and nowhere else: which frozen
        // prompt produced the text, and whether a written recogniser had to degrade to a
        // transcription. Recorded on the attempt line so a change in either is visible in the
        // process's own output rather than only in a response body. The text goes to the ROW, not to
        // the line: it is the attempt's own returned value, and the line carries no free text.
        logAttempt('ok', 200, {
          promptVersion: result.meta?.promptVersion,
          writtenFallback: result.meta?.writtenFallback,
          text: result.text,
        });

        // The payload stays `{ text }`. The seam's richer envelope (`style`, `transformations`,
        // the provider's own `meta`) belongs to the surfaces that consume it — the settings entry
        // point and the trim declarations of later tasks — not to this route's two fields.
        return { ok: true, value: { text: result.text } };
      } catch (error) {
        // Reachable only if an adapter throws where its contract says it answers: every documented
        // failure is a returned `AsrFailure`, and each adapter catches its own transport errors,
        // so this keeps the module's promise — `transcribe` answers with a result — for the bug
        // rather than for the design.
        const refusal = unreachableBackendFailure(error, dependencies.timeoutMs);
        logAttempt('fail', refusal.status);
        return refusal;
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

/**
 * Every field of a settings document, so validation cannot miss one by accident.
 *
 * THE PROVIDER-OWNED FIELDS BELONG ON THIS LIST even though the headers above say the browser calls
 * the backend itself: these are the fields the SERVER presents upstream when the selected provider
 * is one whose transport is `proxy-only`, so they are stored through this same document and have to
 * survive the same validation. Leaving them off would not make them unreachable — the store's own
 * field list would still carry them — it would make them the one part of the document a request
 * could set to a non-string or to megabytes of text, which is exactly what this list exists to
 * prevent.
 */
const VOICE_SETTINGS_FIELDS: readonly (keyof VoiceSettings)[] = [
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
 * The longest value each field accepts. Generous for any real endpoint, key or
 * model name, and small enough that one request cannot park megabytes in the
 * settings row and have every later read pay for it.
 *
 * The provider-owned entries are the same generous bounds as their counterparts above rather than
 * new policy: an endpoint is an endpoint and a key is a key, and a bound that differed by field
 * would be a second, silent rule about which provider's address is the longer one.
 */
const VOICE_SETTINGS_MAX_LENGTHS: Record<keyof VoiceSettings, number> = {
  baseUrl: 2048,
  apiKey: 4096,
  sttModel: 256,
  ttsModel: 256,
  ttsVoice: 256,
  ttsFormat: 64,
  providerId: 128,
  dashscopeEndpoint: 2048,
  dashscopeApiKey: 4096,
  dashscopeModel: 256,
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
    providerId: '',
    dashscopeEndpoint: '',
    dashscopeApiKey: '',
    dashscopeModel: '',
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

  // The provider-declared addresses are checked with their own providers' rules, after the six above
  // have been read, so a document is rejected for the first thing wrong with it in field order
  // rather than in whichever order the registry happens to iterate.
  const endpointFailure = declaredEndpointRefusal(settings);
  if (endpointFailure) {
    return endpointFailure;
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

    // The readback face is this one method, and it is applied to the SAVED document too rather than
    // only to the read: the two responses a client compares field by field are the document it just
    // sent and the document it reads back, and a save that answered with the key in the clear would
    // be a second place the value leaves the process — one whose output a client stores.
    maskForReadback: (settings) => maskSettingsForReadback(settings),

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
