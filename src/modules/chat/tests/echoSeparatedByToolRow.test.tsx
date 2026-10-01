import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * One reply, drawn twice, with a tool row between the two copies.
 *
 * Observed in the browser on a live turn that says something, runs a tool, then
 * says something else: the opening segment is drawn once from the server's
 * `text` frame and once from the row this client streamed it into. Both vanish
 * into one on a page reload, so only the incremental path produces the pair.
 *
 * Why the existing collapse misses it: `dedupeAdjacentAssistantEchoes` only
 * folds rows that are *adjacent* in merged order. Merged order is by timestamp,
 * and the two timestamps come from two clocks — the server stamps a `text` frame
 * and the `tool_use` frame that follows it when it normalizes them, while the
 * live row is re-stamped with the *client's* wall clock on every flush, the last
 * of which is the settle that follows `stream_end`. The live row is therefore
 * newer than the tool row whenever the tool row was stamped before the client's
 * settle ran, which is the ordinary case (the tool_use frame is already on its
 * way when the client settles). The merged order is then
 * `[echo, tool, live]`, and nothing adjacent matches.
 *
 * Every case drives the store through its own public methods with `Date` pinned,
 * so each states the one ordering it is about instead of racing a real clock.
 * The first, second and third are the defect (red today); the last two are the
 * controls that must stay as they are after any fix: the same words in the
 * adjacent order already collapse, and two different turns that read the same
 * are two replies.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SID = 'session-1';
const SEGMENT = 'the opening segment';
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

const msg = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  provider: 'claude',
  sessionId: SID,
  ...over,
} as NormalizedMessage);

const userRow = (id: string, offsetMs: number) => msg({
  id,
  kind: 'text',
  role: 'user',
  content: `prompt ${id}`,
  timestamp: at(offsetMs),
  transcriptAnchorId: `anchor-${id}`,
});

/** The server's `text` frame (or persisted row) for an assistant segment. */
const echoRow = (id: string, content: string, offsetMs: number) => msg({
  id,
  kind: 'text',
  role: 'assistant',
  content,
  timestamp: at(offsetMs),
});

const toolRow = (id: string, offsetMs: number) => msg({
  id,
  kind: 'tool_use',
  toolId: `tool-${id}`,
  toolName: 'Bash',
  toolInput: { command: 'sleep 8' },
  timestamp: at(offsetMs),
});

const historyOf = (messages: NormalizedMessage[]) => ({
  ok: true,
  json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
});

const rowsWithText = (rows: NormalizedMessage[], content: string) =>
  rows.filter((row) => row.kind !== 'tool_use' && row.content === content && row.role !== 'user');

const describeOrder = (rows: NormalizedMessage[]) =>
  rows.map((row) => `${row.kind}:${row.id}`).join(' → ');

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue(historyOf([]));
  // Only `Date` is pinned: the store reads the wall clock when it stamps a live
  // row, and that read is the thing under test.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/**
 * A store whose slot already holds the persisted prompt row.
 *
 * That is the ordinary state of a conversation by the time its first reply
 * streams: the session page has fetched its history, and the prompt is on disk.
 * It matters here because `computeMerged` only sorts by timestamp once the slot
 * has server rows; with none, realtime rows keep their arrival order and the
 * pair below is adjacent by construction (see the first lines of
 * `computeMerged`), which would hide the defect rather than test for it.
 */
async function freshStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  sessionMessages.mockResolvedValue(historyOf([userRow('u1', -1000)]));
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer(SID, { limit: 20, offset: 0 });
  });
  return view;
}

type StoreView = Awaited<ReturnType<typeof freshStore>>;

/**
 * The frame order of a real turn, as captured off the socket:
 * `stream_delta`s → `text` → `stream_end` → `tool_use`, with the client's
 * settle (`stream_end`) running at `settleAt`.
 *
 *   t=0              first delta flush mints the live row
 *   t=text.ts        the server's `text` frame lands as a realtime row
 *   t=settleAt       settle: the final flush re-stamps the live row, then it
 *                    flips to `text` (what `settleStream` does)
 *   after            the `tool_use` frame lands, carrying the server's stamp
 */
