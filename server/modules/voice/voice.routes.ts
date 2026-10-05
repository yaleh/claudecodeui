import { Readable } from 'node:stream';

import express from 'express';

import type {
  VoiceLexiconService,
  VoiceRequestOverrides,
  VoiceService,
  VoiceServiceResult,
  VoiceSettingsService,
} from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';

type VoiceRouterDependencies = {
  voiceService: VoiceService;
  voiceSettingsService: VoiceSettingsService;
  /**
   * The U-source lexicon: the identifier-shaped tokens the user has sent.
   *
   * A SEPARATE SERVICE rather than a section of `voiceService`, because it holds a
   * different dependency — a token store and a history source, not an outbound
   * recogniser — and because one of its three routes reads no audio at all.
   */
  lexiconService: VoiceLexiconService;
  parseAudioUpload: express.RequestHandler;
  /**
   * The multipart parser for the raw-corpus endpoint, with its OWN size ceiling.
   *
   * A SEPARATE PARSER rather than reusing `parseAudioUpload`: raw audio is 16 kHz mono PCM (about
   * 32 KB/s) and can be minutes long, so its ceiling is its own figure rather than the recogniser
   * upload's provider-derived one. The composition root builds both from the same multer factory.
   */
  parseRawAudioUpload: express.RequestHandler;
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

/**
 * The optional `listenId` text field a paired or raw request carries.
 *
 * MULTER HAS ALREADY PARSED IT: a multipart text field arrives in `request.body`, so this reads what
 * the parser put there rather than re-reading the stream. It answers `undefined` for an absent,
 * non-string or blank field — a blank id is not an id — which is what lets the raw route refuse an
 * unpaired upload and lets `/transcribe` leave the key off a row that was never paired.
 */
function readListenIdField(request: express.Request): string | undefined {
  const value = (request.body as Record<string, unknown> | undefined)?.listenId;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
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
 * The listing ceiling the `?limit=` query asks for.
 *
 * A CLAMP, not a refusal: this is a read of the caller's own vocabulary, so an
 * absent, unparseable or out-of-range `limit` costs nothing to answer with the
 * default or the cap rather than a `400` the caller would have to handle for a
 * number that only trims a list. `DEFAULT_LEXICON_LIMIT` is what an unqualified
 * read returns; `MAX_LEXICON_LIMIT` keeps one request from materialising the
 * whole vocabulary of a heavy user.
 */
const DEFAULT_LEXICON_LIMIT = 100;
const MAX_LEXICON_LIMIT = 1000;

function readLexiconLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LEXICON_LIMIT;
  }

  return Math.min(Math.floor(parsed), MAX_LEXICON_LIMIT);
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
        //
        // `listenId` rides through only when the request named one, so an unpaired request's capture
        // row has no `listenId` key at all rather than an empty one — the module's own convention,
        // applied at the one place the field could enter the row. It does not change this response.
        const listenId = readListenIdField(request);
        const result = await dependencies.voiceService.transcribe({
          audio: {
            bytes: request.file.buffer,
            mimeType: request.file.mimetype || 'audio/webm',
            fileName: request.file.originalname || 'recording.webm',
          },
          overrides: parseVoiceOverrides(request),
          settings: dependencies.voiceSettingsService.getSettings(readUserId(request)),
          ...(listenId === undefined ? {} : { listenId }),
        });

        if (sendFailure(response, result)) {
          return;
        }

        response.json(result.value);
      })().catch(next);
    });
  });

  // THE RAW-CORPUS ENDPOINT: the audio BEFORE the VAD, uploaded for a passive corpus rather than to
  // be transcribed. It is separate from `/transcribe` because the bytes are a different object — the
  // trim's own removal is exactly what makes them unrecoverable from the trimmed upload — and
  // because a deployment collects them only when its own `VOICE_CAPTURE_RAW` switch says so.
  //
  // THE ROUTE ONLY PARSES, CALLS AND RESPONDS. Whether the bytes are written, and the no-op when the
  // switch is off, is the SERVICE's decision off the capture port; a route that consulted the switch
  // itself would be a second reader of a value the port already holds.
  router.post('/capture/raw', (request, response, next) => {
    dependencies.parseRawAudioUpload(request, response, (uploadError?: unknown) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        const failure = readUploadFailure(uploadError);
        response.status(failure.status).json({ error: message, code: failure.code });
        return;
      }

      try {
        const listenId = readListenIdField(request);
        // A raw row exists to be PAIRED with a listen's trimmed rows and text, so a request that
        // carries no `listenId` is as unusable as one that carries no audio — refused in the same
        // words and with the same code `/transcribe` refuses a missing file. See
        // `MALFORMED_UPLOAD_CODE`.
        if (!request.file || listenId === undefined) {
          response.status(400).json({ error: 'No raw audio uploaded', code: MALFORMED_UPLOAD_CODE });
          return;
        }

        const result = dependencies.voiceService.captureRaw({
          listenId,
          audio: {
            bytes: request.file.buffer,
            mimeType: request.file.mimetype || 'application/octet-stream',
            fileName: request.file.originalname || 'raw.bin',
          },
        });
        if (sendFailure(response, result)) {
          return;
        }

        response.json(result.value);
      } catch (error) {
        // `captureRaw` answers with a result rather than throwing, so this is the bug path — a
        // malformed request object, a middleware that already responded — forwarded rather than
        // swallowed.
        next(error);
      }
    });
  });

  // The capability reading: whether this deployment collects raw audio at all.
  //
  // ITS OWN ROUTE RATHER THAN A FIELD ON `/health`, which is a per-user PROVIDER reading consumed by
  // `useVoiceAvailable`: a deployment capability folded into it would be read by every client that
  // only wanted to know whether voice works, and would sit beside fields whose subject is the user's
  // configured backend, not the process's environment.
  router.get('/capture', (_request, response) => {
    response.json(dependencies.voiceService.captureState());
  });

  // THE USER'S OWN KEPT RECORDINGS: the other half of the D1 promise the settings page turns on by
  // default ("stored on this machine, and clearable in one action"). A `DELETE` of the resource the
  // store holds, and the same request the settings page's confirm button sends.
  //
  // IT ANSWERS WITH A COUNT rather than `204`, unlike the lexicon's `DELETE` above: the settings page
  // reports how many recordings were removed, and that number is the one thing the caller could not
  // have computed for itself — the store is the only thing that knows. A deployment or user with no
  // store yet answers `0` at `200`, which is the "nothing to clear is a clear that succeeded" case.
  router.delete('/data', (_request, response) => {
    response.json(dependencies.voiceService.clearVoiceData?.() ?? { deleted: 0 });
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

  // THE U-SOURCE LEXICON. The identifier-shaped words THIS user has typed, most
  // frequent first — the first word source the voice feature derives from the
  // user's own vocabulary rather than from a model.
  //
  // WHAT CROSSES THIS BOUNDARY IS THE TOKEN LIST, never the sentences behind it:
  // the store only holds a token, its count and its timestamps (see
  // `VoiceIdentifierListItem`), so there is nothing here a caller could mine text
  // out of even if a route asked for it wrongly. The route's whole job is to read
  // the clamped `?limit=` and hand it to the service.
  router.get('/lexicon', (request, response) => {
    response.json({ tokens: dependencies.lexiconService.list(readLexiconLimit(request.query.limit)) });
  });

  // Empties the lexicon. A `DELETE` rather than a `POST .../clear` because it is
  // the plain removal of the resource the GET above reads, and it answers with
  // nothing to say: the caller asked for the vocabulary to be gone, and whether
  // it was is the next GET's answer.
  router.delete('/lexicon', (_request, response) => {
    dependencies.lexiconService.clear();
    response.status(204).end();
  });

  // THE COLD START: recompute the lexicon from the whole indexed message history.
  //
  // It is a `POST` because it WRITES (it replaces the table) and it is not
  // idempotent for free — the service makes it so by deriving the counts afresh
  // rather than adding to what is there, which is what lets the route be retried
  // without a doubling. The transport reads the history through the service's own
  // source, so this route never learns which session or transcript a token came
  // from; the response is only the two figures that say the pass ran.
  router.post('/lexicon/import', asyncHandler(async (_request, response) => {
    response.json(await dependencies.lexiconService.importFromHistory());
  }));

  return router;
}
