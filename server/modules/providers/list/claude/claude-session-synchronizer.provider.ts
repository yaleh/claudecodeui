import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';

import { sessionsDb, type SessionNameSource } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

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
        timestamps.updatedAt,
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
      timestamps.updatedAt,
      filePath,
      parsed.nameSource
    );
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
            const title = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
            if (!title?.trim()) {
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
