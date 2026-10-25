import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { writeInto, writtenIn } from './note-editor-testing.js';
import { SharePage } from './screens/SharePage.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Notes (0.9.0, N1), on the web: Notes in the left bar; the notes listed
 * beside the one that is open, the list as wide as each person left it; a
 * note read, then written in the one editor, Saved or Cancelled, one editor
 * at a time; leaving with anything unsaved asked about; on a phone, the
 * list and the note two screens. And a note's link, read on its page.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';

let width = 1280;
function atWidth(px: number) {
  width = px;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || width >= Number(minWidth[1])) &&
          (!minHeight || 900 >= Number(minHeight[1])) &&
          Boolean(minWidth || minHeight),
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

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

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
  notes_updated_at: '2026-09-25T15:12:00Z',
  notes_updated_by_name: 'Sara Seikh',
  ...over,
});

const BOILER = note({
  id: 'note-boiler',
  title: 'Boiler',
  notes: '# Boiler\nRing **Ann** at Northgate Heating first.\n\n- [x] bleed the radiators',
  updated_at: '2026-09-25T15:12:00Z',
  etag: '"boiler"',
});
const STOPCOCK = note({
  id: 'note-stopcock',
  title: 'Where the stopcock is',
  notes: 'Under the kitchen sink',
  updated_at: '2026-09-20T09:14:00Z',
  etag: '"stopcock"',
});
const MINE = note({
  id: 'note-mine',
  title: 'Where the deeds are',
  visibility: 'private',
  notes: 'With Hart & Co',
  updated_at: '2026-09-10T09:14:00Z',
  etag: '"mine"',
});
const THEIRS = note({
  id: 'note-theirs',
  title: 'Sara’s own',
  visibility: 'private',
  owner_member_id: 'm-2',
  notes: 'Never yours to see',
  updated_at: '2026-09-26T09:14:00Z',
});

const withNotes = (over: Partial<FakeState> = {}) =>
  fresh({
    notes: true,
    // Copies: a test's edits are its own.
    documents: [BOILER, STOPCOCK, MINE, THEIRS, PASSPORT].map((d) => ({ ...d })),
    ...over,
  });

async function openAt(state: FakeState, path: string, role: Role = 'owner') {
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  const shown = render(<App />);
  await screen.findByRole('heading', { level: 1, name: /Notes|Note|New note/ });
  return shown;
}
const list = () => screen.findByRole('list', { name: 'Notes' });

describe('Notes in the left bar', () => {
  it('for whoever is given notes, a viewer too; not in a vault from before them', async () => {
    for (const role of ['owner', 'viewer'] as const) {
      installFakeApi(withNotes());
      signedIn(role);
      window.history.replaceState({}, '', '/');
      const shown = render(<App />);
      const nav = await screen.findByRole('navigation', { name: 'Sections' });
      const link = await within(nav).findByRole('link', { name: 'Notes' });
      expect(link).toHaveAttribute('href', '/notes');
      shown.unmount();
    }
    installFakeApi(fresh({ documents: [{ ...PASSPORT }] }));
    signedIn('owner');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    await within(nav).findByRole('link', { name: 'Documents' });
    expect(within(nav).queryByRole('link', { name: 'Notes' })).not.toBeInTheDocument();
  });
});

