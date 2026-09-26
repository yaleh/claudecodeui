import type { IProvider, IProviderRuntime, IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { LLMProvider, RuntimeProviderCapabilities } from '@/shared/types.js';
import { AppError, createCompleteMessage } from '@/shared/utils.js';

import {
  evaluateScenarioExpectations,
  runDebugAgentScenario,
  type DebugAgentFrameForwarder,
} from './debug-agent.engine.js';
import { DEBUG_AGENT_PROVIDER_ID, readDebugAgentGate } from './debug-agent.gate.js';
import {
  createDebugAgentHostDriver,
  type DebugAgentHostDriver,
  type DebugAgentOpenRun,
} from './debug-agent.host-driver.js';
import { readArmedDebugAgentScenario } from './debug-agent.runtime.js';

/**
 * The debug agent as a provider: a face the registry can resolve and the product
 * chat path can drive, with no CLI and no SDK behind it.
 *
 * Where the other faces come from is the design, not a shortcut. `sessions` is the
 * claude provider's own implementation, so "the product and the debug agent turn
 * the same dialect row into the same frame" is reuse rather than a promise kept
 * in step by hand; only `runtime` is written here. ADR-003 decision 2 keeps the id
 * out of `LLMProvider`, which is why it is cast at exactly one place below and
 * why the injection shape exists at all: this module may not import the providers
 * module (the registry registers this provider, so the import would close a cycle
 * and leave the registry reading a half-evaluated binding), so everything it needs
 * from there arrives as a dependency.
 */

/** The id this provider registers under, cast once — the only cast ADR-003 decision 2 needs. */
const DEBUG_AGENT_RUNTIME_PROVIDER_ID = DEBUG_AGENT_PROVIDER_ID as LLMProvider;

/** Where the synchronizer for a fixture home should read from and write as. */
export type DebugAgentSynchronizerOptions = {
  home: string;
  providerId: string;
};

export type DebugAgentProviderDependencies = {
  /**
   * The claude provider instance. Its `sessions` face is the real normalizer, so
   * the frames a debug run produces are the product's own shapes.
   */
  base: IProvider;
  /** The product's normalizer → writer forwarder (`forwardNormalizedFrames`). */
  forwardFrames: DebugAgentFrameForwarder;
  /**
   * Builds the indexer for a fixture home. Injected because the indexer belongs
   * to the providers module, and because the file it indexes is a fixture: the
   * product's own instance would scan the user's real transcripts.
   */
  createSessionSynchronizer: (options: DebugAgentSynchronizerOptions) => IProviderSessionSynchronizer;
  /**
   * How an unattended turn opens the run it belongs to.
   *
   * Injected, and optional, because the run registry lives in the websocket
   * module and the construction site that builds this provider does not have it
   * in scope — the registry this provider is being registered into is what the
   * websocket module imports, so reaching back for it would close the cycle
   * ADR-003 decision 7 forbids. A build that wires no seam gets a provider
   * whose scenario steps still run and whose unattended turn fails loudly
   * naming the gap; the capability declaration below is about the process
   * lifetimes the driver implements, not about this one seam.
   */
  openRun?: DebugAgentOpenRun;
  /**
   * Records the lifecycle facts this provider states about itself.
   *
   * A callback rather than a direct call because the capability matrix belongs
   * to the providers module. It is how a provider that is deliberately not in
   * `LLMProvider` states `resident` mode and a multiplexed host without the
   * union-keyed table gaining a row for an id that can serve no user-facing
   * request.
   */
  declareRuntimeCapabilities?: (capabilities: RuntimeProviderCapabilities) => void;
};

/**
 * The run seam of a build that wired none.
 *
 * Throws rather than returning null: "no run was opened" and "this build has
 * nowhere to open one" are different failures, and a scenario author debugging
 * a silent turn deserves to be told which one they hit.
 */
const unwiredOpenRun: DebugAgentOpenRun = ({ appSessionId }) => {
  throw new AppError(
    `No run seam is wired for the debug agent's unattended turn on session "${appSessionId}".`,
    { code: 'DEBUG_AGENT_RUN_SEAM_UNAVAILABLE', statusCode: 500 },
  );
};

/**
 * The runtime face: it walks the scenario armed for the session the run is for,
 * and reports the artifact's own readings back to its caller.
 *
 * The only id a run can be addressed by is the id an armed scenario was indexed
 * under, so an unarmed session is refused with a reason naming it rather than
 * quietly producing nothing — a debug session that appears to run and emits no
 * frame would be indistinguishable from a client that failed to connect.
 */
function createDebugAgentRuntime(
  forwardFrames: DebugAgentFrameForwarder,
  hostDriver: DebugAgentHostDriver,
): IProviderRuntime {
  return {
    async run(command, options, writer, context) {
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
      const armed = readArmedDebugAgentScenario(sessionId);
      if (!armed) {
        throw new AppError(`No debug agent scenario is armed for session "${sessionId}".`, {
          code: 'DEBUG_AGENT_SCENARIO_NOT_ARMED',
          statusCode: 400,
        });
      }

      // The transcript's session id, announced before the first row is written.
      // It is what the registry maps the run's session back to, and therefore
      // what the terminal `complete`'s REST re-fetch reads the history through.
      writer.setSessionId?.(armed.providerSessionId);

      // Where this run's frames ended up. It starts as the caller's writer and
      // follows them to the run's own writer when an unattended turn opens one,
      // which is the whole reason it is tracked here: the terminal frame has to
      // end the run that produced the turn. Writing it to the caller's writer
      // instead would leave the run open for good — a client that replayed it
      // would see a turn that never finished, and the session would stay
      // "processing" with nothing running.
      let delivery = writer;

      const reading = await runDebugAgentScenario({
        scenario: armed.scenario,
        sessionId: armed.providerSessionId,
        // The id the host layer and the run registry address the session by.
        // `sessionId` above is the provider-native one the rows carry; a host
        // step addressed with that would land on a session no one is watching.
        appSessionId: armed.sessionId,
        cwd: armed.projectPath,
        transcriptPath: armed.transcriptPath,
        writer,
        normalizeMessage: context.normalizeMessage,
        forwardFrames,
        hostOps: hostDriver,
        onDelivery: (next) => {
          delivery = next;
        },
      });

      const evaluation = evaluateScenarioExpectations({
        scenario: armed.scenario,
        transcriptPath: armed.transcriptPath,
        reading,
        sessionId: armed.providerSessionId,
        normalizeMessage: context.normalizeMessage,
      });

      // A scenario's expectations are the run's own verdict on itself, and it is
      // reported the way every provider reports one: the terminal frame's exit
      // code. The numbers stay in the return value, so a caller that wants the
      // artifact's readings does not have to reconstruct them from the socket.
      if (evaluation.failures.length > 0) {
        console.error(
          `[DebugAgent] Scenario run for session "${armed.sessionId}" did not meet its own expectations:\n${evaluation.failures.join('\n')}`,
        );
      }

      delivery.send(
        createCompleteMessage({
          provider: DEBUG_AGENT_RUNTIME_PROVIDER_ID,
          sessionId: armed.providerSessionId,
          exitCode: evaluation.failures.length === 0 ? 0 : 1,
        }),
      );

      return { reading, evaluation };
    },

    abort() {
      // A scenario is a clock walk over a file, and its longest step is a `wait`.
      // There is no child process, no SDK request and no partial artifact to tear
      // down, so there is nothing to abort — reported as "nothing was aborted"
      // rather than as a success a caller could mistake for a stopped run.
      return false;
    },
  };
}

/**
 * Builds the debug agent's provider, or null when the gate is closed.
 *
 * Consumed by the provider registry, which calls this from its own construction
 * site and registers the result under {@link DEBUG_AGENT_PROVIDER_ID}. The gate is
 * read here as well as in the registry's seam so that a closed gate means nothing
 * is constructed at all — not a provider with a plausible-looking home that a
 * later bug could reach.
 */
export function createDebugAgentProvider(
  dependencies: DebugAgentProviderDependencies,
): IProvider | null {
  const gate = readDebugAgentGate();
  if (!gate.enabled || !gate.home) {
    return null;
  }

  const hostDriver = createDebugAgentHostDriver({ openRun: dependencies.openRun ?? unwiredOpenRun });
  if (!hostDriver) {
    // Unreachable: `createDebugAgentHostDriver` reads the same gate this
    // function just read. Kept as a refusal rather than a non-null assertion so
    // that a future gate rule that disagrees between the two produces no
    // provider at all instead of one with an unsound lifetime claim.
    return null;
  }

  // The declaration is derived from the driver rather than written out beside
  // it: "this provider serves resident hosts and multiplexes them" is a
  // statement about what the object below implements, and two copies of it
  // would be two things to keep in step.
  dependencies.declareRuntimeCapabilities?.({
    provider: DEBUG_AGENT_PROVIDER_ID,
    lifecycleModes: [...hostDriver.lifecycleModes],
    multiplexedHost: hostDriver.multiplexedHost === true,
  });

  return {
    id: DEBUG_AGENT_RUNTIME_PROVIDER_ID,
    runtime: createDebugAgentRuntime(dependencies.forwardFrames, hostDriver),
    hostDriver,
    models: dependencies.base.models,
    mcp: dependencies.base.mcp,
    auth: dependencies.base.auth,
    skills: dependencies.base.skills,
    sessions: dependencies.base.sessions,
    sessionSynchronizer: dependencies.createSessionSynchronizer({
      home: gate.home,
      providerId: DEBUG_AGENT_PROVIDER_ID,
    }),
  };
}
