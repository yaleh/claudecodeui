import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { sessionHostManager as processWideSessionHostManager } from '@/modules/session-hosts/index.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  HostMode,
  HostTurnInput,
  LLMProvider,
  ProcessHost,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  /**
   * The lifecycle mode one session is stored under.
   *
   * A dependency rather than a direct read so the dispatch's routing decision is
   * testable without a database: the criterion that proves a resident turn skips
   * the per-run wrapper hands in its own answer, and the criterion that proves a
   * `per-run` session is untouched leaves the production default in place. The
   * default is the repository's own reader, which is also where an unknown stored
   * value is resolved (to `per-run`) rather than at each call site.
   */
  resolveSessionLifecycleMode(sessionId: string): HostMode;
  /**
   * The host view every dispatched turn registers in.
   *
   * Injectable so a criterion can drive a run through this service and then
   * read the very same manager from its own HTTP surface — the default wrapper
   * writes the host, the listing route reads it, and both have to be looking at
   * one table for "the listing comes from the host layer" to be a statement
   * about the production path. Production leaves it at the process-wide
   * singleton.
   */
  sessionHostManager: SessionHostManager;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
  resolveSessionLifecycleMode: (sessionId) => sessionsDb.getSessionLifecycleMode(sessionId),
  sessionHostManager: processWideSessionHostManager,
};

/**
 * The resident turn entry a host driver may carry, beyond `IProviderHostDriver`.
 *
 * `IProviderHostDriver.submit` is the interface's own turn verb and it takes no
 * writer, because for most providers a turn's client-facing frames belong to the
 * runtime the provider already registered. A provider whose resident mode is
 * real hands the run's writer to the process it holds instead, and that entry —
 * the driver's own `run(appSessionId, turn, writer, context)` — is what this file
 * calls for a session whose lifecycle mode is `resident`.
 *
 * Held as a structural type rather than added to `IProviderHostDriver` because
 * the interface is the seam every provider shares and this is a capability of
 * one; declared here, in the dispatch that reads it, because the dispatch is the
 * only consumer. `residentEntryFor` below is what keeps the shape check from
 * being an assumption.
 */
