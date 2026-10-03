import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider, forwardNormalizedFrames, readSessionTurn } from '@/modules/providers/index.js';
import { activityAnnouncement } from '@/modules/websocket/index.js';

// The run loop's SDK message handler used to inline the whole "normalize this
// SDK event, carry the wrapper's parentToolUseId, drop the subagent prompt echo,
// send each frame" block. Both neighbours of that block have their own
// coverage — `claude-stream-event-unwrap.test.ts` pins what the normalizer
// produces, `chat-run-registry.test.ts` pins what a writer does with a frame —
// and the block in between had none: a deleted `writer.send` there left every
// test green while no partial frame ever reached the client. These cases drive
// the extracted loop with a fake writer, so the forwarding itself is the thing
// under test.

type Frame = Record<string, unknown>;

/** A stand-in for the run writer (`ws`) that records what it is handed. */
function recordingWriter(): { frames: Array<Frame>; send: (message: Frame) => void } {
  const frames: Array<Frame> = [];
  return {
    frames,
    send: (message: Frame) => {
      frames.push(message);
    },
  };
}

const SESSION_ID = 'claude-frame-forwarding-1';

test('every normalized frame is handed to the writer, in order', () => {
  const writer = recordingWriter();
  // Kinds the other cases do not use, so a defect local to one of them (a
  // dropped `stream_delta`, a missed echo filter, a lost parentToolUseId) reds
  // its own case instead of this one.
  const frames = [
    { kind: 'text', content: 'first' },
    { kind: 'tool_use', content: 'second' },
    { kind: 'thinking', content: 'third' },
  ];

  forwardNormalizedFrames({
    transformedMessage: { type: 'assistant' },
    sessionId: SESSION_ID,
    normalizeMessage: () => frames,
    writer,
  });

  // Order is the assertion, so the contents are distinct and not in any sorted
  // order: a forwarder that reordered or deduped would show up here.
  assert.deepEqual(
    writer.frames.map((frame) => frame.content),
    ['first', 'second', 'third'],
  );
});

test('a partial SDK frame is not swallowed on its way to the writer', () => {
  // The real normalizer, not a stub: this is the whole point of the seam. The
  // partial frame becomes a `stream_delta`, and the forwarder has to actually
  // hand that frame over — it carries the in-place transcript growth the client
  // renders, and reading the normalizer's output alone cannot prove it left.
  const provider = new ClaudeSessionsProvider();
  const writer = recordingWriter();

  forwardNormalizedFrames({
    transformedMessage: {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      parent_tool_use_id: null,
      uuid: 'u-stream-1',
      session_id: SESSION_ID,
    },
    sessionId: SESSION_ID,
    normalizeMessage: (raw: unknown, sessionId: string | null) => provider.normalizeMessage(raw, sessionId),
    writer,
  });

  assert.equal(writer.frames.length, 1);
  assert.equal(writer.frames[0].kind, 'stream_delta');
  assert.equal(writer.frames[0].content, 'Hel');
});

test('a subagent prompt echo is dropped instead of forwarded', () => {
  const writer = recordingWriter();
  const echo = { kind: 'text', role: 'user', parentToolUseId: 'toolu_agent', content: 'Investigate' };
  const kept = { kind: 'text', role: 'assistant', content: 'On it' };

  forwardNormalizedFrames({
    transformedMessage: { type: 'assistant' },
    sessionId: SESSION_ID,
    normalizeMessage: () => [echo, kept],
    writer,
  });

  assert.deepEqual(writer.frames, [kept]);
});

test("the SDK wrapper's parentToolUseId is carried onto a frame that lacks one", () => {
  const writer = recordingWriter();
  const child = { kind: 'text', role: 'assistant', content: 'working' };

  forwardNormalizedFrames({
    transformedMessage: { type: 'assistant', parentToolUseId: 'toolu_agent' },
    sessionId: SESSION_ID,
    normalizeMessage: () => [child],
    writer,
  });

  assert.equal(writer.frames.length, 1);
  assert.equal(writer.frames[0].parentToolUseId, 'toolu_agent');
});

