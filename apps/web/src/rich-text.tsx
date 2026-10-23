import {
  noteLinkAllowed,
  noteTreeToMarkdown,
  parseNotes,
  tidyNoteTree,
  type NoteBlock,
  type NoteInline,
  type NoteListItem,
  type NoteTree,
} from '@fdv/shared';
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';

/**
 * The note editor (0.9.0, N1): one, for a note kept on its own and for a
 * document's note alike — what you see as you write is what the note says.
 *
 * It writes on the page (contentEditable), with the browser's own editing
 * commands, and keeps nothing it shows but as the note's small Markdown
 * (@fdv/shared notes.ts): what is on the page is read into a note's tree —
 * only the few things a note may say, everything else as its words, or
 * nothing (a script, a style, a picture) — and written out from that. A
 * page pasted in is read the same way before anything of it is shown, in a
 * document of its own that runs nothing and loads nothing. So it holds no
 * editor library, makes no request, and the vault keeps only what reads
 * back the same. What the vault draws is drawn from the tree as elements
 * (notes.tsx), never as HTML: that is where a note is made safe, whoever
 * wrote it and however.
 *
 * Its toolbar is one (the ARIA toolbar pattern): a single stop in the tab
 * order, the arrow keys, Home and End between its buttons, each toggle
 * pressed as the words the caret is in are, and the kinds of text in a
 * menu of their own.
 */

// ------------------------------------------------------------ the page, read

/** Elements whose content is never a note's: left out whole. */
const LEFT_OUT = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'IFRAME',
  'FRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'MATH',
  'CANVAS',
  'IMG',
  'PICTURE',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'TRACK',
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'OPTION',
  'DATALIST',
]);

/** Elements that are blocks: their words begin on a line of their own. */
const BLOCKS = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'MAIN',
  'NAV',
  'ASIDE',
  'ADDRESS',
  'FIGURE',
  'FIGCAPTION',
  'CENTER',
  'FORM',
  'FIELDSET',
  'LEGEND',
  'DETAILS',
  'SUMMARY',
  'PRE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'CAPTION',
  'DL',
  'DT',
  'DD',
  'HR',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'BODY',
  'HTML',
]);

type MarkName = 'strong' | 'em' | 'underline' | 'strike';

/** The marks an element makes, by its name or its own style. */
function marksOf(el: HTMLElement): { add: MarkName[]; drop: MarkName[] } {
  const add: MarkName[] = [];
  const drop: MarkName[] = [];
  const tag = el.tagName;
  const style = el.style;
  const weight = style?.fontWeight ?? '';
  const bold =
    weight === 'bold' || weight === 'bolder' || (/^\d+$/.test(weight) && Number(weight) >= 600);
  const unbold =
    weight === 'normal' || weight === 'lighter' || (/^\d+$/.test(weight) && Number(weight) < 600);
  if (((tag === 'B' || tag === 'STRONG') && !unbold) || bold) add.push('strong');
  if (unbold && (tag === 'B' || tag === 'STRONG' || weight)) drop.push('strong');
  const italic = style?.fontStyle === 'italic' || style?.fontStyle === 'oblique';
  if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'VAR' || italic) add.push('em');
  if (style?.fontStyle === 'normal') drop.push('em');
  const line = `${style?.textDecoration ?? ''} ${style?.textDecorationLine ?? ''}`;
  if (tag === 'U' || tag === 'INS' || /underline/.test(line)) add.push('underline');
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(line)) {
    add.push('strike');
  }
  return { add, drop };
}

/**
 * A link's address as a note keeps one: https, http or mailto, as it is
 * (the N1 review: one with brackets is not written anew), or none.
 */
export function linkAddress(raw: string | null | undefined): string | null {
  const href = (raw ?? '').trim();
  return href && noteLinkAllowed(href) ? href : null;
}

interface ReadOptions {
  /** A page pasted: its spaces and line ends run together, as a browser shows them. */
  pasted: boolean;
}

/**
 * What is on the page, or pasted, as a note's tree (tidied: what a note
 * would read back as). Only the few things a note may say are kept; the
 * rest are their words, and what is never a note's — a script, a style, a
 * picture, a form — is left out whole.
 */