describe('the notes, listed beside the one open (1280)', () => {
  it('each with its name, when it changed and its first words; nobody else’s Only me; found within', async () => {
    const state = withNotes();
    await openAt(state, '/notes');
    const items = within(await list()).getAllByRole('link');
    expect(items.map((a) => a.querySelector('.notes-item-title')?.textContent)).toEqual([
      'Boiler',
      'Where the stopcock is',
      'Where the deeds are',
    ]);
    expect(items[0]).toHaveTextContent(
      'Boiler Ring Ann at Northgate Heating first. - [x] bleed the radiators',
    );
    expect(items[0]).toHaveTextContent('25 Sept');
    expect(items[2]).toHaveTextContent('Only me');
    expect(document.body).not.toHaveTextContent('Never yours to see');
    await expectAccessible();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in notes' }), {
      target: { value: 'ann at' },
    });
    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'Notes' })).getAllByRole('link')).toHaveLength(
        1,
      ),
    );
    expect(state.calls.some((c) => /^\/api\/v1\/notes\?q=ann(\+|%20)at$/.test(c.url))).toBe(true);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in notes' }), {
      target: { value: 'zebra' },
    });
    expect(await screen.findByText('No note has “zebra” in it.')).toBeVisible();
  });

  it('with none yet, says what notes are for, and that they are not for passwords', async () => {
    await openAt(fresh({ notes: true, documents: [{ ...PASSPORT }] }), '/notes');
    expect(
      await screen.findByText(/Notes keep what the family knows: where things are/),
    ).toBeVisible();
    expect(screen.getByText(/A note is not a password manager/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'New note' })).toHaveAttribute('href', '/notes/new');
    await expectAccessible();
  });

  it('a note opened is read: its name, who sees it, its words drawn, its controls', async () => {
    await openAt(withNotes(), '/notes');
    fireEvent.click(within(await list()).getByRole('link', { name: /^Boiler/ }));
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    await waitFor(() =>
      expect(within(pane).getByRole('heading', { level: 2, name: 'Boiler' })).toHaveFocus(),
    );
    expect(within(pane).getByText(/^Everyone in the family ·/)).toBeVisible();
    expect(within(pane).getByText('Ann').tagName).toBe('STRONG');
    expect(within(pane).getByRole('listitem')).toHaveTextContent('Done: bleed the radiators');
    expect(within(await list()).getByRole('link', { name: /^Boiler/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Its own controls, as a document's: who sees it, tags, collections, a link, the Trash,
    // in the one row under it (0.9.0), each section opened from its button.
    expect(within(pane).getByRole('button', { name: 'Edit' })).toBeVisible();
    const row = within(pane).getByRole('toolbar', { name: 'Note actions' });
    expect(within(row).getByRole('button', { name: 'Download' })).toBeVisible();
    expect(within(row).getByRole('button', { name: /Move to the Trash/ })).toBeVisible();
    // Nothing of a file: no versions, no pages, no Download of a file.
    expect(within(pane).queryByRole('heading', { name: 'History' })).not.toBeInTheDocument();
    // Edit on the title's line, and a thin line between its words and the rest.
    const head = within(pane).getByRole('heading', { level: 2, name: 'Boiler' }).closest('header');
    expect(head).not.toBeNull();
    expect(within(head as HTMLElement).getByRole('button', { name: 'Edit' })).toBeVisible();
    const rule = within(pane).getByRole('separator');
    const words = within(pane).getByRole('listitem');
    const download = within(row).getByRole('button', { name: 'Download' });
    expect(words.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rule.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expectAccessible();
    // Its tags and its link, each a section of the row, opened from its button.
    fireEvent.click(within(row).getByRole('button', { name: /^Tags/ }));
    expect(within(pane).getByRole('heading', { name: 'Tags' })).toBeVisible();
    fireEvent.click(within(row).getByRole('button', { name: /^Share a link/ }));
    expect(
      within(pane).getByRole('heading', { name: 'Send this to someone outside the family' }),
    ).toBeVisible();
  });

  it('Edit writes it in the one editor, its title with it; Save keeps it, Cancel leaves it as it was', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-stopcock');
    const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    const box = within(pane).getByRole('textbox', { name: 'Note' });
    expect(within(pane).getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
    expect(writtenIn(box)).toBe('Under the kitchen sink');
    // Cancel: nothing sent.
    fireEvent.click(within(pane).getByRole('button', { name: 'Cancel' }));
    expect(within(pane).queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument();
    expect(state.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    // Edit again, the words and the title changed, saved with the ETag it began from.
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Under the **kitchen** sink');
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'The stopcock' },
    });
    await expectAccessible();
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(pane).queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument(),
    );
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('/api/v1/documents/note-stopcock');
    expect(patch?.body).toEqual({ notes: 'Under the **kitchen** sink', title: 'The stopcock' });
    expect(patch?.headers?.['if-match']).toBe('"stopcock"');
    expect(within(pane).getByText('kitchen').tagName).toBe('STRONG');
    expect(await screen.findByRole('heading', { level: 2, name: 'The stopcock' })).toBeVisible();
  });

  it('one editor at a time: changed by someone else meanwhile, theirs is shown, and keeping mine is a choice', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-stopcock');
    const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Mine: under the sink');
    // Sara saves first.
    Object.assign(state.documents[1] as object, {
      notes: 'Theirs: in the garage',
      notes_updated_at: '2026-09-26T08:00:00Z',
      notes_updated_by_name: 'Sara Seikh',
      etag: '"sara"',
    });
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    const said = await within(pane).findByRole('group', { name: /changed this note/ });
    expect(said).toHaveTextContent('Sara Seikh changed this note while you were writing.');
    expect(said).toHaveTextContent('Theirs: in the garage');
    expect(writtenIn(within(pane).getByRole('textbox', { name: 'Note' }))).toBe(
      'Mine: under the sink',
    );
    await expectAccessible();
    fireEvent.click(within(said).getByRole('button', { name: 'Save mine over theirs' }));
    await waitFor(() =>
      expect(within(pane).queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument(),
    );
    expect(
      state.calls.filter((c) => c.method === 'PATCH').map((c) => c.headers?.['if-match']),
    ).toEqual(['"stopcock"', '"sara"']);
  });

  it('leaving with something unsaved is asked about first; Keep editing keeps it', async () => {
    await openAt(withNotes(), '/notes/note-stopcock');
    const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Half-written');
    fireEvent.click(within(await list()).getByRole('link', { name: /^Boiler/ }));
    const ask = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/notes/note-stopcock');
    expect(writtenIn(within(pane).getByRole('textbox', { name: 'Note' }))).toBe('Half-written');
    // The sidebar too; and Leave goes.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
        name: 'Documents',
      }),
    );
    const again = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents'));
  });

  it('the browser’s Back, the search box and Sign out are asked about too (the N1 review)', async () => {
    const state = withNotes();
    installFakeApi(state);
    signedIn('owner');
    // Came from the Boiler note.
    window.history.replaceState({}, '', '/notes/note-boiler');
    window.history.pushState({}, '', '/notes/note-stopcock');
    render(<App />);
    const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Half-written');
    // Back (a phone's back button too): the page stays, and asks.
    act(() => window.history.back());
    const back = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    expect(window.location.pathname).toBe('/notes/note-stopcock');
    fireEvent.click(within(back).getByRole('button', { name: 'Cancel' }));
    expect(writtenIn(within(pane).getByRole('textbox', { name: 'Note' }))).toBe('Half-written');
    // The search box.
    const field = screen.getByRole('searchbox', { name: 'Search the vault' });
    fireEvent.change(field, { target: { value: 'boiler' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    const search = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    fireEvent.click(within(search).getByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/notes/note-stopcock');
    // Sign out: asked, and staying signs nobody out.
    fireEvent.click(await screen.findByRole('button', { name: /^Your account/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    const out = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    fireEvent.click(within(out).getByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/notes/note-stopcock');
    expect(state.calls.some((c) => c.url.includes('/sign-out') || c.url.includes('/logout'))).toBe(
      false,
    );
    expect(writtenIn(within(pane).getByRole('textbox', { name: 'Note' }))).toBe('Half-written');
    // Back again, and Leave: gone back where they were.
    act(() => window.history.back());
    const leave = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    fireEvent.click(within(leave).getByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => expect(window.location.pathname).toBe('/notes/note-boiler'));
    // And stays there: nothing of the guard left on the history.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(window.location.pathname).toBe('/notes/note-boiler');
    expect(window.history.state).not.toHaveProperty('fdvLeaveGuard');
  });

  describe('the guard’s entry never outlives the page (the N1 re-check)', () => {
    /** The vault, opened at `path` after the Boiler note. */
    function from(path: string) {
      const state = withNotes();
      installFakeApi(state);
      signedIn('owner');
      window.history.replaceState({}, '', '/notes/note-boiler');
      window.history.pushState({}, '', path);
      render(<App />);
      return state;
    }
    const back = async (to: string) => {
      act(() => window.history.back());
      await waitFor(() => expect(window.location.pathname).toBe(to));
      await act(() => new Promise((r) => setTimeout(r, 30)));
    };
    const settled = async () => {
      await waitFor(() => expect(window.history.state).not.toHaveProperty('fdvLeaveGuard'));
    };

    it('a note made: Back goes to where New note was opened from, never an empty New note', async () => {
      from('/notes/new');
      const pane = await screen.findByRole('region', { name: 'New note' });
      writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Spare key under the pot');
      await waitFor(() => expect(window.history.state).toHaveProperty('fdvLeaveGuard'));
      fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
      await screen.findByRole('article', { name: 'Spare key under the pot' });
      await settled();
      expect(window.location.pathname).toMatch(/^\/notes\/note-/);
      await back('/notes/note-boiler');
      expect(screen.queryByRole('region', { name: 'New note' })).not.toBeInTheDocument();
    });

    it('a note moved to the Trash as it is written: Back goes to where it was opened from', async () => {
      from('/notes/note-stopcock');
      const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
      fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
      writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Half-written');
      await waitFor(() => expect(window.history.state).toHaveProperty('fdvLeaveGuard'));
      fireEvent.click(within(pane).getByRole('button', { name: /Move to the Trash/ }));
      const ask = await screen.findByRole('alertdialog', { name: 'Move to the Trash?' });
      fireEvent.click(within(ask).getByRole('button', { name: 'Move to the Trash' }));
      await waitFor(() => expect(window.location.pathname).toBe('/notes'));
      await settled();
      await back('/notes/note-boiler');
    });

    it('a link left by: nothing of the page left on the history but the page itself', async () => {
      from('/notes/note-stopcock');
      const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
      const before = window.history.length;
      fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
      writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Half-written');
      await waitFor(() => expect(window.history.state).toHaveProperty('fdvLeaveGuard'));
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
          name: 'Documents',
        }),
      );
      const ask = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
      fireEvent.click(within(ask).getByRole('button', { name: 'Leave without saving' }));
      await waitFor(() => expect(window.location.pathname).toBe('/documents'));
      // The note's page, then Documents: no copy of the page between them.
      expect(window.history.length).toBe(before + 1);
    });

    it('saved, then written in again: the first Back is asked about', async () => {
      from('/notes/note-stopcock');
      const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
      fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
      writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'First go');
      fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(within(pane).queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument(),
      );
      await settled();
      fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
      writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Second go');
      await waitFor(() => expect(window.history.state).toHaveProperty('fdvLeaveGuard'));
      act(() => window.history.back());
      expect(
        await screen.findByRole('alertdialog', { name: 'Leave without saving?' }),
      ).toBeInTheDocument();
      expect(window.location.pathname).toBe('/notes/note-stopcock');
    });

    it('two Backs, one after the other: still here, and asked; Leave goes back to before the note', async () => {
      from('/notes/note-stopcock');
      const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
      fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
      writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Half-written');
      await waitFor(() => expect(window.history.state).toHaveProperty('fdvLeaveGuard'));
      act(() => window.history.back());
      await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
      // The dialog up, Back again.
      act(() => window.history.back());
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(window.location.pathname).toBe('/notes/note-stopcock');
      expect(writtenIn(within(pane).getByRole('textbox', { name: 'Note' }))).toBe('Half-written');
      const ask = screen.getByRole('alertdialog', { name: 'Leave without saving?' });
      fireEvent.click(within(ask).getByRole('button', { name: 'Leave without saving' }));
      await waitFor(() => expect(window.location.pathname).toBe('/notes/note-boiler'));
      await act(() => new Promise((r) => setTimeout(r, 30)));
      expect(window.location.pathname).toBe('/notes/note-boiler');
    });
  });

  it('a save of the words keeps a title somebody else changed meanwhile (the N1 review)', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-stopcock');
    const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Under the sink, left');
    // Sara renames it as I write.
    Object.assign(state.documents[1] as object, {
      title: 'Stopcock (garage)',
      etag: '"sara"',
    });
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(pane).queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument(),
    );
    const patches = state.calls.filter((c) => c.method === 'PATCH');
    // Only the words, ever: her title is never put back to the one I began from.
    expect(patches.map((c) => c.body)).toEqual(
      patches.map(() => ({ notes: 'Under the sink, left' })),
    );
    expect(state.documents[1]).toMatchObject({
      title: 'Stopcock (garage)',
      notes: 'Under the sink, left',
    });
  });

  it('both renaming it: theirs is shown, and keeping mine is a choice (the N1 review)', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-stopcock');
    const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'The stopcock' },
    });
    Object.assign(state.documents[1] as object, {
      title: 'Stopcock (garage)',
      notes_updated_by_name: 'Sara Seikh',
      etag: '"sara"',
    });
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    const said = await within(pane).findByRole('group', { name: /changed this note/ });
    expect(said).toHaveTextContent('Their title: Stopcock (garage)');
    expect(state.documents[1]).toMatchObject({ title: 'Stopcock (garage)' });
    fireEvent.click(within(said).getByRole('button', { name: 'Save mine over theirs' }));
    await waitFor(() => expect(state.documents[1]).toMatchObject({ title: 'The stopcock' }));
  });

  it('the list is as wide as it is dragged or moved with the keys, remembered for each person', async () => {
    const shown = await openAt(withNotes(), '/notes');
    const bar = await screen.findByRole('separator', { name: 'Width of the list of notes' });
    expect(bar).toHaveAttribute('aria-orientation', 'vertical');
    expect(bar).toHaveAttribute('aria-valuenow', '320');
    expect(bar).toHaveAttribute('aria-valuemin', '240');
    expect(bar).toHaveAttribute('aria-valuemax', '560');
    expect(bar).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(bar).toHaveAttribute('aria-valuenow', '352');
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(bar).toHaveAttribute('aria-valuenow', '336');
    fireEvent.keyDown(bar, { key: 'End' });
    expect(bar).toHaveAttribute('aria-valuenow', '560');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(bar).toHaveAttribute('aria-valuenow', '560');
    fireEvent.keyDown(bar, { key: 'Home' });
    expect(bar).toHaveAttribute('aria-valuenow', '240');
    // Dragged.
    fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 580, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 580, pointerId: 1 });
    expect(bar).toHaveAttribute('aria-valuenow', '320');
    fireEvent.keyDown(bar, { key: 'ArrowRight', shiftKey: true });
    expect(bar).toHaveAttribute('aria-valuenow', '384');
    expect(localStorage.getItem('fdv.notes.list-width.me')).toBe('384');
    shown.unmount();
    // Back again: as it was left.
    await openAt(withNotes(), '/notes');
    expect(
      await screen.findByRole('separator', { name: 'Width of the list of notes' }),
    ).toHaveAttribute('aria-valuenow', '384');
  });

  it('a new note: its title, who can see it and its words; nothing kept until Save', async () => {
    const state = withNotes();
    await openAt(state, '/notes');
    fireEvent.click(await screen.findByRole('link', { name: 'New note' }));
    const pane = await screen.findByRole('region', { name: 'New note' });
    fireEvent.change(within(pane).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Wifi at Gran’s' },
    });
    fireEvent.click(within(pane).getByRole('button', { name: 'Only me' }));
    writeInto(
      within(pane).getByRole('textbox', { name: 'Note' }),
      'Network: **GranNet**\nwifi password: hunter2',
    );
    // A note is not a password manager: said, never refused.
    expect(within(pane).getByRole('status')).toHaveTextContent(/looks like a password or a PIN/);
    await expectAccessible();
    expect(state.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/documents')).toEqual(
      [],
    );
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await screen.findByRole('article', { name: 'Wifi at Gran’s' });
    const post = state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/documents');
    expect(post?.body).toEqual({
      type_key: 'note',
      title: 'Wifi at Gran’s',
      notes: 'Network: **GranNet**\nwifi password: hunter2',
      visibility: 'private',
      owner_member_id: 'me',
    });
    expect(window.location.pathname).toMatch(/^\/notes\/note-/);
  });

  it('an Only me note with no title: nothing of its sealed words put in the plain title; said that titles are not sealed (the N1 review)', async () => {
    const state = withNotes();
    await openAt(state, '/notes');
    fireEvent.click(await screen.findByRole('link', { name: 'New note' }));
    const pane = await screen.findByRole('region', { name: 'New note' });
    const title = within(pane).getByRole('textbox', { name: 'Title' });
    expect(title).not.toHaveAccessibleDescription();
    fireEvent.click(within(pane).getByRole('button', { name: 'Only me' }));
    expect(title).toHaveAccessibleDescription(
      'Only the words of an Only me note are sealed, not its title: keep anything secret out of the title.',
    );
    writeInto(within(pane).getByRole('textbox', { name: 'Note' }), 'Spare key under the third pot');
    await expectAccessible();
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    // Named from its words as it is read, here: never kept so.
    await screen.findByRole('article', { name: 'Spare key under the third pot' });
    const post = state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/documents');
    expect(post?.body).toMatchObject({ title: null, visibility: 'private' });
    // The words go once: as its notes, sealed by the vault.
    expect(JSON.stringify(post?.body).split('third pot')).toHaveLength(2);
    // Edited: the title field says it again, and an empty title stays empty.
    const made = await screen.findByRole('article', { name: 'Spare key under the third pot' });
    fireEvent.click(within(made).getByRole('button', { name: 'Edit' }));
    expect(within(made).getByRole('textbox', { name: 'Title' })).toHaveAccessibleDescription(
      /not its title/,
    );
    writeInto(within(made).getByRole('textbox', { name: 'Note' }), 'Spare key: the fourth pot');
    fireEvent.click(within(made).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(state.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      notes: 'Spare key: the fourth pot',
    });
    // Saved: the editor closed, and the guard's entry off the history.
    await waitFor(() =>
      expect(within(made).queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(window.history.state).not.toHaveProperty('fdvLeaveGuard'));
  });

  it('a family note with no title is kept with none, and named by its first words in Documents and a search (the N1 re-check)', async () => {
    const state = withNotes();
    await openAt(state, '/notes');
    fireEvent.click(await screen.findByRole('link', { name: 'New note' }));
    const pane = await screen.findByRole('region', { name: 'New note' });
    writeInto(
      within(pane).getByRole('textbox', { name: 'Note' }),
      'Spare key under the third pot\n\nAsk Sara first',
    );
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await screen.findByRole('article', { name: 'Spare key under the third pot' });
    const post = state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/documents');
    // Nothing of its words in its title, made Only me later or not.
    expect(post?.body).toMatchObject({ title: null, visibility: 'household' });
    // Documents: named as on Notes.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
        name: 'Documents',
      }),
    );
    expect(await screen.findByText('Spare key under the third pot')).toBeInTheDocument();
    expect(screen.queryByText('Scan · needs a name')).not.toBeInTheDocument();
    // A search hit too.
    const field = screen.getByRole('searchbox', { name: 'Search the vault' });
    fireEvent.change(field, { target: { value: 'third pot' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await screen.findByRole('heading', { name: 'Search', level: 1 });
    expect(await screen.findByText('Spare key under the third pot')).toBeInTheDocument();
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument();
  });

  it('a note made Only me later is said to keep its title in plain (the N1 review)', async () => {
    await openAt(withNotes(), '/notes/note-stopcock');
    const pane = await screen.findByRole('article', { name: 'Where the stopcock is' });
    fireEvent.click(within(pane).getByRole('button', { name: /^Who can see it/ }));
    expect(screen.queryByText(/not its title/)).not.toBeInTheDocument();
    fireEvent.click(within(pane).getByRole('button', { name: 'Only me' }));
    expect(screen.getByText(/not its title/)).toBeVisible();
  });

  it('a viewer reads, and is offered nothing to write', async () => {
    await openAt(withNotes(), '/notes/note-boiler', 'viewer');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    expect(within(pane).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(
      within(pane).queryByRole('button', { name: /Move to the Trash/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New note' })).not.toBeInTheDocument();
    await expectAccessible();
  });

  it('a note opened from Documents or a search is read on Notes', async () => {
    installFakeApi(withNotes());
    signedIn('owner');
    window.history.replaceState({}, '', '/documents/note-boiler');
    render(<App />);
    await screen.findByRole('article', { name: 'Boiler' });
    expect(window.location.pathname).toBe('/notes/note-boiler');
  });

  it('its link is read on the page: what they can do is said, not asked, and it is a link to view', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler');
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Share a link' }));
    expect(within(pane).getByText(/They read the note on the page/)).toBeVisible();
    expect(
      within(pane).queryByRole('button', { name: 'View and download' }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(pane).getByRole('button', { name: 'Make the link' }));
    await waitFor(() =>
      expect(
        state.calls.some(
          (c) => c.method === 'POST' && c.url === '/api/v1/documents/note-boiler/share',
        ),
      ).toBe(true),
    );
    const made = state.calls.find((c) => c.url === '/api/v1/documents/note-boiler/share');
    expect((made?.body as { permission?: string }).permission).toBe('view');
  });
});

describe('on a phone (320), the list and the note are two screens', () => {
  it('the list; a note on its own, with the way back; and back', async () => {
    atWidth(320);
    await openAt(withNotes(), '/notes', 'adult');
    expect(
      screen.queryByRole('separator', { name: 'Width of the list of notes' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    fireEvent.click(within(await list()).getByRole('link', { name: /^Boiler/ }));
    const pane = await screen.findByRole('article', { name: 'Boiler' });
    expect(screen.queryByRole('list', { name: 'Notes' })).not.toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('link', { name: 'All notes' }));
    expect(await list()).toBeVisible();
    expect(pane).not.toBeInTheDocument();
  });
});

describe('a note’s link, opened (0.9.0, N1)', () => {
  it('its words on the page, drawn as the family’s app draws them; nothing of pages or a download', async () => {
    const state = fresh({
      shareValid: true,
      shareNote: {
        id: 'note-boiler',
        title: 'Boiler',
        body: 'Ring **Ann** first.\n\n<script>window.__fdvShared = 1</script>',
      },
    });
    installFakeApi(state);
    render(<SharePage token="tok" />);
    expect(await screen.findByText('You can read it here.')).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    expect(await screen.findByText('Ann')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByText(/<script>window.__fdvShared = 1<\/script>/)).toBeVisible();
    expect((window as unknown as { __fdvShared?: number }).__fdvShared).toBeUndefined();
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Every page shows who it was shared with/)).not.toBeInTheDocument();
    await expectAccessible();
  });
});
