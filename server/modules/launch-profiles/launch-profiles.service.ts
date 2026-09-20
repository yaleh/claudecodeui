import { launchProfilesDb } from '@/modules/database/index.js';
import type { LaunchProfileInput } from '@/modules/database/index.js';
import { isAllowedLaunchEnvKey } from '@/modules/launch-profiles/launch-spec.service.js';
import type { LLMProvider, ResolvedLaunchSpec } from '@/shared/types.js';

const DEFAULT_CONTEXT_WINDOW = 160000;

const MODEL_ALIAS_ENV: Record<string, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

const DEFAULT_AUTH_TARGET = 'ANTHROPIC_AUTH_TOKEN';

/** Seam for the compile-path key filter; tests substitute a lax one to prove the guard is load-bearing. */
export type LaunchSpecGuards = { isAllowedKey: (key: string) => boolean };

/** Seam for the write-path key check; tests substitute a lax one to prove the guard is load-bearing. */
export type LaunchProfilesGuards = { isAllowedKey: (key: string) => boolean };

const DEFAULT_GUARDS = { isAllowedKey: isAllowedLaunchEnvKey };

function compileGatewayEnv(config: Record<string, unknown>, warnings: string[]): Record<string, string> {
  const env: Record<string, string> = {};

  if (typeof config.baseUrl === 'string' && config.baseUrl) {
    env.ANTHROPIC_BASE_URL = config.baseUrl;
  }

  if (config.authMode === 'envVar' && typeof config.authEnvVarName === 'string' && config.authEnvVarName) {
    const value = process.env[config.authEnvVarName];
    const target = typeof config.authEnvVarTarget === 'string' && config.authEnvVarTarget
      ? config.authEnvVarTarget
      : DEFAULT_AUTH_TARGET;
    if (value) {
      env[target] = value;
    } else {
      warnings.push(`Environment variable ${config.authEnvVarName} is not set; the gateway credential is missing`);
    }
  }

  const aliases = config.modelAliases;
  if (aliases && typeof aliases === 'object') {
    for (const [alias, envName] of Object.entries(MODEL_ALIAS_ENV)) {
      const model = (aliases as Record<string, unknown>)[alias];
      if (typeof model === 'string' && model) {
        env[envName] = model;
      }
    }
  }

  return env;
}

/**
 * Resolves the launch spec for a provider run.
 * Consumed by the Claude SDK runtime and the shell websocket service so both
 * launch points share one env compilation step. Without a profile (passthrough)
 * env/argv overrides are empty; a gateway profile compiles to the endpoint,
 * the credential read from the host env var it names, and model aliases.
 */
export function resolveLaunchSpec(
  profileId: string | null,
  _provider: LLMProvider,
  guards: LaunchSpecGuards = DEFAULT_GUARDS,
): ResolvedLaunchSpec {
  const warnings: string[] = [];
  const profile = profileId ? launchProfilesDb.get(profileId) : null;
  if (profileId && !profile) {
    warnings.push(`Launch profile "${profileId}" was not found; running without a profile`);
  }

  // Re-validated on every compile so a row written around the service never reaches a spawn.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile ? compileGatewayEnv(profile.config, warnings) : {})) {
    if (guards.isAllowedKey(key)) {
      env[key] = value;
    } else {
      warnings.push(`Environment variable ${key} is not allowed in a launch profile and was dropped`);
    }
  }

  return {
    env,
    argv: [],
    contextWindow: parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || DEFAULT_CONTEXT_WINDOW,
    warnings,
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
  createProfile(input: LaunchProfileInput, guards: LaunchProfilesGuards = DEFAULT_GUARDS): void {
    const offending = findInlineSecretKey(input.config);
    if (offending) {
      throw new Error(
        `Launch profile config must not contain inline credential "${offending}"; reference an environment variable via authEnvVarName instead`,
      );
    }
    const target = input.config.authEnvVarTarget;
    if (typeof target === 'string' && target && !guards.isAllowedKey(target)) {
      throw new Error(`Environment variable ${target} is not allowed in a launch profile`);
    }
    launchProfilesDb.create(input);
  },
};
