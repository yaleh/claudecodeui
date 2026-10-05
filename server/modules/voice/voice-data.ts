/**
 * The on-disk store of what the user dictated — the D1 "local only" data, default ON.
 *
 * SEPARATE FROM THE DIAGNOSTIC CAPTURE (`voice-capture.ts`) IN EVERY DIMENSION THAT MATTERS. That
 * module is a DEPLOYMENT property: `VOICE_CAPTURE` is read once at start-up, defaults off, and an
 * unrecognised value fails closed. This one is a USER property: it defaults ON, the user's own
 * stored setting turns it off, and the user can clear it. The two share a directory SHAPE and the
 * 0700/0600 permission discipline and nothing else — keeping `VOICE_CAPTURE`'s fail-closed
 * semantics untouched is a requirement of this task, not an accident of the split.
 *
 * WHAT IS STORED. One record per successful transcription: a JSON document naming the provider and
 * the recognised text (with the recogniser's per-token facts when it produced them) plus the
 * segment audio that produced them. A record is exactly `{ recordId, ts, providerId, buildId?,
 * segments }`, where each segment is `{ index, audioFile, text, tokens? }`. Three keys are RESERVED
 * for later tasks and deliberately never written here — `finalText`, `labels` and `flagStats`, which
 * the correction-feedback track fills. Nothing this module writes is a credential: the audio and
 * the text are the user's own, and the settings document — keys, tokens, request headers — is never
 * a field of a record.
 *
 * NOTHING HERE LEAVES THE PROCESS. The only imports are node builtins (`fs`, `path`, `os`,
 * `crypto`); a record is built from what the caller already holds. That is the "stays on this
 * machine" half of D1, and it is asserted by a criterion that reads this file for transport imports
 * rather than trusted to a promise.
 *
 * THE PERMISSIONS ARE THE REASON THE WRITE IS NOT THREE OBVIOUS LINES. `mkdirSync`'s and
 * `writeFileSync`'s `mode:` is a REQUEST the kernel applies THROUGH the process's umask, so under
 * `umask 0o000` an asked-for 0600 lands 0666. Each create is therefore followed by an explicit
 * `chmod` on the same path, which makes the mode a fact about the file rather than about the shell
 * that started the server; the `mode:` argument is kept as well so the window between create and
 * chmod is not a window in the ordinary case.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { VoiceSettings } from '@/shared/types.js';

import type { AsrToken } from '../../../shared/asr/asrRegistry.js';

/**
 * The directory's own name, under the database's parent — `~/.cloudcli/voice-data` by default.
 *
 * THE SAME SHAPE `voice-capture` USES, with its own leaf: a deployment that moved its database
 * moves its voice data with it, and the two stores sit side by side under one parent rather than
 * one of them reaching for a second reading of the database configuration.
 */
const VOICE_DATA_DIRECTORY_NAME = 'voice-data';

/** The fallback database path the default directory is derived from, mirroring the capture store. */
const DEFAULT_DATABASE_FILE = '.cloudcli/auth.db';

/** The directory's mode and the files' mode, both applied explicitly (see the header). */
const VOICE_DATA_DIR_MODE = 0o700;
const VOICE_DATA_FILE_MODE = 0o600;

/** The two suffixes this store owns: a record document and one segment's audio. */
const RECORD_EXTENSION = '.json';
const SEGMENT_EXTENSION = '.wav';

/**
 * The ceiling on the directory, in bytes, when the user's settings name none: 2 GiB.
 *
 * A SHIPPED DEFAULT rather than a policy about recordings — the setting is the user's to change
 * (see `voiceDataMaxBytes`), and the store applies whatever it is told. It exists so a deployment
 * that never opens the settings still has a bound rather than growing without one.
 */
export const DEFAULT_VOICE_DATA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The smallest ceiling a settings document may name: 1 KiB.
 *
 * A bound, not a policy: the user's own setting has to be a number the store can act on, and a
 * ceiling below one record is the same thing as a ceiling of zero — every write is immediately
 * evicted, which reads as "recording is broken" rather than as "the cap is tiny". The criterion
 * that exercises eviction uses 50 KiB, comfortably above this floor.
 */
