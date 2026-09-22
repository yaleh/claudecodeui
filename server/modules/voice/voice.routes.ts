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

  // The semantic code rides beside the message when the refusal has one. It is dropped rather than
  // defaulted for the failures that do not: a placeholder code would read as a classification, and
  // a client branching on it would treat "the backend did not answer" as a kind of bad upload.
  response
    .status(result.status)
    .json(result.code === undefined ? { error: result.error } : { error: result.error, code: result.code });
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

function readUploadFailure(error: unknown): { status: number; code?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return code === UPLOAD_TOO_LARGE ? { status: 413, code: 'OVERSIZE' } : { status: 400 };
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
  router.get('/config', (request, response) => {
    response.json(dependencies.voiceSettingsService.getSettings(readUserId(request)));
  });

  // A whole-document PUT rather than a patch: the settings tab always has all
  // six fields on screen, and an empty string is the explicit "clear this".
  router.put('/config', (request, response) => {
    const result = dependencies.voiceSettingsService.saveSettings(readUserId(request), request.body);
    if (sendFailure(response, result)) {
      return;
    }

    response.json(result.value);
  });

  router.post('/transcribe', (request, response, next) => {
    dependencies.parseAudioUpload(request, response, (uploadError?: unknown) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        const failure = readUploadFailure(uploadError);
        response
          .status(failure.status)
          .json(failure.code === undefined ? { error: message } : { error: message, code: failure.code });
        return;
      }

      // Multer uses a callback API, so bridge its parsed request into the async
      // service call and forward unexpected rejections to Express middleware.
      void (async () => {
        if (!request.file) {
          response.status(400).json({ error: 'No audio uploaded' });
          return;
        }

        const result = await dependencies.voiceService.transcribe({
          audio: {
            bytes: request.file.buffer,
            mimeType: request.file.mimetype || 'audio/webm',
            fileName: request.file.originalname || 'recording.webm',
          },
          overrides: parseVoiceOverrides(request),
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