export function readNote(root: Node, opts: ReadOptions = { pasted: false }): NoteTree {
  const blocks: NoteBlock[] = [];
  let open: NoteInline[] | null = null;
  const flush = () => {
    if (open && open.length > 0) blocks.push({ type: 'paragraph', blankBefore: 0, children: open });
    open = null;
  };
  // The editor's own words as they are, their no-break and zero-width
  // spaces too (the N1 review); a page pasted, as a browser shows it.
  const textOf = (t: string) =>
    opts.pasted
      ? t
          .replace(/\u00a0/g, ' ')
          .replace(/[\u200b\ufeff]/g, '')
          .replace(/[\t\n\r ]+/g, ' ')
      : t;

  /**
   * The words under `node`, each with the marks it is shown with: worked
   * out from the top down, so the nearest says — bold inside "not bold"
   * (a page pasted from a word processor) is bold, and "not bold" inside
   * bold is not.
   */
  const runsOf = (node: Node, marks: MarkName[], inLink: boolean): Run[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      const words = textOf(node.textContent ?? '');
      const out: Run[] = [];
      const lines = opts.pasted ? [words] : words.split('\n');
      lines.forEach((part, i) => {
        if (i > 0) out.push({ kind: 'break' });
        if (part) out.push({ kind: 'text', text: part, marks });
      });
      return out;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const el = node as HTMLElement;
    if (LEFT_OUT.has(el.tagName.toUpperCase()) || isBox(el)) return [];
    if (el.tagName === 'BR') return [{ kind: 'break' }];
    const { add, drop } = marksOf(el);
    const here = [...marks.filter((m) => !drop.includes(m))];
    for (const m of add) if (!here.includes(m)) here.push(m);
    const href = el.tagName === 'A' && !inLink ? linkAddress(el.getAttribute('href')) : null;
    let runs: Run[] = [];
    for (const c of Array.from(el.childNodes)) {
      const inner = runsOf(c, here, inLink || href !== null);
      // A block inside words (a paragraph in a list item, a quote): its own line.
      if (c.nodeType === Node.ELEMENT_NODE && BLOCKS.has((c as HTMLElement).tagName)) {
        if (inner.length > 0 && runs.length > 0) runs.push({ kind: 'break' });
      }
      runs = runs.concat(inner);
    }
    if (href) return [{ kind: 'link', href, marks: here, outer: here, runs }];
    return runs;
  };

  /** Inline words, as the marks round them say. */
  const inline = (node: Node): NoteInline[] => {
    const runs: Run[] = [];
    for (const c of Array.from(node.childNodes)) {
      const inner = runsOf(c, [], false);
      if (c.nodeType === Node.ELEMENT_NODE && BLOCKS.has((c as HTMLElement).tagName)) {
        if (inner.length > 0 && runs.length > 0) runs.push({ kind: 'break' });
      }
      runs.push(...inner);
    }
    return build(runs, MARK_ORDER);
  };

  const listOf = (el: HTMLElement): NoteBlock => {
    const ordered = el.tagName === 'OL';
    const checklist = !ordered && isChecklist(el);
    const items: NoteListItem[] = [];
    const take = (li: HTMLElement) => {
      // A list inside an item: its items follow it, one level deep.
      const nested: HTMLElement[] = [];
      const words: NoteInline[] = [];
      for (const c of Array.from(li.childNodes)) {
        if (c.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test((c as HTMLElement).tagName)) {
          nested.push(c as HTMLElement);
          continue;
        }
        const inner = build(runsOf(c, [], false), MARK_ORDER);
        if (c.nodeType === Node.ELEMENT_NODE && BLOCKS.has((c as HTMLElement).tagName)) {
          if (inner.length > 0 && words.length > 0) words.push({ type: 'break' });
        }
        words.push(...inner);
      }
      items.push({
        marker: ordered ? `${items.length + 1}.` : '-',
        // In a list of to-dos, an item with no box is a plain one (the N1 review).
        checked: checklist && hasBox(li) ? isTicked(li) : null,
        children: words,
      });
      for (const n of nested) {
        for (const c of Array.from(n.children)) if (c.tagName === 'LI') take(c as HTMLElement);
      }
    };
    for (const c of Array.from(el.children)) {
      if (c.tagName === 'LI') take(c as HTMLElement);
      else if (/^(UL|OL)$/.test(c.tagName)) {
        for (const li of Array.from(c.children)) if (li.tagName === 'LI') take(li as HTMLElement);
      }
    }
    const at = Number(el.getAttribute('start') ?? '1');
    const start = ordered ? (Number.isFinite(at) && at >= 0 ? Math.floor(at) : 1) : 1;
    return { type: 'list', blankBefore: 0, ordered, start, items };
  };

  const walk = (node: Node) => {
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const words = build(runsOf(c, [], false), MARK_ORDER);
        if (words.length > 0) open = (open ?? []).concat(words);
        continue;
      }
      if (c.nodeType !== Node.ELEMENT_NODE) continue;
      const el = c as HTMLElement;
      if (LEFT_OUT.has(el.tagName.toUpperCase())) continue;
      if (!BLOCKS.has(el.tagName)) {
        const words = build(runsOf(el, [], false), MARK_ORDER);
        if (words.length > 0) open = (open ?? []).concat(words);
        continue;
      }
      flush();
      const heading = /^H([1-6])$/.exec(el.tagName);
      if (heading) {
        const level = Math.min(Number(heading[1]), 3) as 1 | 2 | 3;
        blocks.push({ type: 'heading', blankBefore: 0, level, children: inline(el) });
      } else if (el.tagName === 'UL' || el.tagName === 'OL') {
        blocks.push(listOf(el));
      } else if (el.tagName === 'LI') {
        blocks.push({
          type: 'list',
          blankBefore: 0,
          ordered: false,
          start: 1,
          items: [{ marker: '-', checked: null, children: inline(el) }],
        });
      } else if (el.tagName === 'BLOCKQUOTE') {
        // Enter in a quote splits it in two, as the browser makes it: a
        // quote straight after a quote is its next line.
        const before = blocks[blocks.length - 1];
        const words = inline(el);
        if (before?.type === 'quote' && el.previousElementSibling?.tagName === 'BLOCKQUOTE') {
          before.children = [...before.children, { type: 'break' }, ...words];
        } else {
          blocks.push({ type: 'quote', blankBefore: 0, children: words });
        }
      } else if (el.tagName === 'TR') {
        // A table's row: its cells one line, apart.
        const cells = Array.from(el.children).map((cell) => inline(cell));
        const words: NoteInline[] = [];
        cells.forEach((cell, i) => {
          if (i > 0 && cell.length > 0) words.push({ type: 'text', text: ' · ' });
          words.push(...cell);
        });
        if (words.length > 0) blocks.push({ type: 'paragraph', blankBefore: 0, children: words });
      } else {
        walk(el);
        flush();
      }
    }
  };
  walk(root);
  flush();
  const tree = tidyNoteTree({ blocks });
  return opts.pasted ? tidyNoteTree(trimmedLines(tree)) : tree;
}

/**
 * Each line of a page pasted without the spaces at its start and end: a
 * page's markup puts them round its words (an indented source, a box before
 * a list's words), and a browser does not show them.
 */
function trimmedLines(tree: NoteTree): NoteTree {
  const trim = (nodes: NoteInline[]): NoteInline[] => {
    const out: NoteInline[] = [];
    let lineStart = true;
    for (const n of nodes) {
      if (n.type === 'break') {
        const last = out[out.length - 1];
        if (last?.type === 'text') last.text = last.text.trimEnd();
        out.push(n);
        lineStart = true;
        continue;
      }
      if (n.type === 'text' && lineStart) {
        const t = n.text.trimStart();
        if (t) out.push({ type: 'text', text: t });
        lineStart = t === '';
        continue;
      }
      out.push(n);
      lineStart = false;
    }
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text = last.text.trimEnd();
    return out.filter((n) => n.type !== 'text' || n.text !== '');
  };
  return {
    blocks: tree.blocks.map((b) =>
      b.type === 'list'
        ? { ...b, items: b.items.map((i) => ({ ...i, children: trim(i.children) })) }
        : { ...b, children: trim(b.children) },
    ),
  };
}

/** A word, a line break or a link, with the marks it is shown with. */
type Run =
  | { kind: 'text'; text: string; marks: MarkName[] }
  | { kind: 'break' }
  | { kind: 'link'; href: string; marks: MarkName[]; outer: MarkName[]; runs: Run[] };

/** Outermost first, as a note writes marks one inside another. */
const MARK_ORDER: MarkName[] = ['strong', 'em', 'underline', 'strike'];

/**
 * Runs as a note's inline tree: words side by side that share a mark go
 * inside one of it, outermost first; a link's words inside the link, with
 * the marks the link itself is shown with outside it.
 */
function build(runs: Run[], order: MarkName[]): NoteInline[] {
  const [mark, ...rest] = order;
  if (!mark) {
    return runs.map((r): NoteInline => {
      if (r.kind === 'text') return { type: 'text', text: r.text };
      if (r.kind === 'break') return { type: 'break' };
      const inner = r.runs.map((x) =>
        x.kind === 'break' ? x : { ...x, marks: x.marks.filter((m) => !r.outer.includes(m)) },
      );
      return { type: 'link', href: r.href, children: build(inner, MARK_ORDER) };
    });
  }
  const has = (r: Run) => r.kind !== 'break' && r.marks.includes(mark);
  const out: NoteInline[] = [];
  for (let i = 0; i < runs.length;) {
    let j = i;
    const marked = has(runs[i] as Run);
    while (j < runs.length && has(runs[j] as Run) === marked) j += 1;
    const group = runs.slice(i, j);
    if (marked) {
      const inner = group.map((r) =>
        r.kind === 'break' ? r : { ...r, marks: r.marks.filter((m) => m !== mark) },
      );
      out.push({ type: mark, children: build(inner, rest) });
    } else {
      out.push(...build(group, rest));
    }
    i = j;
  }
  return out;
}