function runSegmentThenTool(view: StoreView, opts: { echoAt: number; toolAt: number; settleAt: number }) {
  const store = view.result.current;
  vi.setSystemTime(BASE);
  act(() => { store.updateStreaming(SID, SEGMENT, 'claude'); });

  act(() => { store.appendRealtime(SID, echoRow('srv-seg1', SEGMENT, opts.echoAt)); });

  vi.setSystemTime(BASE + opts.settleAt);
  act(() => {
    store.updateStreaming(SID, SEGMENT, 'claude');
    store.finalizeStreaming(SID);
  });

  act(() => { store.appendRealtime(SID, toolRow('srv-tool1', opts.toolAt)); });
}

describe('a settled live row whose server echo has a tool row between them', () => {
  it('draws the segment once when the tool row was stamped before the client settled', async () => {
    const view = await freshStore();

    // Server stamps: text at +640, tool at +641. Client settles at +700, so the
    // live row's last stamp (+700) is newer than the tool row's (+641).
    runSegmentThenTool(view, { echoAt: 640, toolAt: 641, settleAt: 700 });

    const rows = view.result.current.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `the segment must be one row, got: ${describeOrder(rows)}`,
    );
  });

  it('draws the segment once when the live row lands between two tool rows', async () => {
    const view = await freshStore();

    // The shape seen after switching away and back: the tool rows of the same
    // reply straddle the live row's stamp.
    runSegmentThenTool(view, { echoAt: 640, toolAt: 641, settleAt: 700 });
    act(() => { view.result.current.appendRealtime(SID, toolRow('srv-tool2', 800)); });

    const rows = view.result.current.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `the segment must be one row, got: ${describeOrder(rows)}`,
    );
  });

  it('draws the segment once when a server refresh brings the echo and the tool row in', async () => {
    const view = await freshStore();
    const store = view.result.current;

    // No realtime `text` frame at all: the client only streamed the segment, and
    // the persisted copy arrives through a tail refresh (the switch-back path).
    vi.setSystemTime(BASE);
    act(() => { store.updateStreaming(SID, SEGMENT, 'claude'); });
    vi.setSystemTime(BASE + 700);
    act(() => {
      store.updateStreaming(SID, SEGMENT, 'claude');
      store.finalizeStreaming(SID);
    });

    sessionMessages.mockResolvedValue(historyOf([
      userRow('u1', -1000),
      echoRow('srv-seg1', SEGMENT, 640),
      toolRow('srv-tool1', 641),
    ]));
    await act(async () => {
      await store.fetchFromServer(SID, { limit: 20, offset: 0 });
    });

    const rows = store.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `the segment must be one row, got: ${describeOrder(rows)}`,
    );
  });
});

describe('controls that must hold before and after any fix', () => {
  it('already collapses the same pair when no tool row sits between them', async () => {
    const view = await freshStore();

    // Tool row stamped after the client's settle: merged order is
    // `[echo, live, tool]`, adjacent, which the existing rule folds.
    runSegmentThenTool(view, { echoAt: 640, toolAt: 800, settleAt: 700 });

    const rows = view.result.current.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `adjacent order is the already-handled shape, got: ${describeOrder(rows)}`,
    );
  });

  it('keeps two different turns that read the same as two replies', async () => {
    const view = await freshStore();
    const store = view.result.current;

    // Turn 1 settled and persisted; turn 2 (after a second prompt) says the same
    // words. A fix that folds across a tool row must not fold across a user row.
    act(() => { store.appendRealtime(SID, echoRow('srv-seg1', SEGMENT, 100)); });
    act(() => { store.appendRealtime(SID, toolRow('srv-tool1', 200)); });
    act(() => { store.appendRealtime(SID, userRow('u2', 300)); });
    vi.setSystemTime(BASE + 400);
    act(() => { store.updateStreaming(SID, SEGMENT, 'claude'); });

    const rows = store.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      2,
      `two turns are two replies, got: ${describeOrder(rows)}`,
    );
  });
});
