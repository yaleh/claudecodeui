import { launchProfilesDb } from '@/modules/database/index.js';

const ALLOWED_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AUTOCOMPACT_'];
const ALLOWED_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ENABLE_TOOL_SEARCH',
  'DISABLE_TELEMETRY',
]);
// Rejected even when a key also matches an allowed prefix (e.g. CLAUDE_CODE_*-style path overrides).
const DENIED_ENV_KEYS = new Set([
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
  'PYTHONPATH',
  'CLAUDE_CLI_PATH',
  'CLAUDE_CONFIG_DIR',
]);

function isAllowedEnvKey(key: string): boolean {
  if (DENIED_ENV_KEYS.has(key) || key.startsWith('DYLD_')) {
    return false;
  }
  return ALLOWED_ENV_KEYS.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Returns the keys of `env` that are not allowed in a launch profile. */
function findRejectedEnvKeys(env: Record<string, unknown>): string[] {
  return Object.keys(env).filter((key) => !isAllowedEnvKey(key));
}

/** Write-path guard for launch-profiles.service: throws a readable error naming every disallowed env key. */
export function assertAllowedLaunchEnv(env: Record<string, unknown>): void {
  const rejected = findRejectedEnvKeys(env);
  if (rejected.length > 0) {
    throw new Error(`Environment variable(s) not allowed in a launch profile: ${rejected.join(', ')}`);
  }
}

/** Compile-path filter: drops disallowed keys and non-string values so stale rows can never reach a spawn. */
export function filterAllowedLaunchEnv(env: Record<string, unknown>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isAllowedEnvKey(key) && typeof value === 'string') {
      filtered[key] = value;
    }
  }
  return filtered;
}

export type LaunchSpec = { env: Record<string, string> };

/** Seam for the compile-path env filter; tests substitute a lax one to prove the guard is load-bearing. */
export type LaunchSpecGuards = { filterEnv: (env: Record<string, unknown>) => Record<string, string> };

const DEFAULT_GUARDS: LaunchSpecGuards = { filterEnv: filterAllowedLaunchEnv };

function readStoredEnv(configJson: string): Record<string, unknown> {
  try {
    const config = JSON.parse(configJson) as { env?: unknown };
    return config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Compiles a stored profile row into a launch spec, re-validating env regardless of how the row was written. */
export function resolveLaunchSpec(
  profile: { config_json: string },
  guards: LaunchSpecGuards = DEFAULT_GUARDS,
): LaunchSpec {
  return { env: guards.filterEnv(readStoredEnv(profile.config_json)) };
}

/** Used by the WebSocket module: turns a client-supplied profile id into a server-resolved launch spec. */
export function resolveLaunchSpecById(id: string): LaunchSpec {
  const profile = launchProfilesDb.get(id);
  if (!profile) {
    throw new Error(`Launch profile "${id}" not found.`);
  }
  return resolveLaunchSpec(profile);
}
