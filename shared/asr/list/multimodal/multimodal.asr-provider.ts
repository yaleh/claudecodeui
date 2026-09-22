/**
 * The SECOND recogniser adapter: a multimodal service, inline only.
 *
 * WHY A SECOND ADAPTER IS THE DELIVERABLE RATHER THAN A NICER FIRST ONE. A capability table with
 * one instance in it is a claim nobody can falsify: every field could be wrong and no reading
 * would move, because there is no second shape to disagree with. This module is that second
 * shape, and the disagreement is the point — it is a whole-request-budget, JSON, written-style,
 * context-honouring recogniser where the first one is an audio-seconds, multipart, verbatim,
 * prompt-shaped one. ADR-004 §S2 places it here; AC-132 is the criterion.
 *
 * THE THREE PROPERTIES THIS ADAPTER CARRIES, each one a place the first adapter cannot disagree:
 *
 *   · THE BUDGET IS THE WHOLE REQUEST. `maxInlineRequestBytes` is a request maximum — the prompt,
 *     the context and the audio share it — so the guard sizes the request that is about to be
 *     sent, not the audio inside it. An audio-only guard passes an audio of 14 MB and then ships a
 *     body the service rejects.
 *   · OVERSIZE IS A DECLARED REJECTION, taken BEFORE anything leaves. `oversize: 'reject'` is the
 *     only value the first version allows (ADR-004 §缺口②.5), and the rejection happens before
 *     `fetchImpl` is reached, so a rejected request costs no upstream call and no money.
 *   · AN UNACKNOWLEDGED HINT IS NOT SENT. This provider declares `honors.prompt: false` — the
 *     measured effect is that prompt biasing is harmful on Chinese audio under the shipped
 *     trimming (ADR-004 §二) — so a prompt is left off the wire entirely rather than forwarded as
 *     an empty value or silently dropped behind the caller's back. `honoredHints` is the single
 *     place that decision is made, and it reads the same declaration the capability table exports.
 *
 * ENVIRONMENT NEUTRALITY, the same machine property `../asrRegistry.ts` documents: this file is
 * compiled by BOTH compiler configurations (root: `lib: ES2020 + DOM`, `types: vite/client`;
 * server: `lib: ES2022`, NodeNext, `types: node`), so it uses no Node built-in and no ES2021+
 * library feature, and every environment dependency arrives through `AsrInvocation`. That is also
 * what makes the adapter's budget arithmetic — and not merely its shape — testable offline.
 */

import type {
  AsrAdapter,
  AsrCapabilities,
  AsrErrorCode,
  AsrHints,
  AsrInvocation,
  AsrRequest,
  AsrResult,
} from '../../asrRegistry.js';

/** The id this provider is registered under. */
export const id: string = 'multimodal';

/**
 * This provider's capability declaration. The values that are NOT the first adapter's are the
 * load-bearing part: `billing: 'request'` (a whole request is the unit, so a saved second is not
 * a saved cent), `pauseCues: 'useful'` (pauses are punctuation cues, which is why this one is not
 * trimmed by default), `style: 'written'` (the answer comes back already written up, ADR-004 D3),
 * and `honors.prompt: false` (see the module comment).
 */
export const capabilities: AsrCapabilities = {
  acceptsMime: [
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
    'audio/webm',
  ],
  // The published inline maximum, and it is the WHOLE request: prompt, context and every file.
  maxInlineRequestBytes: 20 * 1024 * 1024,
  oversize: 'reject',
  honors: { prompt: false, language: false, context: true },
  billing: 'request',
  pauseCues: 'useful',
  style: 'written',
  oneShot: true,
};

/** The transformations a `style: 'written'` recogniser performs on its way to `AsrResult.text`. */
export const WRITTEN_STYLE_TRANSFORMATIONS = ['punctuate', 'de-disfluency', 'written-style'] as const;

// ── the request body ─────────────────────────────────────────────────────────────────────────

export type InlineTextPart = { text: string };
export type InlineDataPart = { inlineData: { mimeType: string; data: string } };

