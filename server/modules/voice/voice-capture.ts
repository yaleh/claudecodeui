import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// The output port the attempt line already goes through. The capture row is written with the same
// one, so a deployment that pipes the process's structured lines somewhere sees both kinds without a
// second seam, and a test that counts them counts what the shipping process writes.
import type { VoiceLogPort } from '@/shared/types.js';

/**
 * The three modes `VOICE_CAPTURE` resolves to.
 *
 * `off` is not "no value": it is the mode an unset variable, an explicit `off`, and every value the
 * resolver does not recognise all read as. That is deliberate — an unrecognised value must fail
 * CLOSED, because a deployment that misspells a recording mode must end up recording nothing rather
 * than recording the thing it meant to keep out of the log.
 *
 * The two recording modes differ in where an attempt goes: `text` writes the attempt as a row on the
 * process's own output, `audio` additionally writes the uploaded bytes into a directory. Which of the
 * two a deployment wants is a privacy decision, not a debugging detail, which is why it is read once
 * at start-up and never per request.
 */
export type VoiceCaptureMode = 'off' | 'text' | 'audio';

/**
 * What one raw `VOICE_CAPTURE` value resolves to.
 *
 * `warning` is the TEXT of the one warning line an unrecognised value earns — non-null exactly when
 * `mode` was not recognised, and carrying the offending value verbatim. Carrying the text rather than
 * a boolean is what lets the composition root write the line without deciding anything: the decision
 * about what an unrecognised value means is the resolver's, and the root only prints what it is
 * handed.
 */
export type VoiceCaptureResolution = {
  mode: VoiceCaptureMode;
  warning: string | null;
};

/**
 * The audio one attempt sent, exactly as it was uploaded.
 *
 * The bytes are the uploaded buffer itself, never a copy, an encoding, or a re-serialisation: a
 * recording that is written to disk has to be the recording that was transcribed, or the file cannot
 * be replayed and the sha256 beside it is a hash of something else.
 */
export type VoiceCaptureAudio = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
};

/**
 * What the transport answered an attempt, exactly as it was read.
 *
 * THE BODY IS A STRING THIS MODULE DID NOT WRITE. It is the upstream's own answer, byte for byte, and
 * it is here rather than in the service because a row that recorded the text the caller finally got
 * would answer a different question — "what did we send back" instead of "what did they say" — and
 * the two differ exactly when the answer was a failure, which is when a reader needs the second one.
 *
 * IT CARRIES NOTHING OF THE REQUEST. The transport hands this module an answer; the request's body
 * and headers are not part of it and are not fields here, so "no credential, no prompt and no header
 * is in the row" stays a property of the shape rather than a filter to remember — see
 * `buildVoiceCapturePayload`, the one place a row is built.
 */
export type VoiceCaptureRawReturn = {
  status: number;
  body: string;
};

/**
 * The raw answer as it goes into a row: verbatim while it fits, a flagged prefix when it does not.
 *
 * `truncated` is ABSENT rather than `false` when nothing was cut. The two are not the same reading to
 * a consumer: an absent key says "this is all of it", while `truncated: false` says "this is a field
 * that could have been true". Only one of those is a promise the row can keep — a body that fits is
 * the answer itself, and marking it would put a field on every row that means nothing on any of them.
 */
export type VoiceCaptureUpstream = {
  status: number;
  body: string;
  truncated?: true;
};

/**
 * The most of an upstream answer one row ever carries, in UTF-8 bytes.
 *
 * A CONSTANT, and exported, because the criterion that reads both sides of the cut has to name the
 * same number the implementation uses: a threshold spelled twice is a threshold that can drift, and
 * the drift would be invisible — a row cut at 65536 and a criterion checking 65537 disagree only
 * about the byte after the last one. 64 KiB is the size a row stays readable at: past it a log line
 * stops being something an operator can look at and becomes a file transfer.
 */
export const RAW_RETURN_LIMIT_BYTES = 65536;

/**
 * The six answers one attempt's outcome falls into, as a CLOSED set.
 *
 * The first two are the two ways a written recogniser succeeds — it produced the instruction it was
 * asked for, or it degraded to the transcription and said so through `meta.writtenFallback`. The next
 * two are the two ways a 2xx answer fails to be usable — the service heard nothing (an envelope that
 * parsed with neither field in it) or the answer was not this service's envelope at all. The last two
 * are the two ways an attempt ends without a usable answer: the transport answered and the answer was
 * a refusal, or no transport was reached at all.
 *
 * A closed set rather than a free string because a reader selects on it: "how often does this
 * deployment degrade to a transcription" and "how often is the upstream refusing us" are two
 * different questions, and they are answerable from a row only if both answers have a name.
 */
