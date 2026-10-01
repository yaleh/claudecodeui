import type { ChatMessage } from '@/shared/types';

const toMessageKeyPart = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

export const getIntrinsicMessageKey = (message: ChatMessage): string | null => {
  // `blockKey` leads the candidates on purpose. It is the one field that is the
  // same on all three states of a streamed block — the client's live row, the
  // settled record that replaces it, and the persisted row a refresh brings in
  // under the same id — while every other candidate changes between them: the
  // live id is the client's own, the settled id is the server's, and the
  // timestamp is re-minted. Keying by any of those re-keys the row on the frame
  // it settles, which is an unmount on a pane pinned to the bottom.
  const candidates = [
    message.blockKey,
    message.id,
    message.messageId,
    message.toolId,
    message.toolCallId,
    message.blobId,
    message.rowid,
    message.sequence,
  ];

  for (const candidate of candidates) {
    const keyPart = toMessageKeyPart(candidate);
    if (keyPart) {
      return `message-${message.type}-${keyPart}`;
    }
  }

  const timestamp = new Date(message.timestamp).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const contentPreview = typeof message.content === 'string' ? message.content.slice(0, 48) : '';
  const toolName = typeof message.toolName === 'string' ? message.toolName : '';
  return `message-${message.type}-${timestamp}-${toolName}-${contentPreview}`;
};