/** One inline request, as this service's JSON API expects it. */
export type MultimodalRequestBody = {
  contents: { parts: (InlineDataPart | InlineTextPart)[] }[];
  systemInstruction?: { parts: InlineTextPart[] };
};

/**
 * Joins the configured base URL with the generation endpoint.
 *
 * The model name is part of the PATH here, which is one of the ways this service's wire differs
 * from an OpenAI-compatible one — a second reason the seam has to exist before a second provider
 * can be added at all.
 */
export function generateContentEndpoint(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
}

/** `audio/webm;codecs=opus` and `audio/webm` are the same container (ADR-004 §缺口①.3). */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/** Whether this provider accepts `mimeType`, matched on the base type. */
export function acceptsMime(mimeType: string): boolean {
  return capabilities.acceptsMime.indexOf(baseMimeType(mimeType)) !== -1;
}

/**
 * The subset of `hints` this provider will actually put on the wire.
 *
 * This is the only place the `honors` declaration is applied, and the body builder only ever sees
 * the value this returns — so "the prompt is not sent" is a property of the declaration rather
 * than of a second condition somewhere downstream that could drift from it.
 */
export function honoredHints(hints: AsrHints | undefined): AsrHints {
  const honored: AsrHints = {};
  if (hints === undefined) return honored;
  if (capabilities.honors.prompt && hints.prompt !== undefined) honored.prompt = hints.prompt;
  if (capabilities.honors.language && hints.language !== undefined) honored.language = hints.language;
  if (capabilities.honors.context && hints.context !== undefined) honored.context = hints.context;
  return honored;
}

/**
 * Builds the request body.
 *
 * `inlineData` is a PARAMETER rather than something this function computes, and that is what makes
 * the budget check below exact without materialising the encoded audio: the same builder produces
 * the skeleton the guard measures and the body that is sent, so the two can never describe
 * different requests. See `measureInlineRequestBytes`.
 */
export function buildInlineRequestBody(
  request: AsrRequest,
  hints: AsrHints,
  inlineData: string,
): MultimodalRequestBody {
  const parts: (InlineDataPart | InlineTextPart)[] = [
    { inlineData: { mimeType: baseMimeType(request.audio.mimeType), data: inlineData } },
  ];
  if (hints.context !== undefined && hints.context !== '') parts.push({ text: hints.context });

  const body: MultimodalRequestBody = { contents: [{ parts }] };
  if (hints.prompt !== undefined && hints.prompt !== '') {
    body.systemInstruction = { parts: [{ text: hints.prompt }] };
  }
  return body;
}

// ── the budget arithmetic ────────────────────────────────────────────────────────────────────

/** The exact length a base64 encoding of `byteLength` bytes has, without encoding anything. */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/** The UTF-8 length of `value`, counted directly so no encoder global is needed on either side. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of `bytes`. Written out rather than reached for, for the neutrality reason above. */
export function base64Encode(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    encoded += BASE64_ALPHABET[first >> 2];
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    encoded += index + 1 < bytes.length ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
    encoded += index + 2 < bytes.length ? BASE64_ALPHABET[third & 0x3f] : '=';
  }
  return encoded;
}

/**
 * The byte length of the request this adapter would send for `request` and `hints` — the budget
 * subject, and an exact reading rather than an estimate.
 *
 * It is exact because the audio's contribution is not guessed at: the body is serialised once with
 * an EMPTY inline payload and the encoded payload's length is added on. Base64's alphabet contains
 * no character JSON would escape, so replacing `""` with the encoded audio changes the serialised
 * length by exactly `base64Length(bytes)`. The cost is that the audio is never encoded for a
 * request that is about to be rejected — which is the same discipline the guard's position
 * (before `fetchImpl`) enforces on the network side.
 *
 * What this deliberately does not model: the constant transport envelope (URL, headers). It is
 * fixed per call and carries no caller-controlled bytes; everything a caller can grow — the audio,
 * the context, the prompt when it is honoured — is inside the number below.
 */
export function measureInlineRequestBytes(request: AsrRequest, hints: AsrHints): number {
  const skeleton = JSON.stringify(buildInlineRequestBody(request, hints, ''));
  return utf8ByteLength(skeleton) + base64Length(request.audio.bytes.length);
}

