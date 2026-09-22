// The debug agent's public surface (ADR-003).
//
// Importing this module is inert: every consumer asks the gate before it acts,
// which keeps "off" a decision made at the consumer's own seam rather than a
// side effect of an import. Cross-module consumers must come through here
// (backend module standards / `boundaries/dependencies`):
//
//  - `server/index.ts` — mounts the control plane only when the gate is open;
//  - `server/modules/providers/provider.registry.ts` — the runtime provider id,
//    and the provider factory it registers under it;
//  - `server/modules/providers/services/sessions-watcher.service.ts` — the fixture root.
//
// The engine, the scenario document and the arming step are reachable from here
// by value for the module's own tests and for the control plane that will drive
// them; they cost an importer nothing until it calls one, because the gate is
// read inside the call and not at import time.
export {
  DEBUG_AGENT_CONTROL_PLANE_PATH,
  DEBUG_AGENT_PROVIDER_ID,
  debugAgentControlPlaneRouter,
  getDebugAgentGateReason,
  getDebugAgentProjectsRoot,
  isDebugAgentEnabled,
  mountDebugAgentControlPlane,
  readDebugAgentGate,
} from './debug-agent.gate.js';

export {
  DEBUG_AGENT_DIALECTS,
  DEBUG_AGENT_HOMES,
  DEBUG_AGENT_OPS,
  DEBUG_AGENT_ROLES,
  DEBUG_AGENT_SCENARIO_VERSION,
  DEBUG_AGENT_TRANSCRIPT_MODES,
  loadScenario,
} from './debug-agent.scenario.js';
export type {
  DebugAgentDialect,
  DebugAgentHome,
  DebugAgentRole,
  DebugAgentScenario,
  DebugAgentScenarioExpectations,
  DebugAgentScenarioOp,
  DebugAgentScenarioSeed,
  DebugAgentScenarioStep,
  DebugAgentTranscriptMode,
} from './debug-agent.scenario.js';

export {
  armDebugAgentScenario,
  disarmDebugAgentScenario,
  readArmedDebugAgentScenario,
} from './debug-agent.runtime.js';
export type {
  ArmedDebugAgentScenario,
  DebugAgentArmInput,
  DebugAgentTranscriptShape,
} from './debug-agent.runtime.js';

export { evaluateScenarioExpectations, runDebugAgentScenario } from './debug-agent.engine.js';
export type {
  DebugAgentFrameForwarder,
  DebugAgentGrowReading,
  DebugAgentRunInput,
  DebugAgentRunReading,
  DebugAgentScenarioEvaluation,
  DebugAgentStepObservation,
} from './debug-agent.engine.js';

export { createDebugAgentProvider } from './debug-agent.provider.js';
export type {
  DebugAgentProviderDependencies,
  DebugAgentSynchronizerOptions,
} from './debug-agent.provider.js';
