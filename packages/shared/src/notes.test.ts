import { describe, expect, it } from 'vitest';
import {
  noteLinkAllowed,
  notesPlainText,
  noteTreeText,
  NOTES_MAX,
  parseNotes,
  type NoteBlock,
  type NoteInline,
  type NoteTree,
} from './notes.js';

/** A small, seeded generator: the same strings every run, so a failure can be found again. */
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

const BLOCK_KEYS: Record<NoteBlock['type'], string[]> = {
  paragraph: ['blankBefore', 'children', 'type'],
  heading: ['blankBefore', 'children', 'type'],
  list: ['blankBefore', 'items', 'ordered', 'start', 'type'],
};
const INLINE_KEYS: Record<NoteInline['type'], string[]> = {
  text: ['text', 'type'],
  strong: ['children', 'type'],
  em: ['children', 'type'],
  link: ['children', 'href', 'type'],
  break: ['type'],
};

/**
 * What in the tree is not one of the allowed few, with exactly its own
 * fields: nothing, for any note.
 */
function outsideAllowed(tree: NoteTree): string[] {
  const wrong: string[] = [];
  const keys = (o: object) => Object.keys(o).sort().join(',');
  if (keys(tree) !== 'blocks') wrong.push(`the tree has ${keys(tree)}`);
  const inline = (nodes: NoteInline[], inLink: boolean) => {
    for (const n of nodes) {
      const allowed = INLINE_KEYS[n.type] as string[] | undefined;
      if (!allowed) {
        wrong.push(`an inline ${String(n.type)}`);
        continue;
      }
      if (keys(n) !== allowed.join(',')) wrong.push(`a ${n.type} with ${keys(n)}`);
      if (n.type === 'text' && (typeof n.text !== 'string' || n.text.length === 0)) {
        wrong.push('an empty text');
      }
      if (n.type === 'link') {
        // Never a link in a link, and only ever to the web or an email.
        if (inLink) wrong.push('a link in a link');
        if (!noteLinkAllowed(n.href) || !/^(https?:\/\/|mailto:)\S+$/i.test(n.href)) {
          wrong.push(`a link to ${n.href}`);
        }
        inline(n.children, true);
      }
      if (n.type === 'strong' || n.type === 'em') inline(n.children, inLink);
    }
  };
  for (const b of tree.blocks) {
    const allowed = BLOCK_KEYS[b.type] as string[] | undefined;
    if (!allowed) {
      wrong.push(`a block ${String(b.type)}`);
      continue;
    }
    if (keys(b) !== allowed.join(',')) wrong.push(`a ${b.type} with ${keys(b)}`);
    if (!Number.isInteger(b.blankBefore) || b.blankBefore < 0) wrong.push('a blank count');
    if (b.type === 'list') {
      if (b.items.length === 0) wrong.push('an empty list');
      for (const item of b.items) {
        if (keys(item) !== 'checked,children,marker') wrong.push(`an item with ${keys(item)}`);
        if (!(b.ordered ? /^\d{1,9}\.$/ : /^[-*+]$/).test(item.marker)) {
          wrong.push(`a marker ${item.marker}`);
        }
        if (![null, true, false].includes(item.checked) || (b.ordered && item.checked !== null)) {
          wrong.push('a box');
        }
        inline(item.children, false);
      }
    } else {
      inline(b.children, false);
    }
  }
  return wrong;
}

function expectAllowed(tree: NoteTree, input: string) {
  const wrong = outsideAllowed(tree);
  if (wrong.length) expect(wrong, JSON.stringify(input)).toEqual([]);
}

const text = (t: string): NoteInline => ({ type: 'text', text: t });

