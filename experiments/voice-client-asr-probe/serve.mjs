#!/usr/bin/env node
// Static server for the client-side ASR probe.
//
//   node experiments/voice-client-asr-probe/serve.mjs [--port 8791] [--isolated]
//
// Serves index.html / probe.mjs from this directory, the ONNX runtime from `.cache/` (git-ignored),
// the pinned model from MODEL_DIR, and the clips from VOICE_PROBE_CLIPS_DIR.
//
//   --isolated  add Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy (+ CORP) so the page
//               is cross-origin isolated and SharedArrayBuffer / multi-threaded WASM become
//               available. Off by default — the app's own headers do not set these, and the
//               default arm must reproduce that (crossOriginIsolated = false).
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, extname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.onnx': 'application/octet-stream', '.wav': 'audio/wav',
};

export function parseArgs(argv) {
  const a = { port: 8791, isolated: false, root: HERE, model: null, clips: null, ort: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--isolated') a.isolated = true;
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--root') a.root = resolve(argv[++i]);
    else if (t === '--model') a.model = resolve(argv[++i]);
    else if (t === '--clips') a.clips = resolve(argv[++i]);
    else if (t === '--ort') a.ort = resolve(argv[++i]);
  }
  a.model = a.model || process.env.MODEL_DIR || '/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
  a.clips = a.clips || process.env.VOICE_PROBE_CLIPS_DIR || '/data/home/yale/work/tc-verify/corpus/voice-index-loop/wav';
  a.ort = a.ort || join(HERE, '.cache', 'package', 'dist');
  return a;
}

// Map a URL path to an absolute file path, or null if outside the allowed roots.
export function resolvePath(urlPath, cfg) {
  const p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '/index.html') return join(cfg.root, 'index.html');
  const mounts = [
    ['/ort/', cfg.ort], ['/model/', cfg.model], ['/clips/', cfg.clips], ['/', cfg.root],
  ];
  for (const [prefix, base] of mounts) {
    if (p.startsWith(prefix)) {
      const rel = normalize(p.slice(prefix.length)).replace(/^(\.\.(\/|\\|$))/, '');
      const full = join(base, rel);
      if (!full.startsWith(resolve(base))) return null;
      return full;
    }
  }
  return null;
}

export function createProbeServer(cfg) {
  const securityHeaders = cfg.isolated
    ? {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      }
    : {};
  return createServer((req, res) => {
    const file = resolvePath(req.url, cfg);
    if (!file) { res.writeHead(404, securityHeaders); res.end('not found'); return; }
    let st;
    try { st = statSync(file); } catch (e) { res.writeHead(404, securityHeaders); res.end('not found'); return; }
    if (st.isDirectory()) { res.writeHead(404, securityHeaders); res.end('not found'); return; }
    const ext = extname(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      ...securityHeaders,
    };
    // The model is meant to be cached (that is what arm "second open" measures); page assets are not.
    headers['Cache-Control'] = ext === '.onnx' ? 'public, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  });
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const cfg = parseArgs(process.argv.slice(2));
  const server = createProbeServer(cfg);
  server.listen(cfg.port, () => {
    console.log(`probe server on http://127.0.0.1:${cfg.port} (isolated=${cfg.isolated})`);
    console.log(`  root=${cfg.root}`);
    console.log(`  model=${cfg.model}`);
    console.log(`  clips=${cfg.clips}`);
    console.log(`  ort=${cfg.ort}`);
  });
}
