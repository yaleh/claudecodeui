import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  HostCloseReason,
  HostReconfigurePatch,
  HostTurnInput,
  LLMProvider,
  McpScope,
  NormalizedMessage,
  ProcessHost,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderAuthStatus,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderMcpServer,
  ProviderSkillCreateInput,
  ProviderSkillRemoveInput,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRuntimeWriter,
  SessionBinding,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';

//----------------- PROVIDER CONTRACT INTERFACES ------------

/**
 * Live execution contract implemented by each provider SDK/CLI adapter.
 *
 * The provider registry owns this adapter as one facet of `IProvider`; runtime
 * execution context is supplied by the application service at call time.
 */
export interface IProviderRuntime {
  run(
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown>;
  abort(sessionId: string): boolean | Promise<boolean>;
  permissions?: ProviderRuntimePermissionGateway;
}

/**
 * Main provider contract for CLI and SDK integrations.
 *
 * Each concrete provider owns its MCP/auth handlers plus the provider-specific
 * logic for converting native events/history into the app's normalized shape.
 */
export interface IProvider {
  readonly id: LLMProvider;
  readonly runtime: IProviderRuntime;
  readonly models: IProviderModels;
  readonly mcp: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
  /**
   * Transcript branching. Present only for providers that can materialise a
   * prefix of one conversation as an independent, resumable provider session;
   * its absence is what makes "fork session" unavailable.
   */
  readonly fork?: IProviderFork;
  /**
   * Rename write-back. Present only for providers whose own storage keeps a
   * session title that their tooling reads back (Claude's transcript
   * `custom-title` entry); its absence is what makes the app-side name the only
   * place the rename exists.
   */
  readonly rename?: IProviderSessionRename;
  /**
   * Process-lifetime ownership. Present only for providers that can hold a
   * process across turns (Claude `resident`) or multiplex several conversations
   * onto one already-running process. Its absence is the normal case: every
   * provider without it is driven by the session-host manager's default per-run
   * wrapper, which keeps the existing `IProviderRuntime.run`/`abort` contract as
   * the whole of the provider's lifecycle.
   */
  readonly hostDriver?: IProviderHostDriver;
}

// ---------------------------
//----------------- PROVIDER HOST DRIVER INTERFACE ------------
/**
 * Optional provider facet for lifecycle modes the default per-run wrapper
 * cannot express.
 *
 * The default wrapper in `server/modules/session-hosts` only observes: it opens
 * a per-run host, watches the runtime's writer for the terminal frame and lets
 * the runtime keep `IProviderRuntime.abort` as the way to stop a turn. A
 * provider that implements this facet instead owns process lifetime — it decides
 * when a host starts, which session is bound to it, and how it is closed — which
 * is what makes `resident` mode and multiplexed hosts possible.
 *
 * `host` carries the identity and state the manager already tracks; a driver
 * mutates process reality and reports back through the manager, never by editing
 * the host record itself. Verbs are specified in
 * `docs/proposals/claude-resident-sessions.md` §4.
 */
export interface IProviderHostDriver {
  /** Starts the host process, or returns the already-running one a multiplexing provider reuses. */
  startHost(host: ProcessHost): Promise<ProcessHost>;
  /** Opens one session binding on the host (for Claude this is the same action as `startHost`). */
  bind(host: ProcessHost, binding: SessionBinding): Promise<void>;
  /** Delivers one turn: for `per-run` this is what `run` used to be; for `resident` it writes to the process input. */
  submit(host: ProcessHost, appSessionId: string, turn: HostTurnInput): Promise<void>;
  /** Stops the turn in flight and reports whether anything was stopped. */
  interrupt(host: ProcessHost, appSessionId: string): Promise<boolean>;
  /** Applies a model/effort/permission change, reporting whether it took effect now or next turn. */
  reconfigure(
    host: ProcessHost,
    appSessionId: string,
    patch: HostReconfigurePatch,
  ): Promise<'live' | 'next-turn'>;
  /** Detaches one session, leaving the host running while it still has other bindings. */
  unbind(host: ProcessHost, appSessionId: string, reason: HostCloseReason): Promise<void>;
  /** Terminates the host process. */
  closeHost(host: ProcessHost, reason: HostCloseReason): Promise<void>;
}

// ---------------------------
//----------------- PROVIDER SESSION RENAME INTERFACE ------------
/**
 * Offline rename contract for one provider.
 *
 * A rename in this app is authoritative in the app's own database; this is the
 * second, best-effort half that records the same name in the provider's own
 * store. It exists so the name a user sets here is visible to the provider's
 * own tooling — Claude Code's resume list, its session search, and `/resume`
 * argument completion all read a session's title from the transcript, not from
 * this app.
 */
export interface IProviderSessionRename {
  /**
   * Records `title` as the session's name in the provider's own store.
   *
   * `projectPath` is the session's working directory — the same scoping
   * `forkSession` takes — because providers locate a session by the directory
   * it was run in rather than by the transcript path a caller already knows.
   *
   * Callers treat a rejection as informational, never as a failed rename: the
   * app-side name is stored before this is called, so an implementation may
   * reject freely and a caller must not turn that into a failed request.
   */
  renameSession(input: {
    providerSessionId: string;
    /** The session's working directory — how providers scope a session lookup. */
    projectPath: string;
    title: string;
  }): Promise<void>;
}

// ---------------------------
//----------------- PROVIDER FORK INTERFACE ------------
/**
 * Transcript-branching contract for one provider.
 */
export interface IProviderFork {
  /**
   * Copies a session's transcript, up to and including `upToAnchorId` (the
   * whole conversation when omitted), into a brand-new provider session.
   *
   * Returns the new provider-native id and the path of the artifact it wrote,
   * so the caller can insert the database row before the filesystem watcher
   * notices the file and indexes it as an unrelated session.
   */
  forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    /** The session's working directory — how providers scope a session lookup. */
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }>;
}

