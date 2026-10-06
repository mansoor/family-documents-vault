import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { parseNotes, type NoteBlock, type NoteInline } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { formatNote, type NoteFormat } from './notes.js';
import { Session } from './session.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Notes you can write, the review round (5.35): a refusal (409) told apart
 * from somebody changing the note; a draft that remembers the note it began
 * from, and is each person's own; no draft once a document is no longer for
 * everyone; a preview of what is saved; toolbar marks that read as meant; a
 * link's address as the browser will reach it; and the household's
 * questions on their own.
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

async function openDocument(state: FakeState, role: 'owner' | 'adult' = 'owner') {
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', '/documents/doc-1');
  const shown = render(<App />);
  await screen.findByRole('heading', { level: 1 });
  return shown;
}
/** The page again, as a reload shows it, with the session this browser keeps. */
async function reopen(state: FakeState) {
  installFakeApi(state);
  window.history.replaceState({}, '', '/documents/doc-1');
  const shown = render(<App />);
  await screen.findByRole('heading', { level: 1 });
  return shown;
}
const notes = () => screen.findByRole('region', { name: 'Notes' });
const DRAFT = 'fdv.note-draft.hh.me.doc-1';
const drafts = () => {
  const keys: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i) as string);
  return keys.filter((k) => k.startsWith('fdv.note-draft.'));
};
const ifMatches = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'PATCH').map((c) => c.headers?.['if-match']);

/** The passport with a note Mansoor wrote, and the copy somebody else saved meanwhile. */
const NOTED = {
  ...PASSPORT,
  notes: 'Renew early',
  notes_updated_at: '2026-09-20T09:14:00Z',
  notes_updated_by_name: 'Mansoor Seikh',
};
const THEIRS = {
  notes: 'Theirs: renew in March',
  notes_updated_at: '2026-09-25T15:12:00Z',
  notes_updated_by_name: 'Sarah',
  etag: '"theirs"',
};

/** Opens the editor on the note, and writes `text` in it. */
async function writeNote(text: string) {
  const section = await notes();
  fireEvent.click(within(section).getByRole('button', { name: /Edit note|Add a note/ }));
  const box = within(section).getByRole('textbox', { name: 'Notes' });
  fireEvent.change(box, { target: { value: text } });
  return { section, box };
}

