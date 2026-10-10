import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BatchItemView } from '@fdv/shared';
import axe from 'axe-core';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { batchPolling } from './screens/Batches.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  signedIn,
  type FakeBatch,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * Many documents at once (Phase 6, I1), on the web: Add as a menu — One
 * document, Many documents — the Add many page with what is chosen for all
 * of them, the upload one file after another, carried on later; the Inbox's
 * "Your uploads"; a batch's page, its files' cards, and removing. A batch is
 * its uploader's alone; a viewer adds nothing, and a phone adds one at a time.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';
const PHONE = 375;
const WIDE = 1280;

let width = WIDE;
let height = 900;
/** A window this wide, and this tall: a computer zoomed to 200% is 960 × 480 (the I1 review). */
function atWidth(px: number, tall = 900) {
  width = px;
  height = tall;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || width >= Number(minWidth[1])) &&
          (!minHeight || height >= Number(minHeight[1])) &&
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
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const pdf = (name: string, words = name, size?: number) =>
  new File([size ? 'x'.repeat(size) : `%PDF-1.4\n% ${words}\n%%EOF\n`], name, {
    type: 'application/pdf',
  });
const shaOf = (words: string) =>
  createHash('sha256').update(`%PDF-1.4\n% ${words}\n%%EOF\n`).digest('hex');

const item = (over: Partial<BatchItemView> & { id: string; name: string }): BatchItemView => ({
  batch_id: 'batch-1',
  content_type: 'application/pdf',
  byte_size: 2048,
  sha256: '0'.repeat(64),
  arrived_at: '2026-10-06T09:05:00Z',
  state: 'waiting',
  reading: 'waiting',
  preview_state: 'ready',
  preview_pages: 2,
  duplicate: null,
  document_id: null,
  ...over,
});

const HOUSE: FakeCollection = {
  id: 'collection-h',
  name: 'The house',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"h.1"',
  items: [],
};

/** A batch of three, one a duplicate, with what it chose for all of them. */
const OLD_PAPERS = (): FakeBatch => ({
  id: 'batch-1',
  name: 'Old papers',
  created_at: '2026-10-06T09:00:00Z',
  ends_at: '2026-11-05T09:00:00Z',
  defaults: {
    owner_member_id: 'm-0',
    type_key: 'birth_certificate',
    visibility: null,
    physical_location: 'Filing cabinet',
    collection_id: 'collection-h',
    tags: ['old', 'house'],
    is_essential: true,
  },
  items: [
    item({ id: 'item-1', name: 'scan-001.pdf' }),
    item({
      id: 'item-2',
      name: 'scan-002.pdf',
      duplicate: {
        of: 'document',
        document_id: 'doc-1',
        title: "Mansoor's passport",
      },
    }),
    item({ id: 'item-3', name: 'scan-003.pdf', preview_state: 'pending', preview_pages: null }),
  ],
});

/** The app at `path`, `px` wide, signed in as `role`, with batches. */
function at(
  path: string,
  over: Partial<FakeState> = {},
  role: Role = 'owner',
  px: number = WIDE,
  /** False: a vault from before batches. */
  batches = true,
  tall = 900,
): FakeState {
  atWidth(px, tall);
  const state = fresh({
    members: [{ ...ME, role }, AISHA],
    ...(batches ? { batches: [] } : {}),
    collections: [HOUSE],
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** The bar on top, once the shell is drawn. */
const appBar = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  return document.querySelector('header.app-bar') as HTMLElement;
};
const posts = (state: FakeState, pattern: RegExp) =>
  state.calls.filter((c) => c.method === 'POST' && pattern.test(c.url));

/** Files chosen with the page's own "Choose files": once its lists have loaded (Aisha is there). */
function choose(files: File[]) {
  const input = screen.getByLabelText('Choose files');
  fireEvent.change(input, { target: { files } });
}

describe('Add is a menu (I1)', () => {
  it('One document or Many documents, by mouse and by keyboard; Escape gives the focus back', async () => {
    at('/');
    const add = await within(await appBar()).findByRole('button', { name: 'Add' });
    expect(add).toHaveAttribute('aria-haspopup', 'menu');
    expect(add).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(add);
    const menu = await screen.findByRole('menu', { name: 'Add' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'One documentA photo, a scan or a file',
      'Many documentsFiles or a folder, checked in your Inbox',
    ]);
    expect(items[0]).toHaveAttribute('href', '/add');
    expect(items[1]).toHaveAttribute('href', '/add/many');
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() => expect(items[1]).toHaveFocus());
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() => expect(items[0]).toHaveFocus());
    await expectAccessible();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(add).toHaveFocus());
    // ArrowUp opens it on its last item; choosing it goes there.
    fireEvent.keyDown(add, { key: 'ArrowUp' });
    const last = await screen.findByRole('menuitem', { name: /Many documents/ });
    await waitFor(() => expect(last).toHaveFocus());
    fireEvent.click(last);
    expect(await screen.findByRole('heading', { name: 'Add many documents' })).toBeVisible();
    expect(screen.queryByRole('menu')).toBeNull();
    // `n` puts the focus on it, as it did on the link.
    fireEvent.keyDown(document.body, { key: 'n' });
    const bar = await appBar();
    await waitFor(() => expect(within(bar).getByRole('button', { name: 'Add' })).toHaveFocus());
  });

  it('a vault from before batches keeps the link; at phone width the + is today’s add; a viewer has neither', async () => {
    at('/', {}, 'owner', WIDE, false);
    expect(await within(await appBar()).findByRole('link', { name: 'Add' })).toHaveAttribute(
      'href',
      '/add',
    );
    document.body.innerHTML = '';
    at('/', {}, 'owner', PHONE);
    const bar = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(bar).getByRole('link', { name: 'Add a document' })).toHaveAttribute(
      'href',
      '/add',
    );
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    document.body.innerHTML = '';
    at('/', {}, 'viewer');
    await screen.findByRole('navigation', { name: 'Sections' });
    expect(within(await appBar()).queryByRole('button', { name: 'Add' })).toBeNull();
    expect(within(await appBar()).queryByRole('link', { name: 'Add' })).toBeNull();
  });

  it('at 320 px, adding many says a computer is quicker, and still works', async () => {
    at('/add/many', {}, 'owner', 320);
    expect(
      await screen.findByText('Adding many documents is quicker on a computer.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Choose files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeVisible();
    await expectAccessible();
  });
});

