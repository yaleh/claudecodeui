import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeForkProvider } from '@/modules/providers/list/claude/claude-fork.provider.js';
import { ClaudeMcpProvider } from '@/modules/providers/list/claude/claude-mcp.provider.js';
import { ClaudePerRunHostDriver } from '@/modules/providers/list/claude/claude-per-run-host-driver.provider.js';
import { ClaudeRenameProvider } from '@/modules/providers/list/claude/claude-rename.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { ClaudeSkillsProvider } from '@/modules/providers/list/claude/claude-skills.provider.js';
import { notifyBackgroundWorkCompleted } from '@/modules/notifications/index.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
import type {
  IProviderAuth,
  IProviderFork,
  IProviderHostDriver,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionRename,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * The background-work notification, viewed with the argument shape its module
 * really takes.
 *
 * `notifyBackgroundWorkCompleted` lives in a `.js` module and `checkJs` is off,
 * so TypeScript infers its destructured parameters from their defaults alone:
 * it presents `sessionId` and `sessionName` as `null | undefined`, even though
 * its own body hands both to a `createNotificationEvent` that takes a string and
 * the runtime's callers pass a session id on every run. The assertion is that
 * true contract, made once here instead of at every call site — and because it
 * is only a widening, a record built from the driver's event still reaches the
 * notification unchanged.
 */
const reportBackgroundWorkCompleted = notifyBackgroundWorkCompleted as (event: {
  userId: string | null;
  provider: LLMProvider;
  sessionId: string | null;
  sessionName: string | null;
}) => void;

export class ClaudeProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = claudeRuntime;
  readonly models: IProviderModels = new ClaudeProviderModels();
  readonly mcp = new ClaudeMcpProvider();
  readonly auth: IProviderAuth = new ClaudeProviderAuth();
  readonly skills: IProviderSkills = new ClaudeSkillsProvider();
  readonly sessions: IProviderSessions = new ClaudeSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new ClaudeSessionSynchronizer();
  readonly fork: IProviderFork = new ClaudeForkProvider();
  readonly rename: IProviderSessionRename = new ClaudeRenameProvider();
  /**
   * Per-run process ownership.
   *
   * Claude is the only provider that mounts this facet: its held-input protocol
   * (`createHeldPromptStream` + the print background-work behavior it enables) is
   * what makes a process survive its turn's `result`, so its hosts are the ones
   * whose lifetime the session-host layer has to track rather than infer. The
   * four other providers keep the manager's default per-run wrapper.
   *
   * The driver's completion report goes to the same notification the runtime's own
   * run makes, so a held background task notifies identically however the turn was
   * driven. The event's `userId` is null because neither a bind nor a turn carries
   * a connection: the driver reports *what* completed, and the notification layer
   * already treats a missing user as "no per-user preferences to consult".
   */
  readonly hostDriver: IProviderHostDriver = new ClaudePerRunHostDriver({
    host: sessionHostManager,
    notify: (event) =>
      reportBackgroundWorkCompleted({
        userId: event.userId,
        provider: event.provider,
        sessionId: event.sessionId,
        sessionName: event.sessionName,
      }),
  });

  constructor() {
    super('claude');
  }
}
