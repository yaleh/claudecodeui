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
export { chatRunRegistry } from './services/chat-run-registry.service.js';
// Consumed by the providers module's sessions watcher, which announces the
// sessions it (re)indexed from disk through the same builder the chat gateway
// uses, so both paths put the identical delta on the wire.
export { broadcastSessionUpserted, broadcastSessionUpsertedBatch } from './services/session-upsert-broadcast.service.js';
// runDetachedChatTurn: used by the scheduled-messages module to run a turn
// from a timer, with no socket to stream to or report errors on.
export { runDetachedChatTurn, handleChatConnection } from './services/chat-websocket.service.js';
export type { ProviderRuntimeGateway } from './services/chat-websocket.service.js';
// handleShellConnection: driven by the passthrough-parity test to prove the pty
// env stays byte-identical when no configured model is selected.
export { handleShellConnection } from './services/shell-websocket.service.js';
