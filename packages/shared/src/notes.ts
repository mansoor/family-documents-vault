/**
 * Notes you can write (5.35, A30): a small Markdown, read into a typed tree
 * that each app draws with its own elements. Nothing here is HTML, and
 * nothing turns into HTML: the web makes React elements from the tree, the
 * phone its own, so a note has no way to run a script or load anything.
 *
 * What a note may say:
 *
 *  - paragraphs, each line break kept as it was typed;
 *  - **bold** and *italic* (or _italic_), within a line; and since 0.9.0
 *    (N1, the toolbar's) ~~struck through~~ and ++underlined++;
 *  - bulleted lists (`- `, `* ` or `+ `), numbered lists (`1. `) and
 *    checklists (`- [ ] `, `- [x] `), one level deep;
 *  - headings of three levels (`# `, `## `, `### `; until 0.9.0 only the
 *    third, so a note written before then reads as it did);
 *  - quotes (`> `), a line or several, since 0.9.0;
 *  - links, `[words](address)` or an address written out, to https, http
 *    or mailto only — and drawn with their address, so the words cannot
 *    pass for somewhere they do not go.
 *
 * Anything else is text, exactly as written: HTML, images, tables, a fourth
 * level of heading, a link to anywhere else (`javascript:`, `data:`…), and
 * a link whose address could show as somewhere it does not go — one with an
 * invisible or direction-changing character in it, or a name before its
 * host (`https://bank.example@evil.example`).
 *
 * The web's editor (0.9.0, N1) writes a note from what it shows through
 * `tidyNoteTree` and `noteTreeToMarkdown`, and keeps nothing it cannot
 * read back the same: whatever it is given — a page pasted, say — becomes
 * a tree of these few things first, and only then words.
 *
 * The parser is total — every string is a note — and linear in the note's
 * length, whatever it holds:
 *
 *  - each line is split off and matched once, by patterns that cannot
 *    backtrack;
 *  - a paragraph's or an item's lines are appended to it in place, never
 *    copied;
 *  - a line's `[`, `]` and `)` are found through indexes made in one pass,
 *    and the addresses `[words](address)` tries never overlap;
 *  - a written-out address is read once, its host first: one with no host
 *    (`https:///`, `https://?`) or a name before it is refused there, and
 *    its host holds no `/`, so no other address; one with a host is read
 *    on to its end, and fails only when nothing but a sentence's full stop
 *    or bracket follows the `//` — which holds no other address either;
 *  - at most `MAX_OPEN` unmatched `*` or `_` wait for a partner at a time,
 *    and a closer takes at most three goes.
 *
 * Plain text, as every note was before this, comes back unchanged from
 * `notesPlainText`.
 */

/** The longest a note may be, in characters (UTF-16 units, as the vault counts). */
export const NOTES_MAX = 10_000;

/**
 * The built-in kind of a note kept on its own (0.9.0, N1, 0078): a document
 * with no file, whose words are its note. Never a kind to file a paper as.
 */
export const NOTE_KIND = 'note';

/** Inside a line: words, emphasis, a link, a line break. */
export type NoteInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: NoteInline[] }
  | { type: 'em'; children: NoteInline[] }
  /** 0.9.0 (N1): `~~words~~`. */
  | { type: 'strike'; children: NoteInline[] }
  /** 0.9.0 (N1): `++words++`. */
  | { type: 'underline'; children: NoteInline[] }
  /** Its address, always https, http or mailto; `children` are its words (none: the address alone). */
  | { type: 'link'; href: string; children: NoteInline[] }
  | { type: 'break' };

/** One line of a list: what it was marked with, and a checklist's box. */
export interface NoteListItem {
  /** As written: `-`, `*`, `+`, or a number and a point (`3.`). */
  marker: string;
  /** A checklist's box, ticked or not; null for a plain bullet or number. */
  checked: boolean | null;
  children: NoteInline[];
}

/**
 * A block of a note. `blankBefore` is how many blank lines came before it,
 * so its plain text is the note as it was typed; drawing may ignore it.
 */
export type NoteBlock =
  | { type: 'paragraph'; blankBefore: number; children: NoteInline[] }
  /** `level` is how many `#` (0.9.0); a note from before has only `### `, level 3. */
  | { type: 'heading'; blankBefore: number; level: 1 | 2 | 3; children: NoteInline[] }
  /** A quote's lines, joined by line breaks (0.9.0, N1). */
  | { type: 'quote'; blankBefore: number; children: NoteInline[] }
  | {
      type: 'list';
      blankBefore: number;
      ordered: boolean;
      /** A numbered list's first number, as written; 1 for a bulleted one. */
      start: number;
      items: NoteListItem[];
    };

export interface NoteTree {
  blocks: NoteBlock[];
}

/** How many `*` or `_` may wait for a partner at once: deeper is plain text. */
const MAX_OPEN = 8;

/** What a backslash makes plain: the characters that mean something here. */
const ESCAPABLE = new Set([
  '\\',
  '*',
  '_',
  '[',
  ']',
  '(',
  ')',
  '#',
  '+',
  '-',
  '.',
  '!',
  '`',
  // 0.9.0 (N1): a strike's mark, and a quote's.
  '~',
  '>',
]);