/** A list of things to do: the editor's own, or one pasted from elsewhere. */
function isChecklist(el: HTMLElement): boolean {
  if (el.dataset.checklist === 'true') return true;
  return Array.from(el.children).some(
    (li) =>
      li.tagName === 'LI' &&
      ((li as HTMLElement).dataset.checked !== undefined ||
        li.querySelector(':scope > input[type="checkbox"]') !== null ||
        li.getAttribute('role') === 'checkbox'),
  );
}

/** Whether an item of a list of to-dos is one: its own state, a box, or a pasted one's. */
function hasBox(li: HTMLElement): boolean {
  return (
    li.dataset.checked !== undefined ||
    li.querySelector(':scope > input[type="checkbox"]') !== null ||
    li.getAttribute('aria-checked') !== null ||
    li.getAttribute('role') === 'checkbox'
  );
}

/** The editor's own box on a to-do: what it shows and says, never the note's words. */
export function isBox(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains('rt-box');
}

/**
 * Each to-do's box, as its state says (the N1 review): a checkbox a screen
 * reader hears, "Done", ticked or not — not to be typed in, and not the
 * note's words. Put on every item with a state, taken off anywhere else.
 */
export function syncBoxes(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const box of Array.from(root.querySelectorAll<HTMLElement>('.rt-box'))) {
    const li = box.parentElement;
    const keeps =
      li?.tagName === 'LI' &&
      li.dataset.checked !== undefined &&
      li.parentElement?.dataset.checklist === 'true' &&
      li.firstChild === box;
    if (!keeps) box.remove();
  }
  for (const li of Array.from(
    root.querySelectorAll<HTMLElement>('ul[data-checklist="true"] > li'),
  )) {
    if (li.dataset.checked === undefined) continue;
    let box = li.firstChild as HTMLElement | null;
    if (!box || !isBox(box)) {
      box = doc.createElement('span');
      box.className = 'rt-box';
      box.setAttribute('contenteditable', 'false');
      box.setAttribute('role', 'checkbox');
      box.setAttribute('aria-label', 'Done');
      li.insertBefore(box, li.firstChild);
    }
    box.setAttribute('aria-checked', li.dataset.checked === 'true' ? 'true' : 'false');
  }
}

function isTicked(li: HTMLElement): boolean {
  if (li.dataset.checked !== undefined) return li.dataset.checked === 'true';
  const box = li.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]');
  if (box) return box.checked || box.hasAttribute('checked');
  return li.getAttribute('aria-checked') === 'true';
}

// ------------------------------------------------------------ the page, written

/** A note's tree as the page shows it while it is written. */
export function drawNote(tree: NoteTree, doc: Document): DocumentFragment {
  const out = doc.createDocumentFragment();
  const inline = (parent: Node, nodes: NoteInline[]) => {
    for (const n of nodes) {
      switch (n.type) {
        case 'text':
          parent.appendChild(doc.createTextNode(n.text));
          break;
        case 'break':
          parent.appendChild(doc.createElement('br'));
          break;
        case 'link': {
          const a = doc.createElement('a');
          a.setAttribute('href', n.href);
          inline(a, n.children.length > 0 ? n.children : [{ type: 'text', text: n.href }]);
          parent.appendChild(a);
          break;
        }
        default: {
          const tag = { strong: 'strong', em: 'em', underline: 'u', strike: 's' }[n.type];
          const el = doc.createElement(tag);
          inline(el, n.children);
          parent.appendChild(el);
        }
      }
    }
  };
  for (const b of tree.blocks) {
    if (b.type === 'list') {
      const list = doc.createElement(b.ordered ? 'ol' : 'ul');
      if (b.ordered && b.start !== 1) list.setAttribute('start', String(b.start));
      const checklist = !b.ordered && b.items.some((i) => i.checked !== null);
      if (checklist) list.dataset.checklist = 'true';
      for (const item of b.items) {
        const li = doc.createElement('li');
        if (checklist && item.checked !== null)
          li.dataset.checked = item.checked ? 'true' : 'false';
        inline(li, item.children);
        if (item.children.length === 0) li.appendChild(doc.createElement('br'));
        list.appendChild(li);
      }
      out.appendChild(list);
      continue;
    }
    const el = doc.createElement(
      b.type === 'heading' ? `h${b.level}` : b.type === 'quote' ? 'blockquote' : 'p',
    );
    inline(el, b.children);
    out.appendChild(el);
  }
  if (tree.blocks.length === 0) {
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    out.appendChild(p);
  }
  const holder = doc.createElement('div');
  holder.appendChild(out);
  syncBoxes(holder);
  const drawn = doc.createDocumentFragment();
  while (holder.firstChild) drawn.appendChild(holder.firstChild);
  return drawn;
}

/** A page pasted, read into a note's tree, in a document that runs and loads nothing. */
export function readPasted(html: string): NoteTree {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return readNote(parsed.body, { pasted: true });
}

// ------------------------------------------------------------ what the caret is in

export type HeadingLevel = 0 | 1 | 2 | 3;

export interface Formats {
  strong: boolean;
  em: boolean;
  underline: boolean;
  strike: boolean;
  heading: HeadingLevel;
  list: 'bulleted' | 'numbered' | 'checklist' | null;
  quote: boolean;
  link: boolean;
}

export const NO_FORMATS: Formats = {
  strong: false,
  em: false,
  underline: false,
  strike: false,
  heading: 0,
  list: null,
  quote: false,
  link: false,
};

/** What the words at `node` are, up to the editor's own edge. */
export function formatsAt(node: Node | null, root: HTMLElement): Formats {
  const f: Formats = { ...NO_FORMATS };
  const seen = { strong: false, em: false, underline: false, strike: false };
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const el = n as HTMLElement;
    const { add, drop } = marksOf(el);
    // The nearest says: bold inside "not bold" is bold.
    for (const m of drop) seen[m] = true;
    for (const m of add) {
      if (!seen[m]) f[m] = true;
      seen[m] = true;
    }
    const heading = /^H([1-6])$/.exec(el.tagName);
    if (heading && f.heading === 0) f.heading = Math.min(Number(heading[1]), 3) as HeadingLevel;
    if (el.tagName === 'BLOCKQUOTE') f.quote = true;
    if (el.tagName === 'A') f.link = true;
    if (f.list === null && (el.tagName === 'UL' || el.tagName === 'OL')) {
      f.list = el.tagName === 'OL' ? 'numbered' : isChecklist(el) ? 'checklist' : 'bulleted';
    }
  }
  return f;
}

