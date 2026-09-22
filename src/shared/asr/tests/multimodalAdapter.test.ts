/**
 * The second adapter, driven directly — the unit lane beside the behavioural probe
 * (`scripts/asr-second-adapter-check.mjs`, AC-132).
 *
 * The probe is the criterion's instrument: it builds a fixture out of the shipping files, mutates
 * it, and shows each fake form going red. This file is the cheaper, always-on half — it exercises
 * the same declarations and the same guards in the suite that runs on every change, so a
 * regression is caught by a failing assertion rather than only by the probe's fault injection.
 *
 * It lives under `src/` because that is where the unit suite is collected from; the module under
 * test lives in the repository-root `shared/` tree, which the frontend reaches through the
 * `@shared` alias (ADR-004 decision 2). Importing it here is the alias's third registration being
 * used for real rather than merely asserted.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  UnknownAsrProviderError,
  listProviders,
  resolve,
  tryResolve,
  type AsrInvocation,
  type AsrRequest,
} from '@shared/asr/asrRegistry';
import {
  base64Length,
  capabilities,
  generateContentEndpoint,
  honoredHints,
  id,
  measureInlineRequestBytes,
  readTranscriptText,
  transcribe,
} from '@shared/asr/list/multimodal/multimodal.asr-provider';

const ENVELOPE = JSON.stringify({
  candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
});

/**
 * The two input sizes the budget cases need, DERIVED from the declaration rather than typed in:
 * a declaration whose budget shrinks has to move these with it, or the cases would quietly stop
 * testing anything. The two guards below fail the file if the derived sizes stop straddling the
 * budget, so a stale derivation is a red rather than a vacuous green.
 */
const BUDGET = capabilities.maxInlineRequestBytes;
const AFFORDABLE_AUDIO_BYTES = Math.floor((BUDGET * 0.75) / 4) * 3;
const OVERSIZE_AUDIO_BYTES = Math.ceil((BUDGET + 1) / 4) * 3;
const OVERSIZE_CONTEXT_CHARS = BUDGET - base64Length(AFFORDABLE_AUDIO_BYTES) + 1024;

function audioOf(byteLength: number): AsrRequest['audio'] {
  return { bytes: new Uint8Array(byteLength), mimeType: 'audio/webm;codecs=opus', fileName: 'clip.webm' };
}

function standIn(body: string, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? undefined });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

function invocationFor(stand: ReturnType<typeof standIn>): AsrInvocation {
  return {
    // `.invalid` never resolves: this file must not be able to reach a real service even by
    // accident, which is what makes the readings below offline readings (AC7).
    baseUrl: 'https://asr.invalid',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 1000,
    fetchImpl: stand.fetchImpl,
  };
}

describe('the declared sizes straddle the declared budget', () => {
  it('sizes the two budget cases so each one can only pass for the right reason', () => {
    expect(base64Length(AFFORDABLE_AUDIO_BYTES)).toBeLessThan(BUDGET);
    expect(base64Length(OVERSIZE_AUDIO_BYTES)).toBeGreaterThan(BUDGET);
    expect(OVERSIZE_CONTEXT_CHARS).toBeGreaterThan(0);
  });
});

describe('registration', () => {
  it('resolves the adapter by id, and the registry hands back the module’s own declaration (AC6)', () => {
    const resolved = resolve(id);

    expect(resolved.id).toBe(id);
    expect(resolved.capabilities).toEqual(capabilities);
    expect(listProviders().map((adapter) => adapter.id)).toContain(id);
  });

  it('fails closed on an unregistered id instead of falling back to a default', () => {
    expect(tryResolve('no-such-provider')).toBeNull();
    expect(() => resolve('no-such-provider')).toThrow(UnknownAsrProviderError);
  });

  it('declares an explicit rejection as the only oversize policy (AC5)', () => {
    expect(capabilities.oversize).toBe('reject');
    for (const adapter of listProviders()) {
      expect(adapter.capabilities.oversize).toBe('reject');
    }
  });
});