const BLANK = /^[ \t]*$/;
// At most three `#`, then a space: `####` is text. (The quantifier is
// bounded, so a run of `#` costs at most three tries.)
const HEADING = /^(#{1,3}) ([\s\S]*)$/;
const QUOTE = /^> ([\s\S]*)$/;
const BULLET = /^([-*+]) ([\s\S]*)$/;
const ORDERED = /^(\d{1,9})\. ([\s\S]*)$/;
const CHECKBOX = /^\[([ xX])\](?: ([\s\S]*))?$/;
const INDENTED = /^[ \t]/;

const isWhite = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * What could make an address show as somewhere it does not go: control and
 * format characters — right-to-left overrides and isolates, zero-width
 * spaces and joiners, the soft hyphen, every one of Unicode's Cf — and line
 * and paragraph separators.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A character (one code point) no address has: a space, `<`, `>`, or one of UNSEEN. */
function notInAnyAddress(c: string): boolean {
  return (
    (c.codePointAt(0) ?? 0) <= 0x20 || c === '<' || c === '>' || /\s/u.test(c) || UNSEEN.test(c)
  );
}

/** The code point at `i`, as a string of one or two units. */
const codePointAt = (line: string, i: number) =>
  String.fromCodePoint(line.codePointAt(i) as number);

/** Where a web address's host ends: its first `/`, `?` or `#`, or its end. */
const AUTHORITY_END = /[/?#]/;

/**
 * Whether a link may go there: https or http with a host after the `//`
 * and no name before it (`user@`, which could pass for the host), or
 * mailto with an address — and in neither anything UNSEEN. Asked of every
 * link the parser makes, and by whoever draws one, before it is a link at
 * all.
 */
export function noteLinkAllowed(href: string): boolean {
  const lower = href.toLowerCase();
  const scheme = ['https://', 'http://', 'mailto:'].find((s) => lower.startsWith(s));
  if (!scheme || href.length === scheme.length) return false;
  const rest = href.slice(scheme.length);
  for (const c of rest) if (notInAnyAddress(c)) return false;
  if (scheme === 'mailto:') return true;
  const end = rest.search(AUTHORITY_END);
  const authority = end === -1 ? rest : rest.slice(0, end);
  return authority !== '' && !authority.includes('@');
}

/** A note as a tree. Any string at all is one; null or nothing is an empty note. */
export function parseNotes(source: string | null | undefined): NoteTree {
  const blocks: NoteBlock[] = [];
  let blank = 0;
  /** The block a line may go on: a paragraph's next line, a list's next item. */
  let open: NoteBlock | null = null;
  for (const line of (source ?? '').split(/\r\n|\r|\n/)) {
    if (BLANK.test(line)) {
      blank += 1;
      open = null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading && !BLANK.test(heading[2] as string)) {
      blocks.push({
        type: 'heading',
        blankBefore: blank,
        level: (heading[1] as string).length as 1 | 2 | 3,
        children: parseLine(heading[2] as string),
      });
      blank = 0;
      open = null;
      continue;
    }
    // A quote's line: the quote before it goes on, or a new one begins.
    const quoted = QUOTE.exec(line);
    if (quoted) {
      const words = parseLine(quoted[1] as string);
      if (open?.type === 'quote') {
        open.children = joinLines(open.children, words);
      } else {
        open = { type: 'quote', blankBefore: blank, children: words };
        blocks.push(open);
        blank = 0;
      }
      continue;
    }
    const item = listItem(line);
    if (item) {
      const ordered = item.ordered;
      if (open?.type === 'list' && open.ordered === ordered) {
        open.items.push(item.item);
      } else {
        open = {
          type: 'list',
          blankBefore: blank,
          ordered,
          start: ordered ? Number.parseInt(item.item.marker, 10) : 1,
          items: [item.item],
        };
        blocks.push(open);
      }
      blank = 0;
      continue;
    }
    // An indented line under a list item goes on with it.
    if (open?.type === 'list' && INDENTED.test(line)) {
      const last = open.items[open.items.length - 1] as NoteListItem;
      last.children = joinLines(last.children, parseLine(line));
      continue;
    }
    if (open?.type === 'paragraph') {
      open.children = joinLines(open.children, parseLine(line));
      continue;
    }
    open = { type: 'paragraph', blankBefore: blank, children: parseLine(line) };
    blocks.push(open);
    blank = 0;
  }
  return { blocks };
}

function listItem(line: string): { ordered: boolean; item: NoteListItem } | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    const rest = bullet[2] as string;
    const box = CHECKBOX.exec(rest);
    return {
      ordered: false,
      item: box
        ? {
            marker: bullet[1] as string,
            checked: box[1] !== ' ',
            children: parseLine(box[2] ?? ''),
          }
        : { marker: bullet[1] as string, checked: null, children: parseLine(rest) },
    };
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return {
      ordered: true,
      item: {
        marker: `${ordered[1] as string}.`,
        checked: null,
        children: parseLine(ordered[2] as string),
      },
    };
  }
  return null;
}

/**
 * Two lines of one paragraph (or item): a line break between them, added
 * to what it already holds in place. Copied, a paragraph of many short
 * lines cost the square of its length (the 5.35 review, X535-01).
 */
