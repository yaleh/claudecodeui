import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeForkProvider } from '@/modules/providers/list/claude/claude-fork.provider.js';
import {
  ClaudeResidentHostDriver,
  type ClaudeResidentRunStoppedEvent,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { ClaudeMcpProvider } from '@/modules/providers/list/claude/claude-mcp.provider.js';
import { ClaudeRenameProvider } from '@/modules/providers/list/claude/claude-rename.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { ClaudeSkillsProvider } from '@/modules/providers/list/claude/claude-skills.provider.js';
import {
  notifyBackgroundWorkCompleted,
  notifyRunStopped,
} from '@/modules/notifications/index.js';
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

/**
 * The stop notification, viewed the same way.
 *
 * Same widening as above, and stated against the resident driver's own event
 * type so the two cannot drift: the driver reports the ending of a turn it
 * drove, and this is the assertion that the notification layer takes exactly
 * that record — including the `aborted` reason a stopped resident turn reports.
 */
const reportRunStopped = notifyRunStopped as (event: ClaudeResidentRunStoppedEvent) => void;

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
   * Process ownership: the per-run host, and the resident one.
   *
   * Claude is the only provider that mounts this facet, and the mounted driver
   * serves both of the modes its capabilities declare. `per-run` is the
   * held-input protocol (`createHeldPromptStream` plus the print background-work
   * behavior it enables) that lets a process survive its turn's `result`, which
   * is why Claude's hosts are the ones whose lifetime the session-host layer
   * tracks rather than infers. `resident` is the same protocol held across turns:
   * one CLI reading a never-ending stdin, owned by `ClaudeResidentHostDriver` and
   * reached by the dispatch in `provider-runtime.service`, which routes a turn
   * here only for a session whose stored mode says so.
   *
   * The resident driver composes the per-run one, so the per-run verbs this slot
   * has always served are the same implementation, unchanged — a per-run host
   * opened by anyone still gets that driver's rules.
   *
   * Both drivers' reports go to the notifications the runtime's own run makes, so
   * a held background task and a completed resident turn notify identically
   * however the turn was driven. The event's `userId` is null for a background
   * work report because neither a bind nor a turn carries a connection: the
   * driver reports *what* completed, and the notification layer already treats a
   * missing user as "no per-user preferences to consult".
   */
  readonly hostDriver: IProviderHostDriver = new ClaudeResidentHostDriver({
    host: sessionHostManager,
    notifyBackgroundWork: (event) =>
      reportBackgroundWorkCompleted({
        userId: event.userId,
        provider: event.provider,
        sessionId: event.sessionId,
        sessionName: event.sessionName,
      }),
    notifyRunStopped: (event) =>
      reportRunStopped({
        userId: event.userId,
        provider: event.provider,
        sessionId: event.sessionId,
        sessionName: event.sessionName,
        stopReason: event.stopReason,
      }),
  });

  constructor() {
    super('claude');
  }
}
