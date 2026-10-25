import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  fresh,
  installFakeApi,
  PASSPORT,
  signedIn,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * One action row under a note and under a document (0.9.0, the owner's
 * request of 24 Oct 2026): Download, a button for each section — Who can
 * see it with who, Tags and Collections with their counts, Share a link,
 * a document's History — and Move to the Trash at the far end; each
 * section a disclosure, one open at a time, Escape folding it back to its
 * button, the open one remembered for each person, a note's apart from a
 * document's; a link to a section opens it. Each button only for whoever
 * may use it today.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
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

const BOILER = {
  ...PASSPORT,
  id: 'note-boiler',
  type_key: 'note',
  category: 'other',
  title: 'Boiler',
  identifier: null,
  issued: null,
  expires: null,
  physical_location: null,
  is_essential: false,
  latest_version_id: null,
  versions: 0,
  tags: [],
  notes: 'Ring **Ann** at Northgate Heating first.',
  notes_updated_at: '2026-09-25T15:12:00Z',
  notes_updated_by_name: 'Sara Seikh',
  etag: '"boiler"',
};

const HOLIDAY: FakeCollection = {
  id: 'collection-h',
  name: 'Holiday',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"holiday.1"',
  items: ['doc-1'],
};
const SCHOOL: FakeCollection = { ...HOLIDAY, id: 'collection-s', name: 'School', items: [] };

const state = (over: Partial<FakeState> = {}) =>
  fresh({
    notes: true,
    documents: [{ ...BOILER }, { ...PASSPORT }],
    collections: [{ ...HOLIDAY, items: [...HOLIDAY.items] }, { ...SCHOOL }],
    ...over,
  });

async function openAt(s: FakeState, path: string, role: Role = 'owner') {
  installFakeApi(s);
  signedIn(role);
  window.history.replaceState({}, '', path);
  const shown = render(<App />);
  const row = await screen.findByRole('toolbar', { name: /^(Note|Document) actions$/ });
  return { ...shown, row };
}

/** Each button as it reads on the screen: its words and its pill, not what only a screen reader hears. */
const names = (row: HTMLElement) =>
  within(row)
    .getAllByRole('button')
    .map((b) => {
      const copy = b.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.visually-hidden').forEach((n) => n.remove());
      return copy.textContent?.replace(/\s+/g, ' ').trim();
    });
const button = (row: HTMLElement, name: RegExp) => within(row).getByRole('button', { name });
const panelOf = (b: HTMLElement) =>
  document.getElementById(b.getAttribute('aria-controls') ?? '') as HTMLElement;

