export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
// The business heartbeat's public face. The shipped timings are read by the
// process criterion that measures the beat, and the two entries that read the
// environment overrides / describe the frames are the module's advertised
// activity contract for any other consumer.
export {
  ACTIVITY_HEARTBEAT_INTERVAL_MS,
  ACTIVITY_UNREACHABLE_AFTER_MS,
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
export { chatRunRegistry } from './services/chat-run-registry.service.js';
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
// handleChatConnection: the chat websocket surface, mounted by
// `createWebSocketServer` and driven directly by the gateway criteria.
export { handleChatConnection } from './services/chat-websocket.service.js';
export type { ProviderRuntimeGateway } from './services/chat-websocket.service.js';
// handleShellConnection: driven by the passthrough-parity test to prove the pty
// env stays byte-identical when no configured model is selected.
export { handleShellConnection } from './services/shell-websocket.service.js';
