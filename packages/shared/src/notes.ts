/**
 * Notes you can write (5.35, A30): a small Markdown, read into a typed tree
 * that each app draws with its own elements. Nothing here is HTML, and
 * nothing turns into HTML: the web makes React elements from the tree, the
 * phone its own, so a note has no way to run a script or load anything.
 *
 * What a note may say:
 *
 *  - paragraphs, each line break kept as it was typed;
 *  - **bold** and *italic* (or _italic_), within a line;
 *  - bulleted lists (`- `, `* ` or `+ `), numbered lists (`1. `) and
 *    checklists (`- [ ] `, `- [x] `), one level deep;
 *  - level-3 headings (`### `);
 *  - links, `[words](address)` or an address written out, to https, http
 *    or mailto only — and drawn with their address, so the words cannot
 *    pass for somewhere they do not go.
 *
 * Anything else is text, exactly as written: HTML, images, tables, other
 * headings, a link to anywhere else (`javascript:`, `data:`…). The parser
 * is total — every string is a note — and linear: each line is read once,
 * a link's brackets are found through indexes made in one pass, and at
 * most `MAX_OPEN` unmatched `*` or `_` wait for a partner at a time, so no
 * input makes it backtrack. Plain text, as every note was before this,
 * comes back unchanged from `notesPlainText`.
 */

/** The longest a note may be, in characters (UTF-16 units, as the vault counts). */
export const NOTES_MAX = 10_000;

/** Inside a line: words, emphasis, a link, a line break. */
export type NoteInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: NoteInline[] }
  | { type: 'em'; children: NoteInline[] }
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
  | { type: 'heading'; blankBefore: number; children: NoteInline[] }
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
const ESCAPABLE = new Set(['\\', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '`']);

const BLANK = /^[ \t]*$/;
const HEADING = /^### ([\s\S]*)$/;
const BULLET = /^([-*+]) ([\s\S]*)$/;
const ORDERED = /^(\d{1,9})\. ([\s\S]*)$/;
const CHECKBOX = /^\[([ xX])\](?: ([\s\S]*))?$/;
const INDENTED = /^[ \t]/;

const isWhite = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** A character no address has: a space, a control character, `<` or `>`. */
function notInAnyAddress(c: string): boolean {
  const code = c.charCodeAt(0);
  return code <= 0x20 || code === 0x7f || c === '<' || c === '>' || /\s/.test(c);
}

/**
 * Whether a link may go there: https or http with somewhere after the `//`,
 * or mailto with an address. Asked of every link the parser makes, and by
 * whoever draws one, before it is a link at all.
 */
export function noteLinkAllowed(href: string): boolean {
  const lower = href.toLowerCase();
  const scheme = ['https://', 'http://', 'mailto:'].find((s) => lower.startsWith(s));
  if (!scheme || href.length === scheme.length) return false;
  for (let i = scheme.length; i < href.length; i++) {
    if (notInAnyAddress(href[i] as string)) return false;
  }
  return true;
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
    if (heading && !BLANK.test(heading[1] as string)) {
      blocks.push({
        type: 'heading',
        blankBefore: blank,
        children: parseLine(heading[1] as string),
      });
      blank = 0;
      open = null;
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

/** Two lines of one paragraph (or item): a line break between them. */
function joinLines(before: NoteInline[], after: NoteInline[]): NoteInline[] {
  return [...before, { type: 'break' }, ...after];
}

// ------------------------------------------------------------- inside a line

type Token =
  | { kind: 'node'; node: NoteInline }
  | { kind: 'delim'; ch: '*' | '_'; len: number; open: boolean; close: boolean };

/** For each position, the next position at or after it where `test` holds; -1 for none. */
function nextWhere(line: string, test: (c: string) => boolean): Int32Array {
  const out = new Int32Array(line.length + 1);
  let next = -1;
  out[line.length] = -1;
  for (let i = line.length - 1; i >= 0; i--) {
    if (test(line[i] as string)) next = i;
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
      const scheme = line.startsWith('https://', i) ? 8 : line.startsWith('http://', i) ? 7 : 0;
      if (scheme > 0) {
        // Up to the first character no address has. What is read here holds
        // none, so it fails only when nothing but a sentence's full stop or
        // bracket follows the `//` — and then holds no other address to read.
        let end = i + scheme;
        while (end < n && !notInAnyAddress(line[end] as string)) end += 1;
        const href = trimAddress(line.slice(i, end));
        if (noteLinkAllowed(href)) {
          flush();
          out.push({ kind: 'node', node: { type: 'link', href, children: [] } });
          i += href.length;
          continue;
        }
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
          out.push({ kind: 'delim', ch: c, len, open, close });
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
      const node: NoteInline =
        used === 2
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
