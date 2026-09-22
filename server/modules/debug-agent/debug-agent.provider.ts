import type { IProvider, IProviderRuntime, IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, createCompleteMessage } from '@/shared/utils.js';

import {
  evaluateScenarioExpectations,
  runDebugAgentScenario,
  type DebugAgentFrameForwarder,
} from './debug-agent.engine.js';
import { DEBUG_AGENT_PROVIDER_ID, readDebugAgentGate } from './debug-agent.gate.js';
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
function createDebugAgentRuntime(forwardFrames: DebugAgentFrameForwarder): IProviderRuntime {
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

      const reading = await runDebugAgentScenario({
        scenario: armed.scenario,
        sessionId: armed.providerSessionId,
        cwd: armed.projectPath,
        transcriptPath: armed.transcriptPath,
        writer,
        normalizeMessage: context.normalizeMessage,
        forwardFrames,
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

      writer.send(
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

  return {
    id: DEBUG_AGENT_RUNTIME_PROVIDER_ID,
    runtime: createDebugAgentRuntime(dependencies.forwardFrames),
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
