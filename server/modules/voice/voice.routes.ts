import { Readable } from 'node:stream';

import express from 'express';

import type {
  VoiceRequestOverrides,
  VoiceService,
  VoiceServiceResult,
  VoiceSettingsService,
} from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';

type VoiceRouterDependencies = {
  voiceService: VoiceService;
  voiceSettingsService: VoiceSettingsService;
  parseAudioUpload: express.RequestHandler;
};

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

/**
 * Reads the authenticated user id the auth middleware attached.
 *
 * The whole `/api/voice` router is mounted behind `authenticateToken`, so a
 * request that reaches a handler always has one; `Number(undefined)` would be
 * `NaN` and match no row, which fails closed rather than serving another user's
 * settings.
 */
function readUserId(request: express.Request): number {
  return Number((request as AuthenticatedRequest).user?.id);
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const trimmedValue = normalizedValue?.trim();
  return trimmedValue || undefined;
}

function parseVoiceOverrides(request: express.Request): VoiceRequestOverrides {
  return {
    apiKey: readHeaderValue(request.headers['x-voice-api-key']),
    sttModel: readHeaderValue(request.headers['x-voice-stt-model']),
    ttsModel: readHeaderValue(request.headers['x-voice-tts-model']),
    ttsVoice: readHeaderValue(request.headers['x-voice-tts-voice']),
    ttsFormat: readHeaderValue(request.headers['x-voice-tts-format']),
    providerId: readHeaderValue(request.headers['x-voice-provider']),
  };
}

function sendFailure<TValue>(
  response: express.Response,
  result: VoiceServiceResult<TValue>,
): result is Extract<VoiceServiceResult<TValue>, { ok: false }> {
  if (result.ok) {
    return false;
  }

  // The semantic code rides beside the message whenever the failure has one, and the upstream's own
  // code beside that when the upstream named one. It is dropped rather than defaulted for the few
  // failures that have none: a placeholder code would read as a classification, and a client
  // branching on it would treat "the backend did not answer" as a kind of bad upload. See
  // `VoiceServiceResult.code` for which those are — they are refusals that never became an attempt
  // (a setting that is not a URL, an id nothing is registered for), not failures of one.
  response.status(result.status).json({
    error: result.error,
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.upstreamCode === undefined ? {} : { upstreamCode: result.upstreamCode }),
  });
  return true;
}

/**
 * The status an upload-parser failure owes.
 *
 * Multer reports "the upload is larger than the configured ceiling" as a `MulterError` whose
 * `code` is `LIMIT_FILE_SIZE`. That used to reach the client as `400`, which reads as "the request
 * was malformed" — and a client cannot tell a container problem from a size problem from a
 * malformed body, so the remedy it shows is wrong for two of the three. A size refusal is `413`,
 * which is the same answer the provider-level gate gives, so the two layers of the one limit agree
 * on how to say no.
 *
 * Read off the error's own `code` property rather than by importing multer here: this router is
 * deliberately transport-only and hands the parser in, so it knows the parser's vocabulary and not
 * its implementation.
 */
const UPLOAD_TOO_LARGE = 'LIMIT_FILE_SIZE';

/**
 * The code the two pre-provider upload refusals carry: a parser failure that is not the ceiling, and
 * a request that arrived with no file at all.
 *
 * WHY THESE TWO AND NOT THE REMEDY'S OWN WORD. The vocabulary is the recogniser seam's and is
 * CLOSED — its members name what a recogniser can say about an attempt — so there is no member for
 * "the multipart body was malformed" or "the audio field was missing". The choice is therefore which
 * existing member means closest, and it is `UNSUPPORTED_MIME`: of the ten, it is the one member that
 * is about the UPLOAD AS IT ARRIVED rather than about the service (a missing key, an unreachable
 * host), about the audio's content (no speech in it), or about a limit on its size. Both of these
 * refusals are that same sentence in the caller's terms — "what you sent is not an audio upload this
 * path can serve" — so they share the word, and they keep their own statuses (`400`, which is what
 * the parser's failures have always answered) because the status and the code are answering
 * different questions here: the status is the transport's, the code is the reason.
 *
 * A member of the SHIPPED vocabulary rather than a new string, and a member that survives the
 * vocabulary's evidence-driven expansion: a code invented here would be a second source of truth for
 * a set the criterion reads off `PROVIDER_ERROR_STATUS` at runtime.
 *
 * The size refusal above is not this constant because it is not this sentence: `OVERSIZE` has a
 * remedy of its own (a shorter recording), which is exactly why the two are two statuses.
 */
