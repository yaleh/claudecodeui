export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService, createProviderRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';
// LifecycleModeSwitchResult: the answer `sessionsService.switchSessionLifecycleMode`
// gives — the stored mode plus what happened to the host that was serving the
// session — exported so a criterion can type what the lifecycle-mode route
// answered without restating the shape.
export type { LifecycleModeSwitchResult } from './services/sessions.service.js';
export { searchConversations } from './services/session-conversations-search.service.js';

// readSessionAiTitle: used by the commands module's `/cost` handler to show the
// title Claude generated for a session. Only the providers module knows a
// transcript's shape, and only it owns the row that points at one.
export { readSessionAiTitle } from './services/session-ai-title.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
// resolveProviderWatchPaths / ensureProviderWatchRoots: the observation set's own
// seam, driven by the debug-agent gate criterion (`debug-agent-gate.test.ts`), which
// reads the set on both sides of the gate and then confirms the fixture root was
// neither listed nor created. `providerRegistry` is exported for the same criterion:
// the registry face is about whether a key exists, which is only readable from here.
export {
  resolveProviderWatchPaths,
  ensureProviderWatchRoots,
} from './services/sessions-watcher.service.js';
export type { ProviderWatchPath } from './services/sessions-watcher.service.js';
// readActiveWatcherModes: consumed by the debug agent's external-write criterion
// (`debug-agent-external-write.test.ts`), whose arms must each prove the fixture
// root came up in the mechanism that arm pinned — an arm that asked for native
// events and silently got a polling clock would be reporting a different
// experiment than the one it names.
export { readActiveWatcherModes } from './services/sessions-watcher.service.js';
export type { WatcherMode } from './services/sessions-watcher.service.js';
export { providerRegistry } from './provider.registry.js';
// providerRoutes: the module's HTTP face. Mounted by `server/index.ts`, and by
// the lifecycle-mode criterion, which has to drive the real
// `PUT /:provider/sessions/:sessionId/lifecycle-mode` route (and read its
// refusals) rather than call the service directly — the route is where the
// transport-level `LIFECYCLE_MODE_UNKNOWN` refusal lives.
export { default as providerRoutes } from './provider.routes.js';
// providerCapabilitiesService: the capability matrix. Exported so the
// lifecycle-mode criterion can print the claude row's `residentFeatures` and
// prove a mode is refused because `lifecycleModes` does not list it, reading
// the same statement the route branches on instead of a copy of it.
export { providerCapabilitiesService } from './services/provider-capabilities.service.js';
// resolveModelLaunchSpec: consumed by the websocket module's shell pty to compile the
// spawn env for the selected custom model.
export { resolveModelLaunchSpec, resolveModelContextWindowRow } from './services/model-launch-spec.service.js';
// LaunchSpecGuards: the compile-path key-filter seam, consumed by the model compile tests.
export type { LaunchSpecGuards } from './services/model-launch-spec.service.js';
// mapCliOptionsToSDK: driven by the passthrough-parity test to prove the SDK env
// stays byte-identical when no configured model is selected.
export { mapCliOptionsToSDK } from './list/claude/claude-runtime.provider.js';
// Token-budget helpers: driven by the token-budget tests to prove the context
// window follows the resolved model entry.
export { extractCumulativeTokenBudget, extractTokenBudget } from './list/claude/claude-runtime.provider.js';
// forwardNormalizedFrames: the normalizer→writer seam, driven by the frame-forwarding
// test with a fake writer to prove every normalized frame (stream_delta included) is
// actually handed over — the half neither the normalizer's tests nor the broadcaster's
// tests can see.
export { forwardNormalizedFrames } from './list/claude/claude-runtime.provider.js';
export { createProviderTokenUsageService, summarizeClaudeTokenUsage } from './services/provider-token-usage.service.js';
// ClaudeSessionsProvider: driven by the stream-event unwrap test, which needs the
// normalizer's own class to prove a partial SDK frame reaches the wire as a
// `stream_delta` without a live CLI in the loop.
export { ClaudeSessionsProvider } from './list/claude/claude-sessions.provider.js';
// ClaudeSessionSynchronizer: driven by the websocket module's session-upsert
// broadcast test, which needs the real indexer to put an ai-title on a row
// before asserting the delta that carries it.
export { ClaudeSessionSynchronizer } from './list/claude/claude-session-synchronizer.provider.js';

// Session scoping: `mapCliOptionsToSDK` installs the spawn hook that puts every
// Claude session in its own capped systemd scope, and `server/index.ts` sweeps
// orphaned scopes at start-up and stops this server's scopes on shutdown. The
// session-scope test drives the hook, the lifecycle and the failure readings.
export {
  createClaudeSessionScopeSpawn,
  resolveClaudeSessionMemoryMax,
  probeSystemdUserScope,
  resetClaudeSessionScopeProbeCache,
  buildClaudeSessionScopeUnitName,
  parseClaudeSessionScopeOwnerPid,
  listClaudeSessionScopeUnits,
  stopClaudeSessionScopes,
  sweepOrphanClaudeSessionScopes,
  DEFAULT_CLAUDE_SESSION_MEMORY_MAX,
} from './services/claude-session-scope.service.js';
export type {
  ClaudeSessionScopeSpawnDeps,
  SessionScopeProcess,
  SessionScopeSpawnImpl,
} from './services/claude-session-scope.service.js';