export type VoiceCaptureBranch =
  | 'written'
  | 'verbatim-fallback'
  | 'no-speech'
  | 'envelope-error'
  | 'upstream-failure'
  | 'preflight-refused';

/**
 * What one attempt READ: the adapter's answer, narrowed to the scalars a branch is decided from.
 *
 * `code` is the adapter's own vocabulary for a failure and `writtenFallback` its own for a degraded
 * success, so the branch below is derived from what the adapter said rather than from a second parse
 * of the response. `text` is what the attempt returned to its caller — the instruction on the written
 * branch, the transcription on the degraded one, and the empty string on every failure, because a
 * failure returned no text and inventing one would make the row read as a success.
 */
export type VoiceCaptureAttemptReading = {
  ok: boolean;
  code?: string;
  writtenFallback?: number;
  text: string;
};

/**
 * The NARROWED input the row is built from.
 *
 * THIS IS THE INTERFACE THE ROW'S CONTENTS ARE DECIDED AT, and it is narrow on purpose: a field that
 * is not here cannot reach a row no matter what the caller has in hand. The service holds a request
 * (a URL, an init, a credential); what crosses this boundary is the address the attempt used, the
 * upload, the answer the transport gave back, and the four scalars above. Nothing of the request's
 * headers or body has a name here, which is what makes "the row does not carry them" structural.
 */
export type VoiceCapturePayloadInput = {
  model: string;
  /** The address the attempt used. Only its host is ever written; see `voiceCaptureHost`. */
  baseUrl: string;
  audio: VoiceCaptureAudio;
  /** The raw answer this attempt read, or `null` when it read none. */
  upstream: VoiceCaptureRawReturn | null;
  /**
   * Whether this attempt reached the transport at all.
   *
   * THIS IS NOT `upstream !== null`, and the difference is the reason it is a field. An attempt whose
   * request went out and whose answer could not be read has no `upstream` and is still not a preflight
   * refusal; an attempt refused before the transport has no `upstream` because nothing was sent. Only
   * the service can tell those two apart — it is the side the request leaves from — so it says which
   * one happened rather than leaving the builder to infer it from a consequence that both produce.
   */
  requestSent: boolean;
  reading: VoiceCaptureAttemptReading;
};

/**
 * The payload half of a row: what the attempt actually used, actually sent, and actually got back.
 *
 * Every field is either computed here (`host`, `bytes`, `sha256`, `branch`) or a copy of something
 * read (`model`, `mime`, `upstream`, `text`) — and the two of those that could carry a secret are the
 * two that cannot: `sha256` is a digest of the upload rather than the upload, and `upstream` is an
 * ANSWER, so a credential that went out in a request header is not in it. The upload's bytes are the
 * one thing that would be a recording in the log, and they are represented by a hash and a length.
 */
export type VoiceCapturePayload = {
  model: string;
  host: string;
  mime: string;
  bytes: number;
  sha256: string;
  upstream: VoiceCaptureUpstream | null;
  branch: VoiceCaptureBranch;
  text: string;
};

/**
 * One attempt, as the record construction point sees it.
 *
 * Every field here is one this module or the service COMPUTED — a provider id, an outcome, a status,
 * a duration — plus the upload and, on a recording deployment, the narrowed payload input. No
 * message, no credential, no header and no prompt can reach it, because none of them is a field:
 * "the row has no secret in it" is a property of the row's shape rather than of a filter someone has
 * to remember to keep in step.
 *
 * The audio travels with the attempt rather than through a second seam because the row and the file
 * must describe the same bytes: a writer handed a different copy than the one the row hashes would
 * make the two halves of a recording disagree with nothing on screen to say so. The payload travels
 * the same way — see `buildVoiceCapturePayload`.
 */