describe('notes you can write (5.35)', () => {
  it('reads paragraphs, line breaks, bold and italic', () => {
    expect(parseNotes('Spare key: **under the pot**\nby the *back* door\n\nCall _Sarah_')).toEqual({
      blocks: [
        {
          type: 'paragraph',
          blankBefore: 0,
          children: [
            text('Spare key: '),
            { type: 'strong', children: [text('under the pot')] },
            { type: 'break' },
            text('by the '),
            { type: 'em', children: [text('back')] },
            text(' door'),
          ],
        },
        {
          type: 'paragraph',
          blankBefore: 1,
          children: [text('Call '), { type: 'em', children: [text('Sarah')] }],
        },
      ],
    });
    // Three marks are both; italic inside bold, however the marks meet —
    // as the toolbar makes them, italic chosen inside a bold word.
    expect(
      parseNotes('***now*** and **all *of* it**, ***Spare* key** and *a **b** c*').blocks[0],
    ).toEqual({
      type: 'paragraph',
      blankBefore: 0,
      children: [
        { type: 'em', children: [{ type: 'strong', children: [text('now')] }] },
        text(' and '),
        {
          type: 'strong',
          children: [text('all '), { type: 'em', children: [text('of')] }, text(' it')],
        },
        text(', '),
        {
          type: 'strong',
          children: [{ type: 'em', children: [text('Spare')] }, text(' key')],
        },
        text(' and '),
        {
          type: 'em',
          children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')],
        },
      ],
    });
    // A mark left over is a mark.
    expect(notesPlainText('**a* b')).toBe('*a b');
    expect(notesPlainText('a ** b ** c')).toBe('a ** b ** c');
  });

  it('reads bulleted, numbered and checklist items, and level-3 headings', () => {
    const tree = parseNotes(
      '### Before the trip\n- passports\n* the **visas**\n  (both of them)\n- [ ] insurance\n- [x] tickets\n\n3. first\n4. second\nAfterwards',
    );
    expect(tree.blocks).toEqual([
      { type: 'heading', blankBefore: 0, children: [text('Before the trip')] },
      {
        type: 'list',
        blankBefore: 0,
        ordered: false,
        start: 1,
        items: [
          { marker: '-', checked: null, children: [text('passports')] },
          {
            marker: '*',
            checked: null,
            children: [
              text('the '),
              { type: 'strong', children: [text('visas')] },
              { type: 'break' },
              text('  (both of them)'),
            ],
          },
          { marker: '-', checked: false, children: [text('insurance')] },
          { marker: '-', checked: true, children: [text('tickets')] },
        ],
      },
      {
        type: 'list',
        blankBefore: 1,
        ordered: true,
        start: 3,
        items: [
          { marker: '3.', checked: null, children: [text('first')] },
          { marker: '4.', checked: null, children: [text('second')] },
        ],
      },
      { type: 'paragraph', blankBefore: 0, children: [text('Afterwards')] },
    ]);
    // Only level 3: the others are text, as is a heading with no words.
    expect(parseNotes('# One\n## Two\n#### Four\n### ').blocks).toEqual([
      {
        type: 'paragraph',
        blankBefore: 0,
        children: [
          text('# One'),
          { type: 'break' },
          text('## Two'),
          { type: 'break' },
          text('#### Four'),
          { type: 'break' },
          text('### '),
        ],
      },
    ]);
  });

  it('reads links to the web and to an email, written out or with words', () => {
    expect(
      parseNotes(
        'Pay at [the council](https://council.example/pay), see https://example.com/a_b. or [mail](mailto:tax@example.com)',
      ).blocks[0],
    ).toEqual({
      type: 'paragraph',
      blankBefore: 0,
      children: [
        text('Pay at '),
        { type: 'link', href: 'https://council.example/pay', children: [text('the council')] },
        text(', see '),
        { type: 'link', href: 'https://example.com/a_b', children: [] },
        text('. or '),
        { type: 'link', href: 'mailto:tax@example.com', children: [text('mail')] },
      ],
    });
    // A written-out address keeps a bracket it opened, not one its sentence did.
    expect(
      parseNotes('(see https://en.example/wiki/Thing_(x)) and (http://a.example)').blocks[0],
    ).toMatchObject({
      children: [
        text('(see '),
        { type: 'link', href: 'https://en.example/wiki/Thing_(x)' },
        text(') and ('),
        { type: 'link', href: 'http://a.example' },
        text(')'),
      ],
    });
  });

  it('javascript: and data: links stay text', () => {
    for (const note of [
      '[click](javascript:alert(1))',
      '[click](JavaScript:alert(document.cookie))',
      '[click](javascript:void%200)',
      '[img](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '[x](data:image/svg+xml,<svg/onload=alert(1)>)',
      '[x](vbscript:msgbox)',
      '[x](file:///etc/passwd)',
      '[x](//evil.example/path)',
      '[x](https:/one-slash.example)',
      '[x](https://)',
      '<javascript:alert(1)>',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'xhttps://inside.example/word',
    ]) {
      const tree = parseNotes(note);
      const links: NoteInline[] = [];
      const walk = (nodes: NoteInline[]) => {
        for (const n of nodes) {
          if (n.type === 'link') links.push(n);
          if ('children' in n) walk(n.children);
        }
      };
      for (const b of tree.blocks) {
        if (b.type === 'list') b.items.forEach((i) => walk(i.children));
        else walk(b.children);
      }
      expect(links, note).toEqual([]);
      // Every character is still there, as text.
      expect(notesPlainText(note), note).toBe(note);
    }
    expect(noteLinkAllowed('javascript:alert(1)')).toBe(false);
    expect(noteLinkAllowed('data:text/html,x')).toBe(false);
    expect(noteLinkAllowed('https://a.example\u0000')).toBe(false);
    expect(noteLinkAllowed('HTTPS://A.EXAMPLE')).toBe(true);
  });

  it('a link whose address could show as somewhere it does not go stays text (the 5.35 review, X535-02)', () => {
    /** Each link's address, and its words when it has any. */
    const linksIn = (note: string, withWords = false) => {
      const found: string[] = [];
      const walk = (nodes: NoteInline[]) => {
        for (const n of nodes) {
          if (n.type === 'link') {
            found.push(
              withWords
                ? `${noteTreeText({ blocks: [{ type: 'paragraph', blankBefore: 0, children: n.children }] })} -> ${n.href}`
                : n.href,
            );
          }
          if ('children' in n) walk(n.children);
        }
      };
      for (const b of parseNotes(note).blocks) {
        if (b.type === 'list') b.items.forEach((i) => walk(i.children));
        else walk(b.children);
      }
      return found;
    };
    // Every invisible or direction-changing character: bidi overrides,
    // embeddings, marks and isolates, zero-width spaces and joiners, the
    // soft hyphen, the word joiner and BOM, a language tag (outside the BMP),
    // and line and paragraph separators.
    const unseen = [
      ...'\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f',
      ...'\u200b\u200c\u200d\u00ad\u2060\ufeff\u061c\u2028\u2029\u0085',
      String.fromCodePoint(0xe0001),
    ];
    for (const c of unseen) {
      const code = c.codePointAt(0)?.toString(16) ?? '';
      // Never a link with those words: at most the address written out
      // before the character, which goes where it shows.
      expect(linksIn(`[bank](https://bank.example/${c}x)`, true), code).toEqual([
        ' -> https://bank.example/',
      ]);
      expect(linksIn(`[bank](mailto:a${c}@bank.example)`), code).toEqual([]);
      expect(noteLinkAllowed(`https://bank.example/${c}x`), code).toBe(false);
      // Written out, the address ends where it begins: before the character.
      expect(linksIn(`see https://bank.example${c}moc.live`), code).toEqual([
        'https://bank.example',
      ]);
    }
    // The review's own: an override that shows evil.com as bank.com.
    expect(linksIn('[bank.com](https://\u202emoc.knab@evil.com)')).toEqual([]);
    expect(linksIn('https://\u202emoc.knab@evil.com')).toEqual([]);

    // A name before the host, which could pass for it: never a link.
    for (const note of [
      '[bank](https://bank.example@evil.example)',
      '[bank](https://bank.example:443@evil.example/pay)',
      'https://bank.example@evil.example/pay',
      'http://user:pass@evil.example',
    ]) {
      expect(linksIn(note), note).toEqual([]);
      expect(notesPlainText(note), note).toBe(note);
    }
    // An @ after the host is the path's, and an email's address is its own.
    expect(linksIn('https://evil.example/@bank and [mail](mailto:tax@bank.example)')).toEqual([
      'https://evil.example/@bank',
      'mailto:tax@bank.example',
    ]);
    // No host at all is no link.
    expect(noteLinkAllowed('https:///path')).toBe(false);
    expect(noteLinkAllowed('https://?q=1')).toBe(false);
    // A host in another script is a link; whoever draws it shows it as the
    // browser will reach it (punycode), as the web's own test holds.
    expect(linksIn('https://p\u0430ypal.example/login')).toEqual([
      'https://p\u0430ypal.example/login',
    ]);
  });

  it('plain text round-trips unchanged', () => {
    for (const note of [
      'Spare key under the geranium pot by the back door',
      'Renewed online.\nReference 4471-AB, paid £84.50 on 3 March.\n\nAsk for Mr. Patel (ext. 204).',
      'Two blank lines\n\n\nthen this; and 5 * 3 = 15',
      'snake_case_name and a_file.pdf',
      'C:\\Users\\Sarah\\Documents and C:\\Program Files\\',
      '[draft] (see above) #hashtag 3.5 litres 10.5% off',
      'Shopping:\n- milk\n- eggs\n\n1. first\n2. second',
      'The portal: https://portal.example/login?user=sarah&next=/home.',
      '  indented line\nnext line  ',
      'Emoji 🎉 and accents: café, naïve, 日本語',
    ]) {
      expect(notesPlainText(note), note).toBe(note);
    }
    // And any text made of words, everyday punctuation and line breaks.
    const words = ['passport', 'renewal', 'Sarah', '4471', '£84.50', 'café', 'ref:', 'x2'];
    const glue = [' ', ' ', ', ', '. ', '; ', ' - ', ' (', ') ', '! ', '? ', ' / ', ' & ', ' % '];
    const rng = seeded(535);
    for (let n = 0; n < 2_000; n++) {
      const lines: string[] = [];
      const count = 1 + rng.int(6);
      for (let l = 0; l < count; l++) {
        let line = rng.pick(words);
        for (let w = rng.int(8); w > 0; w--) line += rng.pick(glue) + rng.pick(words);
        // A list's marker at the start of a line comes back as it was.
        const lead = rng.int(10);
        if (lead === 0) line = `- ${line}`;
        if (lead === 1) line = `${1 + rng.int(9)}. ${line}`;
        lines.push(line);
        if (l < count - 1 && rng.int(3) === 0) lines.push('');
      }
      const note = lines.join('\n');
      expect(notesPlainText(note), note).toBe(note);
    }
  });

  it('gives plain text for a note with marks: words, and a link with its address', () => {
    expect(
      notesPlainText(
        '### Bins\n**Blue** on *Mondays*: [the rota](https://council.example/rota)\n- [x] done\n- [ ] not yet',
      ),
    ).toBe(
      'Bins\nBlue on Mondays: the rota (https://council.example/rota)\n- [x] done\n- [ ] not yet',
    );
    expect(notesPlainText(null)).toBe('');
    expect(noteTreeText(parseNotes('a\\*b\\* \\- c'))).toBe('a*b* - c');
  });

  it('no input produces anything outside the allowed elements', () => {
    const pieces = [
      '*',
      '**',
      '***',
      '_',
      '__',
      '[',
      ']',
      '(',
      ')',
      '](',
      '[a](',
      'https://a.example/x',
      'http://b.example',
      'mailto:c@d.example',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '![pic](https://e.example/i.png)',
      '| a | b |\n|---|---|',
      '### ',
      '# ',
      '- ',
      '* ',
      '+ ',
      '- [ ] ',
      '- [x] ',
      '1. ',
      '12345678901. ',
      '\n',
      '\n\n',
      '\r\n',
      '\r',
      ' ',
      '  ',
      '\t',
      '\\',
      '\\*',
      '`code`',
      '&amp;',
      'word',
      'é',
      '日本',
      '\u2028',
      '\u0000',
      '\u202e',
      '🎉',
    ];
    const rng = seeded(5_35);
    for (let n = 0; n < 4_000; n++) {
      let input = '';
      for (let k = 1 + rng.int(40); k > 0; k--) input += rng.pick(pieces);
      const tree = parseNotes(input);
      expectAllowed(tree, input);
      expect(typeof noteTreeText(tree)).toBe('string');
    }
    // And every single character, alone and repeated.
    for (let code = 0; code < 0x250; code++) {
      const c = String.fromCharCode(code);
      expectAllowed(parseNotes(c), c);
      expectAllowed(parseNotes(c.repeat(7)), c);
    }
  });

  it('reads any note quickly, however it is made: no input makes it backtrack', () => {
    // Ten times the longest note a vault keeps, each built to make a naive
    // parser go back over itself.
    const size = NOTES_MAX * 10;
    const fill = (unit: string, tail = '') => unit.repeat(Math.ceil(size / unit.length)) + tail;
    const inputs = {
      stars: fill('*'),
      'stars and letters': fill('*a'),
      'openers never closed': fill('*a _b **c '),
      'closers never opened': fill('a* b_ c** '),
      'openers, then closers of another kind': fill('_a ') + fill('a* '),
      'nested too deep': fill('*_') + fill('_*'),
      brackets: fill('['),
      'labels never closed': fill('[a'),
      'links never closed': fill('[a]('),
      'addresses that end only at the end': fill('[a](b') + ')',
      'every link an address': fill('[a](https://x.example/) '),
      'addresses written out': fill('https://'),
      'addresses with nothing after them': fill('https://. '),
      'addresses each spoiled at once': fill('https://\u0001'),
      'one long address': `https://${fill('a')}`,
      'one long address spoiled at its end': `${fill('https://a')}\u0001`,
      backslashes: fill('\\'),
      'checklist lines': fill('- [ ] *a\n'),
      'heading marks': fill('#'),
      'one long line of underscores in words': fill('a_'),
      // The 5.35 review (X535-01): a paragraph of many lines, and one item
      // carried on over many lines, were copied once a line.
      'one paragraph of many lines': fill('a\n'),
      'one item carried on over many lines': `- a\n${fill(' b\n')}`,
      // And (X535-02) addresses refused for a name before the host, or for
      // a character that could hide where they go.
      'addresses with a name before the host': fill('https://a@b/'),
      'addresses each with an unseen character': fill('https://a\u200b'),
      'bracketed addresses with an unseen character': fill('[a](https://a\u202e)'),
      'addresses outside the BMP': fill(`https://a${String.fromCodePoint(0xe0001)}`),
    };
    for (const [what, input] of Object.entries(inputs)) {
      const started = Date.now();
      const tree = parseNotes(input);
      const plain = noteTreeText(tree);
      const took = Date.now() - started;
      expect(plain.length, what).toBeGreaterThan(0);
      // Linear work is a few milliseconds here; backtracking would be minutes.
      expect(took, `${what}: ${took.toFixed(0)} ms`).toBeLessThan(2_000);
    }
  });

  it('reads a note as long as a vault keeps, of many lines, in a few milliseconds (the 5.35 review, X535-01)', () => {
    // As the vault reads them: once a search hit, once each of a member's
    // Only me documents in their private search. Twenty in a row.
    for (const [what, note] of [
      ['one paragraph of many lines', 'a\n'.repeat(NOTES_MAX / 2)],
      ['one item carried on over many lines', `- a\n${' b\n'.repeat((NOTES_MAX - 4) / 3)}`],
      ['short lines of words', 'ab\n'.repeat(NOTES_MAX / 3)],
    ] as const) {
      expect(note.length, what).toBeLessThanOrEqual(NOTES_MAX);
      const started = Date.now();
      for (let n = 0; n < 20; n++) expect(notesPlainText(note).length, what).toBeGreaterThan(0);
      const took = Date.now() - started;
      // A few milliseconds each; copied once a line, over a hundred.
      expect(took, `${what}: ${took} ms for 20`).toBeLessThan(1_000);
    }
  });
});
