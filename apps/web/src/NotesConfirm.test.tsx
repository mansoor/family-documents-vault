import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { NOTE_ASKS } from './notes.js';
import { writeInto } from './note-editor-testing.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Notes ask "Confirm it's you" as documents do (0.9.0-dev.87): an Only me or
 * an Essential note is listed by its title and date alone, and its words are
 * shown only once it is confirmed to be them — cancelled, the note says so,
 * with the way to confirm again. A note is made Essential, or stops being so,
 * from its row of actions, as a document is from its ⋯; Sensitive is switched
 * under its words while it is written, and saved with them (24 Nov 2026).
 */

function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      return {
        matches: Boolean(minWidth) && px >= Number(minWidth?.[1]),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  atWidth(1280);
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  vi.restoreAllMocks();
});

const note = (over: Record<string, unknown>) => ({
  ...PASSPORT,
  type_key: 'note',
  category: 'other',
  identifier: null,
  issued: null,
  expires: null,
  physical_location: null,
  is_essential: false,
  latest_version_id: null,
  versions: 0,
  tags: [],
  sensitive: null,
  sensitive_effective: false,
  notes_updated_at: '2026-09-25T15:12:00Z',
  notes_updated_by_name: 'Sara Seikh',
  ...over,
});

const SAFE = note({
  id: 'note-safe',
  title: 'The safe',
  is_essential: true,
  notes: 'Behind the kestrel clock',
  updated_at: '2026-09-25T15:12:00Z',
  etag: '"safe"',
});
const DIARY = note({
  id: 'note-diary',
  title: 'Diary',
  visibility: 'private',
  notes: 'Pelican crossing at noon',
  updated_at: '2026-09-24T15:12:00Z',
  etag: '"diary"',
});
const BOILER = note({
  id: 'note-boiler',
  title: 'Boiler',
  notes: 'Ring the heron plumber',
  updated_at: '2026-09-20T15:12:00Z',
  etag: '"boiler"',
});

const withNotes = (over: Partial<FakeState> = {}) =>
  fresh({
    notes: true,
    documents: [SAFE, DIARY, BOILER].map((d) => ({ ...d })),
    sensitive: true,
    ...over,
  });

async function openAt(
  state: FakeState,
  path: string,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: /Notes|Note|New note/ });
}

async function expectAccessible() {
  const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

describe('an Only me or an Essential note, before it is confirmed', () => {
  it('is listed by its title and date alone, and never found by its words', async () => {
    const state = withNotes({ stepUpNeeded: true });
    await openAt(state, '/notes');
    const list = await screen.findByRole('list', { name: 'Notes' });
    const items = within(list).getAllByRole('link');
    expect(items.map((a) => a.querySelector('.notes-item-title')?.textContent)).toEqual([
      'The safe',
      'Diary',
      'Boiler',
    ]);
    expect(items[0]).toHaveTextContent('25 Sept');
    expect(items[0]).toHaveTextContent('Essential');
    expect(items[1]).toHaveTextContent('Only me');
    expect(items[0]?.querySelector('.notes-item-preview')).toBeNull();
    expect(items[1]?.querySelector('.notes-item-preview')).toBeNull();
    expect(items[2]).toHaveTextContent('Ring the heron plumber');
    expect(document.body).not.toHaveTextContent('kestrel');
    expect(document.body).not.toHaveTextContent('Pelican');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in notes' }), {
      target: { value: 'kestrel' },
    });
    expect(await screen.findByText('No note has “kestrel” in it.')).toBeInTheDocument();
  });

  it('asks to confirm it is you before its words are shown; cancelled, says so, and asks again', async () => {
    const state = withNotes({ stepUpNeeded: true });
    await openAt(state, '/notes/note-safe');
    const asked = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(asked).toHaveTextContent('Please confirm it is you to open an Essential document.');
    fireEvent.click(within(asked).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(NOTE_ASKS)).toBeInTheDocument();
    // Its title and date, as the list gives them; the way on has the focus.
    expect(screen.getByRole('heading', { level: 2, name: 'The safe' })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm it’s you' })).toHaveFocus(),
    );
    expect(document.body).not.toHaveTextContent('kestrel');
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm it’s you' }));
    const again = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(within(again).getByLabelText(/password/i), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Behind the kestrel clock')).toBeInTheDocument();
    expect(screen.queryByText(NOTE_ASKS)).toBeNull();
  });

  it('a save asks too, and the words stay in the editor if it is not confirmed', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-diary');
    await screen.findByText('Pelican crossing at noon');
    // Five minutes later.
    state.stepUpNeeded = true;
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Diary, 1 Oct' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const asked = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(asked).toHaveTextContent('to open a document only you can see');
    fireEvent.click(within(asked).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Just checking it is you' })).toBeNull(),
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Diary, 1 Oct');
    expect(state.documents.find((d) => d.id === 'note-diary')?.title).toBe('Diary');
    // Let go of, so nothing unsaved is left asking as the next test begins.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull());
    await waitFor(() => expect(window.location.pathname).toBe('/notes/note-diary'));
  });
});