export type VoiceCaptureAttempt = {
  providerId: string;
  outcome: 'ok' | 'fail';
  status: number;
  audio: VoiceCaptureAudio;
  /**
   * The payload refinement, when this deployment records one.
   *
   * ABSENT MEANS THE ATTEMPT IS RECORDED WITHOUT IT — the row this module has always written. The
   * field exists so the refinement is an ARGUMENT rather than a property of the mode: a criterion
   * that builds a port and hands it an attempt decides what that attempt recorded, and a mode that
   * records nothing still constructs no attempt at all (see the gate in `createVoiceService`).
   */
  payload?: VoiceCapturePayloadInput;
};

/**
 * The audio half of the seam: where a recording goes, and the write itself.
 *
 * IT IS A DEPENDENCY OF THE PORT RATHER THAN OF THE SERVICE, because the service must not know that
 * `audio` mode exists beyond the fact that it records. A deployment supplies the sink — and the
 * directory resolution happens on the first write rather than at start-up, which is what makes "a
 * mode that writes nothing creates no directory anywhere, not even a configured one" a structural
 * property instead of a promise.
 *
 * The shipping implementation (the file write, its 0700/0600 permissions and the directory's
 * creation) belongs to the audio half of the same seam; a deployment that supplies no sink records
 * its attempt rows and puts nothing on disk.
 */
export type VoiceCaptureAudioSink = {
  /** Resolves the directory a recording goes into, at the moment one is actually written. */
  resolveDirectory(): string;
  /** Writes one attempt's uploaded bytes into `directory`. */
  writeAudio(directory: string, audio: VoiceCaptureAudio): void;
};

/**
 * The recording seam the service writes attempts through.
 *
 * TWO CALLS PER ATTEMPT, AND THE ORDER IS THE REASON. `newAttemptId` names the attempt before its
 * `voice.transcribe` line is written, so that line can carry the id; `recordAttempt` writes the
 * capture row immediately AFTER it. One call could not do both: the attempt line has to be the first
 * of the two (a reader following the process's output sees the attempt, then what was recorded about
 * it), and an implementation that minted the id inside the row call would have no id to put on the
 * line that comes first.
 *
 * `mode` is on the port rather than on the service's dependencies so that the one gate lives in one
 * place in the service — see the `recording` binding in `createVoiceService` — and so that a port
 * built for `off` is a port the service can be handed and still record nothing with.
 */
export type VoiceCapturePort = {
  mode: VoiceCaptureMode;
  /** Names one attempt, before its attempt line is written. */
  newAttemptId(): string;
  /** Writes one attempt's row. THE single record construction point. */
  recordAttempt(captureId: string, attempt: VoiceCaptureAttempt): void;
};

/** The marker every capture row carries as its `event`. */
export const VOICE_CAPTURE_EVENT = 'voice.capture';

/** The directory name a recording goes into when `VOICE_CAPTURE_DIR` names none. */
const CAPTURE_DIRECTORY_NAME = 'voice-capture';

/** Where the database lives when `DATABASE_PATH` names none — `server/load-env.ts`'s own default. */
const DEFAULT_DATABASE_FILE = '.cloudcli/auth.db';

/**
 * The mode a raw `VOICE_CAPTURE` value names, and the warning it earns if it names none.
 *
 * THE ARGUMENT IS THE RAW VALUE, NOT `process.env`. Reading the variable here would put a second
 * reader of it somewhere other than the composition root, and "the environment is read exactly once
 * at start-up" is precisely the property this function exists to make checkable: the root reads it,
 * hands the text over, and everything downstream sees only the mode.
 *
 * Blank is the same reading as absent, which is the convention every other value this module's
 * deployment reads uses. A value that is neither blank, `off`, `text` nor `audio` is not a mode: it
 * reads as `off` AND earns a warning naming it, because a deployment whose variable is misspelled
 * would otherwise be silently off with nobody able to tell the two reasons apart.
 */
export function resolveVoiceCaptureMode(raw: string | undefined): VoiceCaptureResolution {
  const value = raw === undefined ? '' : raw.trim();

  if (value === '' || value === 'off') {
    return { mode: 'off', warning: null };
  }
  if (value === 'text' || value === 'audio') {
    return { mode: value, warning: null };
  }

  return { mode: 'off', warning: voiceCaptureWarningLine(value) };
}