describe('the row on a note', () => {
  it('Download, who can see it, its tags, collections, a link, and the Trash at the end; none open', async () => {
    const { row } = await openAt(state(), '/notes/note-boiler');
    await waitFor(() => expect(button(row, /^Collections: 0 collections$/)).toBeVisible());
    expect(names(row)).toEqual([
      'Download',
      'Who can see itEveryone',
      'Tags0',
      'Collections0',
      'Share a link',
      'Move to the Trash',
    ]);
    // The pill says who, and is heard in full.
    expect(button(row, /^Who can see it: Everyone in the family$/)).toBeVisible();
    for (const b of within(row).getAllByRole('button', { expanded: false })) {
      expect(panelOf(b)).not.toBeVisible();
    }
    // The Trash last, as words in the danger colour; Edit where it was, on the title's line.
    expect(within(row).getAllByRole('button').at(-1)).toHaveClass('btn-trash');
    const head = screen.getByRole('heading', { level: 2, name: 'Boiler' }).closest('header');
    expect(within(head as HTMLElement).getByRole('button', { name: 'Edit' })).toBeVisible();
    await expectAccessible();
  });

  it('a viewer: Download, and its tags when it has some; nothing to change', async () => {
    const s = state();
    (s.documents[0] as { tags: string[] }).tags = ['house'];
    const { row } = await openAt(s, '/notes/note-boiler', 'viewer');
    expect(names(row)).toEqual(['Download', 'Tags1']);
    fireEvent.click(button(row, /^Tags/));
    const panel = panelOf(button(row, /^Tags/));
    expect(within(panel).getByRole('link', { name: 'Documents tagged house' })).toBeVisible();
    expect(within(panel).queryByLabelText('Add a tag')).not.toBeInTheDocument();
    await expectAccessible();
  });

  it('a viewer of a note with no tags: Download alone', async () => {
    const { row } = await openAt(state(), '/notes/note-boiler', 'viewer');
    expect(names(row)).toEqual(['Download']);
  });

  it('one open at a time: another closes the first, the open one folds; Escape folds it back to its button', async () => {
    const { row } = await openAt(state(), '/notes/note-boiler');
    const tags = button(row, /^Tags/);
    fireEvent.click(tags);
    expect(tags).toHaveAttribute('aria-expanded', 'true');
    const tagPanel = panelOf(tags);
    expect(tagPanel).toBeVisible();
    // The section keeps its own heading; the focus goes into it.
    expect(within(tagPanel).getByRole('heading', { name: 'Tags' })).toBeVisible();
    await waitFor(() => expect(within(tagPanel).getByLabelText('Add a tag')).toHaveFocus());

    const who = button(row, /^Who can see it/);
    fireEvent.click(who);
    expect(who).toHaveAttribute('aria-expanded', 'true');
    expect(tags).toHaveAttribute('aria-expanded', 'false');
    expect(tagPanel).not.toBeVisible();
    const whoPanel = panelOf(who);
    expect(within(whoPanel).getByRole('heading', { name: 'Who can see it' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(whoPanel).getByRole('button', { name: 'Everyone in the family' }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(within(whoPanel).getByRole('button', { name: 'Only me' }), {
      key: 'Escape',
    });
    expect(who).toHaveAttribute('aria-expanded', 'false');
    expect(whoPanel).not.toBeVisible();
    expect(who).toHaveFocus();

    fireEvent.click(tags);
    fireEvent.click(tags);
    expect(tags).toHaveAttribute('aria-expanded', 'false');
    expect(tagPanel).not.toBeVisible();
  });

  it('a toolbar: one Tab stop, the arrows along it, Home and End', async () => {
    const { row } = await openAt(state(), '/notes/note-boiler');
    const all = within(row).getAllByRole('button');
    expect(all.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    all[0]?.focus();
    fireEvent.keyDown(all[0] as HTMLElement, { key: 'ArrowRight' });
    expect(all[1]).toHaveFocus();
    expect(all[1]).toHaveAttribute('tabindex', '0');
    expect(all[0]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(all[1] as HTMLElement, { key: 'End' });
    expect(all.at(-1)).toHaveFocus();
    fireEvent.keyDown(all.at(-1) as HTMLElement, { key: 'ArrowRight' });
    expect(all[0]).toHaveFocus();
    fireEvent.keyDown(all[0] as HTMLElement, { key: 'ArrowLeft' });
    expect(all.at(-1)).toHaveFocus();
    fireEvent.keyDown(all.at(-1) as HTMLElement, { key: 'Home' });
    expect(all[0]).toHaveFocus();
  });

  it('the open one is remembered for each person, a note’s apart from a document’s', async () => {
    const first = await openAt(state(), '/notes/note-boiler');
    fireEvent.click(button(first.row, /^Tags/));
    first.unmount();

    const again = await openAt(state(), '/notes/note-boiler');
    expect(button(again.row, /^Tags/)).toHaveAttribute('aria-expanded', 'true');
    expect(panelOf(button(again.row, /^Tags/))).toBeVisible();
    // Opened from memory, the focus is left alone.
    expect(
      within(panelOf(button(again.row, /^Tags/))).getByLabelText('Add a tag'),
    ).not.toHaveFocus();
    again.unmount();

    // A document's page remembers its own: none.
    const doc = await openAt(state(), '/documents/doc-1');
    for (const b of within(doc.row).queryAllByRole('button', { expanded: true })) {
      throw new Error(`open on a document: ${b.textContent}`);
    }
    doc.unmount();

    // Somebody else on this browser has their own.
    localStorage.setItem('fdv.actions.note.someone-else', 'share');
    const back = await openAt(state(), '/notes/note-boiler');
    expect(button(back.row, /^Tags/)).toHaveAttribute('aria-expanded', 'true');
    expect(button(back.row, /^Share a link/)).toHaveAttribute('aria-expanded', 'false');
    back.unmount();

    // And somebody else signed in here finds none of mine open.
    const other = state({ refreshMember: 'someone-else' });
    installFakeApi(other);
    signedIn('owner');
    const kept = JSON.parse(localStorage.getItem('fdv.session') ?? '{}') as Record<string, unknown>;
    localStorage.setItem('fdv.session', JSON.stringify({ ...kept, member_id: 'someone-else' }));
    window.history.replaceState({}, '', '/notes/note-boiler');
    render(<App />);
    const theirs = await screen.findByRole('toolbar', { name: 'Note actions' });
    expect(within(theirs).getAllByRole('button', { expanded: true })).toEqual([
      button(theirs, /^Share a link/),
    ]);
  });

  it('nothing remembered when the browser keeps nothing: none open, and no error', async () => {
    // The row's own keys refused; the sign-in kept as it is.
    const getItem = Storage.prototype.getItem.bind(localStorage);
    const setItem = Storage.prototype.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key.startsWith('fdv.actions.')) throw new Error('blocked');
      return getItem(key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, v) => {
      if (key.startsWith('fdv.actions.')) throw new Error('blocked');
      setItem(key, v);
    });
    const { row } = await openAt(state(), '/notes/note-boiler');
    expect(within(row).queryAllByRole('button', { expanded: true })).toEqual([]);
    fireEvent.click(button(row, /^Tags/));
    expect(button(row, /^Tags/)).toHaveAttribute('aria-expanded', 'true');
  });

  it('the counts and who can see it change as the sections change them', async () => {
    const s = state();
    const { row } = await openAt(s, '/notes/note-boiler');

    // A tag added: Tags 1.
    fireEvent.click(button(row, /^Tags/));
    const tagPanel = panelOf(button(row, /^Tags/));
    fireEvent.change(within(tagPanel).getByLabelText('Add a tag'), { target: { value: 'house' } });
    fireEvent.click(within(tagPanel).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(button(row, /^Tags: 1 tag$/)).toBeVisible());

    // Put in a collection: Collections 1.
    fireEvent.click(button(row, /^Collections/));
    const colPanel = panelOf(button(row, /^Collections/));
    fireEvent.click(within(colPanel).getByRole('button', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', { name: /to a collection/ });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Add to “School”' }));
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(button(row, /^Collections: 1 collection$/)).toBeVisible());

    // Made Only me: the pill says so.
    const who = button(row, /^Who can see it/);
    fireEvent.click(who);
    const whoPanel = panelOf(who);
    fireEvent.click(within(whoPanel).getByRole('button', { name: 'Only me' }));
    fireEvent.click(within(whoPanel).getByRole('button', { name: 'Save' }));
    const understood = await within(whoPanel).findByRole('button', { name: 'I understand' });
    await waitFor(() => expect(button(row, /^Who can see it: Only me$/)).toBeVisible());
    expect(within(row).getByRole('button', { name: /^Who can see it/ })).toHaveTextContent(
      'Only me',
    );
    fireEvent.click(understood);
    await waitFor(() => expect(button(row, /^Who can see it/)).toHaveFocus());
    expect(button(row, /^Who can see it/)).toHaveAttribute('aria-expanded', 'false');
    // Opened again, it begins afresh, at the choice.
    fireEvent.click(button(row, /^Who can see it/));
    expect(
      within(panelOf(button(row, /^Who can see it/))).getByRole('button', { name: 'Save' }),
    ).toBeVisible();
  });

  it('folded half-way, a section keeps what it was doing', async () => {
    const { row } = await openAt(state(), '/notes/note-boiler');
    const share = button(row, /^Share a link/);
    fireEvent.click(share);
    const panel = panelOf(share);
    fireEvent.change(within(panel).getByLabelText(/Who is it for/), {
      target: { value: 'The plumber' },
    });
    fireEvent.click(share);
    expect(panel).not.toBeVisible();
    fireEvent.click(share);
    expect(within(panel).getByLabelText(/Who is it for/)).toHaveValue('The plumber');
  });

  it('Escape in a dialog over the page is the dialog’s, not the panel’s', async () => {
    const { row } = await openAt(state(), '/notes/note-boiler');
    const collections = button(row, /^Collections/);
    fireEvent.click(collections);
    fireEvent.click(
      within(panelOf(collections)).getByRole('button', { name: 'Add to a collection' }),
    );
    const sheet = await screen.findByRole('dialog', { name: /to a collection/ });
    fireEvent.keyDown(within(sheet).getAllByRole('button')[0] as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(collections).toHaveAttribute('aria-expanded', 'true');
    expect(panelOf(collections)).toBeVisible();
  });

  it('a link to a section opens it, its heading with the focus', async () => {
    const { row } = await openAt(state(), '/notes/note-boiler#share');
    const share = button(row, /^Share a link/);
    expect(share).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(
        within(panelOf(share)).getByRole('heading', {
          name: 'Send this to someone outside the family',
        }),
      ).toHaveFocus(),
    );
  });

  it('a link to a section it has no button for opens nothing', async () => {
    const { row } = await openAt(state(), '/notes/note-boiler#share', 'viewer');
    expect(within(row).queryAllByRole('button', { expanded: true })).toEqual([]);
  });
});

describe('the row on a document', () => {
  it('for its owner: Download and its History together, then who, tags, collections, a link, and the Trash', async () => {
    const { row } = await openAt(state(), '/documents/doc-1');
    await waitFor(() => expect(button(row, /^Collections: 1 collection$/)).toBeVisible());
    expect(names(row)).toEqual([
      'Download',
      'History1',
      'Who can see itEveryone',
      'Tags1',
      'Collections1',
      'Share a link',
      'Move to the Trash',
    ]);
    expect(button(row, /^History: 1 version$/)).toBeVisible();
    // Under the details: after the facts, and the thin line.
    const facts = document.querySelector('dl.facts') as HTMLElement;
    expect(facts.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Edit stays in the bar at the top.
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/documents/doc-1/confirm',
    );
    await expectAccessible();
  });

  it('a viewer: Download, its History and its tags; nothing to change or send', async () => {
    const { row } = await openAt(state(), '/documents/doc-1', 'viewer');
    expect(names(row)).toEqual(['Download', 'History1', 'Tags1']);
    fireEvent.click(button(row, /^History/));
    const panel = panelOf(button(row, /^History/));
    expect(within(panel).getByRole('heading', { name: 'History' })).toBeVisible();
    await expectAccessible();
  });

  it('a document with no file yet: no Download, and no link to send', async () => {
    const s = state();
    Object.assign(s.documents[1] as Record<string, unknown>, {
      latest_version_id: null,
      versions: 0,
    });
    const { row } = await openAt(s, '/documents/doc-1');
    expect(within(row).queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^Share a link/ })).not.toBeInTheDocument();
  });

  it('Download acts at once, and is no section', async () => {
    const s = state();
    const { row } = await openAt(s, '/documents/doc-1');
    const download = within(row).getByRole('button', { name: 'Download' });
    expect(download).not.toHaveAttribute('aria-expanded');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(download);
    await waitFor(() =>
      expect(
        s.calls.some((c) => c.method === 'GET' && /\/versions\/v-1\/content/.test(c.url)),
      ).toBe(true),
    );
  });

  it('links to its sections open them: #history, #tags, #collections, #who-can-see-it, and an id inside one', async () => {
    for (const [hash, name] of [
      ['#history', /^History/],
      ['#tags', /^Tags/],
      ['#collections', /^Collections/],
      ['#who-can-see-it', /^Who can see it/],
      ['#doc-collections-h', /^Collections/],
      ['#history-h', /^History/],
    ] as const) {
      localStorage.clear();
      const { row, unmount } = await openAt(state(), `/documents/doc-1${hash}`);
      await waitFor(() => expect(button(row, name)).toHaveAttribute('aria-expanded', 'true'));
      expect(within(row).getAllByRole('button', { expanded: true })).toHaveLength(1);
      unmount();
    }
  });

  it('a link made: Share a link counts it; Done folds it back to its button', async () => {
    const { row } = await openAt(state(), '/documents/doc-1');
    const share = button(row, /^Share a link/);
    fireEvent.click(share);
    const panel = panelOf(share);
    fireEvent.click(within(panel).getByRole('button', { name: 'Make the link' }));
    const done = await within(panel).findByRole('button', { name: 'Done' });
    await waitFor(() => expect(button(row, /^Share a link: 1 live link$/)).toBeVisible());
    expect(names(row)).toContain('Share a link1');
    fireEvent.click(done);
    await waitFor(() => expect(button(row, /^Share a link/)).toHaveFocus());
    expect(button(row, /^Share a link/)).toHaveAttribute('aria-expanded', 'false');
    // Taken back, the count goes.
    fireEvent.click(button(row, /^Share a link/));
    fireEvent.click(
      within(panelOf(button(row, /^Share a link/))).getByRole('button', { name: 'Take it back' }),
    );
    await waitFor(() => expect(button(row, /^Share a link$/)).toBeVisible());
  });

  it('Share opened on a document: its form, as from a row’s ⋯; Cancel folds it back to its button', async () => {
    const { row } = await openAt(state(), '/documents/doc-1');
    const share = button(row, /^Share a link/);
    fireEvent.click(share);
    const panel = panelOf(share);
    await waitFor(() => expect(within(panel).getByLabelText(/Who is it for/)).toHaveFocus());
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(share).toHaveFocus());
    expect(share).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('at 320 px (styles.css)', () => {
  const CSS = (() => {
    const file = ['src/styles.css', 'apps/web/src/styles.css']
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    return (file ? readFileSync(file, 'utf8') : '').replace(/\/\*[\s\S]*?\*\//g, '');
  })();
  const rule = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('the row wraps; on a phone the Trash takes a line of its own, last', () => {
    expect(rule(CSS, '.action-row')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(CSS, '.action-btn')).toMatch(/max-width:\s*100%/);
    expect(rule(CSS, '.action-trash')).toMatch(/margin-left:\s*auto/);
    const phone = /@media \(max-width: 480px\) \{((?:\s*[.\w-]+ \{[^}]*\})*)\s*\}/g;
    const blocks = [...CSS.matchAll(phone)].map((m) => m[1] ?? '');
    const trash = blocks.map((b) => rule(b, '.action-trash')).find(Boolean);
    expect(trash).toMatch(/flex-basis:\s*100%/);
    // A folded panel is hidden, whatever its look says.
    expect(rule(CSS, '.action-panel[hidden]')).toMatch(/display:\s*none/);
  });
});
