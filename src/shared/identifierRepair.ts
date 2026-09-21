/**
 * Repairs the identifiers a voice transcript got wrong, using names the project
 * really has.
 *
 * A recogniser never emits a file name. Ask for `voiceConfig.ts` and it hands
 * back "voice config.ts"; say `useVoiceInput` and it hands back "use voice
 * input", one symbol shredded into three words. Neither needs a model to fix,
 * because the candidate set is the project's own file tree — everything the
 * repair needs is a string comparison against names that already exist.
 *
 * There are two failure shapes and they need opposite rules, so there are two
 * passes:
 *
 *  - a dotted token is a *typo*, so it is matched by edit distance;
 *  - a run of words is a *split*, so it is matched by exact equality once
 *    whitespace and case are removed.
 *
 * Everything here is a pure function of its arguments — no DOM, no React, no
 * network, no model, no clock. The caller owns where the candidates come from
 * and what to do with the result.
 */

/**
 * The most edits the dotted pass will pay for. It is also the pruning bound
 * handed to `editDistance`: two names whose lengths differ by more than this
 * cannot be each other's typo, whatever edit script connects them.
 */
const MAX_EDIT_DISTANCE = 2;

/**
 * How much of the longer name has to survive the edit. A raw distance is not
 * enough on its own — two edits are a typo in a 20-character name and a
 * different name entirely in a 4-character one — so the edit is scaled by the
 * length it happened in.
 */
const MIN_SIMILARITY = 0.8;

/**
 * A mistyped name keeps its opening. Without this, short names slide into each
 * other wholesale: the last three characters of `ui.ts` and `api.ts` agree.
 */
const SHARED_PREFIX_LENGTH = 3;

/**
 * A token only enters the dotted pass if it is shaped like a file name: a stem,
 * then one or more `.ext` segments of one to five characters each, each
 * starting with a letter. This is also what keeps the pass off ordinary prose —
 * `ends.` has an empty extension, `3.14` starts its extension with a digit, so
 * neither is ever compared against a candidate and a sentence that merely ends
 * in a full stop cannot be rewritten.
 */
const DOTTED_TOKEN = /^[-A-Za-z0-9_$]+(?:\.[A-Za-z][A-Za-z0-9]{0,4})+$/;

/**
 * What a split symbol may have been broken across. A newline is a real line
 * break, not a recogniser's idea of a word boundary, so a run never spans one.
 */
const INLINE_SEPARATOR = /^[ \t]+$/;

/** One whitespace-delimited run of the input, with where it sits. */
type Token = {
  text: string;
  /** Offset of the token's first character in the input. */
  start: number;
  /** Offset one past its last character. */
  end: number;
  /** The whitespace between the previous token and this one ('' for the first). */
  separator: string;
};

/** One span of the input to replace. */
type Replacement = {
  start: number;
  end: number;
  text: string;
};

/** Splits on whitespace while remembering where every token was. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const word = /\S+/g;
  let match = word.exec(text);

  while (match !== null) {
    const previous = tokens[tokens.length - 1];
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      separator: previous === undefined ? '' : text.slice(previous.end, match.index),
    });
    match = word.exec(text);
  }

  return tokens;
}

/**
 * Levenshtein distance, pruned by a length bound.
 *
 * The difference in length is a *lower* bound on the true distance: no edit
 * script is shorter than the number of characters one side has and the other
 * does not. So once it exceeds `maxDistance` the pair is settled — and it is
 * settled with `Infinity`, deliberately not with `maxDistance + 1`.
 *
 * The caller turns distances into similarity, and `maxDistance + 1` is a finite
 * number that reads as a near-match on a long name: a lower bound on the
 * distance becomes an upper bound on the similarity, and a threshold tested
 * against an upper bound is a false positive waiting for a long enough name.
 * `Infinity` is the honest reading of "these two cannot be within the cap".
 */
function editDistance(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return Infinity;

  const width = b.length + 1;
  let previous = new Array<number>(width);
  let current = new Array<number>(width);
  for (let column = 0; column < width; column += 1) previous[column] = column;

  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let column = 1; column < width; column += 1) {
      const substitute = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitute);
    }
    const finished = previous;
    previous = current;
    current = finished;
  }

  return previous[b.length];
}

