/**
 * The transcription wire protocol, in exactly one place.
 *
 * Three consumers reach this file and no consumer re-derives any of it:
 *
 *   · the browser's direct path (`src/shared/api.ts` builds the request, the chat hook
 *     reads the answer back),
 *   · the server's proxy path (`server/modules/voice/voice.service.ts`),
 *   · the command line (`experiments/voice-asr-cli/transcribe.ts`).
 *
 * Before this module existed the request construction and the response parsing were each
 * written twice, once per path, and the two copies had already drifted: the same upstream
 * answer that the direct path reports as an error is accepted as a transcript by the proxy
 * path. The divergence is not incidental, it is what two copies do — so the tolerance is
 * now an explicit argument (`TranscriptionTolerance`) that each path names at its call
 * site, rather than a property of whichever file you happen to be reading.
 *
 * ENVIRONMENT NEUTRALITY IS A MACHINE PROPERTY HERE, not a style choice. This file is
 * compiled by BOTH compiler configurations — the root one (lib ES2020 + DOM, types
 * `vite/client`, moduleResolution Bundler) and `server/tsconfig.json` (lib ES2022,
 * NodeNext, types `node`) — so it may use neither Node built-ins nor ES2021+ library
 * features, and every environment dependency (fetch, credentials, base URL) stays injected
 * at the call site. `npm run typecheck` compiling this one file under both configurations
 * is the reading that says so.
 */

/** The path every OpenAI-compatible transcription endpoint answers on. */
export const TRANSCRIPTION_PATH = '/audio/transcriptions';

/**
 * How much an upstream answer is allowed to be malformed before it is an error.
 *
 * `strict` is the direct path's historical behaviour: a body that is not JSON throws, and
 * the caller reports a failed transcription. `lenient` is the proxy path's: a body that is
 * not JSON is handed back verbatim as if it were a transcript. Both are kept because
 * collapsing them would change what one of the two paths does with a gateway error page.
 */
export type TranscriptionTolerance = 'strict' | 'lenient';

/** Where the request goes and who it authenticates as. */
export type TranscriptionTarget = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/**
 * The audio half of the request. Callers hand over a `Blob` so the bytes and their declared
 * container travel together: the browser passes the recorded (or trimmed) blob straight
 * through, and Node builds one around the bytes it already has.
 */
export type TranscriptionUpload = {
  audio: Blob;
  fileName: string;
};

/** A method-agnostic description of the one request this protocol defines. */
export type TranscriptionRequest = {
  url: string;
  init: RequestInit;
};

function authorizationHeader(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Joins the configured base URL with the transcription path.
 *
 * A base URL typed with a trailing slash is a base URL, not a different endpoint, so the
 * slash is dropped before the join rather than doubled into the path. Both paths reach the
 * endpoint through this function: the server's own composition root already trims the
 * variable it reads, so this is the same string it built before, and the browser's settings
 * no longer decide whether the endpoint is reachable.
 */
export function transcriptionEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${TRANSCRIPTION_PATH}`;
}

/** Builds the multipart POST an OpenAI-compatible transcription endpoint expects. */
export function createTranscriptionRequest(
  target: TranscriptionTarget,
  upload: TranscriptionUpload,
): TranscriptionRequest {
  const body = new FormData();
  body.append('file', upload.audio, upload.fileName);
  body.append('model', target.model);

  return {
    url: transcriptionEndpoint(target.baseUrl),
    init: {
      method: 'POST',
      headers: authorizationHeader(target.apiKey),
      body,
    },
  };
}

/**
 * Reads the transcript out of an already-consumed response body, under the named tolerance.
 *
 * The two branches are the two historical implementations, kept apart on purpose and
 * selected by an argument rather than by which file the call is in. `strict` propagates the
 * parse failure (the caller's `catch` turns it into a failed transcription); `lenient`
 * treats an unparseable body as the transcript itself.
 */
export function parseTranscriptionResponse(
  responseText: string,
  tolerance: TranscriptionTolerance,
): string {
  if (tolerance === 'lenient') {
    try {
      const parsed = JSON.parse(responseText) as { text?: unknown };
      return typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      return responseText;
    }
  }

  const parsed = JSON.parse(responseText) as { text?: unknown } | null;
  return String(parsed?.text || '');
}