/**
 * The start-up line: the one line that says which mode the process actually came up in.
 *
 * It is a function of the mode rather than of the variable, so the line reports what the deployment
 * IS rather than what it was configured with — the two differ exactly when the value was
 * unrecognised, and there the warning line beside it says so.
 *
 * Consumed by `announceVoiceCapture` below, which is what the composition root calls, and by
 * `tests/voice-capture-off.test.ts`, which reads the line off THIS function rather than repeating
 * the text: a criterion that spelled the line itself would pass against a module whose producer had
 * stopped producing it.
 */
export function voiceCaptureStartupLine(mode: VoiceCaptureMode): string {
  return `voice.capture mode=${mode}`;
}

/**
 * The warning line an unrecognised value earns, naming the value.
 *
 * The value is quoted through `JSON.stringify`, which is what keeps the line exactly ONE line: a
 * variable pasted with a trailing newline, or with a stray quote, would otherwise either split the
 * reading in two or make the line unparseable — and a warning a reader cannot read in one line is
 * not a warning.
 *
 * Consumed by `announceVoiceCapture` below and by `tests/voice-capture-off.test.ts`, which compares
 * the announced warning against this function's own output for the same offending value.
 */
export function voiceCaptureWarningLine(value: string): string {
  return `voice.capture invalid value ${JSON.stringify(value)}; recording is off`;
}

/**
 * THE function the composition root calls: resolve the mode, say it, and hand it back.
 *
 * Reading the variable, deciding the mode, and writing the start-up line are one call on purpose.
 * Split across a root that reads and a root that decides, "the mode the process announced" and "the
 * mode the service records in" could drift apart, and the announcement would then be a description
 * of a configuration nothing used. Here the resolution the root announces IS the resolution it
 * injects.
 *
 * The warning goes through the same port as the start-up line and the attempt lines, so a deployment
 * that collects this process's structured output has one stream to read rather than two.
 */
export function announceVoiceCapture(raw: string | undefined, log: VoiceLogPort): VoiceCaptureResolution {
  const resolution = resolveVoiceCaptureMode(raw);

  log.info(voiceCaptureStartupLine(resolution.mode));
  if (resolution.warning !== null) {
    log.info(resolution.warning);
  }

  return resolution;
}

/**
 * The directory a recording goes into: the explicit setting when there is one, otherwise a directory
 * beside the database.
 *
 * THE INPUTS ARE ARGUMENTS, NOT `process.env`, for the same reason the mode's are: the composition
 * root is the one reader of the environment, and a resolver that read it itself could not be asked
 * what a given pair of values means without mutating the process first.
 *
 * "Beside the database" rather than "in the home directory" is what makes the default follow a
 * deployment that moved its data: a directory resolved from a literal home path would put recordings
 * somewhere other than the state they belong to, and would do it the moment `DATABASE_PATH` was set.
 * The fallback when `databasePath` names nothing is `server/load-env.ts`'s own default, so a
 * deployment that never set it gets the same answer here as there.
 *
 * This function only COMPUTES the path. Nothing creates the directory — the writer does, on the
 * first recording it actually writes — which is why a mode that writes no audio leaves no directory
 * behind even when one is configured.
 */
export function resolveVoiceCaptureDir(raw: string | undefined, databasePath: string | undefined): string {
  const explicit = raw === undefined ? '' : raw.trim();
  if (explicit !== '') {
    return explicit;
  }

  const database = databasePath === undefined || databasePath.trim() === ''
    ? path.join(os.homedir(), DEFAULT_DATABASE_FILE)
    : databasePath;
  return path.join(path.dirname(database), CAPTURE_DIRECTORY_NAME);
}

/**
 * The host an address names, or the empty string when it names none.
 *
 * THE HOST, NOT THE ADDRESS. A `baseUrl` is a deployment's own setting and may carry a port, a path
 * or a query — none of which belongs in a row whose job is to say WHICH service answered. The
 * hostname is the part that names the service, and it is a reading rather than a redaction: nothing
 * is removed from it that a reader would want, and a credential has never been part of it.
 *
 * `''` rather than a throw for an unparseable address: the row is written on paths where the address
 * has already been refused (see the gates in `voice.service.ts`), and a recorder that threw there
 * would turn a refusal into a crash. The empty string is the honest answer to "which host" when the
 * configuration named no host at all.
 */
