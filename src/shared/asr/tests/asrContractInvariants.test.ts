/**
 * The transcription seam's contract board, as the always-on half of the criterion.
 *
 * `scripts/asr-contract-invariants-check.mjs` is the operator command and
 * `scripts/asr-contract-invariants-check.test.mjs` is the fault injection that shows the board
 * going red under a mutation. Both of those run when someone runs them. This file is what runs on
 * every change, and it is deliberately the cheaper half: it drives the same board over the shipped
 * registry and over declarations written here, so a regression is a failing assertion rather than
 * something a reader has to notice.
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT:
 *
 *   · IT DOES NOT RESTATE THE INVARIANTS. Every assertion below is about the BOARD — that it
 *     measured, that it scored an empty board as empty, that it reds a declaration which disagrees
 *     with the wire it feeds. A second copy of the probes here would be a second implementation of
 *     the contract, free to disagree with `shared/asr/asrInvariants.ts` while both stay green.
 *   · IT MEASURES A DECLARATION NOBODY WROTE FOR IT. The shipped adapter declares
 *     `honors.prompt: false`, so "the prompt is left off the wire" is the only reading the shipped
 *     declaration can produce — the opposite reading, `prompt-part-present`, is unreachable that
 *     way. The prompt-honouring stand-in below is what makes that axis two-sided: one adapter that
 *     sends the prompt because it declared it would, and one that lies about it and is caught.
 *
 * It lives under `src/` because that is where the unit suite is collected from; the modules under
 * test live in the repository-root `shared/` tree, reached through the `@shared` alias.
 */

import { describe, expect, it } from 'vitest';

import { listProviders, type AsrAdapter, type AsrHints } from '@shared/asr/asrRegistry';
import {
  INVARIANT_AUDIO_BASE64,
  INVARIANT_AUDIO_TEXT,
  INVARIANT_API_KEY,
  INVARIANT_GROUP_IDS,
  INVARIANT_MODEL,
  affordableAudioBytes,
  goldenBody,
  overBudgetAudioBytes,
  redactionNeedles,
  runAsrContractInvariants,
  scanLines,
} from '@shared/asr/asrInvariants';
import {
  STYLE_TRANSFORMATIONS,
  base64Encode,
  baseMimeType,
  buildInlineRequestBody,
  capabilities,
  errorCodeForStatus,
  generateContentEndpoint,
  measureInlineRequestBytes,
  readTranscriptText,
  transcribe,
} from '@shared/asr/list/multimodal/multimodal.asr-provider';

/** The same wire as the shipped adapter, driven by a declaration that acknowledges the prompt. */
const promptHonouringAdapter: AsrAdapter = {
  id: 'stand-in-prompt-honouring',
  capabilities: { ...capabilities, honors: { prompt: true, language: false, context: true } },
  async transcribe(request, invocation) {
    const declared = promptHonouringAdapter.capabilities;
    if (declared.acceptsMime.indexOf(baseMimeType(request.audio.mimeType)) === -1) {
      return { ok: false, code: 'UNSUPPORTED_MIME', message: 'stand-in: container not declared' };
    }
    // The same two guards the shipped adapter applies, with the declaration applied in one place —
    // the difference between the two adapters is the declaration, not the discipline.
    const hints: AsrHints = request.hints ?? {};
    const honored: AsrHints = {};
    if (declared.honors.context && hints.context !== undefined && hints.context !== '') {
      honored.context = hints.context;
    }
    if (declared.honors.prompt && hints.prompt !== undefined && hints.prompt !== '') {
      honored.prompt = hints.prompt;
    }
    if (measureInlineRequestBytes(request, honored, invocation.model) > declared.maxInlineRequestBytes) {
      return { ok: false, code: 'OVERSIZE', message: 'stand-in: past the declared budget' };
    }
    const endpoint = generateContentEndpoint(invocation.baseUrl, invocation.model);
    let response: Response;
    try {
      response = await invocation.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The header this wire declares it reads the credential from (`AsrWireModel`): a stand-in
          // that announced the key in a header the wire does not declare would be a second wire.
          ...(invocation.apiKey ? { 'x-goog-api-key': invocation.apiKey } : {}),
        },
        body: JSON.stringify(
          buildInlineRequestBody(request, honored, base64Encode(request.audio.bytes), invocation.model),
        ),
        signal: invocation.signal,
      });
    } catch (error) {
      const aborted =
        typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
      return { ok: false, code: aborted ? 'TIMEOUT' : 'UNREACHABLE', message: 'stand-in: no answer' };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: errorCodeForStatus(response.status),
        message: 'stand-in: the service answered',
        status: response.status,
      };
    }
    let text: string;
    try {
      text = readTranscriptText(await response.text());
    } catch {
      return { ok: false, code: 'UPSTREAM_ERROR', message: 'stand-in: unreadable answer' };
    }
    if (text === '') return { ok: false, code: 'NO_SPEECH_DETECTED', message: 'stand-in: no text' };
    return {
      ok: true,
      text,
      style: 'verbatim',
      transformations: [...STYLE_TRANSFORMATIONS],
      providerId: promptHonouringAdapter.id,
    };
  },
};

