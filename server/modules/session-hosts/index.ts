// sessionHostManager: the process-wide host view. Used by the providers module's
// `provider-runtime.service` to register every dispatched run as a per-run host,
// and by this module's criterion test, which reads hosts only through
// `snapshot()`.
export { sessionHostManager, createSessionHostManager } from './session-host-manager.service.js';
// PerRunTurnInput / SessionHostManagerOptions: the manager's own call shapes, so a
// caller can type the turn it hands over without reaching into the service file.
export type {
  PerRunTurnInput,
  SessionHostManager,
  SessionHostManagerOptions,
} from './session-host-manager.service.js';
// Host lifecycle read-port types: the vocabulary a consumer needs to read
// `snapshot()` (and the shape siblings will extend with resident-mode data).
export type {
  HostCloseReason,
  HostLease,
  HostMode,
  HostState,
  ProcessHost,
  SessionBinding,
} from '@/shared/types.js';
