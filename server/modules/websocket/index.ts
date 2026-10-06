export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
// The business heartbeat's public face. The shipped timings are read by the
// process criterion that measures the beat, and the two entries that read the
// environment overrides / describe the frames are the module's advertised
// activity contract for any other consumer.
export {
  ACTIVITY_HEARTBEAT_INTERVAL_MS,
  ACTIVITY_UNREACHABLE_AFTER_MS,
  // BOOT_ID: the identity of the running process, the same value the activity
  // snapshots carry. Consumed by `server/index.ts`, which binds it as the
  // `bootId` seam of the MCP gateway's `run_get` deps (AC-248) so a run's boot
  // and the boot it is compared against are read from one source.
  BOOT_ID,
  resolveActivityHeartbeatConfig,
  activityAnnouncement,
  attachActivityHeartbeat,
} from './services/activity-heartbeat.service.js';
// The activity protocol's storage face and its read port. `activityStore` is the
// process-wide instance the server mounts and the heartbeat reads its revision
// from, so a client's snapshot and its heartbeat always agree about `rev`.
// `createActivityStore` / `createActivityRouter` are the seams the criterion
// (`server/modules/websocket/tests/activity-protocol.test.ts`) and
// `server/index.ts` use; the types are the contract those consumers type against.
export {
  createActivityStore,
  activityStore,
  type ActivityStore,
  type ActivityStoreOptions,
  type ActivityProtocolSnapshot,
  type ActivityProtocolFrame,
  type ActivityProtocolFrameKind,
  type ActivityFrameListener,
} from './services/activity-protocol.service.js';
export { createActivityRouter } from './services/activity.routes.js';
// createChatRunRegistry: the injection seam that builds an ISOLATED registry
// with its own clock, retention window and boot reader (the process singleton
// `chatRunRegistry` below is the default-configured instance). Consumed by the
// MCP gateway's `run_get` criterion (AC-248), which drives a run to completion
// / a reboot on a fake clock without waiting on, or disturbing, the process
// registry.
export { chatRunRegistry, createChatRunRegistry } from './services/chat-run-registry.service.js';
// ChatRunSummary / ChatRunLookupMiss / ChatRunLookupResult: the run-addressing
// vocabulary. `ChatRunSummary` is the read-only projection of one tracked run;
// `ChatRunLookupMiss` is why a by-id read found nothing (`expired` = it existed
// and aged out, `unknown` = the id was never handed out); `ChatRunLookupResult`
// is their union. Consumers: the MCP gateway's `overview` tool (AC-247) types
// the aborted-run reading of `listRecentRuns` against `ChatRunSummary`, and its
// `run_get` (AC-248) types the registry lookup and its three miss reasons
// against the other two — so the vocabulary is not restated in a second module.
export type {
  ChatRunLookupMiss,
  ChatRunLookupResult,
  ChatRunSummary,
} from './services/chat-run-registry.service.js';
// createChatControlService: the transport-agnostic control plane. Consumed by
// `server/index.ts` to build the single process-wide instance the WebSocket
// gateway, the scheduled-message dispatcher and (later) the MCP gateway share;
// by this module's own websocket service (which resolves the seam);
// and by the debug agent's control-queue criterion
// (`server/modules/debug-agent/tests/debug-agent-control-queue.test.ts`), which
// drives a resident busy send and its withdrawal through it with no socket.
export { createChatControlService } from './services/chat-control.service.js';
// Consumed by the providers module's sessions watcher, which announces the
// sessions it (re)indexed from disk through the same builder the chat gateway
// uses, so both paths put the identical delta on the wire.
export { broadcastSessionUpserted, broadcastSessionUpsertedBatch } from './services/session-upsert-broadcast.service.js';
// The `hosts_changed` invalidation producer. Consumed by `server/index.ts`,
// which forwards the session-host manager's `onChange` revisions to it — the
// manager cannot import this module back (the providers module and this module's
// chat websocket already import the manager), so the composition root installs
// the wire. Documented in the service; kept here so the manager's `onChange`
// consumer lives behind the barrel like every other cross-module edge.
export { broadcastHostsChanged } from './services/hosts-changed-broadcast.service.js';
// handleChatConnection: the chat websocket surface, mounted by
// `createWebSocketServer` and driven directly by the gateway criteria.
export { handleChatConnection } from './services/chat-websocket.service.js';
export type { ProviderRuntimeGateway } from './services/chat-websocket.service.js';
// handleShellConnection: driven by the passthrough-parity test to prove the pty
// env stays byte-identical when no configured model is selected.
export { handleShellConnection } from './services/shell-websocket.service.js';