// ------------------------------------------------------------ the editor

/** What a toolbar button does. */
export type Command =
  | 'strong'
  | 'em'
  | 'underline'
  | 'strike'
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulleted'
  | 'numbered'
  | 'checklist'
  | 'quote'
  | 'link'
  | 'clear';

/** True on a Mac or an iPad: shortcuts are said with ⌘. */
const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

interface Shortcut {
  key: string;
  shift?: boolean;
  alt?: boolean;
}

const SHORTCUTS: Partial<Record<Command, Shortcut>> = {
  strong: { key: 'b' },
  em: { key: 'i' },
  underline: { key: 'u' },
  strike: { key: 'x', shift: true },
  // Never Ctrl+Alt: on Windows that is AltGr, which types @, # and } on
  // many keyboards (the N1 review).
  paragraph: { key: '0', shift: true },
  heading1: { key: '1', shift: true },
  heading2: { key: '2', shift: true },
  heading3: { key: '3', shift: true },
  numbered: { key: '7', shift: true },
  bulleted: { key: '8', shift: true },
  checklist: { key: '9', shift: true },
  quote: { key: '.', shift: true },
  link: { key: 'k' },
  clear: { key: '\\' },
};

/** "Ctrl+B", or "⌘B" on a Mac: as the tooltip says it. */
function shortcutWords(s: Shortcut): string {
  const key = s.key === '.' ? '.' : s.key.toUpperCase();
  if (isMac()) return `${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${s.alt ? 'Alt+' : ''}${s.shift ? 'Shift+' : ''}${key}`;
}

/** As aria-keyshortcuts says it. */
function shortcutAria(s: Shortcut): string {
  const key = s.key === '.' ? 'Period' : s.key === '\\' ? 'Backslash' : s.key.toUpperCase();
  return `${isMac() ? 'Meta' : 'Control'}+${s.alt ? 'Alt+' : ''}${s.shift ? 'Shift+' : ''}${key}`;
}

/** The command a key pressed in the editor asks for, or none. */
export function commandFor(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  getModifierState?(key: 'AltGraph'): boolean;
}): Command | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  // AltGr (Ctrl and Alt, on Windows) types a character: never a command.
  if (e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey)) return null;
  // Shift turns 7 into & and . into >: the key's own place says which.
  const fromCode = e.code
    ? (/^Digit(\d)$/.exec(e.code)?.[1] ??
      (e.code === 'Period'
        ? '.'
        : e.code === 'Backslash'
          ? '\\'
          : /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase()))
    : undefined;
  const key = (fromCode ?? e.key).toLowerCase();
  for (const [command, s] of Object.entries(SHORTCUTS) as Array<[Command, Shortcut]>) {
    if (s.key === key && Boolean(s.shift) === e.shiftKey && Boolean(s.alt) === e.altKey) {
      return command;
    }
  }
  return null;
}

// ------------------------------------------------------------ lists and quotes

/**
 * A list or a quote is made here, not by the browser's own command:
 * Chromium puts a list inside the paragraph it was asked of, and leaves the
 * caret before its words. Here every block the choice touches — a
 * paragraph, a heading, a quote, a list — becomes one list of the kind
 * asked for, or one quote; asked again of what already is one, each of its
 * lines goes back to a paragraph. The caret stays in the words it was in.
 */
const isListEl = (n: Element | null): boolean => !!n && /^(UL|OL)$/.test(n.tagName);

type ListKind = 'bulleted' | 'numbered' | 'checklist';

function listKind(el: HTMLElement): ListKind {
  return el.tagName === 'OL' ? 'numbered' : isChecklist(el) ? 'checklist' : 'bulleted';
}

/** Words at the top of the editor, outside any block: put in a paragraph of their own. */
function wrapLoose(root: HTMLElement): void {
  const doc = root.ownerDocument;
  let p: HTMLElement | null = null;
  for (const c of Array.from(root.childNodes)) {
    const block = c.nodeType === Node.ELEMENT_NODE && BLOCKS.has((c as HTMLElement).tagName);
    if (block) {
      p = null;
      continue;
    }
    if (c.nodeType === Node.TEXT_NODE && (c.textContent ?? '') === '') continue;
    if (!p) {
      p = doc.createElement('p');
      root.insertBefore(p, c);
    }
    p.appendChild(c);
  }
}

/** The editor's own child that holds `node`. */
function topOf(root: HTMLElement, node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n && n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : null;
}

/** The item of `list` that holds `node`. */
function itemOf(list: HTMLElement, node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n && n.parentNode !== list) n = n.parentNode;
  return n && n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : null;
}

/**
 * A list split round the items from `from` to `to`: those before and those
 * after stay lists of their own, as they were; the list answered holds
 * only the items chosen.
 */
function splitList(
  list: HTMLElement,
  from: HTMLElement | null,
  to: HTMLElement | null,
): HTMLElement {
  const items = Array.from(list.children) as HTMLElement[];
  const a = from ? items.indexOf(from) : 0;
  const b = to ? items.indexOf(to) : items.length - 1;
  if (a < 0 || b < 0 || (a === 0 && b === items.length - 1)) return list;
  const copy = () => {
    const l = list.cloneNode(false) as HTMLElement;
    return l;
  };
  const middle = copy();
  for (const li of items.slice(a, b + 1)) middle.appendChild(li);
  const after = items.slice(b + 1);
  list.after(middle);
  if (after.length > 0) {
    const rest = copy();
    for (const li of after) rest.appendChild(li);
    // A numbered list goes on counting where it was.
    if (rest.tagName === 'OL') rest.setAttribute('start', String(b + 2));
    middle.after(rest);
  }
  if (list.children.length === 0) list.remove();
  return middle;
}

/** The editor's blocks a choice touches, first to last: of a list, only the items it touches. */
export function blocksTouched(root: HTMLElement, range: Range): HTMLElement[] {
  // Where the choice begins and ends, before anything moves.
  const from = range.startContainer;
  const to = range.endContainer;
  wrapLoose(root);
  let first = topOf(root, from) ?? (root.firstElementChild as HTMLElement | null);
  let last = topOf(root, to) ?? first;
  if (!first || !last) return [];
  if (first === last && isListEl(first))
    return [splitList(first, itemOf(first, from), itemOf(first, to))];
  // Each list's items first, so the second split finds its own.
  const lastItem = isListEl(last) ? itemOf(last, to) : null;
  if (isListEl(first)) first = splitList(first, itemOf(first, from), null);
  if (isListEl(last)) last = splitList(last, null, lastItem);
  const out: HTMLElement[] = [];
  for (let n: Element | null = first; n; n = n.nextElementSibling) {
    out.push(n as HTMLElement);
    if (n === last) break;
  }
  return out;
}

