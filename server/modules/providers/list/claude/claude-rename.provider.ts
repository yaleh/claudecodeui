import { renameSession as renameClaudeSession } from '@anthropic-ai/claude-agent-sdk';

import type { IProviderSessionRename } from '@/shared/interfaces.js';

/**
 * Writes a renamed session back into Claude Code's own transcript.
 *
 * The SDK owns this: it appends a `custom-title` entry to the session's JSONL
 * file, which is where the CLI reads a session's name from for its resume list,
 * its session search, and `/resume` argument completion. Going through the SDK
 * rather than appending the line here is deliberate — the entry's shape is the
 * CLI's contract, not this app's, and the same SDK call is what the fork path
 * uses to title a new session.
 *
 * What this does NOT change, and the reason it is not the app's source of truth:
 * the CLI's own title ladder (`agentName > customTitle > aiTitle > firstPrompt`)
 * puts an `agent-name` entry above the rename. Most real transcripts carry one
 * (1172 of 1254 on the machine this was written on), so for such a session the
 * title the CLI *lists* stays the agent's even after this succeeds. The rename
 * is still recorded, searchable, and offered by completion — it is just not that
 * session's displayed title. The app is unaffected either way, because its
 * display prefers the explicit override.
 *
 * Consumed by: `sessionsService.renameSessionById`, which resolves this through
 * the provider registry after the app-side name has already been stored.
 */
export class ClaudeRenameProvider implements IProviderSessionRename {
  async renameSession(input: {
    providerSessionId: string;
    projectPath: string;
    title: string;
  }): Promise<void> {
    // `dir` is the session's working directory, which the SDK encodes into the
    // `~/.claude/projects/<encoded>` folder name itself — passing that folder
    // makes it encode an already-encoded path and find nothing. Same reasoning
    // as the fork provider's `dir`, and the same reason the session's own
    // working directory is what the caller has to hand over.
    await renameClaudeSession(input.providerSessionId, input.title, { dir: input.projectPath });
  }
}
