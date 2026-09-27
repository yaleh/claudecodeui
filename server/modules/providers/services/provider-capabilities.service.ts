import type {
  HostMode,
  LLMProvider,
  RuntimeProviderCapabilities,
} from '@/shared/types.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
type ProviderCapabilities = {
  provider: LLMProvider;
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Whether image attachments can be included in a chat.send. */
  supportsImages: boolean;
  /** Whether general file attachments can be included in a chat.send. */
  supportsFiles: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether interactive tool permission prompts can reach the UI. */
  supportsPermissionRequests: boolean;
  /** Whether the token-usage endpoint has data for this provider. */
  supportsTokenUsage: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
  /**
   * Whether an already-sent message can be replaced, which requires the
   * provider to re-run a conversation truncated at a chosen point.
   */
  supportsMessageEditing: boolean;
  /**
   * Whether a session's transcript can be branched into an independent one.
   */
  supportsSessionForking: boolean;
  /**
   * Host lifecycle modes the provider's driver implements. Every provider here
   * is driven by the session-host manager's default per-run wrapper, which is
   * why the whole union is `['per-run']` today; a provider with its own
   * `IProviderHostDriver` states its own list through
   * `declareRuntimeProviderCapabilities` instead of being added to this table,
   * so this record stays a complete description of the `LLMProvider` union.
   */
  lifecycleModes: HostMode[];
  /**
   * Whether one process may serve several sessions at once. False for every
   * provider in the union: the default wrapper opens one process per turn and
   * never reuses a host, so a second binding is refused rather than multiplexed.
   */
  multiplexedHost: boolean;
};

/**
 * The capability matrix mirrors what each runtime actually implements today:
 * - permission modes match the option sets accepted by each CLI/SDK.
 * - only the Claude SDK integration surfaces interactive permission requests.
 * - Cursor has no token usage endpoint support (its store.db has no usage rows).
 */
const PROVIDER_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
    // `resumeSessionAt` re-runs a conversation truncated at a message, and
    // `forkSession` copies a transcript prefix into a new session file.
    supportsMessageEditing: true,
    supportsSessionForking: true,
    lifecycleModes: ['per-run'],
    multiplexedHost: false,
  },
  cursor: {
    provider: 'cursor',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: false,
    supportsEffort: false,
    supportsMessageEditing: false,
    supportsSessionForking: false,
    lifecycleModes: ['per-run'],
    multiplexedHost: false,
  },
  codex: {
    provider: 'codex',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
    // Not from the Codex SDK, which only starts and resumes threads: both ride
    // the same CLI's `app-server` protocol, whose `thread/fork` copies a
    // thread up to a chosen turn. Editing is that fork plus a new prompt,
    // which is how Codex's own IDE clients do it.
    supportsMessageEditing: true,
    supportsSessionForking: true,
    lifecycleModes: ['per-run'],
    multiplexedHost: false,
  },
  opencode: {
    provider: 'opencode',
    // Mapped by the runtime onto OpenCode's controls: `--agent plan` (plan),
    // `--auto` (bypassPermissions) and the OPENCODE_PERMISSION env var
    // (acceptEdits). See resolveOpenCodePermissionOptions in the OpenCode runtime adapter.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
    supportsMessageEditing: false,
    supportsSessionForking: false,
    lifecycleModes: ['per-run'],
    multiplexedHost: false,
  },
};

/**
 * Capabilities stated by providers that are not in the `LLMProvider` union.
 *
 * A separate store, not extra keys in `PROVIDER_CAPABILITIES`, and that
 * separation is the point: the union-keyed table is read by routes that
 * validate a provider id against the union first, so an entry for a
 * CLI-less/SDK-less provider placed there would be unreachable at best and, at
 * worst, would tempt a reader into widening `LLMProvider` to include a provider
 * that cannot serve any user-facing request. Declarations here are made by the
 * provider's own construction path at boot and are absent until then, which is
 * also how a build with the provider gated off reads: no declaration, no row.
 */
const RUNTIME_PROVIDER_CAPABILITIES = new Map<string, RuntimeProviderCapabilities>();

/**
 * Application service exposing the provider capability matrix.
 */
export const providerCapabilitiesService = {
  getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
    return PROVIDER_CAPABILITIES[provider];
  },

  listAllProviderCapabilities(): ProviderCapabilities[] {
    return Object.values(PROVIDER_CAPABILITIES);
  },

  /**
   * Records the lifecycle facts of one non-union provider.
   *
   * Idempotent and last-write-wins: the declaration is derived from the
   * provider's own driver, so re-declaring the same provider at a second
   * construction point (tests build the registry more than once per process)
   * must not fail or accumulate.
   */
  declareRuntimeProviderCapabilities(capabilities: RuntimeProviderCapabilities): void {
    RUNTIME_PROVIDER_CAPABILITIES.set(capabilities.provider, {
      ...capabilities,
      lifecycleModes: [...capabilities.lifecycleModes],
    });
  },

  /**
   * Reads one non-union provider's declaration, or `undefined` when nothing
   * declared it — either the provider is gated off in this build, or its
   * construction path never ran.
   */
  getRuntimeProviderCapabilities(provider: string): RuntimeProviderCapabilities | undefined {
    const declared = RUNTIME_PROVIDER_CAPABILITIES.get(provider);
    if (!declared) {
      return undefined;
    }

    return { ...declared, lifecycleModes: [...declared.lifecycleModes] };
  },
};