export function voiceCaptureHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * The digest a row carries in place of the upload: 64 lowercase hex characters of sha256.
 *
 * A DIGEST AND NOT THE BYTES, which is the whole reason it is here. A recording is the one thing on
 * this path that must never reach a log line, and a row that carried the upload — in any encoding —
 * would be a copy of a user's voice in the process's output. The hash answers the question a reader
 * actually asks of a row ("is the thing that was sent the thing I think it was") without being
 * replayable, and it is computed over the SAME buffer the adapter was handed rather than a
 * re-encoding of it, so the answer is about the bytes that were sent.
 */
export function voiceCaptureSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The longest prefix of `source` that is a whole number of UTF-8 characters and at most `limit` bytes.
 *
 * WHY NOT SIMPLY THE FIRST `limit` BYTES. Cutting a multi-byte character in half produces a string
 * that is not text, and re-encoding it does not give back the bytes it came from (the dangling lead
 * byte becomes U+FFFD, three bytes where there was one), so a row could end up carrying MORE than the
 * limit it was cut to. Backing off to the last character boundary keeps the two properties that
 * matter: the body is a prefix of the original — never a splicing of two parts of it — and its length
 * in bytes is never above the limit. For the ASCII-bodied JSON a chat service answers with, the
 * boundary is the limit itself.
 */
function utf8PrefixAtMost(source: Buffer, limit: number): string {
  for (let end = limit; end > 0; end -= 1) {
    const text = source.subarray(0, end).toString('utf8');
    if (Buffer.byteLength(text, 'utf8') === end) {
      return text;
    }
  }
  return '';
}

/**
 * One raw answer as the row carries it: verbatim while it fits, a flagged prefix past the limit.
 *
 * THE TWO HALVES ARE ONE CALL because they are one decision. A caller that took the body and the
 * flag from two places would eventually write a body it had not cut beside a flag that said it had,
 * and the row would then be wrong about the only thing it is for. The limit is
 * `RAW_RETURN_LIMIT_BYTES`, and "fits" is measured in UTF-8 bytes rather than in characters, because
 * bytes are what a log line costs.
 */
export function truncateVoiceCaptureReturn(rawReturn: VoiceCaptureRawReturn): VoiceCaptureUpstream {
  const bytes = Buffer.from(rawReturn.body, 'utf8');
  if (bytes.length <= RAW_RETURN_LIMIT_BYTES) {
    return { status: rawReturn.status, body: rawReturn.body };
  }
  return {
    status: rawReturn.status,
    body: utf8PrefixAtMost(bytes, RAW_RETURN_LIMIT_BYTES),
    // `true` and never `false`: the key is present exactly when something was cut. See
    // `VoiceCaptureUpstream` for why the two are not interchangeable.
    truncated: true,
  };
}

/**
 * Which of the six branches one attempt's outcome is.
 *
 * TOTAL BY CONSTRUCTION: every combination of the four scalars reaches one of the six, and the order
 * below is the reason why. Success is decided first, and it is decided by `writtenFallback` alone —
 * the fact the adapter records precisely on the degraded path (`meta.writtenFallback: 1`), so the two
 * successful branches are told apart by the adapter's own reading rather than by re-parsing the
 * answer. Among failures, `NO_SPEECH_DETECTED` is asked first because it is the one failure that
 * arrives on a 2xx answer: asked later, it would be caught by the envelope test below and reported as
 * a malformed answer instead of as silence. The envelope test itself needs BOTH halves of its name —
 * `UPSTREAM_UNAVAILABLE` is the adapter's word for "I could not use what came back", and a 2xx
 * status is what makes that a malformed ANSWER rather than a refusal — so a 404 carrying the same
 * code falls through to the transport test below and is reported as what it is.
 *
 * The last two are decided by whether a request ever left the process, which is why `requestSent` is
 * an input rather than something the builder infers: an attempt refused before the transport never
 * sent anything, and an attempt whose request went out is an upstream failure whether or not an
 * answer came back readable. `upstream` is still an input, because the envelope test needs the status
 * the answer arrived with — a 2xx carrying the adapter's "I could not use this" is a malformed answer,
 * while the same code on a 4xx is the upstream refusing.
 */
