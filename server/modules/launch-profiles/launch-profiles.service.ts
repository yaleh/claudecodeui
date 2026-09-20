import type { LLMProvider, ResolvedLaunchSpec } from '@/shared/types.js';

const DEFAULT_CONTEXT_WINDOW = 160000;

/**
 * Resolves the launch spec for a provider run.
 * Consumed by the Claude SDK runtime and the shell websocket service so both
 * launch points share one env compilation step. Only the passthrough path
 * (no profile) exists so far: it yields empty env/argv overrides.
 */
export function resolveLaunchSpec(
  _profileId: string | null,
  _provider: LLMProvider,
): ResolvedLaunchSpec {
  return {
    env: {},
    argv: [],
    contextWindow: parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || DEFAULT_CONTEXT_WINDOW,
    warnings: [],
  };
}