describe('a note’s words, kept as it changes', () => {
  it('made Essential, it keeps the words in hand where the answer withholds them, and an edit saves them', async () => {
    const state = withNotes({ withholdNoteWords: true });
    await openAt(state, '/notes/note-boiler');
    const row = await screen.findByRole('toolbar', { name: 'Note actions' });
    fireEvent.click(within(row).getByRole('button', { name: 'Make it Essential' }));
    expect(await screen.findByText('This note is Essential now.')).toBeInTheDocument();
    const pane = screen.getByRole('article');
    expect(within(pane).getByText('Ring the heron plumber')).toBeInTheDocument();
    // Edited, and saved as it was: its words, never nothing.
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    fireEvent.click(await within(pane).findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        state.calls
          .filter((c) => c.method === 'PATCH')
          .map((c) => (c.body as { notes?: unknown }).notes)
          .filter((n) => n !== undefined),
      ).toEqual(['Ring the heron plumber']),
    );
    // No draft is kept of it.
    expect(Object.keys(sessionStorage).filter((k) => k.includes('note-boiler'))).toEqual([]);
  });
});

describe('a note’s Essential', () => {
  it('Make it Essential from the row, at once, as a document’s ⋯ does; Stop it being Essential asks to confirm it’s you first', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler');
    const row = await screen.findByRole('toolbar', { name: 'Note actions' });
    // No section for it any more: an action, beside Print.
    expect(within(row).queryByRole('button', { name: /Essential and sensitive/ })).toBeNull();
    const make = within(row).getByRole('button', { name: 'Make it Essential' });
    expect(make).not.toHaveAttribute('aria-expanded');
    fireEvent.click(make);
    expect(await screen.findByText('This note is Essential now.')).toBeInTheDocument();
    await waitFor(() =>
      expect(state.calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])).toEqual([
        ['/api/v1/documents/note-boiler', { is_essential: true }],
      ]),
    );
    // Its details say so, for anybody who reads it.
    expect(document.querySelector('.note-pane-meta')).toHaveTextContent(
      /^Everyone in the family · Essential · changed /,
    );
    const stop = within(row).getByRole('button', { name: 'Stop it being Essential' });
    // Off, five minutes later: asked first, and kept Essential if not confirmed.
    state.stepUpNeeded = true;
    fireEvent.click(stop);
    const asked = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(asked).toHaveTextContent('to open an Essential document');
    await expectAccessible();
    fireEvent.click(within(asked).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Just checking it is you' })).toBeNull(),
    );
    expect(state.documents.find((d) => d.id === 'note-boiler')?.is_essential).toBe(true);
    // Confirmed: no longer Essential.
    fireEvent.click(within(row).getByRole('button', { name: 'Stop it being Essential' }));
    const again = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(within(again).getByLabelText(/password/i), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('This note is not Essential any more.')).toBeInTheDocument();
    expect(state.documents.find((d) => d.id === 'note-boiler')?.is_essential).toBe(false);
    expect(within(row).getByRole('button', { name: 'Make it Essential' })).toBeVisible();
  });

  it('a viewer is offered neither, and reads Essential in its details', async () => {
    await openAt(withNotes(), '/notes/note-safe', 'viewer');
    const row = await screen.findByRole('toolbar', { name: 'Note actions' });
    expect(within(row).queryByRole('button', { name: /Essential/ })).toBeNull();
    expect(document.querySelector('.note-pane-meta')).toHaveTextContent(
      /^Everyone in the family · Essential · changed /,
    );
  });
});

