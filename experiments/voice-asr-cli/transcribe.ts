#!/usr/bin/env tsx
/**
 * The command line's face of the voice transcription chain (ADR-004 decision 2).
 *
 * The point of this entry point is not that a terminal can transcribe a file — it is that
 * the SAME module the browser and the server compile can be driven from outside them. Until
 * this existed, "prove the shipping implementation is correct against a new recognition
 * service" had no object to call: the only thing that spoke the wire protocol lived inline
 * in a React hook and a server method, so any experiment would have had to re-implement it
 * and would then have been measuring the re-implementation. This file therefore imports
 * shared/asr/transcriptionWire.ts rather than repeating any of it.
 *
 * Started with `npx tsx`, not bare `node`: the wire module is compiled by the server's
 * NodeNext configuration, whose relative import specifiers carry a `.js` extension, and bare
 * node resolves those literally (there is no `.js` on disk next to the `.ts` source). tsx
 * maps the specifier for us. The ADR records the alternative — teaching
 * server/tsconfig.json to rewrite extensions — and rejects it as a global build change made
 * for one CLI's sake.
 *
 * Out of scope here, by the ADR's own split: `--dry-run` (a request with no network and no
 * secrets) and `--offline` (replaying a recorded response) belong to the follow-up task that
 * owns them; this file only has to be a real consumer that loads.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import {
  createTranscriptionRequest,
  parseTranscriptionResponse,
} from '../../shared/asr/transcriptionWire.js';

const USAGE_LINE =
  'usage: npx tsx experiments/voice-asr-cli/transcribe.ts --audio <file> --base-url <url> [--api-key <key>] [--model <name>]';

const USAGE_NOTES = [
  '  --audio     path to the recording to transcribe (required)',
  '  --base-url  the OpenAI-compatible endpoints base, e.g. https://api.groq.com/openai/v1 (required)',
  '  --api-key   bearer token for that endpoint (optional; omitted sends no Authorization header)',
  '  --model     transcription model name (default: whisper-1)',
  '',
  'The request is built and the answer is read by shared/asr/transcriptionWire.ts — the same',
  'module the browser and the server compile, so a reading taken here is a reading of the',
  'shipping implementation rather than of a copy of it.',
].join('\n');

/** The container the recogniser is told the bytes have, from the file's own extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
};

type Options = {
  audioPath: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

/**
 * Reads the documented flags, or returns null so the caller prints the usage line. Unknown
 * flags are refused rather than ignored: a typo'd `--base-url` that silently fell back to a
 * default would send a recording somewhere the caller did not name.
 */
function parseArgs(argv: readonly string[]): Options | null {
  const options: Options = { audioPath: '', baseUrl: '', apiKey: '', model: 'whisper-1' };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--audio':
        options.audioPath = value;
        i += 1;
        break;
      case '--base-url':
        options.baseUrl = value;
        i += 1;
        break;
      case '--api-key':
        options.apiKey = value;
        i += 1;
        break;
      case '--model':
        options.model = value;
        i += 1;
        break;
      default:
        return null;
    }
  }

  return options.audioPath && options.baseUrl ? options : null;
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options) {
    process.stdout.write(`${USAGE_LINE}\n`);
    process.stdout.write(`${USAGE_NOTES}\n`);
    return 2;
  }

  const bytes = readFileSync(options.audioPath);
  const mimeType = MIME_BY_EXTENSION[extname(options.audioPath).toLowerCase()] || 'audio/webm';
  const request = createTranscriptionRequest(
    { baseUrl: options.baseUrl, apiKey: options.apiKey, model: options.model },
    { audio: new Blob([bytes], { type: mimeType }), fileName: basename(options.audioPath) },
  );

  const response = await fetch(request.url, request.init);
  const responseText = await response.text();
  if (!response.ok) {
    process.stderr.write(`transcribe: ${response.status} ${responseText}\n`);
    return 1;
  }

  // `strict` here, unlike the proxy path: this is a diagnostic, so a malformed answer has to
  // be visible as a failure rather than printed as if it were a transcript.
  process.stdout.write(`${parseTranscriptionResponse(responseText, 'strict')}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`transcribe: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
