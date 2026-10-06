/**
 * The MCP gateway's `session_cancel_queued` handler (AC-271).
 *
 * `session_cancel_queued` withdraws a message a busy send queued, by the
 * `queuedMessageUuid` that `session_send` handed back. It is an ADAPTER: it
 * translates a tool call into the shared `ChatControlService`'s `cancelQueued`
 * (the same verb AC-231 landed and AC-238 exercised over the debug driver) and
 * translates that verb's verdict into AC-271's own vocabulary.
 *
 * The vocabulary mismatch is the whole point of this module. The control service
 * answers with the shared union `HostQueuedInputCancelResult`
 * (`server/shared/types.ts`): a message still in the queue really leaves it and
 * is answered `withdrawn`; one already taken — already started — is answered
 * `unknown` by the debug driver (`already-started` by the real Claude driver,
 * covered by AC-275). AC-271 requires the TOOL to report `cancelled` for the
 * successful withdrawal, so this adapter maps `withdrawn` -> `cancelled` and
 * must never pass `withdrawn` through verbatim; the other members map to
 * themselves, so a message that already started is never reported `cancelled`.
 *
 * Everything is injected ({@link McpSessionCancelQueuedDeps}): production wires
 * the process singleton (`server/index.ts`); the criterion wires the real control
 * service over its own fixture. The `session` argument arrives already rewritten
 * to an id by AC-246's target gate (the criterion uses an exact id).
 */

import { z } from 'zod';

import type { HostQueuedInputCancelResult } from '@/shared/types.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpControlCaller } from './mcp-session-send.js';

// --------------------------- injected services ---------------------------

/**
 * The one control verb `session_cancel_queued` needs: withdrawing a queued
 * message by uuid.
 *
 * The caller shape is {@link McpControlCaller} (`{ userId, via: 'mcp' }`), the
 * same caller `session_send` presents, so a withdrawal goes through the control
 * service's shared access entry exactly as a send does. `forbidden` is the
 * control service's own refusal (a caller with no access); it is deliberately a
 * member of this contract because the adapter must treat it as a refusal, never
 * as a successful withdrawal.
 */
export type McpSessionCancelQueuedDeps = {
  control: {
    cancelQueued(
      caller: McpControlCaller,
      input: { sessionId: string; messageUuid: string },
    ): Promise<HostQueuedInputCancelResult | 'forbidden'>;
  };
};

// --------------------------- input and payload ---------------------------

/**
 * AC-271's report vocabulary — the words THIS tool uses.
 *
 * `cancelled` is the control service's `withdrawn` (the message really left the
 * queue and will never become a round); `already-started` is the real Claude
 * driver's reading of a message that had already been taken (the debug driver
 * reports it as `unknown`, per AC-238); `unknown` is "this session's queue holds
 * no such uuid" — a uuid that never existed, belongs to another session, or a
 * session with no resident host.
 */
export type SessionCancelQueuedOutcome = 'cancelled' | 'already-started' | 'unknown';

/** The `session_cancel_queued` tool's typed input. */
export type McpSessionCancelQueuedInput = {
  /** The session whose queue is being withdrawn from; the gate resolves a name to an id first. */
  session: string;
  /** The `queuedMessageUuid` a busy `session_send` returned. */
  messageUuid: string;
};

/** The `session_cancel_queued` tool's Zod input shape, used for registration and validation. */
export const SESSION_CANCEL_QUEUED_INPUT_SCHEMA = {
  session: z.string(),
  messageUuid: z.string(),
} satisfies z.ZodRawShape;

/**
 * The `session_cancel_queued` result.
 *
 * `session` and `messageUuid` echo what was withdrawn (the id the gate left and
 * the uuid the caller passed), so a caller can match the answer to the message
 * it took back. `message` is the human sentence AC-271 pins for each outcome.
 */
export type SessionCancelQueuedPayload = {
  outcome: SessionCancelQueuedOutcome;
  session: string;
  messageUuid: string;
  message: string;
};

