import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
 * with the way to confirm again. A note's Essential and Sensitive are offered
 * where it is written, as a document's are.
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

async function openAt(state: FakeState, path: string) {
  installFakeApi(state);
  signedIn('owner');
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
    await screen.findByRole('toolbar', { name: 'Note actions' });
    fireEvent.click(screen.getByRole('button', { name: /Essential and sensitive/ }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Essential' }));
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

describe('a note’s Essential and Sensitive', () => {
  it('offered with a document’s rules, each saved as it is switched; turning Essential off asks', async () => {
    const state = withNotes();
    await openAt(state, '/notes/note-boiler');
    await screen.findByRole('toolbar', { name: 'Note actions' });
    fireEvent.click(screen.getByRole('button', { name: /Essential and sensitive/ }));
    const essential = await screen.findByRole('switch', { name: 'Essential' });
    expect(essential).not.toBeChecked();
    fireEvent.click(essential);
    expect(await screen.findByText('This note is Essential now.')).toBeInTheDocument();
    await waitFor(() =>
      expect(state.calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])).toEqual([
        ['/api/v1/documents/note-boiler', { is_essential: true }],
      ]),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Sensitive' }));
    expect(await screen.findByText('This note is sensitive now.')).toBeInTheDocument();
    expect(state.documents.find((d) => d.id === 'note-boiler')).toMatchObject({
      is_essential: true,
      sensitive: true,
    });
    // Essential off, five minutes later: asked first.
    state.stepUpNeeded = true;
    fireEvent.click(screen.getByRole('switch', { name: 'Essential' }));
    expect(
      await screen.findByRole('dialog', { name: 'Just checking it is you' }),
    ).toHaveTextContent('to open an Essential document');
    await expectAccessible();
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
