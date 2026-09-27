import express from 'express';
import type { Request, Response } from 'express';

import type { HostLease, LLMProvider, ProcessHost, SessionBinding } from '@/shared/types.js';
import { createApiSuccessResponse } from '@/shared/utils.js';

import type { SessionHostManager } from './session-host-manager.service.js';

/**
 * One host as the listing endpoint reports it.
 *
 * A projection rather than the manager's own record, for two reasons. The
 * record's `bindings` is a `Map`, which `JSON.stringify` would flatten to `{}`
 * — the one shape a browser cannot read — and the record carries fields
 * (`closeDetail`, `quietDeadlineAt`, `quietWindowStartAt`) whose meaning is the
 * state machine's internal bookkeeping. What a client is owed is the host's
 * identity, what it is, whether it is still there, and who is on it.
 *
 * `closeReason` is null on a host that is still open, which is also the only
 * way a reader can tell "still running" from "closed" without a second field:
 * a closed host always has a reason (`closeHost` sets the two together).
 */
type HostView = {
  hostId: string;
  provider: LLMProvider;
  mode: ProcessHost['mode'];
  state: ProcessHost['state'];
  /** The child process id, or null for a host that was never given one. */
  pid: number | null;
  startedAt: number;
  closeReason: ProcessHost['closeReason'];
  bindings: BindingView[];
};

/** One session on a host, as the listing endpoint reports it. */
type BindingView = {
  appSessionId: string;
  providerSessionId: string | null;
  state: SessionBinding['state'];
  leases: HostLease[];
  lastActivityAt: number;
};

/**
 * The HTTP face of the host layer: `GET /api/session-hosts`.
 *
 * Exported as a factory rather than as a ready-made router because the manager
 * is a dependency, not a module-level constant: `server/index.ts` mounts it
 * over the process-wide singleton, and a criterion mounts it over a manager it
 * built and drove itself, so the listing it reads is the same table the
 * dispatch under test wrote.
 *
 * The handler does one thing — read the manager's snapshot, project it, wrap it
 * in the standard envelope — and deliberately does not import `chatRunRegistry`
 * or touch the database. That is not stylistic: the hosts are the host layer's
 * own state, and a listing built from the run registry would silently omit the
 * hosts that exist *after* their run ended (a `lingering` process, a held-stdin
 * window), which is exactly the state this endpoint exists to show.
 */
export function createSessionHostsRouter({
  sessionHostManager,
}: {
  sessionHostManager: SessionHostManager;
}) {
  const router = express.Router();

  router.get('/', (_request: Request, response: Response) => {
    const hosts = sessionHostManager.snapshot().map(toHostView);
    response.json(createApiSuccessResponse({ hosts }));
  });

  return router;
}

/** Projects one manager record into the wire shape above. */
function toHostView(host: ProcessHost): HostView {
  return {
    hostId: host.hostId,
    provider: host.provider,
    mode: host.mode,
    state: host.state,
    pid: host.pid,
    startedAt: host.startedAt,
    closeReason: host.closeReason,
    bindings: [...host.bindings.values()].map(toBindingView),
  };
}

/** Projects one session on a host. Leases are copied by `snapshot()` already. */
function toBindingView(binding: SessionBinding): BindingView {
  return {
    appSessionId: binding.appSessionId,
    providerSessionId: binding.providerSessionId,
    state: binding.state,
    leases: binding.leases,
    lastActivityAt: binding.lastActivityAt,
  };
}