/** Each line a block holds, as the nodes to move: a list's items, a quote's lines, a paragraph. */
function linesOf(block: HTMLElement): Node[][] {
  if (isListEl(block)) {
    return Array.from(block.children)
      .filter((li) => li.tagName === 'LI')
      .map((li) => Array.from(li.childNodes).filter((n) => !isBox(n)));
  }
  const lines: Node[][] = [[]];
  for (const c of Array.from(block.childNodes)) {
    // A block's lines are its line breaks' — and a quote's, its paragraphs.
    if (c.nodeType === Node.ELEMENT_NODE) {
      const el = c as HTMLElement;
      if (el.tagName === 'BR') {
        lines.push([]);
        continue;
      }
      if (BLOCKS.has(el.tagName)) {
        lines.push(Array.from(el.childNodes), []);
        continue;
      }
    }
    if (!isBox(c)) (lines[lines.length - 1] as Node[]).push(c);
  }
  return lines.filter((l, i) => l.length > 0 || i === 0);
}

/** A place in the words, pinned to what moves with them: a word's text, or a line break. */
type Pin = { node: Node; offset: number } | { before: Node };

function firstText(n: Node): Text | null {
  if (n.nodeType === Node.TEXT_NODE) return n as Text;
  for (const c of Array.from(n.childNodes)) {
    const t = firstText(c);
    if (t) return t;
  }
  return null;
}

function lastText(n: Node): Text | null {
  if (n.nodeType === Node.TEXT_NODE) return n as Text;
  const kids = Array.from(n.childNodes);
  for (let i = kids.length - 1; i >= 0; i--) {
    const t = lastText(kids[i] as Node);
    if (t) return t;
  }
  return null;
}

function pin(node: Node, offset: number): Pin {
  if (node.nodeType === Node.TEXT_NODE) return { node, offset };
  const at = node.childNodes[offset];
  if (at) {
    const t = firstText(at);
    if (t) return { node: t, offset: 0 };
    return { before: at };
  }
  const prev = node.childNodes[offset - 1];
  if (prev) {
    const t = lastText(prev);
    if (t) return { node: t, offset: t.length };
  }
  return { node, offset };
}

function place(range: Range, p: Pin, start: boolean): boolean {
  const node = 'before' in p ? p.before : p.node;
  if (!node.isConnected) return false;
  if ('before' in p) {
    if (start) range.setStartBefore(p.before);
    else range.setEndBefore(p.before);
  } else if (start) range.setStart(p.node, p.offset);
  else range.setEnd(p.node, p.offset);
  return true;
}

/**
 * The caret, pinned to the words it is in before anything moves, to be put
 * back once they have: a word's text, or a line break, moves with its words.
 */
function holdCaret(root: HTMLElement, r: Range): () => void {
  const sel = root.ownerDocument.getSelection();
  const at = pin(r.startContainer, r.startOffset);
  const to = pin(r.endContainer, r.endOffset);
  return () => {
    const range = root.ownerDocument.createRange();
    try {
      if (!place(range, at, true)) return;
      if (!place(range, to, false)) range.collapse(true);
    } catch {
      return;
    }
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
}

/** The blocks touched made one list of `kind`, or — all of that kind already — paragraphs again. */
export function toggleList(root: HTMLElement, range: Range, kind: ListKind): void {
  const back = holdCaret(root, range);
  const blocks = blocksTouched(root, range);
  if (blocks.length === 0) return;
  const doc = root.ownerDocument;
  const off = blocks.every((b) => isListEl(b) && listKind(b) === kind);
  if (off) {
    for (const b of blocks) {
      for (const line of linesOf(b)) {
        const p = doc.createElement('p');
        for (const n of line) p.appendChild(n);
        if (!p.firstChild) p.appendChild(doc.createElement('br'));
        root.insertBefore(p, b);
      }
      b.remove();
    }
  } else {
    const list = doc.createElement(kind === 'numbered' ? 'ol' : 'ul');
    if (kind === 'checklist') list.dataset.checklist = 'true';
    root.insertBefore(list, blocks[0] as HTMLElement);
    for (const b of blocks) {
      const ticks = isListEl(b) && isChecklist(b) ? Array.from(b.children) : [];
      linesOf(b).forEach((line, i) => {
        const li = doc.createElement('li');
        for (const n of line) li.appendChild(n);
        if (!li.firstChild) li.appendChild(doc.createElement('br'));
        if (kind === 'checklist') {
          li.dataset.checked =
            (ticks[i] as HTMLElement | undefined)?.dataset.checked === 'true' ? 'true' : 'false';
        }
        list.appendChild(li);
      });
      b.remove();
    }
  }
  syncBoxes(root);
  back();
}

/** The blocks touched made one quote, a line each — or, all quotes already, paragraphs again. */
export function toggleQuote(root: HTMLElement, range: Range): void {
  const back = holdCaret(root, range);
  const blocks = blocksTouched(root, range);
  if (blocks.length === 0) return;
  const doc = root.ownerDocument;
  if (blocks.every((b) => b.tagName === 'BLOCKQUOTE')) {
    for (const b of blocks) {
      for (const line of linesOf(b)) {
        const p = doc.createElement('p');
        for (const n of line) p.appendChild(n);
        if (!p.firstChild) p.appendChild(doc.createElement('br'));
        root.insertBefore(p, b);
      }
      b.remove();
    }
  } else {
    const quote = doc.createElement('blockquote');
    root.insertBefore(quote, blocks[0] as HTMLElement);
    for (const b of blocks) {
      for (const line of linesOf(b)) {
        if (quote.firstChild) quote.appendChild(doc.createElement('br'));
        for (const n of line) quote.appendChild(n);
      }
      b.remove();
    }
    if (!quote.firstChild) quote.appendChild(doc.createElement('br'));
  }
  back();
}

interface Tool {
  command: Command;
  label: string;
  icon: ReactNode;
  /** A toggle, pressed as the caret's words are. */
  pressed?: (f: Formats) => boolean;
}

const svg = (body: ReactNode) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 20 20"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {body}
  </svg>
);

const ICONS: Record<
  Exclude<Command, 'paragraph' | 'heading1' | 'heading2' | 'heading3'>,
  ReactNode