export const MIN_VOICE_DATA_MAX_BYTES = 1024;

/**
 * One transcribed segment, as it is stored.
 *
 * `tokens` is present only when the selected recogniser actually produced per-token facts — the
 * same absence-means-none rule the service already applies to the response, so a segment written
 * from a recogniser that declares no tokens carries the field nowhere.
 */
export type VoiceDataSegment = {
  /** The segment's ordinal within its record. The first (and, today, only) one is `0`. */
  index: number;
  /** The audio file beside this record that holds this segment, named `<recordId>-<index>.wav`. */
  audioFile: string;
  /** The text the recogniser returned for this segment. */
  text: string;
  tokens?: AsrToken[];
};

/**
 * One transcription, as it is stored.
 *
 * The three trailing keys are RESERVED and never written by this task: the correction-feedback
 * track fills `finalText`/`labels` and the confidence-flag shadow fills `flagStats`. They are named
 * here so a reader of a written record — and the later writer — has one shape to agree on.
 */
export type VoiceDataRecord = {
  recordId: string;
  /** When the record was written, in milliseconds since the epoch. The eviction order's key. */
  ts: number;
  providerId: string;
  buildId?: string;
  segments: VoiceDataSegment[];
  /** Reserved for the correction loop; not written by this task. */
  finalText?: string;
  /** Reserved for the correction loop; not written by this task. */
  labels?: unknown;
  /** Reserved for the confidence-flag shadow stats; not written by this task. */
  flagStats?: unknown;
};

/** What one successful transcription hands the store. */
export type VoiceDataRecordInput = {
  /**
   * The user's stored settings. Recording is off ONLY when this says `false`.
   *
   * ABSENT AND DEFAULTED ARE THE SAME READING: a user who never opened the settings has no such
   * key, and D1 says that user's dictation IS recorded. Anything other than the literal `false`
   * therefore records, which is what makes the default-on promise a property of this gate rather
   * than of a document somebody has to write first.
   */
  settings: VoiceSettings | undefined;
  providerId: string;
  buildId?: string;
  text: string;
  tokens?: AsrToken[];
  /** The audio this transcription was made from, exactly as it was uploaded. */
  audio: Uint8Array;
};

/** Where a stored record landed: the id the caller returns and the audio file beside it. */
export type VoiceDataRecordResult = { recordId: string; audioFile: string };

/** The answer to a clear: how many record documents were removed. */
export type VoiceDataClearResult = { deleted: number };

/**
 * The store the service holds.
 *
 * `record` returns `null` when recording is off — the gate is the store's own switch, read off the
 * passed settings, so the caller does not have to know the setting's name to respect it. I/O
 * failures throw, and the service catches them: a store that cannot write must never cost the user
 * the transcription it was trying to keep.
 */
export type VoiceDataStore = {
  record(input: VoiceDataRecordInput): VoiceDataRecordResult | null;
  clear(): VoiceDataClearResult;
  directory(): string;
};

/**
 * Where voice data goes, from the two values the composition root read.
 *
 * THE INPUTS ARE ARGUMENTS, for the same reason `resolveVoiceCaptureDir`'s are: the environment
 * belongs to the composition root, and a resolver that read a variable itself could not be asked
 * what a given pair of values means without mutating the process first. An explicit directory wins;
 * otherwise the default sits BESIDE THE DATABASE, so a deployment that moved its state moved its
 * recordings with it.
 *
 * THIS ONLY COMPUTES A PATH. Nothing is created here — the writer creates the directory on the
 * first record it actually writes — which is why a user who turned recording off leaves no
 * directory behind even though one was resolved.
 */
export function resolveVoiceDataDir(raw: string | undefined, databasePath: string | undefined): string {
  const explicit = raw === undefined ? '' : raw.trim();
  if (explicit !== '') {
    return explicit;
  }

  const database = databasePath === undefined || databasePath.trim() === ''
    ? path.join(os.homedir(), DEFAULT_DATABASE_FILE)
    : databasePath;
  return path.join(path.dirname(database), VOICE_DATA_DIRECTORY_NAME);
}