test("a frame's own parentToolUseId is not overwritten by the wrapper's", () => {
  // The other half of the carry rule: a frame that already knows which tool call
  // it belongs to must keep it, or a nested subagent's rows would all be
  // re-parented to the outermost one.
  const writer = recordingWriter();
  const child = { kind: 'text', role: 'assistant', content: 'working', parentToolUseId: 'toolu_inner' };

  forwardNormalizedFrames({
    transformedMessage: { type: 'assistant', parentToolUseId: 'toolu_outer' },
    sessionId: SESSION_ID,
    normalizeMessage: () => [child],
    writer,
  });

  assert.equal(writer.frames[0].parentToolUseId, 'toolu_inner');
});

// ---------------------------------------------------------------------------
// gap-activity-turn-phase-id-space-mismatch (AC1/AC2)
//
// The turn tracker used to be fed the id the *normalizer* addresses the run by
// (the provider-native id the SDK reports) while the activity frames read it
// back with the **app session id** the browser subscribes with. Two id spaces,
// one Map: every read missed and answered `idle`, so the dock stayed on the
// fallback `Working…` label with no timer for a turn that was really running.
// The two cases below pin the fixed contract — the tracker is keyed by the app
// session id — with a distinct provider id in play so a regression that keys by
// `sessionId` again reds the first case instead of passing on a coincidence.
// ---------------------------------------------------------------------------

/** The app session id the activity frames read the turn back under. */
const APP_SESSION_ID = 'app-session-frame-forwarding-1';
/** The provider-native id the run's frames are routed by; deliberately different. */
const PROVIDER_SESSION_ID = 'provider-session-frame-forwarding-1';

/** An `assistant` message carrying the `tool_use` block that starts a tool phase. */
function toolUseFrame(id: string, name: string): Frame {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    uuid: `u-tool-${id}`,
    session_id: PROVIDER_SESSION_ID,
  };
}

test('the turn phase is readable under the app session id while the turn runs (AC1)', () => {
  const writer = recordingWriter();

  // A real turn with a tool call: the run loop hands the forwarder the provider
  // id for routing/normalization but the app id for the phase key.
  forwardNormalizedFrames({
    transformedMessage: toolUseFrame('toolu_ff_1', 'Bash'),
    sessionId: PROVIDER_SESSION_ID,
    turnSessionId: APP_SESSION_ID,
    normalizeMessage: () => [],
    writer,
  });

  // The reading the activity heartbeat transports to the browser.
  const announcement = activityAnnouncement(APP_SESSION_ID);
  assert.notEqual(
    announcement.phase,
    'idle',
    'the heartbeat reported idle for a running turn — the phase was written under a different id space than it is read under',
  );
  assert.equal(announcement.phase, 'tool', `the phase is ${announcement.phase}, not the running tool`);
  assert.equal(announcement.toolName, 'Bash', 'the pending tool name did not survive the read');

  // The same read through the tracker's own facade, so the two entry points AC1
  // names cannot disagree: a run keyed by the provider id would answer `idle`
  // here and leave the raw tracking key non-idle.
  const raw = readSessionTurn(APP_SESSION_ID);
  assert.equal(raw.phase, 'tool');
  assert.equal(raw.toolName, 'Bash');
});

test('the phase falls back to idle when the turn’s result arrives (AC2)', () => {
  const writer = recordingWriter();

  forwardNormalizedFrames({
    transformedMessage: toolUseFrame('toolu_ff_2', 'Bash'),
    sessionId: PROVIDER_SESSION_ID,
    turnSessionId: APP_SESSION_ID,
    normalizeMessage: () => [],
    writer,
  });
  assert.equal(
    readSessionTurn(APP_SESSION_ID).phase,
    'tool',
    'precondition: the turn is not in the tool phase, so the fallback below would be vacuous',
  );

  forwardNormalizedFrames({
    transformedMessage: { type: 'result', subtype: 'success', session_id: PROVIDER_SESSION_ID },
    sessionId: PROVIDER_SESSION_ID,
    turnSessionId: APP_SESSION_ID,
    normalizeMessage: () => [],
    writer,
  });

  assert.equal(
    activityAnnouncement(APP_SESSION_ID).phase,
    'idle',
    'the result frame did not return the same query to idle — the tracker reports a turn that has ended',
  );
  assert.equal(readSessionTurn(APP_SESSION_ID).phase, 'idle');
});