> = {
  strong: svg(<path d="M6 4h5a3 3 0 0 1 0 6H6zM6 10h6a3 3 0 0 1 0 6H6z" strokeWidth="2.1" />),
  em: svg(<path d="M12 4H8.5M11.5 16H8M11 4 9 16" />),
  underline: svg(<path d="M6 4v5a4 4 0 0 0 8 0V4M5 17h10" />),
  strike: svg(
    <>
      <path d="M4 10h12" />
      <path d="M13.5 6.2C13 5 11.8 4.2 10 4.2c-2 0-3.5 1-3.5 2.6 0 .9.4 1.6 1.2 2.1M7 13.8c.5 1.2 1.7 2 3.4 2 2.2 0 3.6-1.1 3.6-2.7 0-.6-.2-1.1-.5-1.6" />
    </>,
  ),
  bulleted: svg(
    <>
      <circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="14" r="1" fill="currentColor" stroke="none" />
      <path d="M8 6h8M8 10h8M8 14h8" />
    </>,
  ),
  numbered: svg(
    <>
      <path
        d="M3.5 4.5h1.2v3.2M3.4 7.7h2.4M3.5 12.2c.3-.6 2.3-.8 2.1.5-.1.7-2.1 1.4-2.1 2.3h2.3"
        strokeWidth="1.3"
      />
      <path d="M9 6h7.5M9 10h7.5M9 14h7.5" />
    </>,
  ),
  checklist: svg(
    <>
      <rect x="3" y="4" width="4" height="4" rx="1" />
      <path d="m3.6 13.4 1.2 1.2 2.4-2.6" />
      <path d="M10 6h6.5M10 13.5h6.5" />
    </>,
  ),
  quote: svg(
    <>
      <path d="M4 5v10" strokeWidth="2.2" />
      <path d="M8 7h8M8 10h8M8 13h5" />
    </>,
  ),
  link: svg(
    <>
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9" />
      <path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9" />
    </>,
  ),
  clear: svg(
    <>
      <path d="M7 4h9M11.5 4 9 12" />
      <path d="m4 16 8-8M4 8l8 8" strokeWidth="1.5" />
    </>,
  ),
};

/** The toolbar's groups, in order, a separator between each. */
const GROUPS: Tool[][] = [
  [
    { command: 'strong', label: 'Bold', icon: ICONS.strong, pressed: (f) => f.strong },
    { command: 'em', label: 'Italic', icon: ICONS.em, pressed: (f) => f.em },
    {
      command: 'underline',
      label: 'Underline',
      icon: ICONS.underline,
      pressed: (f) => f.underline,
    },
    { command: 'strike', label: 'Strikethrough', icon: ICONS.strike, pressed: (f) => f.strike },
  ],
  [
    {
      command: 'bulleted',
      label: 'Bulleted list',
      icon: ICONS.bulleted,
      pressed: (f) => f.list === 'bulleted',
    },
    {
      command: 'numbered',
      label: 'Numbered list',
      icon: ICONS.numbered,
      pressed: (f) => f.list === 'numbered',
    },
    {
      command: 'checklist',
      label: 'Checklist',
      icon: ICONS.checklist,
      pressed: (f) => f.list === 'checklist',
    },
  ],
  [
    { command: 'link', label: 'Link', icon: ICONS.link, pressed: (f) => f.link },
    { command: 'quote', label: 'Quote', icon: ICONS.quote, pressed: (f) => f.quote },
  ],
  [{ command: 'clear', label: 'Clear formatting', icon: ICONS.clear }],
];

interface TextStyle {
  level: HeadingLevel;
  command: Command;
  label: string;
  short: string;
}

const NORMAL: TextStyle = { level: 0, command: 'paragraph', label: 'Normal text', short: 'Normal' };

const STYLES: TextStyle[] = [
  NORMAL,
  { level: 1, command: 'heading1', label: 'Heading 1', short: 'Heading 1' },
  { level: 2, command: 'heading2', label: 'Heading 2', short: 'Heading 2' },
  { level: 3, command: 'heading3', label: 'Heading 3', short: 'Heading 3' },
];

/** What a parent may ask of the editor. */
export interface RichTextHandle {
  focus(): void;
  /** The note as it is written now. */
  markdown(): string;
}

/**
 * The note editor: a toolbar, and the words. `initial` is the note it
 * begins from; `onChange` is told the note, as the vault would keep it,
 * after every change the person makes (and not before: an editor opened
 * and closed changes nothing).
 */
