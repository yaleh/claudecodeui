import { DEBUG_AGENT_PROVIDER_ID, isDebugAgentEnabled } from '@/modules/debug-agent/index.js';
import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// Keyed by `string` rather than by `LLMProvider` because a runtime provider id
// is not a member of that union (ADR-003 decision 2): the union is a product
// declaration that appears in settings, model menus and compile-time exhaustive
// maps, and the debug agent deliberately is not one of those. Resolution was
// already written against `string`, so nothing at the read side had to change.
const providers: Record<string, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),
  opencode: new OpenCodeProvider(),
};

/**
 * Central registry for resolving concrete provider implementations by id.
 *
 * Consumed by: the provider routes, the runtime service, the sessions service
 * and the WebSocket chat path — everything that turns an id from a request into
 * an implementation.
 */
export const providerRegistry = {
  listProviders(): IProvider[] {
    return Object.values(providers);
  },

  resolveProvider(provider: string): IProvider {
    const key = provider as LLMProvider;
    const resolvedProvider = providers[key];
    if (!resolvedProvider) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }

    return resolvedProvider;
  },

  /**
   * Registers the debug agent under its runtime id, and is the ONLY way a
   * non-union id can enter this table. Consumed by the debug agent's provider
   * module when it constructs itself.
   *
   * ADR-003 decision 3, face 1 — "registry 里没有键". The gate is read HERE, so
   * that a closed gate means the key was **never written**: `resolveProvider
   * ('debug')` then throws the same `UNSUPPORTED_PROVIDER` error, with the same
   * message, as `resolveProvider('claud')`. A closed gate and a typo are
   * indistinguishable, which is the property the face is about — a key that
   * existed and was rejected on lookup would be distinguishable, and would put
   * the debug agent on a code path every user's request already traverses.
   *
   * Callers must invoke this after module evaluation (from `server/index.ts` or
   * from a construction site reached through it) rather than at the top level of
   * a module this registry itself imports: the debug agent's provider file is
   * reached through `@/modules/debug-agent/index.js`, so registering it from
   * that file's module scope would close a cycle.
   *
   * @returns whether the key is registered after the call.
   */
  registerDebugAgentProvider(provider: IProvider): boolean {
    if (!isDebugAgentEnabled()) {
      return false;
    }

    providers[DEBUG_AGENT_PROVIDER_ID] = provider;
    return true;
  },
};