const MALFORMED_UPLOAD_CODE = 'UNSUPPORTED_MIME';

function readUploadFailure(error: unknown): { status: number; code: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return code === UPLOAD_TOO_LARGE
    ? { status: 413, code: 'OVERSIZE' }
    : { status: 400, code: MALFORMED_UPLOAD_CODE };
}

/**
 * Creates the transport-only router used by the Voice composition root. It is
 * exported for Voice route tests; other modules consume only the composed
 * router exposed from the Voice barrel.
 */
export function createVoiceRouter(dependencies: VoiceRouterDependencies): express.Router {
  const router = express.Router();

  // The health reading is per user: it answers with the configuration the caller's own stored
  // settings produce, not with the server process's environment. The route's only job is to
  // fetch that user's settings and hand them over — what "configured" means is the service's.
  router.get('/health', (request, response) => {
    const result = dependencies.voiceService.getHealth({
      settings: dependencies.voiceSettingsService.getSettings(readUserId(request)),
    });
    if (sendFailure(response, result)) {
      return;
    }

    response.json(result.value);
  });

  // The user's own backend settings. Reading them back is what lets a second
  // device (or the same device on another origin) pick up a configuration the
  // user saved somewhere else, instead of starting from nothing.
  //
  // WHAT CROSSES THIS BOUNDARY IS THE MASKED DOCUMENT, not the stored one: a credential the SERVER
  // holds and presents upstream is not something a readback has any use for, and a response is the
  // one place it would outlive the request. The mask is applied by the settings service rather than
  // here — see `maskForReadback` — because which fields are credentials is a provider's declaration
  // and this router knows no provider. `getHealth` above still reads the STORED document, which is
  // the point: a masked key would be a non-empty string and every provider would read as configured.
  router.get('/config', (request, response) => {
    const settings = dependencies.voiceSettingsService.getSettings(readUserId(request));
    response.json(dependencies.voiceSettingsService.maskForReadback(settings));
  });

  // A whole-document PUT rather than a patch: the settings tab always has all
  // ten fields on screen, and an empty string is the explicit "clear this". The
  // answer is masked for the same reason the read is: the client compares the two
  // responses, and the saved document is not a second exemption from the rule.
  router.put('/config', (request, response) => {
    const result = dependencies.voiceSettingsService.saveSettings(readUserId(request), request.body);
    if (sendFailure(response, result)) {
      return;
    }

    response.json(dependencies.voiceSettingsService.maskForReadback(result.value));
  });

  router.post('/transcribe', (request, response, next) => {
    dependencies.parseAudioUpload(request, response, (uploadError?: unknown) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        const failure = readUploadFailure(uploadError);
        response.status(failure.status).json({ error: message, code: failure.code });
        return;
      }

      // Multer uses a callback API, so bridge its parsed request into the async
      // service call and forward unexpected rejections to Express middleware.
      void (async () => {
        if (!request.file) {
          // The same code the parser's other failures carry, for the same reason: the audio this
          // route was asked to transcribe is not there, which is a fault in the upload the caller
          // can fix and not one of the recogniser's. See `MALFORMED_UPLOAD_CODE`.
          response.status(400).json({ error: 'No audio uploaded', code: MALFORMED_UPLOAD_CODE });
          return;
        }

        // The stored document rides along as the STORED document — unmasked, because the wire is
        // where a server-held credential is supposed to be presented. It is the same read the
        // health route makes, so "which provider is configured" and "which credential an attempt
        // uses" are answered from one document rather than from two that could drift.
        const result = await dependencies.voiceService.transcribe({
          audio: {
            bytes: request.file.buffer,
            mimeType: request.file.mimetype || 'audio/webm',
            fileName: request.file.originalname || 'recording.webm',
          },
          overrides: parseVoiceOverrides(request),
          settings: dependencies.voiceSettingsService.getSettings(readUserId(request)),
        });

        if (sendFailure(response, result)) {
          return;
        }

        response.json(result.value);
      })().catch(next);
    });
  });

  router.post('/tts', asyncHandler(async (request, response) => {
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      response.status(400).json({ error: 'text required' });
      return;
    }

    const result = await dependencies.voiceService.synthesizeSpeech({
      text,
      overrides: parseVoiceOverrides(request),
    });
    if (sendFailure(response, result)) {
      return;
    }

    response.setHeader('Content-Type', result.value.contentType);
    response.setHeader('Cache-Control', 'no-store');
    if (!result.value.body) {
      response.end();
      return;
    }

    Readable.fromWeb(result.value.body).on('error', (error) => response.destroy(error)).pipe(response);
  }));

  return router;
}