describe('Add many documents (I1)', () => {
  it('what is chosen for all of them is chosen once, and the batch is made with it', async () => {
    const state = at('/add/many');
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    fireEvent.change(screen.getByLabelText('Name this batch'), { target: { value: 'Old papers' } });
    fireEvent.change(screen.getByLabelText('Whose documents'), { target: { value: 'm-0' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'birth_certificate' } });
    const vis = screen.getByRole('group', { name: 'Who can see them' });
    expect(within(vis).getByRole('button', { name: 'As each kind says' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Only me is for one's own documents: not for Aisha's.
    expect(within(vis).getByRole('button', { name: 'Only me' })).toBeDisabled();
    fireEvent.click(within(vis).getByRole('button', { name: 'Adults only' }));
    fireEvent.change(screen.getByLabelText('Where the paper copies are'), {
      target: { value: 'Filing cabinet' },
    });
    fireEvent.change(await screen.findByLabelText('Collection'), {
      target: { value: 'collection-h' },
    });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'old, house' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Essential' }));
    choose([pdf('one.pdf'), pdf('two.pdf')]);
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 2 files' }));
    expect(await screen.findByRole('link', { name: 'Open the batch' })).toHaveAttribute(
      'href',
      '/inbox/batches/batch-1',
    );
    const made = posts(state, /\/api\/v1\/batches$/);
    expect(made).toHaveLength(1);
    expect(made[0]?.body).toEqual({
      name: 'Old papers',
      defaults: {
        owner_member_id: 'm-0',
        type_key: 'birth_certificate',
        visibility: 'adults',
        physical_location: 'Filing cabinet',
        collection_id: 'collection-h',
        tags: ['old', 'house'],
        is_essential: true,
      },
    });
    expect(posts(state, /\/items$/).map((c) => (c.body as { file: string }).file)).toEqual([
      'one.pdf',
      'two.pdf',
    ]);
    // Chosen once: said now, not asked again.
    expect(screen.queryByLabelText('Name this batch')).toBeNull();
    const chosen = screen.getByRole('list', { name: 'Chosen for all of them' });
    expect(
      within(chosen)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual([
      'Aisha',
      'Birth certificate',
      'Adults only',
      'Filing cabinet',
      'The house',
      '#old',
      '#house',
      'Essential',
    ]);
  });

  it('one file after another, each one’s progress and all of it, said as each arrives; a file refused is said, and the rest carry on', async () => {
    let release: (() => void) | null = null;
    const state = at('/add/many', {
      maxUploadBytes: 4096,
      batchRefuse: {
        'odd.pdf': {
          status: 415,
          code: 'unsupported_type',
          message: 'That kind of file cannot be stored here. PDFs, photos and scans are fine.',
        },
      },
      hold: (method, path) =>
        method === 'POST' && /items$/.test(path) && !release
          ? new Promise<void>((r) => (release = r))
          : undefined,
    });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([
      pdf('a.pdf'),
      pdf('huge.pdf', 'huge', 8000),
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      pdf('odd.pdf'),
      pdf('b.pdf'),
    ]);
    // Refused before anything is sent, with why; the rest ready.
    const list = screen.getByRole('list', { name: 'The files' });
    expect(within(list).getByText(/Too big: over 4 KB/)).toBeVisible();
    expect(within(list).getByText(/Not a kind the vault takes/)).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Start: upload 3 files' }));
    // The first on its way: its own progress, and all of it; nothing said for every percent.
    expect(await screen.findByRole('progressbar', { name: 'a.pdf, sending' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'All of them' })).toBeVisible();
    const live = document.querySelector('[role="status"][aria-live="polite"]') as HTMLElement;
    expect(live).toHaveTextContent('Sending 3 files.');
    await waitFor(() => expect(release).not.toBeNull());
    act(() => (release as () => void)());
    await screen.findByRole('link', { name: 'Open the batch' });
    expect(within(list).getAllByText('Arrived · waiting to be read')).toHaveLength(2);
    expect(
      within(list).getByText(
        /That kind of file cannot be stored here\. PDFs, photos and scans are fine\./,
      ),
    ).toBeVisible();
    expect(screen.getByText(/2 files arrived in “Upload of/)).toBeVisible();
    expect(screen.getByText(/3 files not sent/)).toBeVisible();
    // Only what the vault might take was sent.
    expect(posts(state, /\/items$/).map((c) => (c.body as { file: string }).file)).toEqual([
      'a.pdf',
      'odd.pdf',
      'b.pdf',
    ]);
    await expectAccessible();
  });

  it('Stop is heard after the file being sent; the rest wait, and are sent later', async () => {
    let release: (() => void) | null = null;
    const state = at('/add/many', {
      hold: (method, path) =>
        method === 'POST' && /items$/.test(path) && !release
          ? new Promise<void>((r) => (release = r))
          : undefined,
    });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('one.pdf'), pdf('two.pdf'), pdf('three.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 3 files' }));
    const stop = await screen.findByRole('button', { name: 'Stop after this file' });
    // Start went as it started: the focus is on Stop.
    await waitFor(() => expect(stop).toHaveFocus());
    fireEvent.click(stop);
    await waitFor(() => expect(release).not.toBeNull());
    act(() => (release as () => void)());
    const rest = await screen.findByRole('button', { name: 'Send the rest' });
    expect(posts(state, /\/items$/)).toHaveLength(1);
    expect(screen.getAllByText('Not sent yet')).toHaveLength(2);
    const arrived = screen.getByText(/1 file arrived in “Upload of/);
    expect(arrived).toBeVisible();
    // Stop went as it ended: the focus is on what arrived.
    await waitFor(() => expect(arrived).toHaveFocus());
    fireEvent.click(rest);
    await waitFor(() => expect(posts(state, /\/items$/)).toHaveLength(3));
    // One batch, carried on: not a second.
    expect(posts(state, /\/api\/v1\/batches$/)).toHaveLength(1);
  });

  it('a file the connection dropped is not lost: it waits, said so, and is sent again', async () => {
    const state = at('/add/many', { dropConnectionLost: true });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('one.pdf'), pdf('two.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 2 files' }));
    expect(
      await screen.findByText(
        'The connection to the vault dropped. Send the rest again when it is back.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/The connection dropped: it can be sent again/)).toBeVisible();
    expect(screen.getByText('Not sent yet')).toBeVisible();
    state.dropConnectionLost = false;
    fireEvent.click(screen.getByRole('button', { name: 'Send the rest' }));
    await waitFor(() =>
      expect(screen.getAllByText('Arrived · waiting to be read')).toHaveLength(2),
    );
    expect(posts(state, /\/items$/).map((c) => (c.body as { file: string }).file)).toEqual([
      'one.pdf',
      'one.pdf',
      'two.pdf',
    ]);
  });

  it('carrying on a batch sends only what is not in it already: the same name, size and SHA-256', async () => {
    const batch = OLD_PAPERS();
    const words = 'the first scan';
    const first = pdf('scan-001.pdf', words);
    batch.items = [
      item({ id: 'item-1', name: 'scan-001.pdf', byte_size: first.size, sha256: shaOf(words) }),
      // The same name and size, other bytes: a different file.
      item({ id: 'item-2', name: 'scan-002.pdf', byte_size: pdf('scan-002.pdf', 'xx').size }),
    ];
    const state = at('/add/many?batch=batch-1', { batches: [batch] });
    expect(await screen.findByRole('heading', { name: 'Carry on: Old papers' })).toBeVisible();
    // What it chose for all of them is said, not asked again.
    expect(screen.queryByLabelText('Name this batch')).toBeNull();
    expect(await screen.findByText('Filing cabinet')).toBeVisible();
    choose([first, pdf('scan-002.pdf', 'yy'), pdf('scan-004.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Send 3 files' }));
    await screen.findByRole('link', { name: 'Open the batch' });
    expect(posts(state, /\/items$/).map((c) => (c.body as { file: string }).file)).toEqual([
      'scan-002.pdf',
      'scan-004.pdf',
    ]);
    expect(screen.getByText('Already in this batch.')).toBeVisible();
    expect(posts(state, /\/api\/v1\/batches$/)).toHaveLength(0);
  });
});

describe('the Inbox: your uploads (I1)', () => {
  it('your uploads beside the files sent to you, each batch with how many wait; the sidebar counts them', async () => {
    const W2 = {
      id: 'in-1',
      request_id: 'req-1',
      request_title: 'Your tax papers',
      recipient_label: 'Jane, accountant',
      item_label: null,
      name: 'W-2 2025.pdf',
      content_type: 'application/pdf',
      byte_size: 120 * 1024,
      sender_note: null,
      sent_at: '2026-10-01T09:00:00Z',
      removed_at: '2026-10-31T09:00:00Z',
      scan_state: 'unscanned',
      preview_state: 'ready',
      preview_pages: 2,
      suggested_member_id: null,
      suggested_type_key: null,
      review_by: 'me',
      moved_to_owners: false,
    };
    at('/inbox', { batches: [OLD_PAPERS()], incoming: [W2] });
    const tabs = await screen.findByRole('navigation', { name: 'Inbox' });
    const uploads = await within(tabs).findByRole('link', { name: 'Your uploads, 3 waiting' });
    expect(uploads).toHaveAttribute('aria-current', 'page');
    expect(
      await within(tabs).findByRole('link', { name: 'Files sent to you, 1 waiting' }),
    ).toHaveAttribute('href', '/inbox/sent');
    const list = await screen.findByRole('list', { name: 'Your uploads' });
    const row = within(list).getByRole('link', { name: /Old papers/ });
    expect(row).toHaveAttribute('href', '/inbox/batches/batch-1');
    expect(row).toHaveTextContent('3 files · 3 waiting · 1 duplicate');
    expect(row).toHaveTextContent('removed on 5 November unless accepted');
    expect(screen.getByText(/Only you can see these until you accept them/)).toBeVisible();
    // Three uploads and one file sent in.
    const side = await screen.findByRole('navigation', { name: 'Sections' });
    expect(await within(side).findByRole('link', { name: 'Inbox, 4 waiting' })).toBeVisible();
    await expectAccessible();
    fireEvent.click(within(tabs).getByRole('link', { name: /Files sent to you/ }));
    expect(await screen.findByText('W-2 2025.pdf')).toBeVisible();
    expect(
      within(screen.getByRole('navigation', { name: 'Inbox' })).getByRole('link', {
        name: /Files sent to you/,
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('a teen has their own uploads, and no files sent to them; an empty Inbox says what it is for; a viewer has no Inbox', async () => {
    at('/inbox', { batches: [] }, 'teen');
    expect(await screen.findByText('Nothing you uploaded is waiting.')).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Inbox' })).toBeNull();
    const side = await screen.findByRole('navigation', { name: 'Sections' });
    expect(within(side).getByRole('link', { name: 'Inbox' })).toBeVisible();
    await expectAccessible();
    document.body.innerHTML = '';
    at('/', { batches: [] }, 'viewer');
    const theirs = await screen.findByRole('navigation', { name: 'Sections' });
    expect(within(theirs).queryByRole('link', { name: /Inbox/ })).toBeNull();
  });
});

describe('a batch’s page (I1)', () => {
  it('its files: the first page when drawn, name, size and pages, waiting to be read, a duplicate said', async () => {
    at('/inbox/batches/batch-1', { batches: [OLD_PAPERS()] });
    expect(await screen.findByRole('heading', { name: 'Old papers' })).toBeVisible();
    const table = screen.getByRole('grid', { name: 'Files in Old papers' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('scan-001.pdf');
    expect(rows[0]).toHaveTextContent('2 KB · 2 pages');
    expect(rows[0]).toHaveTextContent('Waiting to be read');
    expect(
      within(rows[1] as HTMLElement).getByRole('link', {
        name: "Already in the vault: Mansoor's passport",
      }),
    ).toHaveAttribute('href', '/documents/doc-1');
    expect(
      await within(rows[0] as HTMLElement).findByRole('img', {
        name: 'First page of scan-001.pdf',
      }),
    ).toBeVisible();
    // What it chose for all of them.
    const chosen = screen.getByRole('list', { name: 'Chosen for all of them' });
    expect(
      within(chosen)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual([
      'Aisha',
      'Birth certificate',
      'Filing cabinet',
      'The house',
      '#old',
      '#house',
      'Essential',
    ]);
    expect(screen.getByRole('link', { name: 'Carry on uploading' })).toHaveAttribute(
      'href',
      '/add/many?batch=batch-1',
    );
    await expectAccessible();
  });

  it('Accept opens the card filled from what the batch chose, and only that; it files it, and the next file opens, saying what happened', async () => {
    const state = at('/inbox/batches/batch-1', { batches: [OLD_PAPERS()] });
    fireEvent.click(await screen.findByRole('link', { name: 'Accept scan-001.pdf' }));
    await screen.findByLabelText('What it is');
    expect(screen.getByRole('heading', { level: 1, name: 'scan-001.pdf' })).toBeVisible();
    await screen.findByRole('option', { name: 'Aisha' });
    // The batch's choices fill the card...
    expect(screen.getByLabelText('What it is')).toHaveValue('birth_certificate');
    expect(screen.getByLabelText('Whose it is')).toHaveValue('m-0');
    expect(screen.getByLabelText('Name')).toHaveValue("Aisha's birth certificate");
    expect(screen.getByLabelText('Collection')).toHaveValue('collection-h');
    expect(screen.getByLabelText('Tags')).toHaveValue('old, house');
    expect(screen.getByRole('switch', { name: 'Essential' })).toBeChecked();
    // ...and nothing else: what it did not choose stays blank.
    expect(screen.getByLabelText(/Number/)).toHaveValue('');
    expect(screen.getByLabelText('Notes')).toHaveValue('');
    // As each kind says: a birth certificate is for Everyone.
    const vis = screen.getByRole('group', { name: 'Who can see it' });
    expect(within(vis).getByRole('button', { name: 'Everyone' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectAccessible();
    fireEvent.change(screen.getByLabelText(/Number/), { target: { value: 'BC-1' } });
    fireEvent.click(screen.getByRole('button', { name: /^Accept and next/ }));
    // The next file, saying what happened, with the focus on its first field.
    expect(
      await screen.findByText("“scan-001.pdf” is a document now: Aisha's birth certificate."),
    ).toBeVisible();
    await screen.findByRole('heading', { level: 1, name: 'scan-002.pdf' });
    await waitFor(() => expect(screen.getByLabelText('What it is')).toHaveFocus());
    const sent = posts(state, /\/items\/item-1\/accept$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      type_key: 'birth_certificate',
      title: "Aisha's birth certificate",
      owner_member_id: 'm-0',
      visibility: 'household',
      identifier: 'BC-1',
      tags: ['old', 'house'],
      is_essential: true,
      collection_id: 'collection-h',
    });
    expect((sent[0]?.body as Record<string, unknown>).category).toBeUndefined();
    // It is a document now: accepted, with a way to it.
    fireEvent.click(screen.getByRole('link', { name: 'Old papers' }));
    const rows = within(
      await screen.findByRole('grid', { name: 'Files in Old papers' }),
    ).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Accepted');
    expect(
      within(rows[1] as HTMLElement).getByRole('link', { name: 'Open the document' }),
    ).toBeVisible();
    expect(within(rows[1] as HTMLElement).queryByRole('link', { name: /Accept/ })).toBeNull();
  });

  it('Remove asks first; then the focus goes to the next file’s Accept, and to what happened when none is left', async () => {
    const batch = OLD_PAPERS();
    batch.items = batch.items.slice(0, 2);
    const state = at('/inbox/batches/batch-1', { batches: [batch] });
    const remove = await screen.findByRole('button', { name: 'Remove scan-001.pdf' });
    fireEvent.click(remove);
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove “scan-001.pdf”?' });
    await expectAccessible();
    // Cancel: nothing is removed, the focus back on Remove.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(remove).toHaveFocus());
    expect(state.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(remove);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove it' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Accept scan-002.pdf' })).toHaveFocus(),
    );
    expect(state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      '/api/v1/batches/batch-1/items/item-1',
    ]);
    expect(screen.getByText(/“scan-001.pdf” was removed/)).toBeVisible();
    // The last one: the focus on what happened.
    fireEvent.click(screen.getByRole('button', { name: 'Remove scan-002.pdf' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove it' }),
    );
    const said = await screen.findByText(/“scan-002.pdf” was removed/);
    await waitFor(() => expect(said).toHaveFocus());
    expect(screen.getByText('Nothing is in this batch yet.')).toBeVisible();
  });

  it('Remove the batch asks first, says what stays, and goes back to the Inbox saying so', async () => {
    const batch = OLD_PAPERS();
    batch.items[0] = {
      ...(batch.items[0] as BatchItemView),
      state: 'accepted',
      document_id: 'doc-1',
    };
    const state = at('/inbox/batches/batch-1', { batches: [batch] });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the batch' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove “Old papers”?' });
    expect(dialog).toHaveTextContent('2 files not accepted are removed from the vault');
    expect(dialog).toHaveTextContent('What you accepted (1 document) stays in the vault.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove the batch' }));
    const said = await screen.findByText(
      '“Old papers” was removed, with what was not accepted in it.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      '/api/v1/batches/batch-1',
    ]);
  });

  it('at phone width, its files are rows, each with its Accept and Remove; carrying on is still there', async () => {
    at('/inbox/batches/batch-1', { batches: [OLD_PAPERS()] }, 'owner', PHONE);
    const list = await screen.findByRole('list', { name: 'Files in Old papers' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByRole('link', { name: 'Accept scan-001.pdf' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Carry on uploading' })).toBeVisible();
    await expectAccessible();
  });
});

describe('many documents at once, the review (I1)', () => {
  const aBatch = (items: BatchItemView[], defaults: Partial<FakeBatch['defaults']> = {}) => ({
    ...OLD_PAPERS(),
    defaults: { ...OLD_PAPERS().defaults, ...defaults },
    items,
  });
  const held = () => {
    const at = { release: null as (() => void) | null };
    return {
      at,
      hold: (method: string, path: string) =>
        method === 'POST' && /items$/.test(path) && !at.release
          ? new Promise<void>((r) => (at.release = r))
          : undefined,
    };
  };

  it('Only me makes them yours: whose they are becomes you, never different people; the card starts there', async () => {
    const state = at('/add/many');
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    const vis = () => screen.getByRole('group', { name: 'Who can see them' });
    fireEvent.click(within(vis()).getByRole('button', { name: 'Only me' }));
    await waitFor(() => expect(screen.getByLabelText('Whose documents')).toHaveValue('me'));
    // Different people again: Only me goes with it.
    fireEvent.change(screen.getByLabelText('Whose documents'), { target: { value: '' } });
    await waitFor(() =>
      expect(within(vis()).getByRole('button', { name: 'As each kind says' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    fireEvent.click(within(vis()).getByRole('button', { name: 'Only me' }));
    choose([pdf('mine.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 1 file' }));
    await screen.findByRole('link', { name: 'Open the batch' });
    expect(posts(state, /\/api\/v1\/batches$/)[0]?.body).toEqual({
      defaults: { owner_member_id: 'me', visibility: 'private' },
    });
    // A batch kept Only me with nobody chosen: its card starts as the uploader's own, Only me.
    document.body.innerHTML = '';
    at('/inbox/batches/batch-1/items/item-1', {
      batches: [
        aBatch([item({ id: 'item-1', name: 'clinic.pdf' })], {
          owner_member_id: null,
          type_key: null,
          visibility: 'private',
        }),
      ],
    });
    await screen.findByRole('option', { name: 'Aisha' });
    await waitFor(() => expect(screen.getByLabelText('Whose it is')).toHaveValue('me'));
    expect(
      within(screen.getByRole('group', { name: 'Who can see it' })).getByRole('button', {
        name: 'Only me',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('a batch removed while its files go stops the upload: said once, and the rest are not offered again', async () => {
    let n = 0;
    const state = at('/add/many', {
      refuseWith: (method, path) =>
        method === 'POST' && /\/items$/.test(path) && ++n >= 2
          ? { status: 404, code: 'not_found', message: 'That batch is not here.' }
          : undefined,
    });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 3 files' }));
    await screen.findByRole('link', { name: 'Open the batch' });
    expect(posts(state, /\/items$/)).toHaveLength(2);
    expect(screen.getAllByText(/This batch is not there any more/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Send the rest' })).toBeNull();
    expect(screen.getByText(/1 file arrived in/)).toHaveTextContent('2 files not sent');
  });

  it('the vault busy (429): the file waits to be sent again, the rest stop, and Send the rest says when', async () => {
    let n = 0;
    const state = at('/add/many', {
      refuseWith: (method, path) =>
        method === 'POST' && /\/items$/.test(path) && ++n === 2
          ? {
              status: 429,
              code: 'rate_limited',
              message: 'Too many requests at once.',
              retryAfter: 30,
            }
          : undefined,
    });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'), pdf('d.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 4 files' }));
    await screen.findByRole('button', { name: 'Send the rest' });
    expect(posts(state, /\/items$/)).toHaveLength(2);
    expect(
      screen.getByText('Too many requests at once. Send the rest in about 30 seconds.'),
    ).toBeVisible();
    expect(screen.getByText(/The vault was busy: it can be sent again/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Send the rest' }));
    await waitFor(() =>
      expect(screen.getAllByText('Arrived · waiting to be read')).toHaveLength(4),
    );
    expect(posts(state, /\/items$/)).toHaveLength(5);
    // One batch, and nothing in it twice.
    expect(state.batches?.[0]?.items).toHaveLength(4);
  });

  it('Start pressed twice makes one batch, and sends each file once', async () => {
    let release: (() => void) | null = null;
    const state = at('/add/many', {
      hold: (method, path) =>
        method === 'POST' && path === '/api/v1/batches' && !release
          ? new Promise<void>((r) => (release = r))
          : undefined,
    });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('one.pdf'), pdf('two.pdf')]);
    const start = screen.getByRole('button', { name: 'Start: upload 2 files' });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(await screen.findByRole('button', { name: 'Making the batch…' })).toBeDisabled();
    await waitFor(() => expect(release).not.toBeNull());
    act(() => (release as () => void)());
    await screen.findByRole('link', { name: 'Open the batch' });
    expect(posts(state, /\/api\/v1\/batches$/)).toHaveLength(1);
    expect(posts(state, /\/items$/)).toHaveLength(2);
  });

  it('a file sent again carries its Idempotency-Key: the vault answers with the item it made', async () => {
    const state = at('/add/many', { dropAnswerLost: true });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('one.pdf'), pdf('two.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 2 files' }));
    await screen.findByRole('button', { name: 'Send the rest' });
    // The batch cannot be asked just then: the key alone keeps it one item.
    state.dropAnswerLost = false;
    state.refuseWith = (method, path) =>
      method === 'GET' && path === '/api/v1/batches/batch-1'
        ? { status: 503, code: 'unavailable', message: 'The vault is busy.' }
        : undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Send the rest' }));
    await waitFor(() =>
      expect(screen.getAllByText('Arrived · waiting to be read')).toHaveLength(2),
    );
    const tries = posts(state, /\/items$/).filter(
      (c) => (c.body as { file: string }).file === 'one.pdf',
    );
    expect(tries).toHaveLength(2);
    const keys = tries.map((c) => (c.headers ?? {})['idempotency-key']);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(state.batches?.[0]?.items).toHaveLength(2);
  });

  it('Send the rest asks the batch first: a file whose answer was lost is not sent again', async () => {
    const state = at('/add/many', { dropAnswerLost: true });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('one.pdf'), pdf('two.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 2 files' }));
    await screen.findByRole('button', { name: 'Send the rest' });
    state.dropAnswerLost = false;
    fireEvent.click(screen.getByRole('button', { name: 'Send the rest' }));
    await screen.findByText('Already in this batch.');
    await waitFor(() => expect(screen.getByText('Arrived · waiting to be read')).toBeVisible());
    expect(posts(state, /\/items$/).map((c) => (c.body as { file: string }).file)).toEqual([
      'one.pdf',
      'two.pdf',
    ]);
  });

  it('carrying on matches by SHA-256 against every item, never by a name the vault tidied', async () => {
    const words = 'a résumé scan';
    const nfd = 'Résumé.pdf';
    const resume = pdf(nfd, words);
    const twinA = pdf('scan.pdf', 'twin bytes AAAA');
    const batch = aBatch([
      item({
        id: 'item-1',
        name: nfd.normalize('NFC'),
        byte_size: resume.size,
        sha256: shaOf(words),
      }),
      // The same name and size, other bytes: listed first.
      item({
        id: 'item-2',
        name: 'scan.pdf',
        byte_size: twinA.size,
        sha256: shaOf('twin bytes BBBB'),
      }),
      item({
        id: 'item-3',
        name: 'scan.pdf',
        byte_size: twinA.size,
        sha256: shaOf('twin bytes AAAA'),
      }),
    ]);
    const state = at('/add/many?batch=batch-1', { batches: [batch] });
    await screen.findByRole('heading', { name: 'Carry on: Old papers' });
    // Said before anything is chosen: a removed file is sent again.
    expect(
      screen.getByText(/A file you removed from this batch is sent again if you choose it\./),
    ).toBeVisible();
    choose([resume, twinA]);
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 files' }));
    await screen.findByRole('link', { name: 'Open the batch' });
    expect(posts(state, /\/items$/)).toHaveLength(0);
    expect(screen.getAllByText('Already in this batch.')).toHaveLength(2);
  });

  it('a batch of 200: one accept, there and back, asks for a few first pages, and none again', async () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      item({ id: `item-${i + 1}`, name: `scan-${i + 1}.pdf` }),
    );
    // Accepted already, as a vault from before the review said: ready, and no page to ask for.
    items[0] = { ...(items[0] as BatchItemView), state: 'accepted', document_id: 'doc-x' };
    const state = at('/inbox/batches/batch-1', { batches: [aBatch(items)] });
    await screen.findByRole('heading', { name: 'Old papers' });
    const pages = () => state.calls.filter((c) => /\/pages\/1$/.test(c.url));
    // No IntersectionObserver here: the first few rows draw theirs.
    await waitFor(() => expect(pages()).toHaveLength(7));
    expect(pages().some((c) => c.url.includes('/items/item-1/'))).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'Accept scan-2.pdf' }));
    await screen.findByLabelText('What it is');
    // Its pages, beside the card: the first is the one the batch's page drew.
    expect(await screen.findByRole('img', { name: 'Page 1 of 2' })).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: /^Accept and next/ }));
    await screen.findByText(/“scan-2.pdf” is a document now/);
    fireEvent.click(screen.getByRole('link', { name: 'Old papers' }));
    expect(await screen.findByRole('img', { name: 'First page of scan-3.pdf' })).toBeVisible();
    await new Promise((r) => setTimeout(r, 100));
    // Nothing asked again, coming back; far under the vault's 300 a minute in all.
    expect(pages()).toHaveLength(7);
    expect(state.calls.length).toBeLessThan(40);
  });

  it('first pages in view are asked for four at a time', async () => {
    const open = { now: false, waiting: [] as Array<() => void> };
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly seen: (entries: Array<{ isIntersecting: boolean }>) => void) {}
        observe() {
          queueMicrotask(() => this.seen([{ isIntersecting: true }]));
        }
        disconnect() {}
        unobserve() {}
      },
    );
    try {
      const items = Array.from({ length: 20 }, (_, i) =>
        item({ id: `item-${i + 1}`, name: `scan-${i + 1}.pdf` }),
      );
      const state = at('/inbox/batches/batch-1', {
        batches: [aBatch(items)],
        hold: (method, path) =>
          method === 'GET' && /\/pages\/1$/.test(path) && !open.now
            ? new Promise<void>((r) => open.waiting.push(r))
            : undefined,
      });
      await screen.findByRole('heading', { name: 'Old papers' });
      const pages = () => state.calls.filter((c) => /\/pages\/1$/.test(c.url));
      await waitFor(() => expect(pages()).toHaveLength(4));
      await new Promise((r) => setTimeout(r, 50));
      expect(pages()).toHaveLength(4);
      act(() => {
        open.now = true;
        for (const go of open.waiting) go();
      });
      await waitFor(() => expect(pages()).toHaveLength(20));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the sidebar counts your uploads again after a change, not on every move', async () => {
    const state = at('/inbox/batches/batch-1', {
      batches: [
        aBatch([item({ id: 'item-1', name: 'a.pdf' }), item({ id: 'item-2', name: 'b.pdf' })]),
      ],
    });
    const side = () => screen.getByRole('navigation', { name: 'Sections' });
    await screen.findByRole('navigation', { name: 'Sections' });
    expect(await within(side()).findByRole('link', { name: 'Inbox, 2 waiting' })).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove a.pdf' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove it' }),
    );
    await waitFor(() =>
      expect(within(side()).getByRole('link', { name: 'Inbox, 1 waiting' })).toBeVisible(),
    );
    const listed = () =>
      state.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/batches').length;
    const before = listed();
    fireEvent.click(within(side()).getByRole('link', { name: /^Home/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    fireEvent.click(within(side()).getByRole('link', { name: /^Documents/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents'));
    await new Promise((r) => setTimeout(r, 50));
    expect(listed()).toBe(before);
  });

  it('the upload goes on when its page is left: the shell says how far, with a way back, and the page shows it again', async () => {
    const h = held();
    const state = at('/add/many', { hold: h.hold });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('one.pdf'), pdf('two.pdf'), pdf('three.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 3 files' }));
    await screen.findByRole('button', { name: 'Stop after this file' });
    // The page says it may be left; closing the tab asks first.
    expect(screen.getByText(/You can leave this page/)).toBeVisible();
    const closing = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(true);
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
        name: /^Home/,
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    const strip = await screen.findByRole('link', { name: /^Uploading 1 of 3/ });
    expect(strip).toHaveAttribute('href', '/add/many');
    expect(
      screen.getByText('Your upload carries on. Follow it from Uploading, at the top of the page.'),
    ).toBeInTheDocument();
    fireEvent.click(strip);
    // Back on its page: the same upload, with its progress and Stop.
    expect(await screen.findByRole('button', { name: 'Stop after this file' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'one.pdf, sending' })).toBeVisible();
    await waitFor(() => expect(h.at.release).not.toBeNull());
    act(() => (h.at.release as () => void)());
    await screen.findByText(/3 files arrived in/);
    expect(posts(state, /\/items$/)).toHaveLength(3);
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('signing out stops the upload at once: the file going is stopped, and nothing more is sent', async () => {
    const h = held();
    const state = at('/add/many', { hold: h.hold });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('one.pdf'), pdf('two.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 2 files' }));
    await screen.findByRole('button', { name: 'Stop after this file' });
    await waitFor(() => expect(h.at.release).not.toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Your account: Mansoor Seikh' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    });
    await waitFor(() => expect(window.location.pathname).toBe('/sign-in'));
    expect(state.xhrStopped).toBe(1);
    act(() => (h.at.release as () => void)());
    await new Promise((r) => setTimeout(r, 50));
    expect(posts(state, /\/items$/)).toHaveLength(1);
  });

  it('with the batch on the screen, a reload that fails says so beside it, keeps a dialog open, and asks again later', async () => {
    const was = { ...batchPolling };
    batchPolling.every = 30;
    try {
      let fail = false;
      const state = at('/inbox/batches/batch-1', {
        batches: [OLD_PAPERS()],
        refuseWith: (method, path) =>
          fail && method === 'GET' && path === '/api/v1/batches/batch-1'
            ? { status: 503, code: 'unavailable', message: 'The vault is busy.' }
            : undefined,
      });
      await screen.findByRole('heading', { name: 'Old papers' });
      fireEvent.click(await screen.findByRole('button', { name: 'Remove scan-001.pdf' }));
      await screen.findByRole('alertdialog');
      await waitFor(() =>
        expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(true),
      );
      fail = true;
      expect(await screen.findByText('The vault is busy.')).toBeVisible();
      expect(screen.getByRole('grid', { name: 'Files in Old papers' })).toBeVisible();
      expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(true);
      // Asked again, more slowly: the vault back, the note goes.
      const asked = state.calls.length;
      fail = false;
      await waitFor(() => expect(screen.queryByText('The vault is busy.')).toBeNull());
      expect(state.calls.length).toBeGreaterThan(asked);
    } finally {
      Object.assign(batchPolling, was);
    }
  });

  it('nothing is taken away by the layout: a computer zoomed to 960 × 480 adds many, carries on, and is not told it is a phone', async () => {
    at('/add/many', { batches: [OLD_PAPERS()] }, 'owner', 960, true, 480);
    expect(await screen.findByRole('heading', { name: 'Add many documents' })).toBeVisible();
    expect(screen.getByLabelText('Choose files')).toBeInTheDocument();
    expect(screen.queryByText(/quicker on a computer/)).toBeNull();
    act(() => {
      window.history.pushState({}, '', '/inbox');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('link', { name: 'Add many documents' })).toHaveAttribute(
      'href',
      '/add/many',
    );
    act(() => {
      window.history.pushState({}, '', '/inbox/batches/batch-1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('link', { name: 'Carry on uploading' })).toHaveAttribute(
      'href',
      '/add/many?batch=batch-1',
    );
    await expectAccessible();
  });

  it('accepting into a collection says who else will now see it; choosing one shared outside says so first', async () => {
    const shared = { ...HOUSE, shared_outside: { with: ['Jane Smith'], following: true } };
    at('/inbox/batches/batch-1/items/item-1', {
      batches: [OLD_PAPERS()],
      collections: [shared],
      collectionWarnings: ['Jane (viewer) will be able to see this.'],
    });
    await screen.findByLabelText('What it is');
    await screen.findByRole('option', { name: 'Aisha' });
    await waitFor(() =>
      expect(screen.getByLabelText('Collection')).toHaveAccessibleDescription(
        /This collection is shared with Jane Smith/,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Accept and next/ }));
    expect(
      await screen.findByText(
        "“scan-001.pdf” is a document now: Aisha's birth certificate. Jane (viewer) will be able to see this.",
      ),
    ).toBeVisible();
    // And the batch's own choice, before anything is sent.
    document.body.innerHTML = '';
    at('/add/many', { collections: [shared] });
    fireEvent.change(await screen.findByLabelText('Collection'), {
      target: { value: 'collection-h' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Collection')).toHaveAccessibleDescription(
        /This collection is shared with Jane Smith/,
      ),
    );
  });

  it('after a finished upload, Add → Many documents starts a new one, and so does Add another batch', async () => {
    at('/add/many');
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('one.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 1 file' }));
    await screen.findByRole('link', { name: 'Open the batch' });
    fireEvent.click(within(await appBar()).getByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Many documents/ }));
    await waitFor(() => expect(screen.getByLabelText('Choose files')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Open the batch' })).toBeNull();
    choose([pdf('two.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 1 file' }));
    await screen.findByRole('link', { name: 'Open the batch' });
    fireEvent.click(screen.getByRole('button', { name: 'Add another batch' }));
    await waitFor(() => expect(screen.getByLabelText('Choose files')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Choose some files first' })).toBeDisabled();
  });

  it('whose documents: everybody of the family, those who have died after the living', async () => {
    const gran = { ...AISHA, id: 'm-9', display_name: 'Gran', is_deceased: true };
    at('/add/many', { members: [{ ...ME, role: 'owner' }, gran, AISHA] });
    await screen.findByRole('option', { name: 'Aisha' });
    const options = within(screen.getByLabelText('Whose documents'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'Different people, or not sure',
      'Mansoor Seikh',
      'Aisha',
      'Gran (passed away)',
    ]);
  });
});

describe('many documents at once, the check (I1)', () => {
  it('another tab signed in as somebody else: the upload stops, nothing more goes under their sign-in, and nothing of it is shown', async () => {
    let release: (() => void) | null = null;
    const state = at('/add/many', {
      // Every call asks for a fresh token: the session another tab left is found at once.
      accessSeconds: 30,
      hold: (method, path) =>
        method === 'POST' && /items$/.test(path) && !release
          ? new Promise<void>((r) => (release = r))
          : undefined,
    });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('mine-one.pdf'), pdf('mine-two.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 2 files' }));
    await screen.findByRole('button', { name: 'Stop after this file' });
    await waitFor(() => expect(release).not.toBeNull());
    // Another tab signs in as somebody else; this one takes their sign-in over.
    state.refreshMember = 'somebody-else';
    act(() => (release as () => void)());
    await waitFor(() => expect(screen.getByLabelText('Choose files')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(posts(state, /\/items$/)).toHaveLength(1);
    expect(screen.queryByText('mine-one.pdf')).toBeNull();
    expect(screen.queryByText('mine-two.pdf')).toBeNull();
    expect(screen.queryByRole('link', { name: /^Upload/ })).toBeNull();
  });

  it('Add another batch on a carry-on page starts a new batch, not the one carried on', async () => {
    const state = at('/add/many?batch=batch-1', { batches: [OLD_PAPERS()] });
    await screen.findByRole('heading', { name: 'Carry on: Old papers' });
    choose([pdf('one.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 file' }));
    await screen.findByRole('link', { name: 'Open the batch' });
    fireEvent.click(screen.getByRole('button', { name: 'Add another batch' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Add many documents'),
    );
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('two.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 1 file' }));
    await screen.findByRole('link', { name: 'Open the batch' });
    expect(posts(state, /\/api\/v1\/batches$/)).toHaveLength(1);
    expect(posts(state, /\/items$/).map((c) => c.url)).toEqual([
      '/api/v1/batches/batch-1/items',
      '/api/v1/batches/batch-2/items',
    ]);
  });

  it('stopped short away from its page: the shell says how far it got, and Send the rest, never finished', async () => {
    let release: (() => void) | null = null;
    let n = 0;
    const state = at('/add/many', {
      hold: (method, path) =>
        method === 'POST' && /items$/.test(path) && !release
          ? new Promise<void>((r) => (release = r))
          : undefined,
      refuseWith: (method, path) =>
        method === 'POST' && /\/items$/.test(path) && ++n === 2
          ? { status: 503, code: 'unavailable', message: 'The vault is busy.' }
          : undefined,
    });
    await screen.findByRole('heading', { name: 'Add many documents' });
    await screen.findByRole('option', { name: 'Aisha' });
    choose([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: 'Start: upload 3 files' }));
    await screen.findByRole('button', { name: 'Stop after this file' });
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
        name: /^Home/,
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    await waitFor(() => expect(release).not.toBeNull());
    act(() => (release as () => void)());
    const strip = await screen.findByRole('link', {
      name: /^Upload stopped: 1 of 3 files arrived\. Send the rest/,
    });
    expect(strip).toHaveAttribute('href', '/add/many');
    expect(screen.queryByText(/Upload finished/)).toBeNull();
    expect(
      screen.getByText(/^Your upload stopped: 1 of 3 files arrived in “.+”\. Send the rest\.$/),
    ).toBeInTheDocument();
    expect(posts(state, /\/items$/)).toHaveLength(2);
  });
});
