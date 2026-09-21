/**
 * Deterministic identifier repair against the project's own file list.
 *
 * Prompt biasing asks the recogniser to prefer a vocabulary, which is a nudge
 * and loses to acoustics most of the time. But this app is not guessing: it can
 * enumerate every path in the project. That turns identifier recovery from a
 * recognition problem into a string-matching problem, with an exact answer, no
 * model, no cost, and no risk of inventing a file that does not exist.
 *
 * `voice.seluis.ts` -> `voice.service.ts` is one edit-distance lookup away.
 *
 * Provenance: ported from the out-of-repo verification harness whose findings
 * report is quoted in the goal record for this work (§10, §16 of FINDINGS.md).
 * The candidate set is no longer read from that harness — it is enumerated from
 * `git ls-files` at run time, so this module depends on nothing outside the
 * repository and the readings below are reproducible in CI.
 */

import { execFileSync } from 'node:child_process';

/**
 * Levenshtein with early abandonment, returning Infinity once the cap is passed.
 *
 * The early exit must NOT report the cap as the distance. `cap + 1` is a LOWER
 * bound on the true distance, so turning it into a similarity yields an UPPER
 * bound — and thresholding on an upper bound lets unrelated candidates through.
 * That is precisely how `Recording.G` came to be "repaired" into `tests`: the
 * length difference alone (6 > cap 3) short-circuited to a flattering score.
 * Abandoned comparisons must be unusable, not merely approximate.
 */