/** The start-up line naming where records land, one literal with nothing to construct. */
export function voiceDataDirStartupLine(directory: string): string {
  return `voice.data dir=${directory}`;
}

/** The characters a record's file name may keep — the capture module's own alphabet, reused. */
function pathSafeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The ceiling to enforce, from whatever the settings document carried.
 *
 * A value the store cannot act on — absent, non-finite, or below the floor — reads as the shipped
 * default rather than as "unbounded", which is the safe direction: a malformed cap must not be the
 * one that lets a directory grow without a bound. The value is floored so it stays an integer
 * number of bytes even if a client sent a fraction.
 */
function normalizeMaxBytes(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_VOICE_DATA_MAX_BYTES
    ? Math.floor(value)
    : DEFAULT_VOICE_DATA_MAX_BYTES;
}

/** The record's own `ts`, or `null` when the file is unreadable or carries none. */
function readRecordTs(recordPath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      const ts = (parsed as { ts?: unknown }).ts;
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        return ts;
      }
    }
  } catch {
    // An unreadable record is not a reason to stop: it is still a file on disk (it counts toward
    // the total and is evicted by its mtime below), and it is not a reason to fail the write that
    // is happening now.
  }
  return null;
}

/**
 * One record's files, and the age eviction orders them by.
 *
 * `files` holds every file that belongs to the record — its JSON document and its segment audio —
 * so deleting the group deletes both halves and leaves no orphan audio behind.
 */
type StoredGroup = { ts: number; mtimeMs: number; files: string[] };

/**
 * Every record in the directory, oldest first.
 *
 * The order is (`ts`, then the record file's `mtimeMs`, then its name). `ts` is the semantic
 * timestamp and is what "oldest first" means; the mtime tiebreak matters because two records
 * written in the same millisecond share a `ts`, and the filesystem's own nanosecond timestamp is
 * what keeps their order the order they were written in rather than whatever `readdir` returned.
 *
 * A `.wav` with no matching `.json` — an orphan from a crash between the two writes — is still a
 * group of its own, keyed by its mtime, so it is bounded by the same ceiling as everything else
 * rather than accumulating forever.
 */
function listStoredGroups(directory: string): StoredGroup[] {
  const groups = new Map<string, StoredGroup>();
  const groupFor = (stem: string, ts: number, mtimeMs: number): StoredGroup => {
    const existing = groups.get(stem);
    if (existing) {
      // The record's own document defines the group's age; an audio file only ever raises a group
      // into existence when no document exists (the orphan case).
      return existing;
    }
    const created: StoredGroup = { ts, mtimeMs, files: [] };
    groups.set(stem, created);
    return created;
  };

  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    if (name.endsWith(RECORD_EXTENSION)) {
      const stem = name.slice(0, -RECORD_EXTENSION.length);
      const ts = readRecordTs(full);
      groupFor(stem, ts ?? stats.mtimeMs, stats.mtimeMs).files.push(name);
    } else if (name.endsWith(SEGMENT_EXTENSION)) {
      // `<recordId>-<segmentIndex>.wav`; the group stem is everything before the final `-<digits>`.
      const stem = name.slice(0, -SEGMENT_EXTENSION.length).replace(/-\d+$/, '');
      groupFor(stem, stats.mtimeMs, stats.mtimeMs).files.push(name);
    }
  }

  return [...groups.values()].sort((left, right) => (
    left.ts - right.ts || left.mtimeMs - right.mtimeMs || 0
  ));
}

/** The bytes of every regular file directly under the directory. */
function directoryBytes(directory: string): number {
  let total = 0;
  for (const name of readdirSync(directory)) {
    try {
      const stats = statSync(path.join(directory, name));
      if (stats.isFile()) {
        total += stats.size;
      }
    } catch {
      // A file that vanished between the listing and the stat is not bytes we have to account for.
    }
  }
  return total;
}

/**
 * Trims the directory to the ceiling, OLDEST RECORD FIRST.
 *
 * Deletes whole records — the JSON document and the audio it names together — so a directory left
 * over the ceiling never holds a record whose audio is gone. The just-written record is the newest
 * and is therefore the last candidate, which is what makes "write then trim" leave the record the
 * caller is about to return on disk in every case the record fits at all.
 */
