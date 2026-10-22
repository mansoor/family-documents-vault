import { describe, expect, it } from 'vitest';
import {
  noteLinkAllowed,
  notePreview,
  notesPlainText,
  noteTreeText,
  noteTreeToMarkdown,
  NOTES_MAX,
  parseNotes,
  tidyNoteTree,
  type NoteBlock,
  type NoteInline,
  type NoteTree,
} from './notes.js';

/**
 * The toolbar's format (0.9.0, N1): what a note may say grew by exactly
 * what the toolbar makes — three levels of heading, a quote, struck and
 * underlined words — and the editor writes a note from a tree through
 * tidyNoteTree and noteTreeToMarkdown, which always reads back as nothing
 * but what was written.
 */

function seeded(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)] as T;
  return { next, int, pick };
}

const text = (t: string): NoteInline => ({ type: 'text', text: t });
const para = (...children: NoteInline[]): NoteBlock => ({
  type: 'paragraph',
  blankBefore: 0,
  children,
});

/** Every node in a tree, of a type. */
function nodesOf(tree: NoteTree, type: NoteInline['type']): NoteInline[] {
  const found: NoteInline[] = [];
  const walk = (nodes: NoteInline[]) => {
    for (const n of nodes) {
      if (n.type === type) found.push(n);
      if ('children' in n) walk(n.children);
    }
  };
  for (const b of tree.blocks) {
    if (b.type === 'list') b.items.forEach((i) => walk(i.children));
    else walk(b.children);
  }
  return found;
}

describe('what the toolbar makes, read (0.9.0, N1)', () => {
  it('reads headings of three levels, a quote, struck and underlined words', () => {
    expect(
      parseNotes('# Boiler\n## Service\n### Who\n> Ring first\n> after 9\nCall ~~Bob~~ ++Ann++')
        .blocks,
    ).toEqual([
      { type: 'heading', blankBefore: 0, level: 1, children: [text('Boiler')] },
      { type: 'heading', blankBefore: 0, level: 2, children: [text('Service')] },
      { type: 'heading', blankBefore: 0, level: 3, children: [text('Who')] },
      {
        type: 'quote',
        blankBefore: 0,
        children: [text('Ring first'), { type: 'break' }, text('after 9')],
      },
      para(text('Call '), { type: 'strike', children: [text('Bob')] }, text(' '), {
        type: 'underline',
        children: [text('Ann')],
      }),
    ]);
  });

  it('what reads as words stays words: C++, a lone ~, ~~~, a fourth #, a quote mark with no space', () => {
    for (const note of [
      'C++ and D++ are languages',
      'about ~5 minutes, ~ or so',
      'a ~~~ b ~~~ c',
      'a +++ b +++ c',
      '#### Four',
      '>no space',
      'x ~~ y ~~ z',
    ]) {
      const tree = parseNotes(note);
      expect(nodesOf(tree, 'strike'), note).toEqual([]);
      expect(nodesOf(tree, 'underline'), note).toEqual([]);
      expect(
        tree.blocks.every((b) => b.type === 'paragraph'),
        note,
      ).toBe(true);
      expect(notesPlainText(note), note).toBe(note);
    }
  });

  it('a note written before 0.9.0 with a level-3 heading reads exactly as it did', () => {
    expect(parseNotes('### Bins\n**Blue** on *Mondays*').blocks[0]).toEqual({
      type: 'heading',
      blankBefore: 0,
      level: 3,
      children: [text('Bins')],
    });
  });

  it('no input produces anything outside the allowed elements, the new marks among them', () => {
    const pieces = [
      '~~',
      '~',
      '++',
      '+',
      '> ',
      '>',
      '# ',
      '## ',
      '### ',
      '#### ',
      '*',
      '**',
      '_',
      '[',
      '](',
      'https://a.example/x',
      'javascript:alert(1)',
      '<script>alert(1)</script>',
      '<style>p{}</style>',
      '- ',
      '- [ ] ',
      '1. ',
      '\n',
      ' ',
      'word',
      '\\',
    ];
    const allowedInline = new Set(['text', 'strong', 'em', 'strike', 'underline', 'link', 'break']);
    const rng = seeded(901);
    for (let n = 0; n < 4_000; n++) {
      let input = '';
      for (let k = 1 + rng.int(40); k > 0; k--) input += rng.pick(pieces);
      const tree = parseNotes(input);
      for (const b of tree.blocks) {
        expect(['paragraph', 'heading', 'quote', 'list']).toContain(b.type);
        if (b.type === 'heading') expect([1, 2, 3]).toContain(b.level);
      }
      const walk = (nodes: NoteInline[]) => {
        for (const x of nodes) {
          expect(allowedInline.has(x.type), input).toBe(true);
          if (x.type === 'link') expect(noteLinkAllowed(x.href), input).toBe(true);
          if ('children' in x) walk(x.children);
        }
      };
      for (const b of tree.blocks) {
        if (b.type === 'list') b.items.forEach((i) => walk(i.children));
        else walk(b.children);
      }
      expect(typeof noteTreeText(tree)).toBe('string');
    }
  });

  it('reads a long note of the new marks quickly: no input makes it backtrack', () => {
    const size = NOTES_MAX * 10;
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length));
    for (const [what, input] of Object.entries({
      'strikes never closed': fill('~~a '),
      'underlines never closed': fill('++a '),
      'tildes and pluses': fill('~+'),
      'quote lines': fill('> a\n'),
      'heading marks and spaces': fill('## '),
      'marks of every kind open': fill('*a _b ~~c ++d '),
    })) {
      const started = Date.now();
      const plain = noteTreeText(parseNotes(input));
      const took = Date.now() - started;
      expect(plain.length, what).toBeGreaterThan(0);
      expect(took, `${what}: ${took} ms`).toBeLessThan(2_000);
    }
  });
});