describe('the inline budget is the whole request', () => {
  it('refuses an over-budget request without spending an upstream call (AC1)', async () => {
    const stand = standIn(ENVELOPE);
    const spy = vi.spyOn(globalThis, 'fetch');

    const result = await transcribe({ audio: audioOf(OVERSIZE_AUDIO_BYTES) }, invocationFor(stand));

    expect(result).toMatchObject({ ok: false, code: 'OVERSIZE' });
    expect(stand.calls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts the audio alone and refuses the same audio once a long context joins it (AC2)', async () => {
    const alone = standIn(ENVELOPE);
    const aloneResult = await transcribe({ audio: audioOf(AFFORDABLE_AUDIO_BYTES) }, invocationFor(alone));
    expect(aloneResult.ok).toBe(true);
    expect(alone.calls).toHaveLength(1);

    const withContext = standIn(ENVELOPE);
    const withContextResult = await transcribe(
      { audio: audioOf(AFFORDABLE_AUDIO_BYTES), hints: { context: 'x'.repeat(OVERSIZE_CONTEXT_CHARS) } },
      invocationFor(withContext),
    );

    // The audio is the same object size in both calls, so only the budget's SCOPE can explain the
    // two different verdicts. An implementation that measures the audio bytes alone accepts both.
    expect(withContextResult).toMatchObject({ ok: false, code: 'OVERSIZE' });
    expect(withContext.calls).toHaveLength(0);
  });

  it('counts the context and the prompt into the measured size, not just the audio', () => {
    const audio = audioOf(2048);
    const bare = measureInlineRequestBytes({ audio }, {});
    const withContext = measureInlineRequestBytes({ audio }, { context: 'x'.repeat(5000) });

    expect(bare).toBeGreaterThan(base64Length(audio.bytes.length));
    // The whole context is charged, not a sample of it: the delta is the context plus the fixed
    // JSON scaffolding of the part carrying it, so it is bounded above as well as below.
    expect(withContext - bare).toBeGreaterThanOrEqual(5000);
    expect(withContext - bare).toBeLessThan(5000 + 64);
  });
});

describe('hints', () => {
  it('leaves an unacknowledged hint off the wire rather than sending it empty (AC3)', async () => {
    const stand = standIn(ENVELOPE);

    await transcribe(
      {
        audio: audioOf(2048),
        hints: { prompt: 'a prompt this provider does not acknowledge', language: 'zh', context: 'revenue policy' },
      },
      invocationFor(stand),
    );

    const body = String(stand.calls[0]?.init?.body ?? '');
    expect(body).not.toContain('a prompt this provider does not acknowledge');
    expect(body).not.toContain('systemInstruction');
    expect(JSON.parse(body)).not.toHaveProperty('systemInstruction');
    // The positive control: what IS acknowledged is on the wire, so the absences above cannot be
    // satisfied by a body builder that sends no hints at all.
    expect(body).toContain('revenue policy');
  });

  it('drops exactly the hints the declaration does not acknowledge', () => {
    const hints = { prompt: 'p', language: 'zh', context: 'c' };

    expect(honoredHints(hints)).toEqual({ context: 'c' });
    expect(honoredHints(undefined)).toEqual({});
  });
});

describe('the answer envelope', () => {
  it('reads the text out of the generation envelope (AC4)', async () => {
    const stand = standIn(ENVELOPE);

    const result = await transcribe({ audio: audioOf(1024) }, invocationFor(stand));

    expect(result).toMatchObject({ ok: true, text: 'hello world', style: 'written', providerId: id });
    expect(stand.calls[0]?.url).toBe(generateContentEndpoint('https://asr.invalid', 'test-model'));
  });

  it('never returns a body that is not the envelope as if it were a transcript (AC4)', async () => {
    const gatewayError = standIn(JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }));
    const gatewayResult = await transcribe({ audio: audioOf(1024) }, invocationFor(gatewayError));

    expect(gatewayResult.ok).toBe(false);

    const htmlError = standIn('<html><body>502 Bad Gateway</body></html>');
    const htmlResult = await transcribe({ audio: audioOf(1024) }, invocationFor(htmlError));

    expect(htmlResult.ok).toBe(false);
    expect(readTranscriptText(ENVELOPE)).toBe('hello world');
  });

  it('maps an upstream status onto the semantic error vocabulary', async () => {
    const unauthorized = await transcribe({ audio: audioOf(1024) }, invocationFor(standIn('{}', 401)));
    const limited = await transcribe({ audio: audioOf(1024) }, invocationFor(standIn('{}', 429)));

    expect(unauthorized).toMatchObject({ ok: false, code: 'UNAUTHORIZED', status: 401 });
    expect(limited).toMatchObject({ ok: false, code: 'RATE_LIMITED', status: 429 });
  });

  it('refuses a container it does not declare, before sizing anything', async () => {
    const stand = standIn(ENVELOPE);

    const result = await transcribe({ audio: { ...audioOf(1024), mimeType: 'video/mp4' } }, invocationFor(stand));

    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_MIME' });
    expect(stand.calls).toHaveLength(0);
  });
});
