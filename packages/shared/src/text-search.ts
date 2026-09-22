/**
 * Matching text in memory, for the second pass of search (FND-08).
 *
 * Household and Adults-only text is indexed in PostgreSQL and searched
 * there. A private document's text is sealed under its owner's key and has
 * no index, so it can only be searched by decrypting it inside the
 * caller's own session — which means the matching has to happen here, in
 * TypeScript, rather than in SQL.
 *
 * The aim is to behave the way `websearch_to_tsquery('simple', …)` does
 * for the queries people actually type: words are ANDed, `or` makes its
 * neighbours alternatives, `-` excludes, and "quoted words" must appear
 * together. There is no stemming, because the indexed side uses the
 * `simple` configuration and does not stem either. Differences from
 * PostgreSQL are the price of not having an index; they are listed in the
 * tests so they stay deliberate.
 */

export interface ParsedQuery {
  /** Each group is a set of alternatives; every group must match. */
  groups: string[][];
  /** None of these may appear. */
  exclude: string[];
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Words, lowercased, with everything else treated as a separator. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []) as string[];
}

/** Splits a query the way a person means it, not the way a parser wants it. */
export function parseQuery(q: string): ParsedQuery {
  const tokens: Array<{ text: string; negated: boolean; or: boolean }> = [];
  const re = /(-?)"([^"]*)"|(-?)(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const raw = m[2] ?? m[4] ?? '';
    const negated = (m[1] ?? m[3]) === '-';
    const text = raw.trim();
    if (!text) continue;
    if (!negated && /^or$/i.test(text)) {
      const last = tokens[tokens.length - 1];
      if (last) last.or = true; // the next token joins this one
      continue;
    }
    tokens.push({ text, negated, or: false });
  }

  const groups: string[][] = [];
  const exclude: string[] = [];
  let joinPrevious = false;
  for (const t of tokens) {
    const phrase = words(t.text).join(' ');
    if (!phrase) continue;
    if (t.negated) {
      exclude.push(phrase);
      joinPrevious = false;
      continue;
    }
    const previous = groups[groups.length - 1];
    if (joinPrevious && previous) previous.push(phrase);
    else groups.push([phrase]);
    joinPrevious = t.or;
  }
  return { groups, exclude };
}

/**
 * Whole-word positions of a phrase in an already-tokenised text. Matching
 * whole words rather than substrings is what keeps "art" out of "cart".
 */
function positionsOf(haystack: string[], phrase: string): number[] {
  const needle = phrase.split(' ');
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

export interface TextMatch {
  /** How many times the query's words appear; used only for ordering. */
  hits: number;
  /** A window of the text with `<em>` around what matched, like ts_headline. */
  snippet: string;
}

const MAX_WORDS = 18;

/**
 * Does this text satisfy the query, and if so, what should the person see?
 * Returns null when it does not match, so a caller can filter and format
 * in one pass.
 */
export function matchText(content: string, query: ParsedQuery): TextMatch | null {
  if (query.groups.length === 0) return null;
  const lower = words(content);
  if (lower.length === 0) return null;

  for (const phrase of query.exclude) {
    if (positionsOf(lower, phrase).length > 0) return null;
  }

  const marked = new Set<number>();
  let hits = 0;
  let first = -1;
  for (const group of query.groups) {
    let found = false;
    for (const phrase of group) {
      const at = positionsOf(lower, phrase);
      if (at.length === 0) continue;
      found = true;
      hits += at.length;
      const span = phrase.split(' ').length;
      for (const i of at) for (let j = 0; j < span; j++) marked.add(i + j);
      if (first === -1 || at[0]! < first) first = at[0]!;
    }
    if (!found) return null; // every group must match
  }

  return { hits, snippet: snippetAround(content, marked, first) };
}

/**
 * The original text — not the lowercased tokens — around the first match,
 * with the matched words wrapped. Offsets are tracked while re-scanning so
 * that punctuation and capitals survive into what the person reads.
 */
function snippetAround(content: string, marked: Set<number>, first: number): string {
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(WORD.source, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  if (spans.length === 0) return content.slice(0, 120);

  const from = Math.max(0, first - Math.floor((MAX_WORDS - 1) / 2));
  const to = Math.min(spans.length - 1, from + MAX_WORDS - 1);
  const startChar = spans[from]?.start ?? 0;
  const endChar = spans[to]?.end ?? content.length;

  let out = '';
  let cursor = startChar;
  for (let i = from; i <= to; i++) {
    const span = spans[i];
    if (!span) continue;
    out += content.slice(cursor, span.start);
    const word = content.slice(span.start, span.end);
    out += marked.has(i) ? `<em>${word}</em>` : word;
    cursor = span.end;
  }
  out += content.slice(cursor, endChar);
  const lead = startChar > 0 ? '…' : '';
  const tail = endChar < content.length ? '…' : '';
  return `${lead}${out.trim()}${tail}`;
}