describe('a tree written out reads back the same (0.9.0, N1)', () => {
  const roundTrip = (tree: NoteTree) => parseNotes(noteTreeToMarkdown(tree));
  /** A tree as a reader compares it: tidied, blank lines aside. */
  const seen = (tree: NoteTree) =>
    JSON.parse(
      JSON.stringify(tidyNoteTree(tree).blocks.map((b) => ({ ...b, blankBefore: 0 }))),
    ) as unknown;

  it('every kind of block and mark', () => {
    const tree: NoteTree = {
      blocks: [
        { type: 'heading', blankBefore: 0, level: 1, children: [text('Where things are')] },
        para(
          text('The '),
          { type: 'strong', children: [text('stopcock')] },
          text(' is '),
          { type: 'em', children: [text('under')] },
          text(' the '),
          { type: 'underline', children: [text('sink')] },
          text(', not '),
          { type: 'strike', children: [text('the garage')] },
          text('.'),
          { type: 'break' },
          text('See '),
          { type: 'link', href: 'https://water.example/help', children: [text('the guide')] },
        ),
        { type: 'heading', blankBefore: 0, level: 2, children: [text('Who to call')] },
        {
          type: 'list',
          blankBefore: 0,
          ordered: false,
          start: 1,
          items: [
            { marker: '-', checked: null, children: [text('Plumber: 0161 496 0000')] },
            { marker: '-', checked: null, children: [text('Electrician')] },
          ],
        },
        {
          type: 'list',
          blankBefore: 0,
          ordered: true,
          start: 1,
          items: [
            { marker: '1.', checked: null, children: [text('Turn it off')] },
            { marker: '2.', checked: null, children: [text('Open a tap')] },
          ],
        },
        {
          type: 'list',
          blankBefore: 0,
          ordered: false,
          start: 1,
          items: [
            { marker: '-', checked: true, children: [text('Spare key cut')] },
            { marker: '-', checked: false, children: [text('Tell Sara')] },
          ],
        },
        { type: 'quote', blankBefore: 0, children: [text('Never in the loft')] },
        { type: 'heading', blankBefore: 0, level: 3, children: [text('Last')] },
      ],
    };
    expect(seen(roundTrip(tree))).toEqual(seen(tree));
    expect(noteTreeToMarkdown(tree)).toContain('# Where things are');
    expect(noteTreeToMarkdown(tree)).toContain('++sink++');
    expect(noteTreeToMarkdown(tree)).toContain('~~the garage~~');
    expect(noteTreeToMarkdown(tree)).toContain('> Never in the loft');
  });

  it('words that look like marks stay words, with a backslash only where they must', () => {
    for (const words of [
      '5 * 3 = 15 and snake_case',
      'C++ and C# and ~5 mins',
      '**not bold** and _not italic_',
      '~~not struck~~ and ++not underlined++',
      '[not a link](see below)',
      'a\\*b\\ and C:\\Users\\Sara',
      '- not a list',
      '1. not numbered',
      '# not a heading',
      '> not a quote',
      '[x] not a box',
    ]) {
      const tree: NoteTree = { blocks: [para(text(words))] };
      const back = roundTrip(tree);
      expect(back.blocks, words).toEqual([para(text(words))]);
    }
    // An address written out reads as a link, as it always has (5.35):
    // the editor keeps it one, and writes it out as it was typed.
    const address: NoteTree = { blocks: [para(text('See https://x.example/a. Then'))] };
    expect(roundTrip(address).blocks).toEqual(tidyNoteTree(address).blocks);
    expect(tidyNoteTree(address).blocks[0]).toEqual(
      para(
        text('See '),
        { type: 'link', href: 'https://x.example/a', children: [] },
        text('. Then'),
      ),
    );
    expect(noteTreeToMarkdown(address)).toBe('See https://x.example/a. Then');
    // Plain words are written as they are.
    expect(noteTreeToMarkdown({ blocks: [para(text('5 * 3 = 15 and snake_case'))] })).toBe(
      '5 * 3 = 15 and snake_case',
    );
    // A line inside a paragraph that would begin a list is not one.
    const lines: NoteTree = { blocks: [para(text('Milk'), { type: 'break' }, text('- eggs'))] };
    expect(roundTrip(lines).blocks).toEqual(lines.blocks);
    // An item's words that would read as a box are not one.
    const item: NoteTree = {
      blocks: [
        {
          type: 'list',
          blankBefore: 0,
          ordered: false,
          start: 1,
          items: [{ marker: '-', checked: null, children: [text('[x] really')] }],
        },
      ],
    };
    expect(seen(roundTrip(item))).toEqual(seen(item));
  });

  it('tidies what an editor makes: spaces outside marks, a mark split at a line break, marks inside the same mark', () => {
    const tidy = tidyNoteTree({
      blocks: [
        para(
          { type: 'strong', children: [text(' a ')] },
          { type: 'strong', children: [text('b')] },
          { type: 'em', children: [text('c'), { type: 'break' }, text('d')] },
          { type: 'strong', children: [{ type: 'strong', children: [text('e')] }] },
          { type: 'strong', children: [{ type: 'em', children: [text('f')] }] },
        ),
        para(text('x'), { type: 'break' }, { type: 'break' }, text('y')),
        {
          type: 'heading',
          blankBefore: 0,
          level: 2,
          children: [text('one'), { type: 'break' }, text('line')],
        },
        para(text('   ')),
        para({ type: 'link', href: 'javascript:alert(1)', children: [text('bad')] }),
        para({ type: 'link', href: 'https://a.example', children: [text('[x]')] }),
      ],
    });
    expect(tidy.blocks).toEqual([
      para(
        text(' '),
        { type: 'strong', children: [text('a')] },
        text(' '),
        { type: 'strong', children: [text('b')] },
        { type: 'em', children: [text('c')] },
        { type: 'break' },
        { type: 'em', children: [text('d')] },
        { type: 'strong', children: [text('e')] },
        { type: 'em', children: [{ type: 'strong', children: [text('f')] }] },
      ),
      para(text('x')),
      para(text('y')),
      { type: 'heading', blankBefore: 0, level: 2, children: [text('one line')] },
      para(text('bad')),
      para({ type: 'link', href: 'https://a.example', children: [text('(x)')] }),
    ]);
  });

  it('any tree an editor could make reads back as the same words, and as the same marks when words part them', () => {
    const words = [
      'passport',
      'Sara',
      '4471',
      'café',
      'a*b',
      'x_y',
      'C++',
      '~5',
      '[1]',
      'a\\b',
      '#2',
    ];
    const rng = seeded(2026);
    const inline = (depth: number, spaced: boolean): NoteInline[] => {
      const out: NoteInline[] = [];
      for (let k = 1 + rng.int(4); k > 0; k--) {
        const r = rng.int(10);
        if (depth > 0 && r < 4) {
          const type = rng.pick(['strong', 'em', 'strike', 'underline'] as const);
          out.push({ type, children: inline(depth - 1, spaced) });
        } else if (depth > 0 && r === 4) {
          out.push({
            type: 'link',
            href: 'https://ex.example/p',
            children: [text(rng.pick(words))],
          });
        } else if (r === 5 && out.length > 0) {
          out.push({ type: 'break' });
          out.push(text(rng.pick(words)));
        } else {
          out.push(text(rng.pick(words)));
        }
        if (spaced) out.push(text(' '));
      }
      return out;
    };
    const block = (spaced: boolean): NoteBlock => {
      const r = rng.int(5);
      if (r === 0) {
        return {
          type: 'heading',
          blankBefore: 0,
          level: (1 + rng.int(3)) as 1 | 2 | 3,
          children: inline(2, spaced),
        };
      }
      if (r === 1) return { type: 'quote', blankBefore: 0, children: inline(2, spaced) };
      if (r === 2) {
        const ordered = rng.int(2) === 0;
        const check = !ordered && rng.int(2) === 0;
        return {
          type: 'list',
          blankBefore: 0,
          ordered,
          start: 1,
          items: Array.from({ length: 1 + rng.int(3) }, () => ({
            marker: ordered ? '1.' : '-',
            checked: check ? rng.int(2) === 0 : null,
            children: inline(2, spaced),
          })),
        };
      }
      return para(...inline(3, spaced));
    };
    for (let n = 0; n < 1_500; n++) {
      const spaced = n % 2 === 0;
      const tree: NoteTree = {
        blocks: Array.from({ length: 1 + rng.int(4) }, () => block(spaced)),
      };
      const md = noteTreeToMarkdown(tree);
      const back = parseNotes(md);
      // Never a word lost or added: the plain text is the same.
      expect(noteTreeText({ blocks: seenBlocks(tidyNoteTree(back)) }), md).toBe(
        noteTreeText({ blocks: seenBlocks(tidyNoteTree(tree)) }),
      );
      // Written again, it settles: what it reads back as is written the same.
      const again = noteTreeToMarkdown(back);
      expect(noteTreeToMarkdown(parseNotes(again)), md).toBe(again);
      // With words between the marks, every mark too.
      if (spaced) expect(seen(back), md).toEqual(seen(tree));
    }
  });

  it('writes a note as long as a vault keeps quickly', () => {
    const tree: NoteTree = {
      blocks: Array.from({ length: 400 }, (_, i) =>
        para({ type: 'strong', children: [text(`line ${i} *`)] }, text(' and ~~ more')),
      ),
    };
    const started = Date.now();
    for (let n = 0; n < 10; n++) noteTreeToMarkdown(tree);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/** Blocks with nothing to tell blank lines or an item's indent apart. */
function seenBlocks(tree: NoteTree): NoteBlock[] {
  return tree.blocks.map((b) => ({ ...b, blankBefore: 0 }));
}

describe('a note’s preview (0.9.0, N1)', () => {
  it('its words, run together and cut short at a word', () => {
    expect(notePreview('# Boiler\n**Ring** Ann first\n\n- key under pot')).toBe(
      'Boiler Ring Ann first - key under pot',
    );
    const long = notePreview(`${'word '.repeat(100)}`, 40);
    expect(long.length).toBeLessThanOrEqual(41);
    expect(long.endsWith('…')).toBe(true);
    expect(notePreview(null)).toBe('');
    // Only the start of a note is read.
    expect(notePreview(`short${' '.repeat(5_000)}**never read**`)).toBe('short');
  });
});