type ResidentTurnEntry = {
  run(
    appSessionId: string,
    turn: HostTurnInput,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void>;
};

/**
 * Reads the application session id out of a run's options.
 *
 * `options.sessionId` is the stable app id every runtime already receives (and
 * the id `abort` is called with), which is what a host binding is keyed by.
 * Callers that pass none get no host, rather than a host keyed by a
 * provider-native id that changes every run.
 */
function resolveAppSessionId(options: AnyRecord): string | null {
  const sessionId = options?.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

/**
 * Resolves the resident turn entry for one run, or null when the run is not
 * resident.
 *
 * Three facts have to agree, and each is owned by a different layer, which is
 * the point of checking them separately:
 *
 *  1. **The session's own preference** — what the user asked for, read from the
 *     session row. A session that has never been set reads `per-run`.
 *  2. **The provider's declaration** — `lifecycleModes` in the capability
 *     matrix, which is what keeps a stored preference from turning into a
 *     promise the provider never made (a resident preference on a session whose
 *     provider only runs per-turn processes would otherwise route a turn into a
 *     driver that cannot serve it).
 *  3. **The driver's own shape** — the entry above must really be there. A
 *     provider whose capabilities and driver disagree is a bug, and the safe
 *     reading of a bug is the behavior every session had before resident mode
 *     existed: the turn runs per-run.
 *
 * A probe that throws answers "not resident" for the same reason — the mode is a
 * detail of *how* a turn runs, and it must not be able to stop a turn from
 * running at all.
 */
function residentEntryFor(provider: IProvider, appSessionId: string | null): ResidentTurnEntry | null {
  if (!appSessionId) {
    return null;
  }

  try {
    const declared = providerCapabilitiesService
      .getProviderCapabilities(provider.id)
      .lifecycleModes.includes('resident');
    if (!declared) {
      return null;
    }
  } catch {
    return null;
  }

  const driver = provider.hostDriver as unknown as Partial<ResidentTurnEntry> | undefined;
  if (!driver || typeof driver.run !== 'function') {
    return null;
  }

  return driver as ResidentTurnEntry;
}

/**
 * The live host bound to one session, as the manager sees it.
 *
 * Read through `snapshot()` — the manager's detached view — because the dispatch
 * has no business holding a host record across an await, and because a copy is
 * all the driver verbs need: they are addressed by `hostId` and read the mode.
 * A closed host is skipped rather than returned, so an abort cannot be aimed at
 * a process that is already gone.
 */
function liveHostForSession(
  sessionHostManager: SessionHostManager,
  appSessionId: string,
): ProcessHost | null {
  return (
    sessionHostManager
      .snapshot()
      .find((host) => host.state !== 'closed' && host.bindings.has(appSessionId)) ?? null
  );
}

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  /**
   * Resolves one run's resident entry, or null when the run takes the per-run
   * path.
   *
   * The mode is read last and defensively: it is the only one of the three facts
   * that comes from storage, and a session whose mode cannot be read is a session
   * whose turns must still run. The two facts that come from code — the
   * provider's declaration and the driver's shape — are read by
   * `residentEntryFor` and are what keep the mode from being the only thing
   * standing between a stored preference and a route that cannot serve it.
   */
  const resolveResidentEntry = (
    provider: IProvider,
    appSessionId: string | null,
  ): ResidentTurnEntry | null => {
    const entry = residentEntryFor(provider, appSessionId);
    if (!entry || !appSessionId) {
      return null;
    }

    try {
      return dependencies.resolveSessionLifecycleMode(appSessionId) === 'resident' ? entry : null;
    } catch {
      return null;
    }
  };

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    const appSessionId = resolveAppSessionId(options);
    const context = createRuntimeContext(provider);
    const resident = resolveResidentEntry(provider, appSessionId);

    if (resident && appSessionId) {
      // Resident dispatch: the provider's own driver owns the process across
      // turns, so the per-run wrapper is bypassed entirely — it would open a
      // process for this turn and close it at the turn's end, which is the
      // behavior resident mode exists to replace. The driver brings its process
      // up on the first turn and writes later turns into the process it is
      // already holding; `options` therefore reaches it as the *first* turn's
      // launch options when the session is cold, and as a later turn's options
      // (attachments, command) when it is not.
      return resident.run(appSessionId, { command, options }, writer, context);
    }

    // Every other dispatched turn becomes a per-run host. The manager only
    // observes — it wraps the writer so it can see the terminal frame and hands
    // the runtime's own promise straight back — so the runtimes below stay
    // byte-identical and this stays the single dispatch entry point.
    return dependencies.sessionHostManager.trackPerRunTurn({
      provider: providerName,
      appSessionId,
      writer,
      start: (observingWriter) => provider.runtime.run(command, options, observingWriter, context),
    });
  };

  return {
    run,

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      const provider = dependencies.resolveProvider(providerName);
      const resident = resolveResidentEntry(provider, sessionId);

      if (resident) {
        // Resident abort stops the turn, not the process: the driver's interrupt
        // is the SDK's own, which leaves the CLI running so the next turn lands
        // on the same pid. `requestAbort` below is deliberately not reached for
        // this mode — it closes the host, and closing a resident host is exactly
        // killing the process the mode exists to hold. The turn's terminal
        // `complete` is the caller's (the websocket abort handler sends it on the
        // run's behalf), so a false here means no round was in flight to stop.
        const driver = provider.hostDriver;
        const host = liveHostForSession(dependencies.sessionHostManager, sessionId);
        if (!driver || !host) {
          return false;
        }
        return driver.interrupt(host, sessionId);
      }

      const aborted = Boolean(await provider.runtime.abort(sessionId));
      if (aborted) {
        // The runtime confirmed it stopped something, so the host bound to this
        // session is aborted rather than left busy. Reported after `abort` (not
        // before) so a failed stop never closes a host that is still running.
        dependencies.sessionHostManager.requestAbort(sessionId);
      }
      return aborted;
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