/** How much of the longer of the two strings the given edit left standing. */
function similarity(distance: number, a: string, b: string): number {
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * The dotted candidate closest to `token`, or null if none is close enough.
 *
 * Three guards run, and all three are load-bearing:
 *
 *  1. only dotted candidates are considered — the caller passes exactly those,
 *     so a token spelled without its extension can never reach a name that has
 *     one (and the reverse is true by construction of the other pass);
 *  2. the two must open with the same three characters;
 *  3. the edit must leave enough of the name standing, which is what the
 *     distance-to-similarity step measures.
 *
 * Comparison is case-folded because recognisers do not preserve case, and the
 * winner is returned with the candidate's own spelling. Ties break on the name
 * itself, so the answer does not depend on the order the caller listed them in.
 */
function nearestDottedCandidate(token: string, candidates: readonly string[]): string | null {
  const needle = token.toLowerCase();
  const opening = needle.slice(0, SHARED_PREFIX_LENGTH);
  let best: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const haystack = candidate.toLowerCase();
    if (haystack.slice(0, SHARED_PREFIX_LENGTH) !== opening) continue;

    const distance = editDistance(needle, haystack, MAX_EDIT_DISTANCE);
    if (!Number.isFinite(distance)) continue;
    if (similarity(distance, needle, haystack) < MIN_SIMILARITY) continue;

    if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * Indexes the dotless candidates by the shape a recogniser would leave behind
 * if it split them: whitespace removed, case removed.
 */
function splitIndex(candidates: readonly string[]): { keys: Map<string, string>; longest: number } {
  const keys = new Map<string, string>();
  let longest = 0;

  for (const candidate of candidates) {
    const key = candidate.replace(/\s+/g, '').toLowerCase();
    if (key.length === 0) continue;
    if (!keys.has(key)) keys.set(key, candidate);
    if (key.length > longest) longest = key.length;
  }

  return { keys, longest };
}

/**
 * The longest run of tokens starting at `start` that spells a split candidate,
 * or null.
 *
 * The test is *equality* — the run with whitespace and case removed against the
 * candidate's own form the same way — and deliberately nothing looser. The
 * tempting rule here is a similarity threshold and it cannot be made to work:
 * "use voice input" and "look at how" have exactly the same shape, three
 * lowercase words, so any threshold that accepts the first accepts the second.
 * Only one of them is the symbol. Only equality can tell them apart.
 */
function longestSplitMatch(
  tokens: readonly Token[],
  start: number,
  keys: Map<string, string>,
  longest: number,
): { end: number; text: string } | null {
  let compact = '';
  let match: { end: number; text: string } | null = null;
  const limit = Math.min(longest, tokens.length - start);

  for (let length = 1; length <= limit; length += 1) {
    const token = tokens[start + length - 1];
    if (length > 1 && !INLINE_SEPARATOR.test(token.separator)) break;

    compact += token.text.toLowerCase();
    if (compact.length > longest) break;

    const candidate = keys.get(compact);
    if (candidate !== undefined) match = { end: start + length - 1, text: candidate };
  }

  return match;
}

/**
 * Returns `text` with every identifier-shaped mistake against `candidates`
 * repaired, and every other character exactly as it was.
 *
 * `candidates` are names the project really has. They are only read: nothing is
 * mutated, nothing is fetched, and the result depends on nothing but the two
 * arguments — the same call always produces the same string.
 */
export function repairIdentifiers(text: string, candidates: readonly string[]): string {
  if (text.length === 0 || candidates.length === 0) return text;

  const dotted: string[] = [];
  const dotless: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    if (candidate.includes('.')) dotted.push(candidate);
    else dotless.push(candidate);
  }

  const tokens = tokenize(text);
  const replacements: Replacement[] = [];

  // Pass one: dotted names, one token at a time.
  for (const token of tokens) {
    if (!DOTTED_TOKEN.test(token.text)) continue;
    const repaired = nearestDottedCandidate(token.text, dotted);
    if (repaired !== null && repaired !== token.text) {
      replacements.push({ start: token.start, end: token.end, text: repaired });
    }
  }

  // Pass two: split symbols, a run of tokens at a time.
  if (dotless.length > 0) {
    const { keys, longest } = splitIndex(dotless);
    let index = 0;

    while (index < tokens.length) {
      const matched = longestSplitMatch(tokens, index, keys, longest);
      if (matched === null) {
        index += 1;
        continue;
      }
      const start = tokens[index];
      const end = tokens[matched.end];
      if (text.slice(start.start, end.end) !== matched.text) {
        replacements.push({ start: start.start, end: end.end, text: matched.text });
      }
      index = matched.end + 1;
    }
  }

  if (replacements.length === 0) return text;

  // The two passes walk the same tokens, so their finds can arrive out of
  // order; they can never overlap (a dotless key has no dot to match).
  replacements.sort((left, right) => left.start - right.start);

  let repaired = '';
  let cursor = 0;
  for (const replacement of replacements) {
    repaired += text.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }

  return repaired + text.slice(cursor);
}