function joinLines(before: NoteInline[], after: NoteInline[]): NoteInline[] {
  before.push({ type: 'break' });
  for (const node of after) before.push(node);
  return before;
}

// ------------------------------------------------------------- inside a line

/** A mark: `*` or `_` (italic, bold), and since 0.9.0 `~` (struck) and `+` (underlined), two at a time. */
type Mark = '*' | '_' | '~' | '+';

type Token =
  | { kind: 'node'; node: NoteInline }
  | { kind: 'delim'; ch: Mark; len: number; open: boolean; close: boolean };

/**
 * For each position, the next position at or after it where `test` holds
 * of the code point there; -1 for none. (A character outside the BMP is
 * tested whole at its first unit.)
 */
function nextWhere(line: string, test: (c: string) => boolean): Int32Array {
  const out = new Int32Array(line.length + 1);
  let next = -1;
  out[line.length] = -1;
  for (let i = line.length - 1; i >= 0; i--) {
    if (test(codePointAt(line, i))) next = i;
    out[i] = next;
  }
  return out;
}

/** What may not be in a `[words](address)` address: what no address has, and a bracket. */
const NOT_IN_ADDRESS = (c: string) => c === '(' || c === ')' || notInAnyAddress(c);

/** Ends of a written-out address that belong to the sentence, not to it. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '*', '_']);

/** One line, read into words, emphasis and links. */
function parseLine(line: string, links = true): NoteInline[] {
  return emphasis(tokens(line, links));
}