// ── the response ─────────────────────────────────────────────────────────────────────────────

export type MultimodalResponse = {
  candidates?: { content?: { parts?: { text?: unknown }[] } }[];
};

/**
 * The transcript out of this service's answer envelope.
 *
 * A loop over the first candidate's text parts, and nothing else: a body that is not this envelope
 * yields the empty string, and a body that is not JSON at all throws — the caller turns the throw
 * into `UPSTREAM_ERROR`. Handing the raw response back as if it were a transcript is the shape
 * this function exists to not have (ADR-004 §一 records the proxy path already doing exactly that
 * for the first provider); `scripts/asr-second-adapter-check.mjs` pins it with a baseline.
 */
export function readTranscriptText(responseText: string): string {
  const parsed = JSON.parse(responseText) as MultimodalResponse;
  const parts = parsed?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let transcript = '';
  for (const part of parts) {
    if (typeof part?.text === 'string') transcript += part.text;
  }
  return transcript;
}

/** Transport status to the semantic code the route above maps to HTTP. */
export function errorCodeForStatus(status: number): AsrErrorCode {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  return 'UPSTREAM_ERROR';
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

// ── the adapter ──────────────────────────────────────────────────────────────────────────────

/**
 * Transcribes one inline request.
 *
 * The two guards run before the transport is touched, in this order: an unaccepted container is
 * refused before anything is sized, and an oversized request is refused before anything is
 * encoded or sent. Neither produces an upstream call.
 */
export async function transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult> {
  if (!acceptsMime(request.audio.mimeType)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MIME',
      message:
        `provider '${id}' does not accept ${baseMimeType(request.audio.mimeType)}; ` +
        `it accepts ${capabilities.acceptsMime.join(', ')}`,
    };
  }

  const hints = honoredHints(request.hints);
  const requestBytes = measureInlineRequestBytes(request, hints);
  if (requestBytes > capabilities.maxInlineRequestBytes) {
    return {
      ok: false,
      code: 'OVERSIZE',
      message:
        `inline request of ${requestBytes} B exceeds provider '${id}' budget of ` +
        `${capabilities.maxInlineRequestBytes} B (the budget covers the whole request: audio, context ` +
        `and prompt together, not the audio alone)`,
    };
  }

  const endpoint = generateContentEndpoint(invocation.baseUrl, invocation.model);
  const body = JSON.stringify(buildInlineRequestBody(request, hints, base64Encode(request.audio.bytes)));
  const signal = invocation.signal ?? AbortSignal.timeout(invocation.timeoutMs);

  let response: Response;
  try {
    response = await invocation.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(invocation.apiKey ? { Authorization: `Bearer ${invocation.apiKey}` } : {}),
      },
      body,
      signal,
    });
  } catch (error) {
    return {
      ok: false,
      code: isAbortError(error) ? 'TIMEOUT' : 'UNREACHABLE',
      message: isAbortError(error)
        ? `provider '${id}' did not answer within ${invocation.timeoutMs} ms`
        : `provider '${id}' could not be reached`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: errorCodeForStatus(response.status),
      message: `provider '${id}' answered ${response.status}`,
      status: response.status,
    };
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    return { ok: false, code: 'UPSTREAM_ERROR', message: `provider '${id}' answer could not be read` };
  }

  let transcript: string;
  try {
    transcript = readTranscriptText(responseText);
  } catch {
    return {
      ok: false,
      code: 'UPSTREAM_ERROR',
      message: `provider '${id}' answer was not the inline generation envelope`,
    };
  }

  if (transcript === '') {
    return { ok: false, code: 'NO_SPEECH_DETECTED', message: `provider '${id}' returned no text part` };
  }

  return {
    ok: true,
    text: transcript,
    style: 'written',
    transformations: [...WRITTEN_STYLE_TRANSFORMATIONS],
    providerId: id,
    meta: { model: invocation.model },
  };
}

/** This module as the registry consumes it. */
export const adapter: AsrAdapter = { id, capabilities, transcribe };