// ---------------------------
//----------------- PROVIDER MODEL INTERFACE ------------
/**
 * Model catalog contract for one provider.
 *
 * Implementations supply CloudCLI's curated predefined models and can inspect
 * provider-native session state. The Providers service merges these immutable
 * source-controlled definitions with user-created SQLite rows at read time.
 */
export interface IProviderModels {
  /**
   * Returns the curated predefined catalog owned by this provider adapter.
   */
  getSupportedModels(): Promise<ProviderModelsDefinition>;

  /**
   * Reads the model the provider itself believes one session is running with.
   *
   * Only consulted for sessions the app has never recorded a model for — a
   * session started directly in the provider CLI, for example. Selecting a
   * model in the app is persisted on the session row instead, so adapters here
   * are read-only and must fall back to the catalog default when the
   * provider-specific lookup finds nothing.
   */
  getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel>;
}

// ---------------------------
//----------------- PROVIDER AUTH INTERFACE ------------
/**
 * Auth contract for one provider.
 *
 * Implementations should return a complete installation/authentication status
 * without throwing for normal "not installed" or "not authenticated" states.
 */
export interface IProviderAuth {
  /**
   * Checks whether the provider is installed and has usable credentials.
   */
  getStatus(): Promise<ProviderAuthStatus>;
}

// ---------------------------
//----------------- PROVIDER SKILLS INTERFACE ------------
/**
 * Skills contract for one provider.
 *
 * Implementations discover provider-native skill markdown locations and return
 * normalized skill records with the exact command syntax expected by that
 * provider. Each skill is read from a `SKILL.md` file under its skill directory.
 */
export interface IProviderSkills {
  /**
   * Lists all skills visible to this provider for the optional workspace.
   */
  listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]>;

  /**
   * Writes one or more global user-scoped skills for this provider.
   *
   * Implementations should install the supplied markdown entries into the
   * provider's writable user skill folder and return the normalized skill
   * records that were written.
   */
  addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]>;

  removeSkill(
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }>;
}

// ---------------------------
//----------------- PROVIDER MCP INTERFACE ------------
/**
 * MCP contract for one provider.
 *
 * Implementations must map provider-native MCP config formats to shared
 * `ProviderMcpServer` records used by routes and frontend state.
 */
export interface IProviderMcp {
  listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }>;
}

// ---------------------------
//----------------- PROVIDER SESSION INTERFACE ------------
/**
 * Session/history contract for one provider.
 *
 * Implementations normalize provider-specific events and message history into
 * shared transport shapes consumed by API routes and realtime streams.
 */
export interface IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult>;

  /**
   * Resolves where a conversation must resume from so that the turn identified
   * by `anchorId`, and everything after it, is replaced.
   *
   * `resumeThroughId` is the last transcript row to KEEP — resuming is
   * inclusive of it — or `null` when the edited turn is the first prompt and
   * the conversation should start over. `found` is false when `anchorId` is not
   * in the transcript, which the caller must report rather than guess at.
   *
   * Implemented only by providers whose transcripts have stable per-row
   * identity; its absence is what makes "edit this message" unavailable.
   */
  resolveEditAnchor?(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }>;

  /**
   * Rewinds the session so `keepThroughId` is the last row of its
   * conversation, and points the session at whatever provider session now
   * holds it. `null` keeps nothing: the conversation starts over.
   *
   * Implemented only by providers whose runtime cannot resume a transcript
   * partway and have to branch instead. Codex is one — it has no
   * resume-at-a-row, so the rewind is a `thread/fork` that leaves the pre-edit
   * thread on disk and moves the session onto the copy. Providers that can
   * resume partway leave this undefined, and the anchor is handed to their
   * runtime as a resume option instead; that is the difference the edit
   * gateway branches on.
   */
  rewindSession?(sessionId: string, keepThroughId: string | null): Promise<void>;
}

// ---------------------------
//----------------- PROVIDER SESSION SYNCHRONIZER INTERFACE ------------
/**
 * Session indexing contract for one provider.
 *
 * Implementations scan provider-specific session artifacts on disk and upsert
 * normalized session metadata into the database. The service layer uses this
 * interface for both full rescans and single-file incremental sync triggered
 * by filesystem watcher events.
 */
export interface IProviderSessionSynchronizer {
  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;
}
