import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { noteTreeToMarkdown, parseNotes } from '@fdv/shared';
import axe from 'axe-core';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeInto, writtenIn } from './note-editor-testing.js';
import {
  commandFor,
  drawNote,
  linkAddress,
  readNote,
  readPasted,
  RichTextEditor,
  toggleList,
  toggleQuote,
} from './rich-text.js';

/**
 * The one note editor (0.9.0, N1): a real toolbar — one stop in the tab
 * order, the arrow keys, Home and End, toggles pressed as the caret's words
 * are, the kinds of text in a menu — over words written on the page and
 * kept as the note's small Markdown; and whatever is pasted read into a
 * note first, so nothing of a page but its words and the few marks a note
 * has is ever put in.
 */

afterEach(() => {
  vi.restoreAllMocks();
  // jsdom has no editing commands: a test that stood one in takes it away.
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

/** The editor, and what it last told its page. */
function Editor(props: { initial?: string; onChange?: (md: string) => void }) {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <>
      <RichTextEditor
        label="Note"
        initial={props.initial ?? ''}
        onChange={(md) => {
          setSaid(md);
          props.onChange?.(md);
        }}
      />
      <output data-testid="said">{said ?? 'nothing yet'}</output>
    </>
  );
}

/** Puts the caret, or a choice, in the words, as a click or a drag would. */
function choose(node: Node, from: number, end: Node = node, to = from) {
  const r = document.createRange();
  r.setStart(node, from);
  r.setEnd(end, to);
  const sel = document.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(r);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

const words = () => screen.getByRole('textbox', { name: 'Note' });
const toolbar = () => screen.getByRole('toolbar', { name: 'Formatting' });
const tool = (name: string | RegExp) => within(toolbar()).getByRole('button', { name });

async function expectAccessible() {
  const results = await axe.run(document.body, {
    // jsdom has no layout; and the editor stands alone here, in no landmark.
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

describe('the toolbar is one (the ARIA toolbar pattern)', () => {
  it('named, controlling the words, a single stop in the tab order, its groups apart', async () => {
    render(<Editor initial="Spare key" />);
    expect(toolbar()).toHaveAttribute('aria-controls', words().id);
    expect(words()).toHaveAttribute('aria-multiline', 'true');
    const all = within(toolbar()).getAllByRole('button');
    expect(all.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Text style: Normal text',
      'Bold',
      'Italic',
      'Underline',
      'Strikethrough',
      'Bulleted list',
      'Numbered list',
      'Checklist',
      'Link',
      'Quote',
      'Clear formatting',
    ]);
    // One stop: the first, until another has been used.
    expect(all.filter((b) => b.tabIndex === 0)).toEqual([all[0]]);
    // Groups with a separator between each, and every icon its own drawing.
    expect(within(toolbar()).getAllByRole('separator', { hidden: true })).toHaveLength(4);
    expect(toolbar().querySelectorAll('svg')).toHaveLength(all.length);
    // Each says its shortcut, to a screen reader and in its tip.
    expect(tool('Bold')).toHaveAttribute('aria-keyshortcuts', 'Control+B');
    expect(tool('Checklist')).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+9');
    expect(tool('Bold').querySelector('.rt-tip')).toHaveTextContent('Bold (Ctrl+B)');
    await expectAccessible();
  });

  it('the arrow keys, Home and End move between its buttons, and the one left on is its stop', () => {
    render(<Editor />);
    const all = within(toolbar()).getAllByRole('button');
    const first = all[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(tool('Bold')).toHaveFocus();
    fireEvent.keyDown(tool('Bold'), { key: 'ArrowRight' });
    expect(tool('Italic')).toHaveFocus();
    fireEvent.keyDown(tool('Italic'), { key: 'ArrowLeft' });
    expect(tool('Bold')).toHaveFocus();
    fireEvent.keyDown(tool('Bold'), { key: 'End' });
    expect(tool('Clear formatting')).toHaveFocus();
    // Past the end, round to the start; and back.
    fireEvent.keyDown(tool('Clear formatting'), { key: 'ArrowRight' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(tool('Clear formatting')).toHaveFocus();
    fireEvent.keyDown(tool('Clear formatting'), { key: 'Home' });
    expect(first).toHaveFocus();
    // The stop is the button last on.
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    fireEvent.keyDown(tool('Bold'), { key: 'ArrowRight' });
    const stops = within(toolbar())
      .getAllByRole('button')
      .filter((b) => b.tabIndex === 0);
    expect(stops).toEqual([tool('Italic')]);
  });

  it('each toggle is pressed as the words the caret is in are', () => {
    render(
      <Editor
        initial={'**bold** *it* ++under++ ~~gone~~ [link](https://a.example)\n\n- item\n\n> said'}
      />,
    );
    const at = (selector: string) => {
      const el = words().querySelector(selector) as HTMLElement;
      choose(el.firstChild as Node, 1);
    };
    const pressed = () =>
      within(toolbar())
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.getAttribute('aria-label'));
    at('strong');
    expect(pressed()).toEqual(['Bold']);
    at('em');
    expect(pressed()).toEqual(['Italic']);
    at('u');
    expect(pressed()).toEqual(['Underline']);
    at('s');
    expect(pressed()).toEqual(['Strikethrough']);
    at('a');
    expect(pressed()).toEqual(['Link']);
    at('li');
    expect(pressed()).toEqual(['Bulleted list']);
    at('blockquote');
    expect(pressed()).toEqual(['Quote']);
    // Every toggle says pressed or not; the menu and Clear are no toggles.
    expect(tool('Bold')).toHaveAttribute('aria-pressed', 'false');
    expect(tool('Clear formatting')).not.toHaveAttribute('aria-pressed');
    expect(tool(/^Text style/)).not.toHaveAttribute('aria-pressed');
  });

  it('the kind of text is a menu: it says the caret’s, opens from the keys, and Escape closes it back to its button', async () => {
    render(<Editor initial={'# Big\n\n## Middle\n\n### Small\n\nplain'} />);
    choose(words().querySelector('h3')?.firstChild as Node, 1);
    const menuButton = tool(/^Text style/);
    expect(menuButton).toHaveAccessibleName('Text style: Heading 3');
    expect(menuButton).toHaveAttribute('aria-haspopup', 'menu');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    menuButton.focus();
    fireEvent.keyDown(menuButton, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: 'Text style' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['Normal textCtrl+Shift+0', 'false'],
      ['Heading 1Ctrl+Shift+1', 'false'],
      ['Heading 2Ctrl+Shift+2', 'false'],
      ['Heading 3Ctrl+Shift+3', 'true'],
    ]);
    // Focus on the one chosen, and the arrows move it.
    expect(items[3]).toHaveFocus();
    fireEvent.keyDown(items[3] as HTMLElement, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    await expectAccessible();
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
  });
});

describe('its keys', () => {
  it('each shortcut is the command its tip says', () => {
    const key = (k: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
      commandFor({
        key: k,
        code,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...mods,
      });
    expect(key('b', 'KeyB')).toBe('strong');
    expect(key('i', 'KeyI')).toBe('em');
    expect(key('u', 'KeyU')).toBe('underline');
    expect(key('X', 'KeyX', { shiftKey: true })).toBe('strike');
    expect(key('&', 'Digit7', { shiftKey: true })).toBe('numbered');
    expect(key('*', 'Digit8', { shiftKey: true })).toBe('bulleted');
    expect(key('(', 'Digit9', { shiftKey: true })).toBe('checklist');
    expect(key('>', 'Period', { shiftKey: true })).toBe('quote');
    expect(key('k', 'KeyK')).toBe('link');
    expect(key('\\', 'Backslash')).toBe('clear');
    expect(key('@', 'Digit2', { shiftKey: true })).toBe('heading2');
    expect(key(')', 'Digit0', { shiftKey: true })).toBe('paragraph');
    // AltGr — Ctrl and Alt on Windows — types @, # and } on many keyboards:
    // never a command (the N1 review).
    expect(key('@', 'Digit2', { altKey: true })).toBeNull();
    expect(key('}', 'Digit0', { altKey: true })).toBeNull();
    expect(key('#', 'Digit3', { getModifierState: (m: string) => m === 'AltGraph' })).toBeNull();
    // AltGr with Shift, as a keyboard that says so without Alt: still typing.
    expect(
      key('#', 'Digit3', { shiftKey: true, getModifierState: (m: string) => m === 'AltGraph' }),
    ).toBeNull();
    // ⌘ on a Mac, as Ctrl elsewhere; and nothing without either.
    expect(
      commandFor({
        key: 'b',
        code: 'KeyB',
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe('strong');
    expect(
      commandFor({
        key: 'b',
        code: 'KeyB',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBeNull();
    expect(key('c', 'KeyC')).toBeNull();
  });

  it('marks are the browser’s own commands; lists, quotes and the checklist’s tick the editor’s', () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    render(<Editor initial={'one\n\ntwo'} />);
    const [one, two] = Array.from(words().querySelectorAll('p'));
    words().focus();
    choose(one?.firstChild as Node, 0, one?.firstChild as Node, 3);
    for (const [k, code, shift, command] of [
      ['b', 'KeyB', false, 'bold'],
      ['i', 'KeyI', false, 'italic'],
      ['u', 'KeyU', false, 'underline'],
      ['X', 'KeyX', true, 'strikeThrough'],
    ] as const) {
      fireEvent.keyDown(words(), { key: k, code, ctrlKey: true, shiftKey: shift });
      expect(exec).toHaveBeenCalledWith(command, false, undefined);
    }
    fireEvent.keyDown(words(), { key: '@', code: 'Digit2', ctrlKey: true, shiftKey: true });
    expect(exec).toHaveBeenCalledWith('formatBlock', false, 'h2');
    // AltGr+2 types @ (an AZERTY or QWERTZ keyboard on Windows): left to type it.
    exec.mockClear();
    const typed = fireEvent.keyDown(words(), {
      key: '@',
      code: 'Digit2',
      ctrlKey: true,
      altKey: true,
    });
    expect(typed).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    // A checklist from the keys: both lines, each its own item.
    choose(one?.firstChild as Node, 0, two?.firstChild as Node, 3);
    fireEvent.keyDown(words(), { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true });
    expect(writtenIn(words())).toBe('- [ ] one\n- [ ] two');
    // Ctrl+Enter ticks the item the caret is in.
    choose(words().querySelectorAll('li')[1]?.lastChild as Node, 1);
    fireEvent.keyDown(words(), { key: 'Enter', ctrlKey: true });
    expect(writtenIn(words())).toBe('- [ ] one\n- [x] two');
    // A quote of the first item: the list split round it, the rest kept.
    choose(words().querySelector('li')?.lastChild as Node, 1);
    fireEvent.keyDown(words(), { key: '>', code: 'Period', ctrlKey: true, shiftKey: true });
    expect(writtenIn(words())).toBe('> one\n\n- [x] two');
    // And told to the page, as the note it now is.
    expect(screen.getByTestId('said')).toHaveTextContent('> one - [x] two');
    // Asked again, back to what they were.
    choose(words().querySelector('blockquote')?.firstChild as Node, 1);
    fireEvent.keyDown(words(), { key: '>', code: 'Period', ctrlKey: true, shiftKey: true });
    expect(writtenIn(words())).toBe('one\n\n- [x] two');
  });

  it('each to-do’s state is heard: its box a checkbox, "Done", ticked or not — and never the note’s words (the N1 review)', async () => {
    render(<Editor initial={'- [ ] Key cut\n- [x] Tell Sara\n- Plain'} />);
    const boxes = within(words()).getAllByRole('checkbox', { name: 'Done' });
    // The plain item has none: it is no to-do.
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(boxes.every((b) => b.getAttribute('contenteditable') === 'false')).toBe(true);
    // Ctrl+Enter ticks the first: and its box says so.
    choose(words().querySelector('li')?.lastChild as Node, 1);
    fireEvent.keyDown(words(), { key: 'Enter', ctrlKey: true });
    expect(
      within(words())
        .getAllByRole('checkbox', { name: 'Done' })
        .map((b) => b.getAttribute('aria-checked')),
    ).toEqual(['true', 'true']);
    // A click on a box takes its tick off.
    fireEvent.mouseDown(within(words()).getAllByRole('checkbox', { name: 'Done' })[1] as Element);
    expect(writtenIn(words())).toBe('- [x] Key cut\n- [ ] Tell Sara\n- Plain');
    await expectAccessible();
  });

  it('the caret stays in the words it was in as a list is made', () => {
    render(<Editor initial={'alpha\n\nbeta'} />);
    const beta = words().querySelectorAll('p')[1]?.firstChild as Text;
    choose(beta, 2);
    toggleList(words(), document.getSelection()?.getRangeAt(0) as Range, 'numbered');
    const sel = document.getSelection() as Selection;
    expect(sel.anchorNode).toBe(beta);
    expect(sel.anchorOffset).toBe(2);
    expect(writtenIn(words())).toBe('alpha\n\n1. beta');
  });
});

describe('a link', () => {
  it('goes only to the web or an email: an address typed is made one, anything else refused', () => {
    expect(linkAddress('https://a.example/x')).toBe('https://a.example/x');
    expect(linkAddress('mailto:tax@b.example')).toBe('mailto:tax@b.example');
    // An address with brackets kept as it is (the N1 review): the note writes them.
    expect(linkAddress('https://en.example/wiki/Thing_(x)')).toBe(
      'https://en.example/wiki/Thing_(x)',
    );
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc',
      '//evil.example',
    ]) {
      expect(linkAddress(bad), bad).toBeNull();
    }
  });

  it('Ctrl+K asks for its address: refused if it goes nowhere a note links to, made from what is chosen otherwise', () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    render(<Editor initial="the council" />);
    const text = words().querySelector('p')?.firstChild as Node;
    words().focus();
    choose(text, 0, text, 11);
    fireEvent.keyDown(words(), { key: 'k', code: 'KeyK', ctrlKey: true });
    const form = screen.getByRole('group', { name: 'Link' });
    const field = within(form).getByRole('textbox', { name: 'Link to' });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add link' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(/web address/);
    expect(exec).not.toHaveBeenCalledWith('createLink', false, expect.anything());
    fireEvent.change(field, { target: { value: 'council.example/bins' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add link' }));
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://council.example/bins');
    expect(screen.queryByRole('group', { name: 'Link' })).not.toBeInTheDocument();
  });
});

describe('what the editor keeps is the note it shows', () => {
  it('every kind of block and mark the browser makes, read as the note’s own', () => {
    const box = document.createElement('div');
    box.innerHTML = [
      '<h1>Boiler</h1>',
      '<p>The <b>stopcock</b> is <i>under</i> the <u>sink</u>, not <strike>the garage</strike>.<br>See <a href="https://w.example/help">the guide</a></p>',
      '<h2>Calls</h2>',
      '<ul><li>Plumber</li><li>Electrician</li></ul>',
      '<ol><li>Off</li><li>Drain</li></ol>',
      '<ul data-checklist="true"><li data-checked="true">Key cut</li><li data-checked="false">Tell Sara</li></ul>',
      '<blockquote>Never the loft</blockquote>',
      '<div>A line in a div</div>',
      'loose words',
      '<p><span style="font-weight: 700">styled bold</span> and <span style="font-style: italic">styled italic</span></p>',
    ].join('');
    expect(noteTreeToMarkdown(readNote(box))).toBe(
      [
        '# Boiler',
        'The **stopcock** is *under* the ++sink++, not ~~the garage~~.\nSee [the guide](https://w.example/help)',
        '## Calls',
        '- Plumber\n- Electrician',
        '1. Off\n2. Drain',
        '- [x] Key cut\n- [ ] Tell Sara',
        '> Never the loft',
        'A line in a div',
        'loose words',
        '**styled bold** and *styled italic*',
      ].join('\n\n'),
    );
  });

  it('a link whose address has brackets is written once, as its words and its address (the N1 review)', () => {
    const box = document.createElement('div');
    box.innerHTML =
      '<p>See <a href="https://en.example/wiki/Thing_(x)">the Wiki</a> and <a href="https://en.example/wiki/Thing_%28y%29">this</a></p>';
    const written = noteTreeToMarkdown(readNote(box));
    expect(written).toBe(
      'See [the Wiki](https://en.example/wiki/Thing_%28x%29) and [this](https://en.example/wiki/Thing_%28y%29)',
    );
    // And read back, the same links.
    const again = document.createElement('div');
    again.appendChild(drawNote(parseNotes(written), document));
    expect(noteTreeToMarkdown(readNote(again))).toBe(written);
  });

  it('a note drawn and read back is the same note', () => {
    const note = [
      '# Where things are',
      'The **stopcock** is *under* the ++sink++, not ~~the garage~~.',
      '## Who to call',
      '- [x] Plumber: [Ann](https://ann.example)\n- [ ] Electrician',
      '1. Turn it off\n2. Open a tap',
      '> Never in the loft',
    ].join('\n\n');
    const box = document.createElement('div');
    box.appendChild(drawNote(parseNotes(note), document));
    expect(noteTreeToMarkdown(readNote(box))).toBe(note);
  });

  it('a note opened and saved keeps what it means: every mix of its blocks, its odd spaces and addresses (the N1 review)', () => {
    // The pieces a note is made of, those the review found changed among them:
    // a plain item in a list of to-dos, a list from 0, an address with
    // brackets written either way, a no-break and a zero-width space.
    const pieces = [
      '- Plain\n- [ ] To do\n- [x] Done',
      '- [ ] First\n- Then plain',
      '0. Zero\n1. One',
      '3. Three\n4. Four',
      '[Wiki](https://en.example/wiki/Thing_%28x%29)',
      'See https://en.example/wiki/Thing_(x) for it',
      '[Mail](mailto:tax@b.example)',
      'Room 101, flat 2',
      'Pass​word is not here﻿',
      '# Boiler',
      '### Small',
      '> Never the loft',
      'The **stopcock** is *under* the ++sink++, not ~~the garage~~ `code`',
      'Line one\nLine two',
    ];
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const notes = [...pieces];
    for (let i = 0; i < 60; i += 1) {
      const count = 2 + next(4);
      notes.push(Array.from({ length: count }, () => pieces[next(pieces.length)]).join('\n\n'));
    }
    for (const note of notes) {
      const box = document.createElement('div');
      box.appendChild(drawNote(parseNotes(note), document));
      const saved = noteTreeToMarkdown(readNote(box));
      // What it means — the note as the vault reads it — is the same.
      expect(noteTreeToMarkdown(parseNotes(saved)), JSON.stringify(note)).toBe(
        noteTreeToMarkdown(parseNotes(note)),
      );
      // And a note as the editor writes it comes back word for word.
      const own = noteTreeToMarkdown(parseNotes(note));
      const again = document.createElement('div');
      again.appendChild(drawNote(parseNotes(own), document));
      expect(noteTreeToMarkdown(readNote(again)), JSON.stringify(own)).toBe(own);
    }
  });

  it('tells its page the note only once something is written, never as it opens', () => {
    const told = vi.fn();
    render(<Editor initial="As it was" onChange={told} />);
    expect(told).not.toHaveBeenCalled();
    writeInto(words(), 'As it is **now**');
    expect(told).toHaveBeenLastCalledWith('As it is **now**');
  });
});

describe('what is pasted is read into a note first', () => {
  it('scripts, styles, frames, pictures and forms left out whole; javascript: links their words; marks kept', () => {
    const tree = readPasted(
      [
        '<meta charset="utf-8"><style>p { color: red }</style><title>Page</title>',
        '<p>Hello <script>window.__fdvPaste = 1</script><b style="font-weight:normal" id="docs-internal-guid"><span style="font-weight:700">bold</span> plain</b>',
        '<img src="x" onerror="window.__fdvPaste = 2"><iframe src="https://evil.example"></iframe>',
        '<a href="javascript:alert(1)">bad</a> <a href="https://good.example/a">good</a> <a href="data:text/html,x">data</a>',
        '<input value="typed"><button>Press</button><svg><text>drawn</text></svg></p>',
        '<table><tr><td>Name</td><td>Ann</td></tr></table>',
        '<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> to do</li></ul>',
        '<h4>Small heading</h4><pre>  kept\n  lines</pre>',
      ].join(''),
    );
    expect(noteTreeToMarkdown(tree)).toBe(
      [
        'Hello **bold** plainbad [good](https://good.example/a) data',
        'Name · Ann',
        '- [x] done\n- [ ] to do',
        '### Small heading',
        'kept lines',
      ].join('\n\n'),
    );
    expect((window as unknown as { __fdvPaste?: number }).__fdvPaste).toBeUndefined();
  });

  it('a page pasted into the editor puts in only its words and a note’s marks', () => {
    render(<Editor initial="Before" />);
    const text = words().querySelector('p')?.firstChild as Node;
    words().focus();
    choose(text, 6);
    const data = new Map([
      ['text/html', '<p>New <em>words</em><script>window.__fdvPaste = 3</script><img src=x></p>'],
      ['text/plain', 'New words'],
    ]);
    fireEvent.paste(words(), { clipboardData: { getData: (t: string) => data.get(t) ?? '' } });
    expect(words().querySelector('script, img, style')).toBeNull();
    expect(writtenIn(words())).toBe('BeforeNew *words*');
    expect((window as unknown as { __fdvPaste?: number }).__fdvPaste).toBeUndefined();
  });

  it('a quote and a list from the editor’s own words', () => {
    const box = document.createElement('div');
    box.innerHTML = '<p>first</p><p>second</p>';
    document.body.appendChild(box);
    const r = document.createRange();
    r.setStart(box.firstChild?.firstChild as Node, 0);
    r.setEnd(box.lastChild?.firstChild as Node, 3);
    toggleQuote(box, r);
    expect(noteTreeToMarkdown(readNote(box))).toBe('> first\n> second');
    box.remove();
  });
});
