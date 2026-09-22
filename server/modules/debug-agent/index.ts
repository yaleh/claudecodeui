// The debug agent's public surface (ADR-003).
//
// Importing this module is inert: every consumer asks the gate before it acts,
// which keeps "off" a decision made at the consumer's own seam rather than a
// side effect of an import. Cross-module consumers must come through here
// (backend module standards / `boundaries/dependencies`):
//
//  - `server/index.ts` — mounts the control plane only when the gate is open;
//  - `server/modules/providers/provider.registry.ts` — the runtime provider id;
//  - `server/modules/providers/services/sessions-watcher.service.ts` — the fixture root.
export {
  DEBUG_AGENT_CONTROL_PLANE_PATH,
  DEBUG_AGENT_PROVIDER_ID,
  debugAgentControlPlaneRouter,
  getDebugAgentGateReason,
  getDebugAgentProjectsRoot,
  isDebugAgentEnabled,
  mountDebugAgentControlPlane,
} from './debug-agent.gate.js';
