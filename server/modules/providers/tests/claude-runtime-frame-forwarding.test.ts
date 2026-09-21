import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider, forwardNormalizedFrames } from '@/modules/providers/index.js';

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
  const frames = [
    { kind: 'stream_delta', content: 'first' },
    { kind: 'stream_delta', content: 'second' },
    { kind: 'text', content: 'third' },
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