export function voiceCaptureBranch(input: {
  ok: boolean;
  code?: string;
  writtenFallback?: number;
  upstream: VoiceCaptureRawReturn | null;
  requestSent: boolean;
}): VoiceCaptureBranch {
  if (input.ok) {
    return input.writtenFallback === undefined ? 'written' : 'verbatim-fallback';
  }
  if (input.code === 'NO_SPEECH_DETECTED') {
    return 'no-speech';
  }
  if (input.code === 'UPSTREAM_UNAVAILABLE' && input.upstream !== null && input.upstream.status < 400) {
    return 'envelope-error';
  }
  return input.requestSent ? 'upstream-failure' : 'preflight-refused';
}

/**
 * THE payload builder: the one place a row's payload is decided.
 *
 * Every field is computed here from the narrowed input and nowhere else, so a caller that wants
 * something in a row has to put it in the input — which is what makes an added field a change to this
 * function rather than an edit at a call site. The two fields that need care are the two that could
 * be a disclosure: `sha256` is a digest of the upload and never the upload, and `upstream` is the
 * answer that came back, which is on the receiving side of the request and therefore cannot contain
 * anything this process sent. The upload itself reaches a row only as `bytes` and `sha256`.
 */
export function buildVoiceCapturePayload(input: VoiceCapturePayloadInput): VoiceCapturePayload {
  return {
    model: input.model,
    host: voiceCaptureHost(input.baseUrl),
    mime: input.audio.mimeType,
    bytes: input.audio.bytes.length,
    sha256: voiceCaptureSha256(input.audio.bytes),
    upstream: input.upstream === null ? null : truncateVoiceCaptureReturn(input.upstream),
    branch: voiceCaptureBranch({
      ...input.reading,
      upstream: input.upstream,
      requestSent: input.requestSent,
    }),
    text: input.reading.text,
  };
}

/** What the port factory needs: the mode it was resolved to, where rows go, and the audio sink. */
export type VoiceCaptureDependencies = {
  mode: VoiceCaptureMode;
  log: VoiceLogPort;
  /**
   * The audio half of the seam, when this deployment has one.
   *
   * Absent means `audio` mode records its attempt rows and writes nothing to disk. That is this
   * module's shipping shape today: the file write, its permissions and the injected writer are the
   * audio half's own delivery, and a mode whose writer is absent writes nothing rather than writing
   * somewhere nobody chose.
   */
  audio?: VoiceCaptureAudioSink;
};

/**
 * Builds the recording port for one resolved mode.
 *
 * The id is minted from a per-port sequence, so the three facts a recording rests on hold without a
 * clock, a random source, or a hash of the upload: two attempts never share an id, an id is stable
 * once minted, and the SAME id appears on the attempt line and in the row.
 *
 * `recordAttempt` is the single place a row is ever built. A second construction point — in the
 * service, in a route, in a test — would be a second answer to "what is in a capture row", and the
 * two would drift the first time a field was added.
 */
export function createVoiceCapture(dependencies: VoiceCaptureDependencies): VoiceCapturePort {
  let sequence = 0;

  return {
    mode: dependencies.mode,
    newAttemptId(): string {
      sequence += 1;
      return `${dependencies.mode}-${sequence}`;
    },
    recordAttempt(captureId: string, attempt: VoiceCaptureAttempt): void {
      // The row: the fields that name the attempt, and the payload when this attempt carries one. The
      // payload is BUILT here from the narrowed input rather than taken ready-made, so the set of
      // fields a row can have is decided by `buildVoiceCapturePayload` and nowhere else — a caller
      // cannot add one by putting it in the object it hands over, because what it hands over is the
      // INPUT and not the row. An attempt that carries no payload writes the row this port has always
      // written, byte for byte.
      const row: Record<string, unknown> = {
        event: VOICE_CAPTURE_EVENT,
        captureId,
        providerId: attempt.providerId,
        outcome: attempt.outcome,
        status: attempt.status,
      };
      if (attempt.payload !== undefined) {
        Object.assign(row, buildVoiceCapturePayload(attempt.payload));
      }

      // One line, serialised once. `JSON.stringify` at the construction point rather than at the log
      // port is what keeps the row single-line and parseable no matter which port a deployment wired.
      dependencies.log.info(JSON.stringify(row));

      // The audio write, and only in the mode that asked for it. The directory is resolved HERE
      // rather than at construction, so no mode that writes nothing ever resolves one.
      if (dependencies.mode === 'audio' && dependencies.audio !== undefined) {
        dependencies.audio.writeAudio(dependencies.audio.resolveDirectory(), attempt.audio);
      }
    },
  };
}