export function RichTextEditor(props: {
  /** The words' name, as a screen reader says it ("Notes", "Note"). */
  label: string;
  initial: string;
  onChange: (markdown: string) => void;
  describedBy?: string;
  autoFocus?: boolean;
  handle?: Ref<RichTextHandle>;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [formats, setFormats] = useState<Formats>(NO_FORMATS);
  // The toolbar's one stop: the button it was last on.
  const [active, setActive] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [linking, setLinking] = useState<{ href: string; existing: boolean } | null>(null);
  const { onChange } = props;
  const initial = useRef(props.initial);

  // The note, drawn once: from then on the page is the person's.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    el.replaceChildren(drawNote(parseNotes(initial.current), el.ownerDocument));
    if (props.autoFocus) {
      el.focus();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = el.ownerDocument.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    // Only as it is first drawn.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const markdown = useCallback(() => {
    const el = root.current;
    return el ? noteTreeToMarkdown(readNote(el)) : initial.current;
  }, []);

  useImperativeHandle(props.handle, () => ({
    focus: () => root.current?.focus(),
    markdown,
  }));

  const told = useCallback(() => onChange(markdown()), [markdown, onChange]);

  /** What the caret's words are, said by the toolbar. */
  const look = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const sel = el.ownerDocument.getSelection();
    const at = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (!at || !el.contains(at.startContainer)) return;
    saved.current = at.cloneRange();
    setFormats(formatsAt(at.startContainer, el));
  }, []);

  useEffect(() => {
    const doc = root.current?.ownerDocument;
    if (!doc) return;
    doc.addEventListener('selectionchange', look);
    return () => doc.removeEventListener('selectionchange', look);
  }, [look]);

  /**
   * The words again, the caret where it was: before a command runs. Typed
   * in the words (a shortcut), the caret is where it is now; from the
   * toolbar or the link's field, where it was when the words lost the focus.
   */
  const backInto = () => {
    const el = root.current;
    if (!el) return null;
    const doc = el.ownerDocument;
    const sel = doc.getSelection();
    if (doc.activeElement === el) {
      const at = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (at && el.contains(at.startContainer)) saved.current = at.cloneRange();
      return el;
    }
    const range = saved.current;
    el.focus();
    if (sel && range && el.contains(range.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return el;
  };

  const exec = (name: string, value?: string) => {
    const doc = root.current?.ownerDocument;
    // jsdom has none: the command is nobody's to run there.
    if (typeof doc?.execCommand === 'function') doc.execCommand(name, false, value);
  };

  /** Where the caret is, or what is chosen, in the words. */
  const here = (): Range => {
    const el = root.current as HTMLElement;
    const sel = el.ownerDocument.getSelection();
    const at = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (at && el.contains(at.startContainer)) return at;
    const r = el.ownerDocument.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    return r;
  };

  const run = (command: Command) => {
    const el = backInto();
    if (!el) return;
    const f = formatsAt(el.ownerDocument.getSelection()?.anchorNode ?? null, el);
    exec('styleWithCSS', 'false');
    switch (command) {
      case 'strong':
        exec('bold');
        break;
      case 'em':
        exec('italic');
        break;
      case 'underline':
        exec('underline');
        break;
      case 'strike':
        exec('strikeThrough');
        break;
      case 'paragraph':
        if (f.quote) toggleQuote(el, here());
        else exec('formatBlock', 'p');
        break;
      case 'heading1':
      case 'heading2':
      case 'heading3': {
        const level = Number(command.slice(-1)) as HeadingLevel;
        if (f.quote) toggleQuote(el, here());
        exec('formatBlock', f.heading === level ? 'p' : `h${level}`);
        break;
      }
      case 'bulleted':
      case 'numbered':
      case 'checklist':
        toggleList(el, here(), command);
        break;
      case 'quote':
        toggleQuote(el, here());
        break;
      case 'clear':
        exec('removeFormat');
        exec('unlink');
        if (f.quote) toggleQuote(el, here());
        if (f.heading) exec('formatBlock', 'p');
        break;
      case 'link': {
        const anchor = anchorAt();
        setLinking({ href: anchor?.getAttribute('href') ?? '', existing: anchor !== null });
        return;
      }
    }
    syncBoxes(el);
    told();
    look();
  };

  /** The link the caret is in, if any. */
  const anchorAt = (): HTMLAnchorElement | null => {
    const el = root.current;
    let n: Node | null = saved.current?.startContainer ?? null;
    for (; n && n !== el; n = n.parentNode) {
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === 'A') {
        return n as HTMLAnchorElement;
      }
    }
    return null;
  };

  const applyLink = (href: string | null) => {
    const el = backInto();
    setLinking(null);
    if (!el) return;
    const anchor = anchorAt();
    if (href === null) {
      // Taken off: the link's words stay.
      if (anchor) {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(anchor);
        const sel = el.ownerDocument.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        exec('unlink');
        if (anchor.isConnected) anchor.replaceWith(...Array.from(anchor.childNodes));
      }
    } else if (anchor) {
      anchor.setAttribute('href', href);
    } else {
      const sel = el.ownerDocument.getSelection();
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (range && !range.collapsed) {
        exec('createLink', href);
      } else if (range) {
        // Nothing chosen: the address is its own words.
        const a = el.ownerDocument.createElement('a');
        a.setAttribute('href', href);
        a.textContent = href;
        range.insertNode(a);
        range.setStartAfter(a);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
    told();
    look();
  };

  /** The quote the caret is in, if it is a quote's own empty line. */
  const emptyQuoteAt = (): HTMLElement | null => {
    const el = root.current;
    const sel = el?.ownerDocument.getSelection();
    let n: Node | null = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
    for (; n && n !== el; n = n.parentNode) {
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === 'BLOCKQUOTE') {
        return ((n as HTMLElement).textContent ?? '').trim() === '' ? (n as HTMLElement) : null;
      }
    }
    return null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Enter on a quote's empty line: out of the quote, onto a paragraph.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const quote = emptyQuoteAt();
      if (quote) {
        e.preventDefault();
        const doc = quote.ownerDocument;
        const p = doc.createElement('p');
        p.appendChild(doc.createElement('br'));
        quote.replaceWith(p);
        const range = doc.createRange();
        range.setStart(p, 0);
        range.collapse(true);
        const sel = doc.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        told();
        look();
        return;
      }
    }
    // Ctrl+Enter ticks a checklist's item, or takes its tick off.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const li = itemAt();
      if (li) {
        e.preventDefault();
        li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true';
        if (root.current) syncBoxes(root.current);
        told();
      }
      return;
    }
    const command = commandFor(e);
    if (!command) return;
    e.preventDefault();
    run(command);
  };

  /** The checklist item the caret is in, if any. */
  const itemAt = (): HTMLElement | null => {
    const el = root.current;
    const sel = el?.ownerDocument.getSelection();
    let n: Node | null = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
    for (; n && n !== el; n = n.parentNode) {
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === 'LI') {
        const li = n as HTMLElement;
        return li.parentElement?.dataset.checklist === 'true' && li.dataset.checked !== undefined
          ? li
          : null;
      }
    }
    return null;
  };

  const onInput = (e: FormEvent<HTMLDivElement>) => {
    const el = root.current;
    if (!el) return;
    // A new item of a checklist begins not done, whatever the one before was.
    if ((e.nativeEvent as InputEvent).inputType === 'insertParagraph') {
      const li = itemAt();
      if (li && (li.textContent ?? '') === '') li.dataset.checked = 'false';
    }
    // Each to-do with its box, and nothing else with one.
    syncBoxes(el);
    told();
    look();
  };

  // A page pasted is read into a note first; only that is put in.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    putIn(html ? readPasted(html) : plainTree(text));
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const html = e.dataTransfer.getData('text/html');
    const text = e.dataTransfer.getData('text/plain');
    if (html || text) putIn(html ? readPasted(html) : plainTree(text));
  };

  const putIn = (tree: NoteTree) => {
    const el = backInto();
    if (!el) return;
    const doc = el.ownerDocument;
    const drawn = drawNote(tree, doc);
    // One paragraph's words go in where the caret is, not as a block.
    const only = drawn.childNodes.length === 1 ? (drawn.firstChild as HTMLElement) : null;
    const nodes =
      only && only.tagName === 'P' ? Array.from(only.childNodes) : Array.from(drawn.childNodes);
    const holder = doc.createElement('div');
    for (const n of nodes) holder.appendChild(n);
    if (typeof doc.execCommand === 'function' && doc.queryCommandSupported?.('insertHTML')) {
      // Built here, from the tree: nothing of what was pasted but its words.
      doc.execCommand('insertHTML', false, holder.innerHTML);
    } else {
      const sel = doc.getSelection();
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (range) {
        range.deleteContents();
        const frag = doc.createDocumentFragment();
        const last = holder.lastChild;
        while (holder.firstChild) frag.appendChild(holder.firstChild);
        range.insertNode(frag);
        if (last) {
          range.setStartAfter(last);
          range.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      } else {
        el.appendChild(holder);
      }
    }
    told();
    look();
  };

  // A click on a checklist's box ticks it.
  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const li = target.closest?.('li');
    if (!li || li.parentElement?.dataset.checklist !== 'true' || li.dataset.checked === undefined) {
      return;
    }
    if (!isBox(target) && e.clientX - li.getBoundingClientRect().left > 26) return;
    e.preventDefault();
    li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true';
    if (root.current) syncBoxes(root.current);
    told();
  };

  // ----------------------------------------------------------- the toolbar

  const buttons = () =>
    Array.from(toolbar.current?.querySelectorAll<HTMLButtonElement>('[data-tool]') ?? []);

  const onToolbarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[role="menu"]')) return;
    const all = buttons();
    const at = all.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    const go = (to: number) => {
      e.preventDefault();
      const n = (to + all.length) % all.length;
      setActive(n);
      all[n]?.focus();
    };
    if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
  };

  const style = STYLES.find((s) => s.level === formats.heading) ?? NORMAL;
  let index = 0;
  const tool = (t: Tool) => {
    const i = ++index;
    const s = SHORTCUTS[t.command];
    return (
      <button
        key={t.command}
        type="button"
        className="rt-tool"
        data-tool={t.command}
        tabIndex={active === i ? 0 : -1}
        aria-label={t.label}
        aria-pressed={t.pressed ? t.pressed(formats) : undefined}
        aria-keyshortcuts={s ? shortcutAria(s) : undefined}
        // The words keep their selection: the button never takes it.
        onMouseDown={(e) => e.preventDefault()}
        onFocus={() => setActive(i)}
        onClick={() => run(t.command)}
      >
        {t.icon}
        <span className="rt-tip" aria-hidden="true">
          {t.label}
          {s ? ` (${shortcutWords(s)})` : ''}
        </span>
      </button>
    );
  };

  return (
    <div className="rt">
      <div
        ref={toolbar}
        className="rt-toolbar"
        role="toolbar"
        aria-label="Formatting"
        aria-controls={`${id}-words`}
        onKeyDown={onToolbarKey}
      >
        <StyleMenu
          current={style}
          tabIndex={active === 0 ? 0 : -1}
          open={menuOpen}
          onOpen={setMenuOpen}
          onFocus={() => setActive(0)}
          onChoose={(c) => {
            setMenuOpen(false);
            run(c);
          }}
        />
        {GROUPS.map((group, g) => (
          <div key={g} className="rt-group">
            <span className="rt-sep" role="separator" aria-orientation="vertical" />
            {group.map(tool)}
          </div>
        ))}
      </div>
      {linking && (
        <LinkForm
          href={linking.href}
          existing={linking.existing}
          onApply={applyLink}
          onCancel={() => {
            setLinking(null);
            backInto();
          }}
        />
      )}
      <div
        id={`${id}-words`}
        ref={root}
        className="rt-words note"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={props.label}
        aria-describedby={props.describedBy}
        spellCheck
        tabIndex={0}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onKeyUp={look}
        onMouseUp={look}
        onMouseDown={onMouseDown}
        onPaste={onPaste}
        onDrop={onDrop}
        onFocus={() => {
          exec('defaultParagraphSeparator', 'p');
          look();
        }}
      />
    </div>
  );
}

