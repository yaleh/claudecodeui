import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';

import { appConfigDb, sessionsDb, type SessionNameSource } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  readTranscriptLastActivity,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { readAiTitleEntry } from '@/modules/providers/services/session-ai-title.service.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /** Where `sessionName` came from; travels with it into the session row. */
  nameSource: SessionNameSource;
};

/** What a transcript says the session is called, and how authoritative that is. */
type TranscriptTitle = {
  name: string;
  source: SessionNameSource;
};

/** The name a Claude session carries before anything has named it. */
const UNTITLED_CLAUDE_SESSION = 'Untitled Claude Session';

/**
 * `app_config` key recording that this database's already-indexed Claude rows
 * have had their activity re-derived from transcript content.
 *
 * Versioned because the derivation itself can be corrected later: a new suffix
 * asks every database to redo the pass once, instead of leaving rows the
 * previous pass wrote with a reading this one would no longer produce.
 */
const LAST_ACTIVITY_BACKFILL_KEY = 'claude_last_activity_backfill_v1';

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    await this.backfillLastActivity();

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        await this.resolveLastActivity(filePath, timestamps.updatedAt),
        filePath,
        parsed.nameSource
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      await this.resolveLastActivity(filePath, timestamps.updatedAt),
      filePath,
      parsed.nameSource
    );
  }

  /**
   * Resolves the activity time one transcript should be recorded with.
   *
   * The transcript's own last `timestamp` wins, because a file's mtime moves
   * for reasons that are not activity — a CLI flushing its bookkeeping
   * records, an external process rewriting or restoring the file — which is
   * what let a session idle for days read as active minutes ago.
   *
   * The mtime is the fallback for the two cases content cannot answer: a
   * transcript with no records yet (a session the user just created), and one
   * that cannot be read. Neither may end up without a time, or the session
   * disappears from a sidebar that sorts by activity.
   */
  private async resolveLastActivity(
    filePath: string,
    fileUpdatedAt: string | undefined
  ): Promise<string | undefined> {
    return (await readTranscriptLastActivity(filePath)) ?? fileUpdatedAt;
  }

  /**
   * Re-derives `updated_at` for Claude rows indexed before content was read.
   *
   * A row is only rewritten when its transcript is re-scanned, and both entry
   * points skip a file nothing has touched — the scan cursor compares
   * `birthtime > lastScanAt`, and the watcher only fires on a change. Without
   * this pass every row already in the database would keep its mtime reading
   * forever, which is precisely the wrong reading this synchronizer now
   * refuses to write.
   *
   * Rows are read from the database rather than by walking `~/.claude/projects`:
   * the walk is the one thing that runs on every list request, and paying a
   * content read per transcript there is the cost this design exists to avoid.
   * The `app_config` marker keeps the pass to once per database.
   *
   * A row whose transcript has since been deleted, or records no activity, is
   * left exactly as it is — `pruneOrphanedSessions` owns deletion, and a
   * transcript with no records has no better reading to offer.
   */
  private async backfillLastActivity(): Promise<void> {
    if (appConfigDb.get(LAST_ACTIVITY_BACKFILL_KEY)) {
      return;
    }

    let repaired = 0;
    for (const row of sessionsDb.getSessionsWithTranscriptPath(this.provider)) {
      const lastActivity = await readTranscriptLastActivity(row.jsonl_path);
      if (lastActivity && sessionsDb.updateSessionUpdatedAt(row.session_id, lastActivity)) {
        repaired += 1;
      }
    }

    appConfigDb.set(LAST_ACTIVITY_BACKFILL_KEY, new Date().toISOString());

    if (repaired > 0) {
      console.log(
        `[Sessions] Re-derived last activity from transcript content for ${repaired} Claude session row(s).`
      );
    }
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    const existingNameSource = (existingSession?.name_source ?? 'derived') as SessionNameSource;

    // A name the user chose (`manual`) or one Claude itself wrote (`ai`) is
    // already the best name this file has to offer, and re-reading a transcript
    // that can run to hundreds of megabytes would only re-derive the same
    // answer. Only a name that was inferred — by the app from the first
    // message, or by an earlier scan from a `last-prompt` — is re-extracted,
    // which is what lets a later `ai-title` take over from it.
    if (existingSessionName && existingNameSource !== 'derived') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, UNTITLED_CLAUDE_SESSION),
        nameSource: existingNameSource,
      };
    }

    const transcriptTitle = await this.extractSessionTitle(filePath, parsed.sessionId);
    if (transcriptTitle) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(transcriptTitle.name, UNTITLED_CLAUDE_SESSION),
        nameSource: transcriptTitle.source,
      };
    }

    const historyName = nameMap.get(parsed.sessionId);
    if (historyName) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(historyName, UNTITLED_CLAUDE_SESSION),
        nameSource: 'derived',
      };
    }

    // Nothing on disk names this session. A row that already has a name keeps
    // it: `normalizeSessionName` would otherwise hand back the placeholder and
    // the upsert would replace a real name with it.
    if (existingSessionName) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, UNTITLED_CLAUDE_SESSION),
        nameSource: existingNameSource,
      };
    }

    return {
      ...parsed,
      sessionName: UNTITLED_CLAUDE_SESSION,
      nameSource: 'derived',
    };
  }

  /**
   * Returns the best title one session's transcript carries, and its source.
   *
   * Streams the file line by line and returns as soon as the answer cannot
   * improve, rather than reading a whole transcript into memory: these files
   * reach hundreds of megabytes, and a session's title is decided by a handful
   * of short entries. The `ai-title` entry ends the scan — Claude writes the
   * `custom-title` of a rename immediately *before* the matching `ai-title`,
   * so by the time one is reached every entry that could outrank it has
   * already been seen. A transcript with no title entry at all is the only
   * case that reads to the end, and it falls back to the last `last-prompt`.
   *
   * Returns undefined on a missing or unreadable file so sync can continue.
   */
  private async extractSessionTitle(
    filePath: string,
    sessionId: string
  ): Promise<TranscriptTitle | undefined> {
    let foundCustomTitle: string | undefined;
    let foundLastPrompt: string | undefined;

    try {
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      try {
        for await (const line of lineReader) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }

          const data = parsed as Record<string, unknown>;
          const eventType = typeof data.type === 'string' ? data.type : undefined;
          const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;

          if (eventSessionId !== sessionId) {
            continue;
          }

          if (eventType === 'custom-title') {
            const title = typeof data.customTitle === 'string' ? data.customTitle : undefined;
            if (title?.trim()) {
              foundCustomTitle = title;
            }
          } else if (eventType === 'ai-title') {
            // The same rule the `/cost` reader applies, so the title a session
            // row stores and the one the command modal shows cannot drift.
            const title = readAiTitleEntry(data, sessionId);
            if (!title) {
              continue;
            }

            // `/rename` outranks the generated title, and it is already behind
            // us: stop here instead of reading the rest of the file.
            lineReader.close();
            fileStream.close();
            return { name: foundCustomTitle ?? title, source: foundCustomTitle ? 'manual' : 'ai' };
          } else if (eventType === 'last-prompt') {
            const prompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
            if (prompt?.trim()) {
              foundLastPrompt = prompt;
            }
          }
        }
      } finally {
        lineReader.close();
        fileStream.close();
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    if (foundCustomTitle) {
      return { name: foundCustomTitle, source: 'manual' };
    }

    return foundLastPrompt ? { name: foundLastPrompt, source: 'derived' } : undefined;
  }
}