function tokens(line: string, links: boolean): Token[] {
  const out: Token[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ kind: 'node', node: { type: 'text', text } });
    text = '';
  };
  // Made once, and only for a line with a bracket in it: each `[` then
  // finds its `]`, `(` and `)` without reading the line again.
  let closeBracket: Int32Array | null = null;
  let openBracket: Int32Array | null = null;
  let closeParen: Int32Array | null = null;
  let notAddress: Int32Array | null = null;
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i] as string;
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(line[i + 1] as string)) {
      text += line[i + 1];
      i += 2;
      continue;
    }
    if (c === '[' && links) {
      closeBracket ??= nextWhere(line, (x) => x === ']');
      openBracket ??= nextWhere(line, (x) => x === '[');
      closeParen ??= nextWhere(line, (x) => x === ')');
      notAddress ??= nextWhere(line, NOT_IN_ADDRESS);
      const j = closeBracket[i + 1] as number;
      const inner = openBracket[i + 1] as number;
      if (j >= 0 && (inner < 0 || inner > j) && line[j + 1] === '(') {
        const k = closeParen[j + 2] as number;
        const bad = notAddress[j + 2] as number;
        if (k >= 0 && (bad < 0 || bad >= k)) {
          const href = line.slice(j + 2, k);
          if (noteLinkAllowed(href)) {
            flush();
            out.push({
              kind: 'node',
              node: { type: 'link', href, children: parseLine(line.slice(i + 1, j), false) },
            });
            i = k + 1;
            continue;
          }
        }
      }
      text += c;
      i += 1;
      continue;
    }
    if (c === 'h' && links && !isWordChar(line[i - 1])) {
      const href = writtenAddressAt(line, i);
      if (href) {
        flush();
        out.push({ kind: 'node', node: { type: 'link', href, children: [] } });
        i += href.length;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      let j = i;
      while (line[j] === c) j += 1;
      const len = j - i;
      if (len <= 3) {
        const before = line[i - 1];
        const after = line[j];
        // `_` inside a word (snake_case, a_file_name) is the word's own.
        const open = !isWhite(after) && (c === '*' || !isWordChar(before));
        const close = !isWhite(before) && (c === '*' || !isWordChar(after));
        if (open || close) {
          flush();
          out.push({ kind: 'delim', ch: c, len, open, close: close && !afterOpener(out) });
          i = j;
          continue;
        }
      }
      text += line.slice(i, j);
      i = j;
      continue;
    }
    // Struck (`~~`) and underlined (`++`): exactly two, flanked as `*` is,
    // so `C++ and D++` and a lone `~` stay text (0.9.0, N1).
    if (c === '~' || c === '+') {
      let j = i;
      while (line[j] === c) j += 1;
      if (j - i === 2) {
        const before = line[i - 1];
        const after = line[j];
        const open = !isWhite(after);
        const close = !isWhite(before);
        if (open || close) {
          flush();
          out.push({ kind: 'delim', ch: c, len: 2, open, close: close && !afterOpener(out) });
          i = j;
          continue;
        }
      }
      text += line.slice(i, j);
      i = j;
      continue;
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

/**
 * The address written out at `i` (an `h`), as a link takes it; null for
 * none. Read once, up to the first character no address has. Its host
 * first: none at all (`https:///`, `https://?`), or a name before it
 * (`user@`), is not a link — refused here, before the rest is read (the
 * second round, N535P-01: read, each `https:///` of a run of them read the
 * rest of the run again). The host holds no `/`, so no other address to
 * read. The rest holds nothing noteLinkAllowed refuses, so it fails only
 * when nothing but a sentence's full stop or bracket follows the `//` — and
 * then holds no other address either.
 */
function writtenAddressAt(line: string, i: number): string | null {
  const scheme = line.startsWith('https://', i) ? 8 : line.startsWith('http://', i) ? 7 : 0;
  if (scheme === 0) return null;
  const n = line.length;
  let end = i + scheme;
  let named = false;
  while (end < n) {
    const ch = codePointAt(line, end);
    if (notInAnyAddress(ch) || AUTHORITY_END.test(ch)) break;
    if (ch === '@') named = true;
    end += ch.length;
  }
  if (named || end === i + scheme) return null;
  while (end < n) {
    const ch = codePointAt(line, end);
    if (notInAnyAddress(ch)) break;
    end += ch.length;
  }
  const href = trimAddress(line.slice(i, end));
  return noteLinkAllowed(href) ? href : null;
}

/**
 * Whether the last token is a mark that only opens: a mark straight after
 * it opens too, never closes (0.9.0, N1). So `*a ++**b**++*` is italic
 * round underlined bold — the `**` after `++` cannot close the `*` — as
 * the toolbar makes marks one inside another.
 */
function afterOpener(out: Token[]): boolean {
  const last = out[out.length - 1];
  return last?.kind === 'delim' && last.open && !last.close;
}

/** A written-out address without the full stop, comma or bracket that ends its sentence. */
function trimAddress(raw: string): string {
  let end = raw.length;
  let opens = 0;
  let closes = 0;
  for (const c of raw) {
    if (c === '(') opens += 1;
    else if (c === ')') closes += 1;
  }
  for (;;) {
    const last = raw[end - 1] as string;
    if (TRAILING.has(last)) {
      end -= 1;
    } else if (last === ')' && closes > opens) {
      closes -= 1;
      end -= 1;
    } else {
      break;
    }
  }
  return raw.slice(0, end);
}

interface Frame {
  children: NoteInline[];
  opener: { ch: string; len: number } | null;
}

/**
 * `*` and `_` matched with their partners, as CommonMark matches them: a
 * closer takes the nearest opener of its kind, two marks at a time while
 * both have two (bold), else one (italic), until it or the opener runs out
 * — so `***both***` is italic and bold, and `***a* b**` bold with an italic
 * word in it. Any opener between them, and any left at the end of the
 * line, is plain text. A closer takes at most three goes, and looks at most
 * `MAX_OPEN` openers back.
 */
function emphasis(list: Token[]): NoteInline[] {
  const frames: Frame[] = [{ children: [], opener: null }];
  const top = () => frames[frames.length - 1] as Frame;
  const push = (node: NoteInline) => {
    const children = top().children;
    const last = children[children.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else children.push(node.type === 'text' ? { type: 'text', text: node.text } : node);
  };
  // An opener nobody closed: its marks as text, what followed it after them.
  const giveUp = () => {
    const f = frames.pop() as Frame;
    const o = f.opener as { ch: string; len: number };
    push({ type: 'text', text: o.ch.repeat(o.len) });
    for (const c of f.children) push(c);
  };
  for (const t of list) {
    if (t.kind === 'node') {
      push(t.node);
      continue;
    }
    let left = t.len;
    while (t.close && left > 0) {
      let at = -1;
      for (let k = frames.length - 1; k >= 1; k--) {
        if (((frames[k] as Frame).opener as { ch: string }).ch === t.ch) {
          at = k;
          break;
        }
      }
      if (at < 1) break;
      while (frames.length - 1 > at) giveUp();
      const f = top();
      const o = f.opener as { ch: string; len: number };
      const used = left >= 2 && o.len >= 2 ? 2 : 1;
      // `~~` and `++` are always two to two (0.9.0, N1).
      const node: NoteInline =
        t.ch === '~'
          ? { type: 'strike', children: f.children }
          : t.ch === '+'
            ? { type: 'underline', children: f.children }
            : used === 2
              ? { type: 'strong', children: f.children }
              : { type: 'em', children: f.children };
      left -= used;
      o.len -= used;
      if (o.len > 0) {
        // The opener's marks nearest its words were used: the rest open
        // around what they made.
        f.children = [node];
      } else {
        frames.pop();
        push(node);
      }
    }
    if (left === 0) continue;
    if (t.open && frames.length - 1 < MAX_OPEN) {
      frames.push({ children: [], opener: { ch: t.ch, len: left } });
      continue;
    }
    push({ type: 'text', text: t.ch.repeat(left) });
  }
  while (frames.length > 1) giveUp();
  return (frames[0] as Frame).children;
}

// -------------------------------------------------------------- plain text

/**
 * A note without its marks, for a search's snippet or anywhere words are
 * wanted: bold and italic as their words, a link as its words and its
 * address, a heading as its words, a list's items one a line with their
 * markers, line breaks and blank lines as typed. Text with no Markdown in
 * it comes back exactly as it went in (bar a line of only spaces, which
 * comes back empty, and blank lines after the last words).
 */
export function notesPlainText(source: string | null | undefined): string {
  return noteTreeText(parseNotes(source));
}

/**
 * A note with no title named by its words (0.9.0, N1, the re-check): its
 * first line of words, as plain text, `max` characters at most — or null,
 * with none. Worked out as it is read, never kept: a note's title is only
 * ever what was typed into it.
 */
export function noteFirstWords(words: string | null | undefined, max = 80): string | null {
  if (!words) return null;
  const first = notesPlainText(words.slice(0, Math.max(max * 8, 800)))
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return first ? first.slice(0, max) : null;
}

/**
 * What a document is called wherever it is listed: its title; a note with
 * none, by its first words where the reader is given them (`note_name`), or
 * "Untitled note"; anything else, `untitled`.
 */
export function documentName(
  d: { title: string | null; type_key: string | null; note_name?: string | undefined },
  untitled: string,
): string {
  const t = d.title?.trim();
  if (t) return t;
  if (d.type_key === NOTE_KIND) return d.note_name ?? 'Untitled note';
  return untitled;
}

/** A tree's plain text: what `notesPlainText` gives for its note. */
export function noteTreeText(tree: NoteTree): string {
  let out = '';
  tree.blocks.forEach((b, i) => {
    if (i > 0) out += '\n';
    out += '\n'.repeat(b.blankBefore);
    if (b.type === 'list') {
      out += b.items
        .map((item) => {
          const box = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] ';
          return `${item.marker} ${box}${inlineText(item.children)}`;
        })
        .join('\n');
    } else {
      out += inlineText(b.children);
    }
  });
  return out;
}

function inlineText(nodes: NoteInline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.text;
        break;
      case 'break':
        out += '\n';
        break;
      case 'link': {
        const words = inlineText(node.children);
        out += words && words !== node.href ? `${words} (${node.href})` : node.href;
        break;
      }
      default:
        out += inlineText(node.children);
    }
  }
  return out;
}