describe('a save the vault refuses (409), told apart (the 5.35 review)', () => {
  it('refused for a change to something else, it is saved again, quietly, from the document as it is now (A535-01)', async () => {
    const state = fresh({ documents: [{ ...NOTED }] });
    await openDocument(state);
    const { section } = await writeNote('Renew in March');
    // Somebody renames it meanwhile: its ETag moves, its note does not.
    Object.assign(state.documents[0] as object, { title: 'Renamed passport', etag: '"renamed"' });
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    expect(ifMatches(state)).toEqual(['"abc"', '"renamed"']);
    expect((state.documents[0] as { notes: string }).notes).toBe('Renew in March');
    expect(screen.queryByText(/changed this note/)).not.toBeInTheDocument();
    // The page has the document as it is now.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Renamed passport' }),
    ).toBeVisible();
  });

  it('when the page loads the document again meanwhile — a new version — the edit carries on from it, with no refusal (W535-04)', async () => {
    const state = fresh({ documents: [{ ...NOTED }] });
    await openDocument(state);
    const { section } = await writeNote('Renew in March');
    // A new version is added on the same page: the page loads the document again.
    Object.assign(state.documents[0] as object, { etag: '"new-version"' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.4'], 'renewed.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(
        state.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/documents/doc-1'),
      ).toHaveLength(2),
    );
    expect(within(section).getByRole('textbox', { name: 'Notes' })).toHaveValue('Renew in March');
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    expect(ifMatches(state)).toEqual(['"new-version"']);
    expect(screen.queryByText(/changed this note/)).not.toBeInTheDocument();
  });

  it('refused because somebody changed the note, the page shows theirs: Keep theirs keeps it, and the next edit begins from it (W535-01)', async () => {
    const state = fresh({ documents: [{ ...NOTED }] });
    await openDocument(state);
    const { section } = await writeNote('Mine: renew in February');
    Object.assign(state.documents[0] as object, THEIRS);
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    const said = await within(section).findByRole('group', { name: /changed this note/ });
    expect(said).toHaveTextContent('Sarah changed this note while you were writing.');
    fireEvent.click(within(said).getByRole('button', { name: 'Keep theirs' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    expect(section).toHaveTextContent('Theirs: renew in March');
    expect(section).toHaveTextContent('by Sarah');
    expect(drafts()).toEqual([]);
    // Editing again begins from theirs, and is not refused.
    const { box } = await writeNote('Theirs: renew in March, or April');
    expect(box).toHaveValue('Theirs: renew in March, or April');
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    expect(ifMatches(state)).toEqual(['"abc"', '"theirs"']);
  });

  it('names who changed the note only when the note itself changed', async () => {
    // Their copy has the same stamp as the one the edit began from: it says "Someone else".
    const state = fresh({
      documents: [{ ...NOTED, notes_updated_at: null, notes_updated_by_name: null }],
    });
    await openDocument(state);
    const { section } = await writeNote('Mine');
    Object.assign(state.documents[0] as object, {
      notes: 'Changed, with no stamp',
      notes_updated_at: null,
      notes_updated_by_name: 'Mansoor Seikh',
      etag: '"other"',
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    const said = await within(section).findByRole('group', { name: /changed this note/ });
    expect(said).toHaveTextContent('Someone else changed this note while you were writing.');
    expect(said).not.toHaveTextContent('Mansoor Seikh');
  });
});

describe('a draft remembers the note it began from (the 5.35 review)', () => {
  it('never their ETag: after a reload their note is shown again, and nothing is saved over it unasked (W535-03)', async () => {
    const state = fresh({ documents: [{ ...NOTED }] });
    let shown = await openDocument(state);
    let { section } = await writeNote('Mine');
    Object.assign(state.documents[0] as object, THEIRS);
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await within(section).findByRole('group', { name: /changed this note/ });
    const kept = JSON.parse(sessionStorage.getItem(DRAFT) ?? 'null') as Record<string, unknown>;
    expect(kept).toEqual({
      text: 'Mine',
      baseText: 'Renew early',
      baseEtag: '"abc"',
      baseStamp: '2026-09-20T09:14:00Z',
    });

    // A reload: the draft is back, with their note shown again.
    shown.unmount();
    shown = await reopen(state);
    section = await notes();
    expect(within(section).getByRole('textbox', { name: 'Notes' })).toHaveValue('Mine');
    const said = await within(section).findByRole('group', { name: /changed this note/ });
    expect(said).toHaveTextContent('Sarah changed this note while you were writing.');
    expect(said).toHaveTextContent('Theirs: renew in March');
    expect(within(section).queryByRole('button', { name: 'Save note' })).not.toBeInTheDocument();
    expect(ifMatches(state)).toEqual(['"abc"']);
    // Saved over theirs only when asked.
    fireEvent.click(within(said).getByRole('button', { name: 'Save mine over theirs' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    expect(ifMatches(state)).toEqual(['"abc"', '"theirs"']);
    shown.unmount();
  });

  it('a draft whose note nobody changed carries on from the document as it is now', async () => {
    const state = fresh({ documents: [{ ...NOTED }] });
    const shown = await openDocument(state);
    await writeNote('Mine');
    shown.unmount();
    Object.assign(state.documents[0] as object, { title: 'Renamed', etag: '"renamed"' });
    await reopen(state);
    const section = await notes();
    expect(
      within(section).queryByRole('group', { name: /changed this note/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    expect(ifMatches(state)).toEqual(['"renamed"']);
  });
});

describe('no draft of a note on a document no longer for everyone (the 5.35 review, W535-02)', () => {
  it('made Adults only during an edit, with its note changed: the draft goes, and no keystroke after keeps one', async () => {
    const state = fresh({ documents: [{ ...NOTED }] });
    await openDocument(state, 'adult');
    const { section, box } = await writeNote('Half-written');
    expect(drafts()).toEqual([DRAFT]);
    Object.assign(state.documents[0] as object, {
      ...THEIRS,
      visibility: 'adults',
      etag: '"adults"',
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await within(section).findByRole('group', { name: /changed this note/ });
    expect(drafts()).toEqual([]);
    fireEvent.change(box, { target: { value: 'Now an Adults only note: the safe code is 4471' } });
    expect(drafts()).toEqual([]);
  });

  it('made Adults only during an edit, its note as it was: saved again, and no draft left', async () => {
    const state = fresh({ documents: [{ ...NOTED }] });
    await openDocument(state, 'adult');
    const { section } = await writeNote('Half-written');
    Object.assign(state.documents[0] as object, { visibility: 'adults', etag: '"adults"' });
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    expect(ifMatches(state)).toEqual(['"abc"', '"adults"']);
    expect(drafts()).toEqual([]);
  });
});

describe('drafts are each person’s own (the 5.35 review, W535-07)', () => {
  it('a draft somebody else left in this tab is not shown, and is forgotten', async () => {
    sessionStorage.setItem(
      'fdv.note-draft.hh.somebody-else.doc-1',
      JSON.stringify({ text: 'Not yours', baseText: '', baseEtag: '"abc"', baseStamp: null }),
    );
    await openDocument(fresh({ documents: [{ ...PASSPORT }] }));
    const section = await notes();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Not yours')).not.toBeInTheDocument();
    expect(drafts()).toEqual([]);
  });

  it('a tab that takes over somebody else’s sign-in forgets the last person’s drafts', async () => {
    installFakeApi(fresh({ documents: [{ ...PASSPORT }] }));
    // This tab was signed in as somebody else; the session it finds is Mansoor's.
    localStorage.setItem(
      'fdv.session',
      JSON.stringify({
        refresh_token: 'hh.secret',
        household_id: 'hh',
        member_id: 'somebody-else',
        role: 'adult',
      }),
    );
    sessionStorage.setItem(
      'fdv.note-draft.hh.somebody-else.doc-1',
      JSON.stringify({ text: 'Theirs', baseText: '', baseEtag: '"abc"', baseStamp: null }),
    );
    const session = new Session();
    expect((await session.token()).kind).toBe('ok');
    expect(session.info?.member_id).toBe('me');
    expect(drafts()).toEqual([]);
  });
});

describe('the preview shows what Save stores (the 5.35 review, W535-08)', () => {
  it('trimmed, as it is sent', async () => {
    const state = fresh({ documents: [{ ...PASSPORT }] });
    await openDocument(state);
    const { section } = await writeNote(' ### Renewing\nonline\n');
    fireEvent.click(within(section).getByRole('button', { name: 'Preview' }));
    const preview = within(section).getByRole('region', { name: 'Preview of the note' });
    expect(within(preview).getByRole('heading', { level: 3, name: 'Renewing' })).toBeVisible();
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ notes: '### Renewing\nonline' });
    expect(within(section).getByRole('heading', { level: 3, name: 'Renewing' })).toBeVisible();
  });
});

/** Each block of a note as [its kind, its plain words], inline nodes by kind. */
function shape(text: string) {
  const inline = (nodes: NoteInline[]): string =>
    nodes
      .map((n) =>
        n.type === 'text'
          ? n.text
          : n.type === 'break'
            ? '/'
            : n.type === 'link'
              ? `link(${inline(n.children)} -> ${n.href})`
              : `${n.type}(${inline(n.children)})`,
      )
      .join('');
  return parseNotes(text).blocks.map((b: NoteBlock) =>
    b.type === 'list'
      ? `${b.ordered ? 'ol' : 'ul'}[${b.items
          .map((i) => `${i.checked === null ? '' : i.checked ? '[x]' : '[ ]'}${inline(i.children)}`)
          .join('|')}]`
      : `${b.type === 'heading' ? 'h3' : 'p'}(${inline(b.children)})`,
  );
}
/** The toolbar's `format` on [start, end) of `text`: the note it leaves, as it reads. */
const after = (text: string, start: number, end: number, format: NoteFormat) =>
  shape(formatNote(text, start, end, format).text);

describe('the toolbar’s marks read as the button meant (the 5.35 review, W535-05)', () => {
  it('bold and italic: spaces left outside, each line on its own, inside a word, and with nothing chosen', () => {
    // A word chosen with the space after it, as a double-click on Windows does.
    expect(after('Spare key', 0, 6, 'bold')).toEqual(['p(strong(Spare) key)']);
    expect(after('Spare key', 5, 9, 'italic')).toEqual(['p(Spare em(key))']);
    expect(after('  Spare key  ', 0, 13, 'bold')).toEqual(['p(  strong(Spare key)  )']);
    // At either end of the note.
    expect(after('Spare', 0, 5, 'bold')).toEqual(['p(strong(Spare))']);
    // Across lines: each line marked, a blank one left blank.
    expect(after('one\n\ntwo', 0, 8, 'bold')).toEqual(['p(strong(one))', 'p(strong(two))']);
    expect(after('one\ntwo', 1, 6, 'italic')).toEqual(['p(oem(ne)/em(tw)o)']);
    // A list's marker stays the list's.
    expect(after('- milk\n- eggs', 0, 13, 'bold')).toEqual(['ul[strong(milk)|strong(eggs)]']);
    // Inside a word.
    expect(after('Sparekey', 0, 5, 'bold')).toEqual(['p(strong(Spare)key)']);
    expect(after('snake_case', 6, 10, 'italic')).toEqual(['p(snake_em(case))']);
    // Nothing chosen: the word the caret is in, or a word to type over.
    expect(after('Spare key', 2, 2, 'bold')).toEqual(['p(strong(Spare) key)']);
    expect(formatNote('Spare ', 6, 6, 'italic')).toEqual({
      text: 'Spare *italic*',
      start: 7,
      end: 13,
    });
    expect(after('', 0, 0, 'bold')).toEqual(['p(strong(bold))']);
  });

  it('a link: its words, one line, an address to type over', () => {
    expect(after('see the rota ', 4, 13, 'link')).toEqual([
      'p(see link(the rota -> https://example.com) )',
    ]);
    expect(after('rota', 0, 0, 'link')).toEqual(['p(link(rota -> https://example.com))']);
    expect(after('', 0, 0, 'link')).toEqual(['p(link(link -> https://example.com))']);
    // Across lines: the first line only.
    expect(after('one\ntwo', 0, 7, 'link')).toEqual(['p(link(one -> https://example.com)/two)']);
    // A bracket in the words would end them early: read as a parenthesis.
    expect(after('a [draft]', 0, 9, 'link')).toEqual(['p(link(a (draft) -> https://example.com))']);
  });

  it('lists: every line touched, a marker replaced, blank lines left blank, the first line found', () => {
    expect(after('milk\neggs', 0, 9, 'list')).toEqual(['ul[milk|eggs]']);
    expect(after('milk\n\neggs', 0, 10, 'numbered')).toEqual(['ol[milk]', 'ol[eggs]']);
    expect(formatNote('milk\n\neggs', 0, 10, 'numbered').text).toBe('1. milk\n\n2. eggs');
    expect(after('milk\neggs', 2, 7, 'checklist')).toEqual(['ul[[ ]milk|[ ]eggs]']);
    expect(after('1. milk\n2. eggs', 0, 15, 'list')).toEqual(['ul[milk|eggs]']);
    expect(after('- [ ] milk', 0, 0, 'numbered')).toEqual(['ol[milk]']);
    // The caret on a note's first line, which is blank: an item there.
    expect(formatNote('\nfoo', 0, 0, 'list').text).toBe('- \nfoo');
    // A choice that ends at the start of a line leaves that line alone.
    expect(formatNote('one\ntwo', 0, 4, 'list').text).toBe('- one\ntwo');
    // Indented, as pasted: the item is the words.
    expect(after('   milk', 0, 0, 'list')).toEqual(['ul[milk]']);
  });

  it('Bold or Italic pressed again takes the mark off (the second round, N535W-01)', () => {
    // Bold twice: the words, still chosen, lose the marks they were given.
    const bold = formatNote('Spare key', 0, 5, 'bold');
    expect(bold).toEqual({ text: '**Spare** key', start: 2, end: 7 });
    expect(formatNote(bold.text, bold.start, bold.end, 'bold')).toEqual({
      text: 'Spare key',
      start: 0,
      end: 5,
    });
    // Italic twice.
    const italic = formatNote('Spare key', 0, 5, 'italic');
    expect(shape(italic.text)).toEqual(['p(em(Spare) key)']);
    expect(formatNote(italic.text, italic.start, italic.end, 'italic').text).toBe('Spare key');
    // Bold with the caret inside a bold word, or with its marks chosen too.
    expect(formatNote('**Spare** key', 4, 4, 'bold').text).toBe('Spare key');
    expect(formatNote('**Spare** key', 0, 9, 'bold').text).toBe('Spare key');
    // A `**` is bold, never italic: Italic on a bold word makes it both, and
    // pressed again leaves it bold; Bold on both leaves it italic.
    const both = formatNote('**Spare** key', 4, 4, 'italic');
    expect(shape(both.text)).toEqual(['p(em(strong(Spare)) key)']);
    expect(formatNote(both.text, both.start, both.end, 'italic').text).toBe('**Spare** key');
    expect(formatNote(both.text, both.start, both.end, 'bold').text).toBe('*Spare* key');
    // Several lines, all bold: all lose it. Some: the rest gain it.
    expect(formatNote('**one**\n**two**', 0, 15, 'bold').text).toBe('one\ntwo');
    expect(formatNote('**one**\ntwo', 0, 11, 'bold').text).toBe('**one**\n**two**');
    // Never a run of four, which reads as asterisks: part of a bold run is left as it is.
    expect(formatNote('**Spare key**', 2, 7, 'bold').text).toBe('**Spare key**');
  });

  it('Checklist keeps a box as it is: done stays done (the second round, N535W-03)', () => {
    expect(after('- [x] a\nb', 0, 9, 'checklist')).toEqual(['ul[[x]a|[ ]b]']);
    expect(formatNote('- [x] paid\n- [ ] send\n- book', 0, 27, 'checklist').text).toBe(
      '- [x] paid\n- [ ] send\n- [ ] book',
    );
    expect(formatNote('1. call\n- [x] paid', 0, 18, 'checklist').text).toBe(
      '- [ ] call\n- [x] paid',
    );
    expect(formatNote('- [x] paid', 0, 0, 'checklist').text).toBe('- [x] paid');
  });
});

describe('a link’s address, as the browser will reach it (the 5.35 review, X535-02)', () => {
  it('a host in another script as punycode, a name before the host not a link, and each part isolated', async () => {
    const note = [
      'Pay https://p\u0430ypal.example/login today.',
      'Not [the bank](https://bank.example@evil.example) either.',
      'And [\u202eknab eht](https://bank.example/pay) then.',
    ].join('\n');
    await openDocument(fresh({ documents: [{ ...PASSPORT, notes: note }] }));
    const section = await notes();
    const links = within(section).getAllByRole('link');
    expect(links).toHaveLength(2);
    const [homoglyph, words] = links as [HTMLAnchorElement, HTMLAnchorElement];
    // The address shown is the one followed: punycode, never the look-alike.
    expect(homoglyph.getAttribute('href')).toMatch(/^https:\/\/xn--[a-z0-9-]+\.example\/login$/);
    expect(homoglyph.textContent).toBe(homoglyph.getAttribute('href'));
    expect(homoglyph.textContent).not.toContain('\u0430');
    expect(homoglyph.querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
    // A name before the host is no link, and every character is still there.
    expect(section).toHaveTextContent('Not [the bank](https://bank.example@evil.example) either.');
    expect(section.querySelector('a[href*="evil"]')).toBeNull();
    // Words and address each in an isolate: an override in the words stays in them.
    expect(words.getAttribute('href')).toBe('https://bank.example/pay');
    expect(words.querySelector('bdi')?.textContent).toBe('\u202eknab eht');
    const address = words.nextElementSibling?.querySelector('bdi');
    expect(address?.getAttribute('dir')).toBe('ltr');
    expect(address?.textContent).toBe('https://bank.example/pay');
    await expectAccessible();
  });
});

describe('the household’s questions on their own (the 5.35 review, W535-10)', () => {
  it('from Reminders: just the questions, with the answers given already, and back to Reminders once saved', async () => {
    const state = fresh({
      documents: [{ ...PASSPORT }],
      profileAnswered: false,
      profile: {
        owns_home: false,
        rents_home: true,
        vehicle_count: 2,
        has_pets: true,
        country: 'GB',
      },
    });
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/reminders');
    render(<App />);
    const missing = await screen.findByRole('region', { name: 'We noticed something missing' });
    fireEvent.click(within(missing).getByRole('link', { name: 'Answer the questions' }));
    await screen.findByRole('heading', { name: 'A few quick questions' });
    expect(window.location.pathname).toBe('/household-questions');
    expect(await screen.findByRole('button', { name: 'We rent' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pets' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'A business' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByLabelText('Where you live (country code)')).toHaveValue('GB');
    // Not the first-run wizard: no steps, no Skip, nothing about the vault's first owner.
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Children' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/owner of this vault|Who is in the family/);
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'We own it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save the answers' }));
    await screen.findByRole('heading', { name: 'Needs attention' });
    expect(window.location.pathname).toBe('/reminders');
    const put = state.calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/profile');
    expect(put?.body).toEqual({
      country: 'GB',
      owns_home: true,
      rents_home: false,
      vehicle_count: 2,
      has_pets: true,
      has_business: false,
    });
  });

  it('somebody who may not answer them is told who can, and offered nothing to save', async () => {
    installFakeApi(fresh({ documents: [{ ...PASSPORT }] }));
    signedIn('teen');
    window.history.replaceState({}, '', '/household-questions');
    render(<App />);
    expect(await screen.findByText(/An adult in the family answers these/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save the answers' })).not.toBeInTheDocument();
  });
});