/** A declaration that claims to honor the prompt while feeding the adapter that does not. */
const lyingAdapter: AsrAdapter = {
  ...promptHonouringAdapter,
  id: 'stand-in-lying-declaration',
  transcribe,
};

/** An adapter that throws out of `transcribe` instead of answering. */
const throwingAdapter: AsrAdapter = {
  id: 'stand-in-throwing',
  capabilities,
  async transcribe() {
    throw new Error('the transport exploded');
  },
};

/** The recorded reading for `id`, or `undefined` when the board never produced it. */
function readingFor(report: Awaited<ReturnType<typeof runAsrContractInvariants>>, id: string) {
  return report.readings.find((entry) => entry.id.startsWith(id));
}

describe('the transcription seam invariant board', () => {
  it('measures every registered provider and passes every group', async () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);

    const report = await runAsrContractInvariants({ providers });

    expect(report.verdict).toBe('pass');
    expect(report.groups.map((entry) => entry.group)).toEqual([...INVARIANT_GROUP_IDS]);
    for (const group of report.groups) {
      expect(group.readings, `${group.group} measured nothing`).toBeGreaterThan(0);
      expect(group.verdict, `${group.group} failed: ${group.failing.join(', ')}`).toBe('pass');
    }
    // A floor, so a board that silently stopped probing most of its subjects cannot pass by
    // measuring one reading per group.
    expect(report.readings.length).toBeGreaterThanOrEqual(40);
    // Every reading is printed, so a reading that cannot be printed cannot hide.
    expect(report.logs.length).toBe(report.readings.length);
    expect(report.verdict === 'pass' && report.readings.some((entry) => entry.verdict === 'fail')).toBe(false);
  });

  it('scores an empty provider list as empty rather than as a pass', async () => {
    const report = await runAsrContractInvariants({ providers: [] });

    expect(report.verdict).toBe('empty');
    expect(report.readings).toEqual([]);
    expect(report.logs).toEqual([]);
    for (const group of report.groups) expect(group.verdict).toBe('unmeasured');
  });

  it('scores a selection that named no group as empty', async () => {
    const report = await runAsrContractInvariants({ providers: listProviders(), groups: [] });

    expect(report.verdict).toBe('empty');
    expect(report.groups).toEqual([]);
    expect(report.readings).toEqual([]);
  });

  it('reports a probe that throws as a red reading instead of a thrown board', async () => {
    const report = await runAsrContractInvariants({ providers: [throwingAdapter] });

    expect(report.verdict).toBe('fail');
    const thrown = report.readings.filter((entry) => entry.id.includes('probe-threw'));
    expect(thrown.length).toBeGreaterThan(0);
    for (const entry of thrown) expect(entry.observed).toContain('the transport exploded');
    // The log surface is still read, so a board that cannot measure the wire can still say that
    // nothing it printed leaked — the failure is reported, not abandoned.
    expect(readingFor(report, 'redaction.log-lines-present')).toBeDefined();
  });

  it('measures a declaration it did not write: an adapter that honors the prompt sends it', async () => {
    const report = await runAsrContractInvariants({ providers: [promptHonouringAdapter] });

    expect(report.verdict).toBe('pass');
    expect(readingFor(report, 'request.prompt.unsupported-omitted')?.observed).toBe('prompt-part-present');
    expect(readingFor(report, 'request.prompt.unsupported-omitted')?.verdict).toBe('pass');
    expect(readingFor(report, 'request.context.honored')?.observed).toBe('text-part-present');
    // An empty prompt is still left off, so the two readings together say "sent when declared, and
    // only when there is something to send".
    expect(readingFor(report, 'request.prompt.empty-hint-omitted')?.observed).toBe('no-prompt-part');
    expect(readingFor(report, 'request.body.golden')?.verdict).toBe('pass');
  });

  it('reds a declaration that disagrees with the wire it feeds', async () => {
    const report = await runAsrContractInvariants({ providers: [lyingAdapter] });

    expect(report.verdict).toBe('fail');
    const prompt = readingFor(report, 'request.prompt.unsupported-omitted');
    expect(prompt?.observed).toBe('no-prompt-part');
    expect(prompt?.expected).toBe('prompt-part-present');
    // The capability table is a claim under test, not documentation: a table that promises the
    // prompt cannot be forwarded while the adapter leaves it off is the red this reading exists for.
    expect(readingFor(report, 'request.body.golden')?.verdict).toBe('fail');
  });

  it('pins the request body against the declaration rather than against itself', () => {
    // The model is a parameter of the golden body because the decode configuration is a function of
    // the model name; the wire's own model is what the board probes with, so it is what is pinned
    // against here.
    const withPrompt = goldenBody(
      { ...capabilities, honors: { prompt: true, language: false, context: true } },
      INVARIANT_MODEL,
    );
    const withoutPrompt = goldenBody(capabilities, INVARIANT_MODEL);

    expect(withoutPrompt).not.toBe(withPrompt);
    expect(withoutPrompt.includes('systemInstruction')).toBe(false);
    expect(withPrompt.includes('systemInstruction')).toBe(true);
    expect(withPrompt.includes(INVARIANT_AUDIO_TEXT)).toBe(false);
    // The audio is carried as a token, so a recorded body can be printed without printing bytes.
    expect(withPrompt.includes('<AUDIO>')).toBe(true);
    // A declaration that does not acknowledge the context drops the part, which is the same rule
    // the prompt axis follows.
    const withoutContext = goldenBody(
      { ...capabilities, honors: { prompt: false, language: false, context: false } },
      INVARIANT_MODEL,
    );
    expect(withoutContext.includes('the invariant context')).toBe(false);
    expect(withoutContext.includes('inlineData')).toBe(true);
  });

  it('derives its size fixtures from the declaration, on both sides of the budget', () => {
    const budget = capabilities.maxInlineRequestBytes;
    // The base64 length of n bytes is ceil(n / 3) * 4 — written out here because THIS is the
    // arithmetic the two fixtures have to straddle, and a stale derivation would leave the size
    // group measuring one side of the line twice.
    const encodedLength = (bytes: number) => Math.ceil(bytes / 3) * 4;
    expect(encodedLength(overBudgetAudioBytes(budget))).toBeGreaterThan(budget);
    expect(encodedLength(affordableAudioBytes(budget))).toBeLessThan(budget);
    expect(affordableAudioBytes(budget)).toBeGreaterThan(0);
  });

  it('scans with a detector that fires on a needle and stays quiet without one', () => {
    const needles = redactionNeedles();

    expect(needles.credential).toBe(INVARIANT_API_KEY);
    expect(needles.payload).toContain(INVARIANT_AUDIO_BASE64);
    expect(needles.payload).toContain(INVARIANT_AUDIO_TEXT);

    const planted = [`a line carrying ${INVARIANT_API_KEY} and ${INVARIANT_AUDIO_BASE64}`];
    expect(scanLines(planted, [needles.credential]).length).toBe(1);
    expect(scanLines(planted, needles.payload).length).toBe(1);
    const clean = ['a line carrying neither'];
    expect(scanLines(clean, [needles.credential, ...needles.payload])).toEqual([]);
  });
});
