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
 * One attempt, as the record construction point sees it.
 *
 * Every field here is one this module or the service COMPUTED — a provider id, an outcome, a status,
 * a duration — plus the upload. No message, no credential, no header and no prompt can reach it,
 * because none of them is a field: "the row has no secret in it" is a property of the row's shape
 * rather than of a filter someone has to remember to keep in step.
 *
 * The audio travels with the attempt rather than through a second seam because the row and the file
 * must describe the same bytes: a writer handed a different copy than the one the row hashes would
 * make the two halves of a recording disagree with nothing on screen to say so.
 */
export type VoiceCaptureAttempt = {
  providerId: string;
  outcome: 'ok' | 'fail';
  status: number;
  audio: VoiceCaptureAudio;
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
      // One line, serialised once. `JSON.stringify` at the construction point rather than at the log
      // port is what keeps the row single-line and parseable no matter which port a deployment wired.
      dependencies.log.info(
        JSON.stringify({
          event: VOICE_CAPTURE_EVENT,
          captureId,
          providerId: attempt.providerId,
          outcome: attempt.outcome,
          status: attempt.status,
        }),
      );

      // The audio write, and only in the mode that asked for it. The directory is resolved HERE
      // rather than at construction, so no mode that writes nothing ever resolves one.
      if (dependencies.mode === 'audio' && dependencies.audio !== undefined) {
        dependencies.audio.writeAudio(dependencies.audio.resolveDirectory(), attempt.audio);
      }
    },
  };
}
