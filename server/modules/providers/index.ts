export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService, createProviderRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';
export { searchConversations } from './services/session-conversations-search.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
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
export { createProviderTokenUsageService, summarizeClaudeTokenUsage } from './services/provider-token-usage.service.js';