export function editDistance(a, b, cap = Infinity) {
  if (Math.abs(a.length - b.length) > cap) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return Infinity;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The module's one normaliser: case-insensitive, spaces and commas gone.
 *
 * Exported because the runners have to state claims in the same terms the
 * matcher uses. A fixture that says "one edit away" while measuring with its own
 * private normaliser would be asserting about a different function.
 */
export const squash = (s) => s.toLowerCase().replace(/[\s,]/g, '');

/**
 * Find the best candidate for a garbled token.
 *
 * Threshold scales with length: short tokens need near-exact agreement, long
 * ones tolerate more, because that is where the recogniser's errors actually
 * land. A fixed threshold either mangles short names or refuses to fix long ones.
 */
export function bestMatch(token, candidates, { minScore = 0.7 } = {}) {
  const t = squash(token);
  if (!t) return null;
  const tHasDot = t.includes('.');
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const cs = squash(c);
    if (!cs) continue;
    if (cs === t) return { match: c, score: 1, exact: true };
    // A filename must be repaired into a filename, and a symbol into a symbol.
    // Without this, a camelCase symbol gets "corrected" into an unrelated
    // extension-bearing name. (Candidates now include bare stems, so a spoken
    // symbol still has a dotless target to match against.)
    if (tHasDot !== cs.includes('.')) continue;
    const cap = Math.max(2, Math.floor(cs.length * 0.35));
    const d = editDistance(t, cs, cap);
    if (!Number.isFinite(d)) continue;
    // Require a shared opening: a real garble keeps the start of the name.
    // Voice recognisers corrupt the middle and the end, rarely the onset.
    if (t.slice(0, 3) !== cs.slice(0, 3)) continue;
    const score = 1 - d / Math.max(t.length, cs.length);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= minScore ? { match: best, score: bestScore, exact: false } : null;
}

/** Dotted names only. Spaces are NOT separators here — see the n-gram pass. */
const DOTTED_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;

/** Ordinary words, for the multi-word pass. */
const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Second pass: a camelCase symbol spoken aloud comes back as separate capitalised
 * words — `useVoiceInput` becomes "Use voice input".
 *
 * Matching this by similarity is hopeless: "look at how" is shaped exactly like
 * "use voice input", and a fuzzy rule that accepts one accepts the other. So the
 * acceptance test here is EXACT after removing case and spaces. Ordinary prose
 * does not squash to a known symbol, so the vocabulary itself is the
 * discriminator and no threshold is needed.
 *
 * KNOWN LIMIT, measured: the vocabulary is the ONLY discriminator, so a symbol
 * whose name is made of ordinary English words also collides with that English.
 * On this repository's file list "Task sorting is handled in the panel" is
 * rewritten to "taskSorting is handled in the panel" — the words really do
 * squash onto the symbol. No local rule separates the two: a speaker dictating
 * `taskSorting` and a speaker saying "task sorting" are acoustically and
 * lexically the same input. See the false-positive runner for the surface this
 * fixture does and does not cover.
 */
function repairSpacedSymbols(text, candidates, minWords = 2, maxWords = 4) {
  const bare = new Map();
  for (const c of candidates) {
    if (c.includes('.')) continue;
    if (c.length < 5) continue;
    bare.set(squash(c), c);
  }
  if (!bare.size) return { text, repairs: [] };

  const repairs = [];
  const words = [...text.matchAll(WORD_RE)].map((m) => ({ w: m[0], i: m.index }));

  // Walk left to right; on a hit, skip past the matched span so overlapping
  // windows cannot rewrite the same words twice.
  let out = '';
  let cursor = 0;
  let k = 0;
  while (k < words.length) {
    let matched = null;
    for (let n = Math.min(maxWords, words.length - k); n >= minWords; n--) {
      const span = words.slice(k, k + n);
      // Only sane if the words are contiguous in the text (single spaces).
      const from = span[0].i;
      const to = span[span.length - 1].i + span[span.length - 1].w.length;
      const between = text.slice(from, to);
      if (/[^\w\s]/.test(between)) continue;
      const hit = bare.get(squash(between));
      if (hit) { matched = { from, to, hit, n }; break; }
    }
    if (matched) {
      out += text.slice(cursor, matched.from) + matched.hit;
      repairs.push({ from: text.slice(matched.from, matched.to), to: matched.hit, score: 1, exact: true });
      cursor = matched.to;
      k += matched.n;
    } else {
      k++;
    }
  }
  out += text.slice(cursor);
  return { text: out, repairs };
}

/**
 * Rewrite a transcript so identifier-shaped spans that closely match a known
 * file are replaced by the real name.
 *
 * Only spans containing a dot or a case change are considered: a bare lowercase
 * English word must never be "repaired" into a filename, or ordinary prose turns
 * into paths.
 */
export function repairIdentifiers(text, candidates, opts = {}) {
  const first = repairDottedNames(String(text), candidates, opts);
  const second = repairSpacedSymbols(first.text, candidates);
  return { text: second.text, repairs: [...first.repairs, ...second.repairs] };
}

function repairDottedNames(text, candidates, opts = {}) {
  const repairs = [];
  const out = text.replace(DOTTED_RE, (span) => {
    const looksLikeName = /[.]/.test(span) || /[a-z][A-Z]/.test(span) || /[A-Z][a-z]+[A-Z]/.test(span);
    if (!looksLikeName) return span;
    // Try the whole span, then progressively trimmed variants, so trailing
    // punctuation the recogniser attached does not defeat the match.
    const variants = [span, span.replace(/[.,\s]+$/, ''), span.replace(/^[.,\s]+/, '')];
    for (const v of variants) {
      if (squash(v).length < 5) continue;
      const m = bestMatch(v, candidates, opts);
      if (m) {
        repairs.push({ from: v, to: m.match, score: m.score, exact: m.exact });
        return span.replace(v, m.match);
      }
    }
    return span;
  });
  return { text: out, repairs };
}

/**
 * Every name this app can enumerate for free: each file's basename AND the bare
 * symbol it exports.
 *
 * The bare form is what makes English recovery work at all. Whisper renders a
 * spoken camelCase symbol as ordinary words — `useVoiceInput` comes back as
 * "Use voice input" — which carries no dot, so a filename-only candidate list
 * cannot match it. Offering `useVoiceInput` beside `useVoiceInput.ts` turns a
 * case-and-spacing error into an exact match, which is the single largest class
 * of English failure and costs nothing to fix.
 */
export function fileCandidates(paths) {
  const out = new Set();
  for (const p of paths) {
    const base = p.split('/').pop();
    if (!base) continue;
    out.add(base);
    const stem = base.replace(/\.[a-z]{1,5}$/i, '');
    if (stem && stem !== base) out.add(stem);
  }
  return [...out];
}

/**
 * The candidate set, taken live from the repository's own index.
 *
 * `git ls-files` rather than a walk: the list is exactly what the app can
 * enumerate for the project, it is what the file-tree endpoint would return,
 * and it needs no ignore rules of its own. No path outside the repository is
 * consulted, so the harness is reproducible in CI.
 */
export function projectCandidates({ cwd = process.cwd() } = {}) {
  const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const paths = out.split('\n').filter(Boolean);
  return { paths, candidates: fileCandidates(paths) };
}
