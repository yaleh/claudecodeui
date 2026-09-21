import { sessionsDb } from '@/modules/database/index.js';
import { extractFirstValidJsonlData } from '@/shared/utils.js';

/**
 * Reads the `ai-title` Claude generated for a session, straight from the
 * transcript that session's row points at.
 *
 * Consumed by the commands module's `/cost` handler, which shows the generated
 * title in the command modal's meta block. It cannot come from the session row:
 * `custom_name` holds only the one name that won the precedence order, so a
 * session the user renamed keeps their word and the generated title is nowhere
 * in the database — and a `manual` row is not re-scanned from disk at all, so
 * waiting for a later sync to store it would never end.
 *
 * The row is resolved by provider id first and app id second, the same way the
 * websocket module's session-upsert broadcast does, because callers hold
 * either id depending on where they came from. Every state with no answer to
 * give returns null rather than throwing — an unknown session, a non-Claude
 * provider, a row with no transcript, a missing or unreadable file, a
 * transcript that carries no generated title — because the caller is
 * assembling a command result that must not fail over a missing title.
 */
export async function readSessionAiTitle(sessionId: string): Promise<string | null> {
  const row = sessionsDb.getSessionByProviderSessionId(sessionId)
    ?? sessionsDb.getSessionById(sessionId);

  if (!row || row.provider !== 'claude' || !row.jsonl_path) {
    return null;
  }

  // A transcript names its own session, and an app-created row records that id
  // separately from its app-facing one. Rows predating the mapping carry no
  // provider id; for those the two ids are equal anyway.
  const providerSessionId = row.provider_session_id ?? row.session_id;

  // `extractFirstValidJsonlData` streams the file and stops at the first entry
  // the extractor accepts, which is what keeps this proportional to how far
  // down the title sits rather than to the file's size: a long session's
  // transcript runs to hundreds of megabytes and a single entry in it can
  // reach hundreds of kilobytes, so neither the whole file nor the whole line
  // may be held. The title is written once, early, and never revised.
  return extractFirstValidJsonlData<string>(row.jsonl_path, (parsedJson) =>
    readAiTitleEntry(parsedJson, providerSessionId),
  );
}

/**
 * Returns the `ai-title` one parsed transcript entry carries for
 * `providerSessionId`, or null when the entry carries none.
 *
 * Shared with the Claude session synchronizer so that the title it stores on a
 * session row and the title the command modal shows are read by one rule: the
 * entry must be an `ai-title`, must belong to this session — a subagent
 * transcript repeats its parent's entries under its own id — and must carry
 * non-blank text. The text itself is returned verbatim: it is Claude's own
 * wording, and it is the whole point that a rename cannot overwrite it.
 */
export function readAiTitleEntry(
  parsedJson: unknown,
  providerSessionId: string
): string | null {
  const data = parsedJson as Record<string, unknown>;
  if (data.type !== 'ai-title' || data.sessionId !== providerSessionId) {
    return null;
  }

  const title = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
  return title?.trim() ? title : null;
}