function evictToLimit(directory: string, maxBytes: number): void {
  let total = directoryBytes(directory);
  if (total <= maxBytes) {
    return;
  }

  for (const group of listStoredGroups(directory)) {
    if (total <= maxBytes) {
      break;
    }
    for (const name of group.files) {
      const full = path.join(directory, name);
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        size = 0;
      }
      rmSync(full, { force: true });
      total -= size;
    }
  }
}

/** Writes one record (and its audio), then trims. `null` when the user turned recording off. */
function recordToStore(directory: string, input: VoiceDataRecordInput): VoiceDataRecordResult | null {
  if (input.settings?.voiceDataRecording === false) {
    return null;
  }
  const maxBytes = normalizeMaxBytes(input.settings?.voiceDataMaxBytes);

  // The directory appears HERE, on the first record that is actually written, and not when the
  // store was built or when a directory was resolved: a user who never records leaves no directory
  // behind even though one was configured for them.
  mkdirSync(directory, { recursive: true, mode: VOICE_DATA_DIR_MODE });
  chmodSync(directory, VOICE_DATA_DIR_MODE);

  // A fresh id rather than anything the request carried: the upload's name is the caller's string,
  // and a name built from it could leave the directory. `randomUUID` is this module's own, so a
  // file name built from it is already safe; `pathSafeStem` is the second lock for the same door.
  const recordId = randomUUID();
  const stem = pathSafeStem(recordId);
  const segmentIndex = 0;
  const audioFile = `${stem}-${segmentIndex}${SEGMENT_EXTENSION}`;
  const audioPath = path.join(directory, audioFile);

  // The audio first, so the file the record names is already on disk when a reader sees the name.
  writeFileSync(audioPath, input.audio, { flag: 'wx', mode: VOICE_DATA_FILE_MODE });
  chmodSync(audioPath, VOICE_DATA_FILE_MODE);

  const record: VoiceDataRecord = {
    recordId,
    ts: Date.now(),
    providerId: input.providerId,
    // Each optional field is OMITTED rather than written as `undefined`/`null`, matching the
    // service's own rule for the response: a key a recogniser did not produce is absent here too.
    ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
    segments: [
      {
        index: segmentIndex,
        audioFile,
        text: input.text,
        ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
      },
    ],
  };

  const recordPath = path.join(directory, `${stem}${RECORD_EXTENSION}`);
  writeFileSync(recordPath, JSON.stringify(record), { mode: VOICE_DATA_FILE_MODE });
  chmodSync(recordPath, VOICE_DATA_FILE_MODE);

  evictToLimit(directory, maxBytes);

  return { recordId, audioFile };
}

/**
 * Removes every file this store owns, and answers how many RECORDS were among them.
 *
 * A missing directory answers `0` rather than failing: "there is nothing here to clear" is the
 * success case of a clear, and a user who turned recording off — who therefore has no directory —
 * must be able to clear without an error. The count is the record documents, not the files, so it
 * reads as "how many recordings were removed" rather than double-counting each one's audio.
 */
function clearStore(directory: string): VoiceDataClearResult {
  if (!existsSync(directory)) {
    return { deleted: 0 };
  }

  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const name of names) {
    if (name.endsWith(RECORD_EXTENSION)) {
      deleted += 1;
    }
    rmSync(path.join(directory, name), { force: true, recursive: true });
  }
  return { deleted };
}

/** What the store is built from: the directory the composition root has already resolved. */
export type VoiceDataStoreOptions = {
  directory: string;
};

/**
 * The shipping store: the write, the clear, and the directory's creation and permissions.
 *
 * THE DIRECTORY IS DISTRIBUTED IN, not read here, for the same reason the capture sink takes one:
 * the environment belongs to the composition root, so "where does voice data go" has one answer
 * produced by the deployment's own configuration.
 */
export function createVoiceDataStore(options: VoiceDataStoreOptions): VoiceDataStore {
  return {
    record: (input) => recordToStore(options.directory, input),
    clear: () => clearStore(options.directory),
    directory: () => options.directory,
  };
}