/** Text with no page round it: its lines, as they were. */
function plainTree(text: string): NoteTree {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const children: NoteInline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) children.push({ type: 'break' });
    if (line) children.push({ type: 'text', text: line });
  });
  return tidyNoteTree({ blocks: [{ type: 'paragraph', blankBefore: 0, children }] });
}

/**
 * Normal text, or a heading: a button that opens a menu (aria-haspopup),
 * the kind of text the caret is in on its face.
 */
function StyleMenu(props: {
  current: TextStyle;
  tabIndex: number;
  open: boolean;
  onOpen: (open: boolean) => void;
  onFocus: () => void;
  onChoose: (command: Command) => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const { open, onOpen } = props;

  useEffect(() => {
    if (!open) return;
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
    );
    (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    const away = (e: Event) => {
      if (!menu.current?.contains(e.target as Node) && e.target !== button.current) onOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, onOpen]);

  const close = () => {
    onOpen(false);
    button.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      onOpen(false);
    }
  };

  return (
    <div className="rt-style">
      <button
        ref={button}
        type="button"
        className="rt-tool rt-style-button"
        data-tool="style"
        tabIndex={props.tabIndex}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-label={`Text style: ${props.current.label}`}
        onMouseDown={(e) => e.preventDefault()}
        onFocus={props.onFocus}
        onClick={() => onOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            onOpen(true);
          }
        }}
      >
        <span className="rt-style-name">{props.current.short}</span>
        {svg(<path d="m6 8 4 4 4-4" />)}
        <span className="rt-tip" aria-hidden="true">
          Text style ({shortcutWords(SHORTCUTS.paragraph as Shortcut)} to{' '}
          {shortcutWords(SHORTCUTS.heading3 as Shortcut)})
        </span>
      </button>
      {open && (
        <div
          ref={menu}
          id={`${id}-menu`}
          className="rt-menu"
          role="menu"
          aria-label="Text style"
          onKeyDown={onMenuKey}
        >
          {STYLES.map((option) => {
            const keys = SHORTCUTS[option.command];
            return (
              <div
                key={option.command}
                role="menuitemradio"
                aria-checked={option.level === props.current.level}
                tabIndex={-1}
                className={`rt-menu-item rt-menu-${option.command}`}
                aria-keyshortcuts={keys ? shortcutAria(keys) : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onChoose(option.command)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    props.onChoose(option.command);
                  }
                }}
              >
                {option.label}
                {keys && <span className="rt-menu-keys">{shortcutWords(keys)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A link's address: typed, checked as a note checks one (https, http or
 * mailto; "example.com" is taken as https, an email address as mailto),
 * and applied, changed or taken off.
 */
function LinkForm(props: {
  href: string;
  existing: boolean;
  onApply: (href: string | null) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(props.href);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => input.current?.focus(), []);

  const apply = () => {
    const raw = typed.trim();
    // Another kind of address (javascript:, data:, file:) is no link.
    const other = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^(https?:|mailto:)/i.test(raw);
    const withScheme = /^(https?:\/\/|mailto:)/i.test(raw)
      ? raw
      : /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(raw)
        ? `mailto:${raw}`
        : `https://${raw}`;
    // A bracket would end a note's address: written as the URL parser writes it.
    const encoded = withScheme.replace(/\(/g, '%28').replace(/\)/g, '%29');
    const href = raw && !other ? linkAddress(encoded) : null;
    if (!href) {
      setProblem('A link goes to a web address (https://…) or an email address.');
      input.current?.focus();
      return;
    }
    props.onApply(href);
  };

  return (
    <div className="rt-link" role="group" aria-label="Link">
      <label htmlFor={`${id}-href`} className="rt-link-label">
        Link to
      </label>
      <input
        id={`${id}-href`}
        ref={input}
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        className="rt-link-input"
        value={typed}
        placeholder="https://… or an email address"
        aria-invalid={problem !== null}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(e) => {
          setTyped(e.target.value);
          setProblem(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          }
        }}
      />
      <div className="rt-link-actions">
        <button type="button" className="btn btn-small" onClick={apply}>
          {props.existing ? 'Change link' : 'Add link'}
        </button>
        {props.existing && (
          <button
            type="button"
            className="btn btn-quiet btn-small"
            onClick={() => props.onApply(null)}
          >
            Remove link
          </button>
        )}
        <button type="button" className="btn btn-quiet btn-small" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {problem && (
        <p id={`${id}-problem`} className="field-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