describe('a note’s Sensitive, switched under its words', () => {
  it('shown only while it is written, at the end of the Save and Cancel row; Cancel puts it back, Save saves it with the words', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    // Read, not written: no switch.
    expect(within(pane).queryByRole('switch', { name: 'Sensitive' })).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    const sensitive = await within(pane).findByRole('switch', { name: 'Sensitive' });
    expect(sensitive).not.toBeChecked();
    // Beside Save and Cancel, after them.
    const save = within(pane).getByRole('button', { name: 'Save' });
    const saveRow = save.closest('.row') as HTMLElement;
    expect(saveRow).toContainElement(sensitive);
    expect(
      within(saveRow).getByRole('button', { name: 'Cancel' }).compareDocumentPosition(sensitive) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Switched, then Cancel: nothing sent, and it is as it was.
    fireEvent.click(sensitive);
    expect(sensitive).toBeChecked();
    expect(state.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    fireEvent.click(within(saveRow).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(pane).queryByRole('switch')).toBeNull());
    expect(state.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    expect(await within(pane).findByRole('switch', { name: 'Sensitive' })).not.toBeChecked();
    // Switched, then Save: one save, the words and Sensitive together.
    fireEvent.click(within(pane).getByRole('switch', { name: 'Sensitive' }));
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This note is sensitive now.')).toBeInTheDocument();
    expect(state.calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])).toEqual([
      ['/api/v1/documents/note-boiler', { notes: 'Ring the heron plumber', sensitive: true }],
    ]);
    expect(state.documents.find((d) => d.id === 'note-boiler')).toMatchObject({
      sensitive: true,
    });
    // Its details say so; no switch once it is read again.
    await waitFor(() => expect(within(pane).queryByRole('switch')).toBeNull());
    expect(document.querySelector('.note-pane-meta')).toHaveTextContent(
      /^Everyone in the family · Sensitive · changed /,
    );
    await expectAccessible();
  });

  it('a save that leaves it as it was sends nothing about it', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    const sensitive = await within(pane).findByRole('switch', { name: 'Sensitive' });
    fireEvent.click(sensitive);
    fireEvent.click(sensitive);
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(pane).queryByRole('switch')).toBeNull());
    expect(state.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { notes: 'Ring the heron plumber' },
    ]);
  });

  it('made sensitive while links outside the family still give it: said, and where to end them', async () => {
    const state = withNotes({ liveLinks: { 'note-boiler': 2 } });
    await openAt(state, '/notes/note-boiler');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    fireEvent.click(await within(pane).findByRole('switch', { name: 'Sensitive' }));
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'This note is sensitive now. It is still shared outside the family by 2 links: end them in Share a link if they should stop.',
      ),
    ).toBeInTheDocument();
  });

  it('where the household has no Sensitive, there is no switch', async () => {
    await openAt(withNotes({ sensitive: false }), '/notes/note-boiler');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    await within(pane).findByRole('button', { name: 'Save' });
    expect(within(pane).queryByRole('switch', { name: 'Sensitive' })).toBeNull();
  });

  it('a teen may make their own note sensitive, never not', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler', 'teen');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    fireEvent.click(await within(pane).findByRole('switch', { name: 'Sensitive' }));
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This note is sensitive now.')).toBeInTheDocument();
    // Sensitive now: written again, it says so, and there is no switch to undo it.
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    await within(pane).findByRole('button', { name: 'Save' });
    expect(within(pane).queryByRole('switch', { name: 'Sensitive' })).toBeNull();
    expect(
      within(pane).getByText('Sensitive. Only an adult can mark a document not sensitive.'),
    ).toBeVisible();
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(pane).queryByRole('button', { name: 'Save' })).toBeNull());
    expect(
      state.calls
        .filter((c) => c.method === 'PATCH')
        .map((c) => (c.body as { sensitive?: unknown }).sensitive),
    ).toEqual([true, undefined]);
  });

  /** Somebody else makes the note sensitive while it is being written. */
  const madeSensitiveMeanwhile = (state: FakeState) =>
    Object.assign(state.documents.find((d) => d.id === 'note-boiler') as object, {
      sensitive: true,
      sensitive_effective: true,
      etag: '"boiler-sensitive"',
    });
  const patches = (state: FakeState) =>
    state.calls.filter((c) => c.method === 'PATCH').map((c) => c.body);

  /** The page learns of it: Make it Essential, refused for the older copy, loads the note again. */
  async function pageLearnsOfIt() {
    const row = screen.getByRole('toolbar', { name: 'Note actions' });
    fireEvent.click(within(row).getByRole('button', { name: 'Make it Essential' }));
    expect(
      await screen.findByText(
        'This note was changed somewhere else, so it has been loaded again. Try again if it still needs changing.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('.note-pane-meta')).toHaveTextContent(/· Sensitive ·/),
    );
  }

  it('a teen’s switch moved and put back sends nothing about it, and an adult’s Sensitive made meanwhile stays', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler', 'teen');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    const sensitive = await within(pane).findByRole('switch', { name: 'Sensitive' });
    fireEvent.click(sensitive);
    fireEvent.click(sensitive);
    madeSensitiveMeanwhile(state);
    await pageLearnsOfIt();
    // Sensitive now, and a teen's to keep so.
    expect(
      within(pane).getByText('Sensitive. Only an adult can mark a document not sensitive.'),
    ).toBeVisible();
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(pane).queryByRole('button', { name: 'Save' })).toBeNull());
    expect(patches(state)).toEqual([{ is_essential: true }, { notes: 'Ring the heron plumber' }]);
    expect(state.documents.find((d) => d.id === 'note-boiler')).toMatchObject({
      sensitive: true,
    });
  });

  it('an adult’s switch moved and put back never undoes Sensitive made meanwhile', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    const sensitive = await within(pane).findByRole('switch', { name: 'Sensitive' });
    fireEvent.click(sensitive);
    fireEvent.click(sensitive);
    madeSensitiveMeanwhile(state);
    await pageLearnsOfIt();
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(pane).queryByRole('button', { name: 'Save' })).toBeNull());
    expect(patches(state)).toEqual([{ is_essential: true }, { notes: 'Ring the heron plumber' }]);
    expect(state.documents.find((d) => d.id === 'note-boiler')).toMatchObject({
      sensitive: true,
    });
  });

  it('a switch left alone sends nothing about it, whatever was done meanwhile', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    await within(pane).findByRole('switch', { name: 'Sensitive' });
    madeSensitiveMeanwhile(state);
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(pane).queryByRole('button', { name: 'Save' })).toBeNull());
    // Refused once for the older copy, then saved from the note as it is now: the words alone.
    expect(patches(state)).toEqual([
      { notes: 'Ring the heron plumber' },
      { notes: 'Ring the heron plumber' },
    ]);
    expect(state.documents.find((d) => d.id === 'note-boiler')).toMatchObject({
      sensitive: true,
    });
  });

  it('a switch moved and nothing else is kept as a draft through a reload; moved back, there is none', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler');
    let pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    fireEvent.click(await within(pane).findByRole('switch', { name: 'Sensitive' }));
    const drafts = () => Object.keys(sessionStorage).filter((k) => k.includes('note-boiler'));
    expect(drafts()).toHaveLength(1);
    // Reloaded: the switch as it was left, and said to be a draft brought back.
    cleanup();
    await openAt(state, '/notes/note-boiler');
    pane = await screen.findByRole('article', { name: 'Boiler' });
    expect(await within(pane).findByRole('switch', { name: 'Sensitive' })).toBeChecked();
    expect(pane).toHaveTextContent('Your unsaved draft of this note is back.');
    // Moved back: nothing to keep, and nothing brought back after a reload.
    fireEvent.click(within(pane).getByRole('switch', { name: 'Sensitive' }));
    expect(drafts()).toEqual([]);
    cleanup();
    await openAt(state, '/notes/note-boiler');
    pane = await screen.findByRole('article', { name: 'Boiler' });
    await within(pane).findByRole('button', { name: 'Edit' });
    expect(within(pane).queryByRole('switch')).toBeNull();
    expect(pane).not.toHaveTextContent('Your unsaved draft of this note is back.');
    // A draft kept with nothing changed in it is not brought back either.
    cleanup();
    sessionStorage.setItem(
      'fdv.note-draft.hh.me.note-boiler',
      JSON.stringify({
        text: 'Ring the heron plumber',
        baseText: 'Ring the heron plumber',
        baseEtag: '"boiler"',
        baseStamp: null,
        title: 'Boiler',
        baseTitle: 'Boiler',
      }),
    );
    await openAt(state, '/notes/note-boiler');
    pane = await screen.findByRole('article', { name: 'Boiler' });
    await within(pane).findByRole('button', { name: 'Edit' });
    expect(pane).not.toHaveTextContent('Your unsaved draft of this note is back.');
    expect(drafts()).toEqual([]);
  });

  it('a new note may start Essential and sensitive', async () => {
    const state = withNotes();
    await openAt(state, '/notes/new');
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Spare key' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Essential' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Sensitive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/documents')?.body,
      ).toMatchObject({
        title: 'Spare key',
        is_essential: true,
        sensitive: true,
      }),
    );
  });
});

// Last: a note made here moves the page on after the test has looked.
describe('a new Essential note', () => {
  it('a note made Essential is opened with what was written, never asked for it', async () => {
    const state = withNotes({ stepUpNeeded: true });
    await openAt(state, '/notes/new');
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Spare key' },
    });
    writeInto(screen.getByRole('textbox', { name: 'Note' }), 'Under the third pot');
    fireEvent.click(screen.getByRole('switch', { name: 'Essential' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Under the third pot')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Just checking it is you' })).toBeNull();
    expect(
      state.calls.filter((c) => c.method === 'GET' && /\/api\/v1\/documents\/note-/.test(c.url)),
    ).toEqual([]);
  });
});
