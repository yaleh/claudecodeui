import { launchProfilesDb } from '@/modules/database/index.js';
import type { LaunchProfileInput } from '@/modules/database/index.js';
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

/** Payload keys that would carry an inline credential value; never persisted. */
const INLINE_SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'authtoken',
  'auth_token',
  'token',
  'secret',
  'password',
]);

/** Recursively finds an inline credential key so the value can never reach `config_json`. */
function findInlineSecretKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (INLINE_SECRET_KEYS.has(key.toLowerCase())) {
      return key;
    }
    const nested = findInlineSecretKey(child);
    if (nested) {
      return nested;
    }
  }
  return null;
}

// launchProfilesService: consumed by launch-profiles routes and tests; credentials are referenced only via `authEnvVarName`.
export const launchProfilesService = {
  /** Persists a profile, rejecting any payload that carries an inline credential value. */
  createProfile(input: LaunchProfileInput): void {
    const offending = findInlineSecretKey(input.config);
    if (offending) {
      throw new Error(
        `Launch profile config must not contain inline credential "${offending}"; reference an environment variable via authEnvVarName instead`,
      );
    }
    launchProfilesDb.create(input);
  },
};