/** The sentence each outcome carries. The three are AC-271's own words, verbatim. */
const OUTCOME_MESSAGES: Record<SessionCancelQueuedOutcome, string> = {
  cancelled: '该排队消息已撤回，不会成为一轮。',
  'already-started': '该消息已不在队列（已被取出开始执行），无法再撤回。',
  unknown: '该会话队列里没有这个消息 uuid（可能从未存在、属于别的会话，或没有常驻宿主）。',
};

/** Reads and validates `session_cancel_queued`'s arguments. */
export function readSessionCancelQueuedInput(args: Record<string, unknown>): McpSessionCancelQueuedInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  const messageUuid = args.messageUuid;
  if (typeof messageUuid !== 'string' || messageUuid.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"messageUuid" is required and must be a non-empty string.',
    );
  }
  return { session, messageUuid };
}

// --------------------------- buildSessionCancelQueued ---------------------------

/**
 * Withdraws one queued message and reports AC-271's outcome.
 *
 * The caller is the token's owner, presented under the same `via: 'mcp'` the
 * send path uses, so the control service's shared access entry decides the same
 * way it does for a send. The verdict is translated HERE and only here:
 * `withdrawn` -> `cancelled` (the tool's word for a successful withdrawal),
 * `already-started` / `unknown` -> themselves, and `forbidden` -> a structured
 * `FORBIDDEN` refusal rather than any outcome. Passing `withdrawn` through, or
 * reading a non-`withdrawn` verdict as `cancelled`, would each be a wrong answer
 * AC-271 pins against.
 *
 * Consumers: `registerMcpSessionCancelQueuedTool` (the registered handler) and
 * this module's criterion, which drives it through the real mount.
 */
export async function buildSessionCancelQueued(
  input: McpSessionCancelQueuedInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionCancelQueuedDeps,
): Promise<SessionCancelQueuedPayload> {
  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const verdict = await deps.control.cancelQueued(caller, {
    sessionId: input.session,
    messageUuid: input.messageUuid,
  });

  if (verdict === 'forbidden') {
    // AC-232 owns the structured refusal body; this adapter only guarantees the
    // refusal is not mistaken for a successful withdrawal.
    throw new McpToolError(
      MCP_ERROR_CODES.FORBIDDEN,
      'The caller is not allowed to withdraw this session\'s queued message.',
    );
  }

  const outcome: SessionCancelQueuedOutcome = verdict === 'withdrawn' ? 'cancelled' : verdict;
  return {
    outcome,
    session: input.session,
    messageUuid: input.messageUuid,
    message: OUTCOME_MESSAGES[outcome],
  };
}

// --------------------------- registration ---------------------------

/**
 * One resident tool as it is handed to the registration seam.
 *
 * Deliberately the same shape as AC-249's `McpWriteToolRegistration`, so the
 * transport's one audited seam installs either without a special case.
 */
export type McpSessionCancelQueuedRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: { principal: McpPrincipal }) => unknown | Promise<unknown>;
};

/**
 * The seam `registerMcpSessionCancelQueuedTool` installs through. The transport
 * supplies one backed by AC-244's `withMcpAudit`, so the tool inherits the
 * single audit row and the scope refusal without restating either.
 */
export type McpSessionCancelQueuedSeam = (registration: McpSessionCancelQueuedRegistration) => void;

/**
 * Installs `session_cancel_queued` through the audited seam: its handler is
 * {@link buildSessionCancelQueued}, its one scope `cloudcli:session:control`.
 *
 * Consumers: `registerMcpResidentTools` (the stage-6 assembly) and this module's
 * criterion, which reads the registered name and scope back off a recording
 * seam.
 */
export function registerMcpSessionCancelQueuedTool(
  seam: McpSessionCancelQueuedSeam,
  deps: McpSessionCancelQueuedDeps,
  requiredScope: string,
): void {
  seam({
    name: 'session_cancel_queued',
    description: 'Withdraw a queued message by the queuedMessageUuid a busy session_send returned.',
    requiredScope,
    inputSchema: SESSION_CANCEL_QUEUED_INPUT_SCHEMA,
    outputSchema: {
      outcome: z.string(),
      session: z.string(),
      messageUuid: z.string(),
      message: z.string(),
    },
    handler: (args, ctx) => buildSessionCancelQueued(readSessionCancelQueuedInput(args), ctx, deps),
  });
}
