import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { writeInto, writtenIn } from './note-editor-testing.js';
import { Session } from './session.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Notes you can write, the review round (5.35): a refusal (409) told apart
 * from somebody changing the note; a draft that remembers the note it began
 * from, and is each person's own; no draft once a document is no longer for
 * everyone; what is saved is what the page shows (since 0.9.0, N1, the
 * editor shows the note as it reads: no preview, no marks typed); a link's
 * address as the browser will reach it; and the household's questions on
 * their own.
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
  writeInto(box, text);
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
    expect(writtenIn(within(section).getByRole('textbox', { name: 'Notes' }))).toBe(
      'Renew in March',
    );
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
    expect(writtenIn(box)).toBe('Theirs: renew in March, or April');
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
    expect(writtenIn(within(section).getByRole('textbox', { name: 'Notes' }))).toBe('Mine');
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
    writeInto(box, 'Now an Adults only note: the safe code is 4471');
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
    expect(screen.queryByText('Not yours')).not.toBeInTheDocument();
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

describe('what Save stores is what the page shows (the 5.35 review, W535-08; 0.9.0, N1)', () => {
  it('trimmed, as it reads: a heading and a line, the note the editor shows', async () => {
    const state = fresh({ documents: [{ ...PASSPORT }] });
    await openDocument(state);
    const { section } = await writeNote('\n### Renewing\nonline\n');
    // No preview to ask for: the words are shown as they will read.
    expect(within(section).queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    const box = within(section).getByRole('textbox', { name: 'Notes' });
    expect(within(box).getByRole('heading', { level: 3, name: 'Renewing' })).toBeVisible();
    fireEvent.click(within(section).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(within(section).queryByRole('textbox')).not.toBeInTheDocument());
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ notes: '### Renewing\n\nonline' });
    expect(within(section).getByRole('heading', { level: 3, name: 'Renewing' })).toBeVisible();
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
