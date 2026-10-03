/**
 * The client's control half of the activity dock: the two requests a person can
 * place against the work a session is holding — stop a background task, and move
 * a running foreground tool to the background.
 *
 * The controls hold no state. A click sends exactly one frame over the app's own
 * socket and changes nothing locally:
 *
 *  - `chat.stop-task` `{ sessionId, taskId, requestId }`
 *  - `chat.background-task` `{ sessionId, toolUseId, requestId }`
 *
 * A row's state, and whether a backgrounded task has appeared at all, come back
 * only through the server's own `activity.snapshot` / `activity.upsert` frames
 * (reduced into `useSessionActivity`). That is what makes "the click is not
 * optimistic" a reading a criterion can take: this module imports no store
 * writer, so there is no local path by which a click could move a row.
 *
 * Whether the controls can be used is the *liveness* reading the caller already
 * has (`useActivityFreshness`): when the dock has gone `unreachable`, both are
 * disabled and carry a reason. The reason reuses the composer stop's own
 * `claudeStatus.unreachable.stopReason`, so the dock and the composer say the
 * same thing about the same outage rather than inventing a second sentence.
 *
 * The pending foreground tool is read off the loaded transcript, never derived
 * here: the server's Turn Tracker is authoritative for "which tool_use is
 * unpaired", and the transcript is where its id is on screen. {@link
 * findPendingForegroundTool} is the one place that reading is taken, so the
 * panel and any other reader agree.
 */

import { useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';

import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ChatMessage } from '@/shared/types';
import type { ActivityLiveness } from '@/modules/chat/utils/activityFreshness';

/** One running foreground tool the dock can offer to move to the background. */
export type ForegroundTool = {
  /** The `tool_use.id` the server's Turn Tracker is holding as pending. */
  toolUseId: string;
  /** The tool's name, drawn beside the control. */
  toolName: string;
};

/** What the dock's controls need: the two senders plus the disabled reading. */
export type ActivityControls = {
  /** The liveness the buttons go by; an unreachable dock disables both. */
  liveness: ActivityLiveness;
  /** True when no request can be placed — unreachable, or no socket to send on. */
  disabled: boolean;
  /** Why the controls are disabled, for the `[data-control-disabled-reason]` text. */
  disabledReason: string;
  /** Places a stop request for one task. Changes nothing locally. */
  stopTask: (taskId: string) => void;
  /** Places a background request for one foreground tool. Changes nothing locally. */
  backgroundTool: (toolUseId: string) => void;
};

/**
 * A request id for one control frame.
 *
 * The server echoes it on the `control_result` receipt; nothing on this side
 * correlates it today, but the protocol requires a non-empty string, so this
 * mints one. `crypto.randomUUID` is absent in some non-secure/test contexts, so
 * the fallback keeps the frame well-formed there rather than throwing inside a
 * click handler.
 */
function newRequestId(): string {
  const cryptoRef = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The pending foreground tool in a loaded transcript, or null.
 *
 * A tool is pending exactly when its `tool_use` row has no paired result —
 * `useChatMessages` has already resolved the pairing onto each row's
 * `toolResult`, so this reads that rather than re-scanning for results. When
 * more than one is unpaired the last one is the pending one, matching the
 * server's tracker (each `tool_use` overwrites the id it holds).
 */
export function findPendingForegroundTool(
  messages: ChatMessage[] | null | undefined,
): ForegroundTool | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  let pending: ForegroundTool | null = null;
  for (const message of messages) {
    if (message?.isToolUse === true && !message.toolResult) {
      const toolUseId = typeof message.toolId === 'string' ? message.toolId : '';
      if (toolUseId) {
        pending = { toolUseId, toolName: message.toolName ?? '' };
      }
    }
  }
  return pending;
}

/**
 * The dock's control handlers for one session, given the liveness reading its
 * caller already holds.
 *
 * `liveness` is a parameter rather than a fresh `useActivityFreshness` call so
 * the dock runs one freshness machine, not two: the machine that drives the
 * dock's own state is the same one that disables its controls.
 */
export function useActivityControls(
  sessionId: string | null | undefined,
  liveness: ActivityLiveness,
): ActivityControls {
  const { t } = useTranslation('chat');
  const connection = useContext(WebSocketContext);
  const sendMessage = connection?.sendMessage;
  const isConnected = connection?.isConnected ?? false;

  const disabled = liveness === 'unreachable' || !isConnected || !sendMessage;
  const disabledReason = t('claudeStatus.unreachable.stopReason', {
    defaultValue: 'Stop is unavailable while the server is unreachable',
  });

  const stopTask = useCallback(
    (taskId: string) => {
      if (!sendMessage || !sessionId || !taskId) {
        return;
      }
      sendMessage({ type: 'chat.stop-task', sessionId, taskId, requestId: newRequestId() });
    },
    [sendMessage, sessionId],
  );

  const backgroundTool = useCallback(
    (toolUseId: string) => {
      if (!sendMessage || !sessionId || !toolUseId) {
        return;
      }
      sendMessage({ type: 'chat.background-task', sessionId, toolUseId, requestId: newRequestId() });
    },
    [sendMessage, sessionId],
  );

  return { liveness, disabled, disabledReason, stopTask, backgroundTool };
}