// ------------------------------------------------------- a note's preview

/**
 * The characters a note's marks are made of (0.9.0, N1): `*`, `_`, `~`,
 * `+`, a backquote and a backslash. As a pattern for the database's
 * regexp_replace too (a bracket expression it reads the same way).
 */
export const NOTE_MARK_CHARACTERS = '[*_~+`\\\\]';
const MARK_CHARACTERS = new RegExp(NOTE_MARK_CHARACTERS, 'g');

/**
 * Words as a note is found by them (0.9.0, N1, GET /notes): without its
 * marks' characters, spaces run together, in lower case — so "ann first"
 * finds `**Ann** first`. Asked of what is typed, and of a note, alike; no
 * more than a pass over the characters.
 */
export function noteMatchWords(text: string | null | undefined): string {
  return (text ?? '').replace(MARK_CHARACTERS, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A note's first words, for a list of notes (0.9.0, N1): its plain text,
 * spaces and lines run together, cut at `max` characters with an ellipsis.
 * Only the start of a long note is read: a preview never costs the whole.
 */
export function notePreview(source: string | null | undefined, max = 140): string {
  const start = (source ?? '').slice(0, Math.max(max * 4, 400));
  const words = notesPlainText(start).replace(/\s+/g, ' ').trim();
  if (words.length <= max) return words;
  const cut = words.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ------------------------------------------------- a tree, written out

type Marked = Extract<NoteInline, { children: NoteInline[] }>;
type MarkType = 'strong' | 'em' | 'strike' | 'underline';
const MARK_TYPES: readonly MarkType[] = ['strong', 'em', 'strike', 'underline'];
const isMark = (n: NoteInline): n is Extract<NoteInline, { type: MarkType }> =>
  (MARK_TYPES as readonly string[]).includes(n.type);

/**
 * A tree as the editor's words make it, tidied so that writing it out reads
 * back the same (0.9.0, N1): texts side by side made one and empty ones
 * dropped; spaces at a mark's edges moved outside it (`** a **` is not
 * bold); a mark or a link split where a line breaks (marks never run across
 * lines); a mark inside the same mark, and empty marks, gone; marks side by
 * side of one kind made one; bold round all of an italic written as italic
 * round bold (`***a***`); in a heading, line breaks as spaces; a link's
 * brackets as parentheses; and blocks with no words left out, as are line
 * breaks that begin or end a block. An empty line — two line breaks in a
 * row, or a line of only spaces — begins a new paragraph, as it reads back.
 */
export function tidyNoteTree(tree: NoteTree): NoteTree {
  const blocks: NoteBlock[] = [];
  for (const b of tree.blocks) {
    if (b.type === 'list') {
      const items = b.items.map((item, i) => ({
        marker: b.ordered ? `${b.start + i}.` : '-',
        checked: b.ordered ? null : item.checked,
        // An item's later lines without the indent that keeps them in it.
        children: trimBreaks(tidyInline(unindented(item.children), false, new Set())),
      }));
      if (items.length > 0) blocks.push({ ...b, blankBefore: 0, items });
      continue;
    }
    const inline = tidyInline(b.children, false, new Set());
    if (b.type === 'heading') {
      const flat: NoteInline[] = inline.map((n) =>
        n.type === 'break' ? { type: 'text', text: ' ' } : n,
      );
      const words = tidyInline(flat, false, new Set());
      if (hasWords(words)) blocks.push({ ...b, blankBefore: 0, children: words });
      continue;
    }
    // A paragraph, or a quote: split at an empty line.
    for (const part of splitAtEmptyLines(inline)) {
      if (hasWords(part)) blocks.push({ ...b, blankBefore: 0, children: part });
    }
  }
  return { blocks };
}

/** Each line after the first without the spaces it begins with. */
function unindented(nodes: NoteInline[]): NoteInline[] {
  const out: NoteInline[] = [];
  let afterBreak = false;
  for (const n of nodes) {
    if (n.type === 'text' && afterBreak) {
      const t = n.text.replace(/^[ \t]+/, '');
      afterBreak = t === '';
      if (t) out.push({ type: 'text', text: t });
      continue;
    }
    afterBreak = n.type === 'break';
    out.push(n);
  }
  return out;
}

function hasWords(nodes: NoteInline[]): boolean {
  return nodes.some((n) =>
    n.type === 'text'
      ? n.text.trim() !== ''
      : n.type === 'break'
        ? false
        : n.type === 'link' || hasWords(n.children),
  );
}

/** Without the line breaks (and lines of only spaces) at its start and end. */
function trimBreaks(nodes: NoteInline[]): NoteInline[] {
  const lines = splitAt(nodes);
  const blank = (p: NoteInline[] | 'break' | undefined) =>
    p === 'break' || (p !== undefined && !hasWords(p));
  while (lines.length > 0 && blank(lines[0])) lines.shift();
  while (lines.length > 0 && blank(lines[lines.length - 1])) lines.pop();
  return lines.flatMap((p) => (p === 'break' ? [{ type: 'break' } as const] : p));
}

/** A block's words in parts, wherever a line is empty (two breaks, or a line of only spaces). */
function splitAtEmptyLines(nodes: NoteInline[]): NoteInline[][] {
  const parts: NoteInline[][] = [];
  let part: NoteInline[] = [];
  let line: NoteInline[] = [];
  const endLine = () => {
    if (hasWords(line)) {
      if (part.length > 0) part.push({ type: 'break' });
      part.push(...line);
    } else if (part.length > 0) {
      parts.push(part);
      part = [];
    }
    line = [];
  };
  for (const n of nodes) {
    if (n.type === 'break') endLine();
    else line.push(n);
  }
  endLine();
  if (part.length > 0) parts.push(part);
  return parts;
}

/**
 * Inline nodes tidied (see tidyNoteTree). `inLink`: inside a link, where a
 * link is its words; `within`: the marks already round these, which a mark
 * inside them repeats for nothing.
 */
function tidyInline(nodes: NoteInline[], inLink: boolean, within: Set<MarkType>): NoteInline[] {
  const out: NoteInline[] = [];
  const push = (n: NoteInline) => {
    const last = out[out.length - 1];
    if (n.type === 'text') {
      if (n.text === '') return;
      if (last?.type === 'text') {
        out[out.length - 1] = { type: 'text', text: last.text + n.text };
        return;
      }
      out.push({ type: 'text', text: n.text });
      return;
    }
    // Two marks of a kind side by side: one.
    if (isMark(n) && last && last.type === n.type) {
      out[out.length - 1] = tidyMark(n.type, [...(last as Marked).children, ...n.children]);
      return;
    }
    out.push(n);
  };
  for (const n of nodes) {
    if (n.type === 'break') {
      push(n);
      continue;
    }
    if (n.type === 'text') {
      // An address written out is a link, as the note will read it.
      if (inLink) push(n);
      else for (const piece of addressesIn(n.text, out)) push(piece);
      continue;
    }
    if (n.type === 'link') {
      if (inLink || !noteLinkAllowed(n.href)) {
        for (const c of tidyInline(n.children, inLink, within)) push(c);
        continue;
      }
      const words = tidyInline(n.children, true, within).map(bracketsAsParens);
      // No words, or only its address: the address alone, written out.
      const only = words.length === 1 ? words[0] : undefined;
      if (!hasWords(words) || (only?.type === 'text' && only.text === n.href)) {
        push({ type: 'link', href: n.href, children: [] });
        continue;
      }
      // A link is one line's: split where its words break a line.
      for (const piece of splitAt(words)) {
        if (piece === 'break') {
          push({ type: 'break' });
          continue;
        }
        const { lead, core, trail } = edges(piece);
        if (lead) push({ type: 'text', text: lead });
        if (hasWords(core)) push({ type: 'link', href: n.href, children: core });
        if (trail) push({ type: 'text', text: trail });
      }
      continue;
    }
    // A mark: inside the same mark, it says nothing more.
    if (within.has(n.type)) {
      for (const c of tidyInline(n.children, inLink, within)) push(c);
      continue;
    }
    const inner = tidyInline(n.children, inLink, new Set([...within, n.type]));
    for (const piece of splitAt(inner)) {
      if (piece === 'break') {
        push({ type: 'break' });
        continue;
      }
      const { lead, core, trail } = edges(piece);
      if (lead) push({ type: 'text', text: lead });
      if (hasWords(core)) push(tidyMark(n.type, core));
      else for (const c of core) push(c);
      if (trail) push({ type: 'text', text: trail });
    }
  }
  return out;
}

/**
 * Words, with each address written out in them a link, where the note
 * would read one: after no letter or digit (the words before them, or what
 * `before` ends with).
 */
function addressesIn(words: string, before: NoteInline[]): NoteInline[] {
  if (!words.includes('http')) return [{ type: 'text', text: words }];
  const prev = before[before.length - 1];
  const out: NoteInline[] = [];
  let from = 0;
  for (let i = words.indexOf('http'); i !== -1; i = words.indexOf('http', i + 1)) {
    if (i < from) continue;
    const ahead = i > 0 ? words[i - 1] : prev?.type === 'text' ? prev.text.slice(-1) : undefined;
    if (isWordChar(ahead)) continue;
    const href = writtenAddressAt(words, i);
    if (!href) continue;
    if (i > from) out.push({ type: 'text', text: words.slice(from, i) });
    out.push({ type: 'link', href, children: [] });
    from = i + href.length;
  }
  if (from < words.length) out.push({ type: 'text', text: words.slice(from) });
  return out;
}

/** A mark round these words; bold round all of an italic is italic round bold, as `***a***` reads. */
function tidyMark(type: MarkType, children: NoteInline[]): NoteInline {
  const only = children.length === 1 ? children[0] : undefined;
  if (type === 'strong' && only?.type === 'em') {
    return { type: 'em', children: [{ type: 'strong', children: only.children }] };
  }
  return { type, children };
}

/** Inline nodes in pieces between line breaks, each break kept in its place. */
function splitAt(nodes: NoteInline[]): Array<NoteInline[] | 'break'> {
  const out: Array<NoteInline[] | 'break'> = [];
  let piece: NoteInline[] = [];
  for (const n of nodes) {
    if (n.type === 'break') {
      if (piece.length > 0) out.push(piece);
      out.push('break');
      piece = [];
    } else piece.push(n);
  }
  if (piece.length > 0) out.push(piece);
  return out;
}

/** The spaces at a piece's start and end, taken off it. */
function edges(piece: NoteInline[]): { lead: string; core: NoteInline[]; trail: string } {
  const core = [...piece];
  let lead = '';
  let trail = '';
  const first = core[0];
  if (first?.type === 'text') {
    const t = first.text.trimStart();
    lead = first.text.slice(0, first.text.length - t.length);
    if (t) core[0] = { type: 'text', text: t };
    else core.shift();
  }
  const last = core[core.length - 1];
  if (last?.type === 'text') {
    const t = last.text.trimEnd();
    trail = last.text.slice(t.length);
    if (t) core[core.length - 1] = { type: 'text', text: t };
    else core.pop();
  }
  return { lead, core, trail };
}

/** A bracket in a link's words would end them early: shown as the parenthesis it reads as. */
function bracketsAsParens(n: NoteInline): NoteInline {
  if (n.type === 'text') {
    return { type: 'text', text: n.text.replace(/\[/g, '(').replace(/\]/g, ')') };
  }
  if (n.type === 'break') return n;
  return { ...n, children: n.children.map(bracketsAsParens) };
}

/** What a mark is written as. */
const MARK_OF: Record<MarkType, string> = { strong: '**', em: '*', strike: '~~', underline: '++' };

/** What would begin a block at the start of a line, read as words. */
const LINE_START = /^(?:#{1,3} |> |[-*+] |\d{1,9}\. )/;
/** A checklist's box at an item's start, read as words. */
const BOX_START = /^\[[ xX]\](?: |$)/;
/** What a careful writing puts a backslash before, wherever it is. */
const SPECIAL = /[\\*_~+[\]]/g;

/**
 * A tree written out as a note (0.9.0, N1): what the web's editor saves.
 * Each block is written plainly first, and read back: the same, it stays
 * so. Otherwise the marks' characters in its words are written with a
 * backslash; then, still not the same, a mark inside a mark is let go; and
 * at the last only its words are kept, every one of them. So what is saved
 * always reads back as nothing but what was written — words never lost, at
 * worst a mark the format cannot say where it is (`**a*b***`).
 *
 * Blocks are one blank line apart. A line that would begin a block of its
 * own (`- `, `# `, `> `, `1. `) is written with a backslash; a list item's
 * later lines are indented, as it reads them. Linear in the tree's size:
 * each block is read back at most four times.
 */
export function noteTreeToMarkdown(tree: NoteTree): string {
  return tidyNoteTree(tree).blocks.map(writeBlock).join('\n\n');
}

function writeBlock(b: NoteBlock): string {
  const tries: Array<[NoteBlock, 'light' | 'full']> = [
    [b, 'light'],
    [b, 'full'],
    [mapInline(b, flattenMarks), 'full'],
    [mapInline(b, withoutMarks), 'full'],
  ];
  let md = '';
  for (const [block, mode] of tries) {
    md = blockText(block, mode);
    const back = parseNotes(md).blocks;
    if (back.length === 1 && sameBlock(back[0] as NoteBlock, block)) return md;
  }
  return md;
}

function mapInline(b: NoteBlock, f: (nodes: NoteInline[]) => NoteInline[]): NoteBlock {
  if (b.type === 'list') {
    return { ...b, items: b.items.map((i) => ({ ...i, children: perLine(i.children, f) })) };
  }
  return { ...b, children: perLine(b.children, f) };
}

/** `f` over each line's nodes, the breaks kept between them. */
function perLine(nodes: NoteInline[], f: (nodes: NoteInline[]) => NoteInline[]): NoteInline[] {
  const out: NoteInline[] = [];
  for (const piece of splitAt(nodes)) {
    if (piece === 'break') out.push({ type: 'break' });
    else out.push(...f(piece).filter((n) => n.type !== 'text' || n.text !== ''));
  }
  return out;
}

/** No marks at all: their words, and each link with its words as words. */
function withoutMarks(nodes: NoteInline[]): NoteInline[] {
  const out: NoteInline[] = [];
  for (const n of nodes) {
    if (n.type === 'text' || n.type === 'break') out.push(n);
    else if (n.type === 'link') {
      out.push(
        n.children.length === 0
          ? n
          : { ...n, children: [{ type: 'text', text: inlineText(n.children) }] },
      );
    } else out.push(...withoutMarks(n.children));
  }
  return out;
}

/** Only the outermost marks: those inside them let go. */
function flattenMarks(nodes: NoteInline[]): NoteInline[] {
  return nodes.map((n): NoteInline => {
    if (n.type === 'text' || n.type === 'break') return n;
    const words: NoteInline[] = [{ type: 'text', text: inlineText(n.children) }];
    if (n.type === 'link') return n.children.length === 0 ? n : { ...n, children: words };
    return { type: n.type, children: words };
  });
}

function blockText(b: NoteBlock, mode: 'light' | 'full'): string {
  switch (b.type) {
    case 'heading':
      return `${'#'.repeat(b.level)} ${inlineMd(b.children, mode)}`;
    case 'quote':
      return inlineMd(b.children, mode)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'paragraph':
      return inlineMd(b.children, mode).split('\n').map(escapeLineStart).join('\n');
    case 'list':
      return b.items
        .map((item, i) => {
          const marker = b.ordered ? `${b.start + i}.` : '-';
          const box = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] ';
          const [first = '', ...rest] = inlineMd(item.children, mode).split('\n');
          // Words that would read as a box are not one.
          const head = item.checked === null && BOX_START.test(first) ? `\\${first}` : first;
          return [`${marker} ${box}${head}`, ...rest.map((l) => `  ${l}`)].join('\n');
        })
        .join('\n');
  }
}

/** A line that would begin a block, written so that it does not. */
function escapeLineStart(line: string): string {
  if (!LINE_START.test(line)) return line;
  const digits = /^\d+/.exec(line);
  return digits ? `${digits[0]}\\${line.slice(digits[0].length)}` : `\\${line}`;
}

function inlineMd(nodes: NoteInline[], mode: 'light' | 'full'): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += mode === 'full' ? n.text.replace(SPECIAL, (c) => `\\${c}`) : n.text;
        break;
      case 'break':
        out += '\n';
        break;
      case 'link':
        // An address alone is written out, as typed — or, where that would
        // not read back (`a.example/x.` loses its full stop), as its own words.
        if (n.children.length === 0 && mode === 'light') out += n.href;
        else {
          const words: NoteInline[] =
            n.children.length > 0 ? n.children : [{ type: 'text', text: n.href }];
          // A bracket would end the address: written as the URL parser writes it.
          out += `[${inlineMd(words, mode)}](${n.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
        }
        break;
      default: {
        const mark = MARK_OF[n.type];
        out += `${mark}${inlineMd(n.children, mode)}${mark}`;
      }
    }
  }
  return out;
}

/** Two blocks the same, as a reader sees them: blank lines and a list item's indent aside. */
function sameBlock(a: NoteBlock, b: NoteBlock): boolean {
  return JSON.stringify(canonBlock(a)) === JSON.stringify(canonBlock(b));
}

function canonBlock(b: NoteBlock): unknown {
  if (b.type === 'list') {
    return {
      type: 'list',
      ordered: b.ordered,
      start: b.start,
      items: b.items.map((i) => ({ checked: i.checked, children: canonInline(i.children, true) })),
    };
  }
  return {
    type: b.type,
    level: b.type === 'heading' ? b.level : null,
    children: canonInline(b.children, false),
  };
}

function canonInline(nodes: NoteInline[], item: boolean): unknown[] {
  const out: Array<Record<string, unknown>> = [];
  let afterBreak = false;
  for (const n of nodes) {
    if (n.type === 'text') {
      const text = item && afterBreak ? n.text.replace(/^[ \t]+/, '') : n.text;
      afterBreak = false;
      if (!text) continue;
      const last = out[out.length - 1];
      if (last?.type === 'text') last.text = `${last.text as string}${text}`;
      else out.push({ type: 'text', text });
      continue;
    }
    afterBreak = n.type === 'break';
    if (n.type === 'break') out.push({ type: 'break' });
    else if (n.type === 'link') {
      // An address alone and an address as its own words read alike.
      const words: NoteInline[] =
        n.children.length > 0 ? n.children : [{ type: 'text', text: n.href }];
      out.push({ type: 'link', href: n.href, children: canonInline(words, false) });
    } else out.push({ type: n.type, children: canonInline(n.children, false) });
  }
  return out;
}
