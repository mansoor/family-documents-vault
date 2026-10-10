import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  levelItem,
  untouchedAccept,
  type BatchDefaults,
  type BatchItemView,
  type BatchReadFailure,
  type BatchReadState,
  type DetailProposal,
  type DocumentTypeView,
} from '@fdv/shared';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { batchPolling } from './screens/Batches.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  signedIn,
  type FakeBatch,
  type FakeState,
} from './test-api.js';

/**
 * The review queue (Phase 6, I3), on the web: the batch's page with its
 * levels to show, each counted and kept in the address, and Accept all
 * Ready — asked first, then a toast with Undo that stays until it is put
 * away; a file in two panes, the card on the left and its pages on the
 * right, Accept and next with Enter, Skip, and Remove, which asks; after
 * the last, back to the queue with what was done; and the Inbox's Accept
 * all Ready and Review for each batch.
 */

const WIDE = 1280;

function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || px >= Number(minWidth[1])) &&
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

const DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: 'household',
  physical_location: null,
  collection_id: null,
  tags: ['post'],
  is_essential: false,
};

const day = (date: string) => ({ date, precision: 'day' as const });
const PASSPORT = (owner: string, c = 0.9): DetailProposal => ({
  type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
  owner_member_id: { value: owner, confidence: c, cue: 'name_labelled' },
  issued: { value: day('2021-03-14'), confidence: 0.89, cue: 'issue_label' },
  expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
  identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
  issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
});

/** An item as the vault answers it: levelled as the vault levels it (levelItem). */
function item(
  id: string,
  name: string,
  read: {
    reading?: BatchReadState;
    proposal?: DetailProposal;
    failure?: BatchReadFailure;
    duplicate?: BatchItemView['duplicate'];
    state?: BatchItemView['state'];
  },
  types: DocumentTypeView[],
): BatchItemView {
  const reading = read.reading ?? (read.failure ? 'failed' : 'read');
  const duplicate = read.duplicate ?? null;
  const state = read.state ?? 'waiting';
  const levelled = levelItem({
    state,
    reading,
    failure: read.failure ?? null,
    proposal: read.proposal ?? null,
    duplicate,
    defaults: DEFAULTS,
    types,
    people: [
      { id: 'me', name: 'Mansoor Seikh' },
      { id: 'm-0', name: 'Aisha' },
    ],
    role: 'owner',
    me: 'me',
  });
  return {
    id,
    batch_id: 'batch-1',
    name,
    content_type: 'application/pdf',
    byte_size: 2048,
    sha256: id.padEnd(64, '0'),
    arrived_at: '2026-10-06T09:05:00Z',
    state,
    reading,
    read_failure: read.failure ?? null,
    preview_state: state === 'accepted' ? 'none' : 'ready',
    preview_pages: state === 'accepted' ? null : 2,
    duplicate,
    document_id: state === 'accepted' ? 'doc-done' : null,
    level: levelled.level,
    tags: levelled.tags,
    proposals: levelled.proposals,
    clashes: levelled.clashes,
  };
}

/** Two Ready, a Check, one not recognised, a Problem, one accepted; and one removed. */
const QUEUE = (types: DocumentTypeView[]) => [
  item('item-1', 'passport.pdf', { proposal: PASSPORT('me') }, types),
  item('item-2', 'aisha.pdf', { proposal: PASSPORT('m-0') }, types),
  item('item-3', 'unsure.pdf', { proposal: PASSPORT('me', 0.7) }, types),
  item('item-4', 'note.pdf', { proposal: {} }, types),
  item('item-5', 'blank.pdf', { failure: 'blank' }, types),
  item('item-6', 'done.pdf', { proposal: PASSPORT('me'), state: 'accepted' }, types),
];

/** The app at `path`, an owner, with this batch. */
function at(
  path: string,
  items: (types: DocumentTypeView[]) => BatchItemView[] = QUEUE,
  over: Partial<FakeState> & { removed?: number; width?: number } = {},
): FakeState {
  const { removed = 1, width = WIDE, ...rest } = over;
  atWidth(width);
  const state = fresh({ members: [{ ...ME, role: 'owner' }, AISHA], batches: [], ...rest });
  const batch: FakeBatch = {
    id: 'batch-1',
    name: 'Scanned post',
    created_at: '2026-10-06T09:00:00Z',
    ends_at: '2026-11-05T09:00:00Z',
    defaults: DEFAULTS,
    items: [
      ...items(state.types as unknown as DocumentTypeView[]),
      ...Array.from({ length: removed }, (_, i) => ({
        ...item(`gone-${i}`, 'gone.pdf', { proposal: {} }, []),
        removed: true,
      })),
    ],
  };
  state.batches = [batch];
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const queueTable = () => screen.findByRole('grid', { name: /^Files in Scanned post/ });
const rowsOf = async () =>
  within(await queueTable())
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '');
const filters = () => screen.getByRole('group', { name: 'Show' });

describe('the review queue (I3)', () => {
  it('filters by level, each with how many, kept in the address; Done says what was accepted and removed', async () => {
    at('/inbox/batches/batch-1');
    await queueTable();
    expect(
      within(filters())
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['All6', 'true'],
      ['Ready2', 'false'],
      ['Check1', 'false'],
      ['Not recognised1', 'false'],
      ['Problems1', 'false'],
      ['Done2', 'false'],
      ['Accept all Ready (2)', null],
    ]);
    fireEvent.click(within(filters()).getByRole('button', { name: /^Check/ }));
    await waitFor(() => expect(window.location.search).toBe('?level=check'));
    expect(await rowsOf()).toHaveLength(1);
    expect((await rowsOf())[0]).toContain('unsure.pdf');
    expect(within(filters()).getByRole('button', { name: /^Check/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectAccessible();
    fireEvent.click(within(filters()).getByRole('button', { name: /^Done/ }));
    await waitFor(() => expect(window.location.search).toBe('?level=done'));
    expect(await rowsOf()).toEqual([expect.stringContaining('done.pdf')]);
    expect(screen.getByText('And 1 file removed: not documents.')).toBeVisible();
  });

  it('opened at a level from its address, it shows that level; the files are named as they would be filed', async () => {
    at('/inbox/batches/batch-1?level=ready');
    const rows = await rowsOf();
    expect(rows).toHaveLength(2);
    // What each would be filed as, and its file.
    expect(rows[0]).toContain("Mansoor's passport");
    expect(rows[0]).toContain('passport.pdf');
    expect(rows[1]).toContain("Aisha's passport");
    expect(rows[1]).toContain('Aisha');
  });

  it('moves from file to file with the arrows, and j and k while single keys are on; one stop for Tab', async () => {
    at('/inbox/batches/batch-1');
    const table = await queueTable();
    const accept = (name: string) => screen.getByRole('link', { name: `Accept ${name}` });
    // One stop for the whole table (R2's grid): the first file's name.
    await waitFor(() =>
      expect(within(table).getAllByRole('link', { name: "Mansoor's passport" })[0]).toHaveAttribute(
        'tabindex',
        '0',
      ),
    );
    expect(accept('passport.pdf')).toHaveAttribute('tabindex', '-1');
    expect(accept('aisha.pdf')).toHaveAttribute('tabindex', '-1');
    accept('passport.pdf').focus();
    fireEvent.keyDown(accept('passport.pdf'), { key: 'ArrowDown' });
    await waitFor(() => expect(accept('aisha.pdf')).toHaveFocus());
    expect(accept('aisha.pdf')).toHaveAttribute('tabindex', '0');
    expect(accept('passport.pdf')).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(accept('aisha.pdf'), { key: 'j' });
    // A Check is opened to be looked at: Review, not Accept.
    const review = () => screen.getByRole('link', { name: 'Review unsure.pdf' });
    await waitFor(() => expect(review()).toHaveFocus());
    fireEvent.keyDown(review(), { key: 'k' });
    await waitFor(() => expect(accept('aisha.pdf')).toHaveFocus());
    // Enter opens it: it is the link to its card, at the queue's level.
    expect(accept('aisha.pdf')).toHaveAttribute('href', '/inbox/batches/batch-1/items/item-2');
  });

  it('with single keys turned off, j and k do nothing; the arrows still move', async () => {
    localStorage.setItem('fdv.shortcuts', 'off');
    at('/inbox/batches/batch-1');
    await queueTable();
    const accept = (name: string) => screen.getByRole('link', { name: `Accept ${name}` });
    accept('passport.pdf').focus();
    fireEvent.keyDown(accept('passport.pdf'), { key: 'j' });
    await new Promise((r) => setTimeout(r, 30));
    expect(accept('passport.pdf')).toHaveFocus();
    fireEvent.keyDown(accept('passport.pdf'), { key: 'ArrowDown' });
    await waitFor(() => expect(accept('aisha.pdf')).toHaveFocus());
    expect(screen.getByText(/Up and down arrows move between the files/)).toBeVisible();
  });

  it('Accept all Ready asks first, sends what the page showed Ready, and says what happened in a toast with Undo that stays', async () => {
    const state = at('/inbox/batches/batch-1');
    await queueTable();
    const all = within(filters()).getByRole('button', { name: 'Accept all Ready (2)' });
    fireEvent.click(all);
    const dialog = await screen.findByRole('alertdialog', { name: 'Accept 2 Ready files?' });
    expect(dialog).toHaveTextContent('You can undo this for 5 minutes.');
    await expectAccessible();
    // Cancel: nothing sent, the focus back on the button.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(all).toHaveFocus());
    expect(state.acceptReadyCalls ?? []).toHaveLength(0);
    fireEvent.click(all);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Accept 2' }),
    );
    const toast = await screen.findByRole('region', { name: 'What was just done' });
    expect(state.acceptReadyCalls).toEqual([{ batch: 'batch-1', item_ids: ['item-1', 'item-2'] }]);
    expect(toast).toHaveTextContent(
      '2 files accepted as documents. You can undo this for 5 minutes.',
    );
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'What was just done' })).toHaveFocus(),
    );
    // Heard politely, too.
    expect(
      screen
        .getAllByRole('status')
        .some((s) => s.textContent?.includes('2 files accepted as documents')),
    ).toBe(true);
    // The page has them accepted; nothing is Ready any more.
    await waitFor(() =>
      expect(within(filters()).queryByRole('button', { name: /Accept all Ready/ })).toBeNull(),
    );
    expect(document.querySelector('main')).toHaveClass('has-toast');
    await expectAccessible();
    // It stays: no timer takes it away.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole('region', { name: 'What was just done' })).toBeVisible();
    // Undo, by keyboard: one Tab from the toast.
    const undo = within(toast).getByRole('button', { name: 'Undo' });
    fireEvent.click(undo);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'What was just done' })).toHaveTextContent(
        'Undone: 2 files are back in the queue, and will be read again.',
      ),
    );
    expect(state.undoCalls).toEqual([{ batch: 'batch-1', item_ids: ['item-1', 'item-2'] }]);
    expect(
      within(screen.getByRole('region', { name: 'What was just done' })).queryByRole('button', {
        name: 'Undo',
      }),
    ).toBeNull();
    await waitFor(async () => expect((await rowsOf()).join()).toContain('Waiting to be read'));
    // Escape puts it away.
    fireEvent.keyDown(screen.getByRole('region', { name: 'What was just done' }), {
      key: 'Escape',
    });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'What was just done' })).toBeNull(),
    );
  });

  it('what could not be accepted, or was not Ready any more, is named in the toast; Undo’s keeps are said', async () => {
    const state = at('/inbox/batches/batch-1', QUEUE, {
      acceptReadyRefuse: {
        'item-2': {
          code: 'storage_unreachable',
          message: 'We can’t reach where your files are kept.',
        },
      },
      undoRefuse: {
        'item-1': { reason: 'too_late', message: 'More than 5 minutes have passed.' },
      },
    });
    await queueTable();
    fireEvent.click(within(filters()).getByRole('button', { name: 'Accept all Ready (2)' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Accept 2' }),
    );
    const toast = await screen.findByRole('region', { name: 'What was just done' });
    expect(toast).toHaveTextContent('1 file accepted as a document.');
    expect(toast).toHaveTextContent(
      '“aisha.pdf” was not accepted: We can’t reach where your files are kept.',
    );
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'What was just done' })).toHaveTextContent(
        '1 file stays a document: More than 5 minutes have passed.',
      ),
    );
    expect(state.undoCalls).toEqual([{ batch: 'batch-1', item_ids: ['item-1'] }]);
  });

  it('a vault from before the review queue has no Accept all Ready', async () => {
    at('/inbox/batches/batch-1', QUEUE, { batchReview: false });
    await queueTable();
    expect(screen.queryByRole('button', { name: /Accept all Ready/ })).toBeNull();
  });
});

describe('a file in two panes (I3)', () => {
  it('the card on the left, its pages on the right, each a named region; on a phone the card first', async () => {
    at('/inbox/batches/batch-1/items/item-1');
    const details = await screen.findByRole('region', { name: "Mansoor's passport" });
    const pages = screen.getByRole('region', { name: 'Pages of passport.pdf' });
    // The card before the pages, in the page's order: first on a phone.
    expect(details.compareDocumentPosition(pages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(details).getByLabelText(/What it is/)).toHaveValue('passport');
    expect(screen.getByText('What it is').closest('label')).toHaveTextContent('suggested · 97%');
    expect(await within(pages).findByRole('img', { name: 'Page 1 of 2' })).toBeVisible();
    expect(screen.getByRole('button', { name: /^Accept and next/ })).toHaveAttribute(
      'aria-keyshortcuts',
      'Enter',
    );
    expect(screen.getByRole('button', { name: /^Accept and next/ })).toHaveTextContent('Enter');
    await expectAccessible();
  });

  it('the pages turn with the buttons, and Page Up and Page Down — or [ and ] — with the page in focus', async () => {
    at('/inbox/batches/batch-1/items/item-1');
    const pages = await screen.findByRole('region', { name: 'Pages of passport.pdf' });
    await within(pages).findByRole('img', { name: 'Page 1 of 2' });
    fireEvent.click(within(pages).getByRole('button', { name: /Next page/ }));
    expect(await within(pages).findByRole('img', { name: 'Page 2 of 2' })).toBeVisible();
    expect(within(pages).getByRole('button', { name: /Next page/ })).toBeDisabled();
    const viewer = within(pages).getByRole('group', { name: /^Page 2 of 2/ });
    fireEvent.keyDown(viewer, { key: 'PageUp' });
    expect(await within(pages).findByRole('img', { name: 'Page 1 of 2' })).toBeVisible();
    fireEvent.keyDown(within(pages).getByRole('group', { name: /^Page 1 of 2/ }), { key: ']' });
    expect(await within(pages).findByRole('img', { name: 'Page 2 of 2' })).toBeVisible();
    // Fit to width, or the page's own size.
    const fit = within(pages).getByRole('button', { name: 'Fit to width' });
    expect(fit).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(fit);
    expect(fit).toHaveAttribute('aria-pressed', 'false');
  });

  it('with single keys off, [ and ] turn nothing; Page Down still does', async () => {
    localStorage.setItem('fdv.shortcuts', 'off');
    at('/inbox/batches/batch-1/items/item-1');
    const pages = await screen.findByRole('region', { name: 'Pages of passport.pdf' });
    await within(pages).findByRole('img', { name: 'Page 1 of 2' });
    fireEvent.keyDown(within(pages).getByRole('group', { name: /^Page 1 of 2/ }), { key: ']' });
    await new Promise((r) => setTimeout(r, 30));
    expect(within(pages).getByRole('img', { name: 'Page 1 of 2' })).toBeVisible();
    fireEvent.keyDown(within(pages).getByRole('group', { name: /^Page 1 of 2/ }), {
      key: 'PageDown',
    });
    expect(await within(pages).findByRole('img', { name: 'Page 2 of 2' })).toBeVisible();
  });

  it('untouched, Enter files it with exactly what Accept all Ready would, and the next file opens with the focus on its first field and where it is said', async () => {
    const state = at('/inbox/batches/batch-1?level=', QUEUE);
    fireEvent.click(await screen.findByRole('link', { name: 'Accept passport.pdf' }));
    const kind = await screen.findByLabelText(/What it is/);
    await waitFor(() => expect(screen.getByLabelText(/What it is/)).toHaveFocus());
    expect(screen.getByText('Item 1 of 5, Ready')).toBeInTheDocument();
    fireEvent.keyDown(kind, { key: 'Enter' });
    await waitFor(() => expect(state.batchAccepts).toHaveLength(1));
    const one = (state.batches?.[0]?.items ?? []).find((i) => i.id === 'item-1');
    const types = state.types as unknown as DocumentTypeView[];
    // What the card sent is what Accept all Ready files for it.
    expect(state.batchAccepts?.[0]?.body).toEqual(
      untouchedAccept({
        proposals: QUEUE(types)[0]?.proposals as NonNullable<BatchItemView['proposals']>,
        defaults: DEFAULTS,
        types,
        people: [ME, AISHA],
        role: 'owner',
        me: 'me',
      }),
    );
    expect(one?.state).toBe('accepted');
    // The next, in the queue's order.
    await screen.findByRole('heading', { level: 1, name: "Aisha's passport" });
    await waitFor(() => expect(screen.getByLabelText(/What it is/)).toHaveFocus());
    expect(screen.getByText('Item 2 of 5, Ready')).toBeInTheDocument();
    expect(screen.getByText("“passport.pdf” is a document now: Mansoor's passport.")).toBeVisible();
  });

  it('Enter in the notes starts a line, and accepts nothing; from a box, it accepts', async () => {
    const state = at('/inbox/batches/batch-1/items/item-1');
    const notes = await screen.findByLabelText('Notes');
    fireEvent.keyDown(notes, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 50));
    expect(state.batchAccepts ?? []).toHaveLength(0);
    // Nor from a button, where Enter presses it.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Everyone' }), { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 50));
    expect(state.batchAccepts ?? []).toHaveLength(0);
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' });
    await waitFor(() => expect(state.batchAccepts).toHaveLength(1));
  });

  it('a check names what to look at, and an accept the vault refuses keeps the file, saying why on the card', async () => {
    const state = at('/inbox/batches/batch-1/items/item-3?level=check', QUEUE, {
      acceptRefuse: {
        'item-3': {
          status: 422,
          code: 'validation_failed',
          message: 'That person is not in the family.',
        },
      },
    });
    await screen.findByRole('heading', { level: 1, name: /passport/ });
    expect(screen.getByText('Item 1 of 1, Check: Person unsure')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Accept and next/ }));
    expect(await screen.findByText('That person is not in the family.')).toBeVisible();
    expect(state.batchAccepts).toHaveLength(1);
    expect(screen.getByRole('region', { name: /passport/ })).toBeVisible();
    expect(window.location.pathname).toBe('/inbox/batches/batch-1/items/item-3');
  });

  it('a duplicate’s button says Accept anyway; a problem says why', async () => {
    at('/inbox/batches/batch-1/items/item-7', (types) => [
      ...QUEUE(types),
      item(
        'item-7',
        'copy.pdf',
        {
          proposal: PASSPORT('me'),
          duplicate: { of: 'document', document_id: 'doc-1', title: "Mansoor's passport" },
        },
        types,
      ),
    ]);
    expect(await screen.findByRole('button', { name: /^Accept anyway/ })).toBeVisible();
    expect(screen.getAllByText("Already in the vault: Mansoor's passport").length).toBeGreaterThan(
      0,
    );
    document.body.innerHTML = '';
    at('/inbox/batches/batch-1/items/item-5');
    expect(
      await screen.findByText('Couldn’t read the pages', { selector: 'strong' }),
    ).toBeVisible();
    expect(screen.getByText(/The pages look blank/)).toBeVisible();
    await expectAccessible();
  });

  it('Skip moves on without deciding; Remove asks first, Cancel gives the focus back, and removing opens the next', async () => {
    const state = at('/inbox/batches/batch-1/items/item-1');
    await screen.findByRole('heading', { level: 1, name: "Mansoor's passport" });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await screen.findByRole('heading', { level: 1, name: "Aisha's passport" });
    // The new card has arrived when its first field has the focus: only then
    // is the focus moved on, as a person would (focused before, the card's
    // arrival could take it back to the first field, and the dialog gave the
    // focus back there: the flake under load).
    await waitFor(() => expect(screen.getByLabelText(/What it is/)).toHaveFocus());
    expect(state.batchAccepts ?? []).toHaveLength(0);
    const remove = screen.getByRole('button', { name: 'Not a document, remove it' });
    // A click puts the focus on the button, as a browser does.
    remove.focus();
    fireEvent.click(remove);
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove “aisha.pdf”?' });
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Not a document, remove it' })).toHaveFocus(),
    );
    expect(state.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Not a document, remove it' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove it' }),
    );
    await waitFor(() =>
      expect(state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
        expect.stringContaining('/items/item-2'),
      ]),
    );
    // The next still waiting: the Check, the focus on its first field.
    await screen.findByRole('heading', { level: 1, name: /passport/ });
    await waitFor(() => expect(screen.getByLabelText(/What it is/)).toHaveFocus());
    expect(window.location.pathname).toBe('/inbox/batches/batch-1/items/item-3');
  });

  it('after the last, back to the queue, saying what was done', async () => {
    const two = (types: DocumentTypeView[]) => QUEUE(types).slice(0, 2);
    const state = at('/inbox/batches/batch-1?level=ready', two, { removed: 0 });
    fireEvent.click(await screen.findByRole('link', { name: 'Accept passport.pdf' }));
    fireEvent.keyDown(await screen.findByLabelText(/What it is/), { key: 'Enter' });
    await screen.findByRole('heading', { level: 1, name: "Aisha's passport" });
    fireEvent.click(screen.getByRole('button', { name: 'Not a document, remove it' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove it' }),
    );
    const said = await screen.findByText(/All 2 done: 1 accepted, 1 removed\./);
    await waitFor(() => expect(said).toHaveFocus());
    expect(window.location.pathname).toBe('/inbox/batches/batch-1');
    expect(window.location.search).toBe('?level=ready');
    expect(state.batchAccepts).toHaveLength(1);
  });
});

describe('the Inbox’s Your uploads (I3)', () => {
  it('each batch has Accept all Ready with its count, asked first and then the toast with Undo, and Review', async () => {
    const state = at('/inbox');
    const list = await screen.findByRole('list', { name: 'Your uploads' });
    const review = await within(list).findByRole('link', { name: 'Review 5 in Scanned post' });
    expect(review).toHaveAttribute('href', '/inbox/batches/batch-1');
    const all = within(list).getByRole('button', { name: 'Accept all Ready in Scanned post (2)' });
    expect(all).toHaveTextContent('Accept all Ready (2)');
    await expectAccessible();
    fireEvent.click(all);
    fireEvent.click(
      within(await screen.findByRole('alertdialog', { name: 'Accept 2 Ready files?' })).getByRole(
        'button',
        { name: 'Accept 2' },
      ),
    );
    const toast = await screen.findByRole('region', { name: 'What was just done' });
    // From the Inbox, whatever is Ready now: the vault decides.
    // The batch read first: what it showed Ready is what is sent (W-I3-3).
    expect(state.acceptReadyCalls).toEqual([{ batch: 'batch-1', item_ids: ['item-1', 'item-2'] }]);
    expect(toast).toHaveTextContent('2 files accepted as documents.');
    await waitFor(() =>
      expect(within(list).queryByRole('button', { name: /Accept all Ready/ })).toBeNull(),
    );
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'What was just done' })).toHaveTextContent(
        'Undone: 2 files are back in the queue',
      ),
    );
    await expectAccessible();
  });
});

describe('the review round (I3)', () => {
  const twoReady = (types: DocumentTypeView[]) => QUEUE(types).slice(0, 2);
  const toast = () => screen.getByRole('region', { name: 'What was just done' });
  const confirmAll = async (n: number) => {
    fireEvent.click(await screen.findByRole('button', { name: `Accept all Ready (${n})` }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: `Accept ${n}` }),
    );
    return screen.findByRole('region', { name: 'What was just done' });
  };

  it('a held Enter accepts one file, never the ones it opens after; a fresh press accepts the next (W-I3-1)', async () => {
    const state = at('/inbox/batches/batch-1/items/item-1');
    await screen.findByRole('heading', { level: 1, name: "Mansoor's passport" });
    await waitFor(() => expect(screen.getByLabelText(/What it is/)).toHaveFocus());
    // A repeat before any press on this card: nothing.
    fireEvent.keyDown(screen.getByLabelText(/What it is/), { key: 'Enter', repeat: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(state.batchAccepts ?? []).toHaveLength(0);
    // Pressed: this one.
    fireEvent.keyDown(screen.getByLabelText(/What it is/), { key: 'Enter' });
    await screen.findByRole('heading', { level: 1, name: "Aisha's passport" });
    // Held on: its repeats on the next card accept nothing.
    for (let n = 0; n < 6; n++) {
      fireEvent.keyDown(screen.getByLabelText(/What it is/), { key: 'Enter', repeat: true });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(state.batchAccepts).toHaveLength(1);
    expect(window.location.pathname).toBe('/inbox/batches/batch-1/items/item-2');
    // Let go, and pressed again: the next.
    fireEvent.keyUp(screen.getByLabelText(/What it is/), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText(/What it is/), { key: 'Enter' });
    await waitFor(() => expect(state.batchAccepts).toHaveLength(2));
  });

  it('a later request that fails keeps what was filed, with its Undo, and says the rest were not accepted (W-I3-2)', async () => {
    const many = (types: DocumentTypeView[]) =>
      Array.from({ length: 60 }, (_, i) =>
        item(`item-${i + 1}`, `f${i + 1}.pdf`, { proposal: PASSPORT('me') }, types),
      );
    const state = at('/inbox/batches/batch-1', many, { removed: 0 });
    const real = window.fetch.bind(window);
    let n = 0;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (/accept-ready$/.test(url) && init?.method === 'POST' && ++n === 2) {
        return Response.json(
          { error: { code: 'internal', message: 'Something went wrong.', request_id: 'r' } },
          { status: 500 },
        );
      }
      return real(input, init);
    };
    try {
      const shown = await confirmAll(60);
      expect(shown).toHaveTextContent('50 files accepted as documents.');
      expect(shown).toHaveTextContent('The rest were not accepted: Something went wrong.');
      fireEvent.click(within(toast()).getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(state.undoCalls?.[0]?.item_ids).toHaveLength(50));
    } finally {
      window.fetch = real;
    }
  });

  it('from the Inbox, the batch is read first: the question counts what is Ready then, and only those are sent (W-I3-3)', async () => {
    const state = at('/inbox', twoReady, { removed: 0 });
    const list = await screen.findByRole('list', { name: 'Your uploads' });
    const button = await within(list).findByRole('button', {
      name: 'Accept all Ready in Scanned post (2)',
    });
    // Read meanwhile: one more Ready before the question.
    const types = state.types as unknown as DocumentTypeView[];
    state.batches?.[0]?.items.push(item('item-3', 'c.pdf', { proposal: PASSPORT('me') }, types));
    fireEvent.click(button);
    const dialog = await screen.findByRole('alertdialog', { name: 'Accept 3 Ready files?' });
    // And two more while it is asked: not sent.
    state.batches?.[0]?.items.push(
      item('item-4', 'd.pdf', { proposal: PASSPORT('me') }, types),
      item('item-5', 'e.pdf', { proposal: PASSPORT('me') }, types),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept 3' }));
    expect(await screen.findByRole('region', { name: 'What was just done' })).toHaveTextContent(
      '3 files accepted as documents.',
    );
    expect(state.acceptReadyCalls).toEqual([
      { batch: 'batch-1', item_ids: ['item-1', 'item-2', 'item-3'] },
    ]);
  });

  it('the toast put away, its button gone: the focus goes to the queue’s status line, or the Inbox’s batch (W-I3-4)', async () => {
    at('/inbox/batches/batch-1', twoReady, { removed: 0 });
    await confirmAll(2);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Accept all Ready/ })).toBeNull(),
    );
    fireEvent.keyDown(toast(), { key: 'Escape' });
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('p.status-line[tabindex="-1"]')),
    );
    document.body.innerHTML = '';
    at('/inbox', twoReady, { removed: 0 });
    const list = await screen.findByRole('list', { name: 'Your uploads' });
    fireEvent.click(
      await within(list).findByRole('button', { name: /Accept all Ready in Scanned post/ }),
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Accept 2' }),
    );
    await screen.findByRole('region', { name: 'What was just done' });
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Your uploads' })).queryByRole('button', {
          name: /Accept all Ready/,
        }),
      ).toBeNull(),
    );
    fireEvent.click(within(toast()).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector('a.batch-row[href="/inbox/batches/batch-1"]'),
      ),
    );
  });

  it('a row whose document the uploader no longer sees still has its stop; the keys pass it and reach the rows after (W-I3-5)', async () => {
    const rows = (types: DocumentTypeView[]) => [
      {
        ...item('item-0', 'gone.pdf', { proposal: PASSPORT('me'), state: 'accepted' }, types),
        document_id: null,
      },
      ...twoReady(types),
    ];
    at('/inbox/batches/batch-1', rows, { removed: 0 });
    const table = await queueTable();
    // Said, and its cell the grid's one stop: every cell takes the focus (R2).
    const gone = within(table).getByText('You can no longer see the document');
    expect(gone).toBeVisible();
    await waitFor(() =>
      expect([...table.querySelectorAll<HTMLElement>('[tabindex="0"]')]).toHaveLength(1),
    );
    const stop = table.querySelector<HTMLElement>('[tabindex="0"]') as HTMLElement;
    expect(stop.closest('tr')).toHaveTextContent('gone.pdf');
    stop.focus();
    fireEvent.keyDown(stop, { key: 'ArrowDown' });
    const name = within(table).getByRole('link', { name: "Mansoor's passport" });
    await waitFor(() => expect(name).toHaveFocus());
    fireEvent.keyDown(name, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(within(table).getByRole('link', { name: "Aisha's passport" })).toHaveFocus(),
    );
  });

  it('on a short screen the toast is part of the page, under the levels, and keeps no room under it (W-I3-6)', async () => {
    at('/inbox/batches/batch-1', twoReady, { removed: 0 });
    const shown = await confirmAll(2);
    // In the page's order: after the levels, before the files.
    const levels = screen.getByRole('group', { name: 'Show' });
    expect(levels.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      shown.compareDocumentPosition(await queueTable()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const file = ['src/styles.css', 'apps/web/src/styles.css'].find((f) => existsSync(f));
    const css = readFileSync(file as string, 'utf8').replace(/\s+/g, ' ');
    const short = /@media \(max-height: 500px\) \{(.*?\} )\}/.exec(css)?.[1] ?? '';
    expect(short).toMatch(/\.toast, \.shell-phone \.toast \{ position: static;/);
    expect(short).toMatch(/\.page\.has-toast \{ padding-bottom: 0; \}/);
    // Never more room kept than a short window has.
    expect(css).not.toMatch(/scroll-padding-bottom: calc\(96px \+ 180px/);
  });

  it('a file read while it is on the screen: asked again, and its untouched card starts from what was read; Skip carries the batch as it is (W-I3-7)', async () => {
    const was = { ...batchPolling };
    batchPolling.every = 20;
    try {
      const pair = (types: DocumentTypeView[]) => [
        item('item-1', 'a.pdf', { proposal: PASSPORT('me') }, types),
        item('item-2', 'b.pdf', { reading: 'reading' }, types),
      ];
      const state = at('/inbox/batches/batch-1/items/item-2', pair, { removed: 0 });
      await screen.findByText('b.pdf', { selector: 'h1' });
      const types = state.types as unknown as DocumentTypeView[];
      Object.assign(
        state.batches?.[0]?.items[1] as object,
        item('item-2', 'b.pdf', { proposal: PASSPORT('m-0') }, types),
      );
      await screen.findByRole('heading', { level: 1, name: "Aisha's passport" });
      await waitFor(() => expect(screen.getByLabelText(/What it is/)).toHaveValue('passport'));
      // Skip, from the first: the second as it is now — not by asking again.
      batchPolling.every = 60_000;
      document.body.innerHTML = '';
      const again = at('/inbox/batches/batch-1/items/item-1', pair, { removed: 0 });
      await screen.findByRole('heading', { level: 1, name: "Mansoor's passport" });
      Object.assign(
        again.batches?.[0]?.items[1] as object,
        item('item-2', 'b.pdf', { proposal: PASSPORT('m-0') }, types),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
      await screen.findByRole('heading', { level: 1, name: "Aisha's passport" });
      expect(screen.getByLabelText(/What it is/)).toHaveValue('passport');
    } finally {
      Object.assign(batchPolling, was);
    }
  });

  it('after the last, Back does not open the file it ended on (W-I3-8)', async () => {
    at('/inbox/batches/batch-1?level=ready', twoReady, { removed: 0 });
    fireEvent.click(await screen.findByRole('link', { name: 'Accept passport.pdf' }));
    fireEvent.keyDown(await screen.findByLabelText(/What it is/), { key: 'Enter' });
    await screen.findByRole('heading', { level: 1, name: "Aisha's passport" });
    fireEvent.keyDown(screen.getByLabelText(/What it is/), { key: 'Enter' });
    await screen.findByText(/All 2 done/);
    window.history.back();
    await new Promise((r) => setTimeout(r, 200));
    expect(window.location.pathname).not.toMatch(/\/items\//);
  });

  it('a second Accept all Ready while the first may still be undone: its Undo takes back both (W-I3-9)', async () => {
    const state = at('/inbox/batches/batch-1', twoReady, { removed: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Accept all Ready (2)' }));
    const dialog = await screen.findByRole('alertdialog');
    const types = state.types as unknown as DocumentTypeView[];
    state.batches?.[0]?.items.push(item('item-3', 'c.pdf', { proposal: PASSPORT('me') }, types));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept 2' }));
    await screen.findByRole('region', { name: 'What was just done' });
    await confirmAll(1);
    await waitFor(() => expect(toast()).toHaveTextContent('Undo takes back all 3 files'));
    fireEvent.click(within(toast()).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(state.undoCalls).toEqual([
        { batch: 'batch-1', item_ids: ['item-1', 'item-2', 'item-3'] },
      ]),
    );
  });

  it('what was not accepted is named, each once; and nothing more is sent after a request where some were not (W-I3-11)', async () => {
    const many = (types: DocumentTypeView[]) =>
      Array.from({ length: 60 }, (_, i) =>
        item(`item-${i + 1}`, `f${i + 1}.pdf`, { proposal: PASSPORT('me') }, types),
      );
    const out = {
      code: 'storage_unreachable',
      message: 'We can’t reach where your files are kept.',
    };
    const state = at('/inbox/batches/batch-1', many, {
      removed: 0,
      acceptReadyRefuse: { 'item-1': out, 'item-2': out },
    });
    const shown = await confirmAll(60);
    expect(state.acceptReadyCalls).toHaveLength(1);
    const lines = within(shown)
      .getAllByText(/was not accepted/)
      .map((l) => l.textContent);
    expect(lines).toEqual([
      '“f1.pdf” was not accepted: We can’t reach where your files are kept.',
      '“f2.pdf” was not accepted: We can’t reach where your files are kept.',
    ]);
    expect(shown).toHaveTextContent('10 more files were not sent');
  });
});

describe('the check’s findings (I3)', () => {
  const pair = (types: DocumentTypeView[]) => [
    item('item-1', 'a.pdf', { proposal: PASSPORT('me') }, types),
    item('item-2', 'b.pdf', { reading: 'reading' }, types),
  ];

  it('read while Skip has the focus: the card stays as it is, and Skip keeps the focus (N4)', async () => {
    const was = { ...batchPolling };
    batchPolling.every = 20;
    try {
      const state = at('/inbox/batches/batch-1/items/item-2', pair, { removed: 0 });
      await screen.findByText('b.pdf', { selector: 'h1' });
      const skip = screen.getByRole('button', { name: 'Skip' });
      skip.focus();
      fireEvent.focus(skip);
      const types = state.types as unknown as DocumentTypeView[];
      Object.assign(
        state.batches?.[0]?.items[1] as object,
        item('item-2', 'b.pdf', { proposal: PASSPORT('m-0') }, types),
      );
      // Asked again: the file is read now…
      await screen.findByRole('heading', { level: 1, name: "Aisha's passport" });
      await new Promise((r) => setTimeout(r, 100));
      // …and the card is as the person left it, with the focus where it was.
      expect(screen.getByRole('button', { name: 'Skip' })).toHaveFocus();
      expect(screen.getByLabelText(/What it is/)).toHaveValue('');
    } finally {
      Object.assign(batchPolling, was);
    }
  });

  it('a refresh that fails does not stop the asking: the next one finds the file read (N6)', async () => {
    const was = { ...batchPolling };
    batchPolling.every = 20;
    batchPolling.most = 40;
    const real = window.fetch.bind(window);
    try {
      const state = at('/inbox/batches/batch-1/items/item-2', pair, { removed: 0 });
      await screen.findByText('b.pdf', { selector: 'h1' });
      let failed = 0;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        if (/\/batches\/batch-1$/.test(url) && failed < 2) {
          failed += 1;
          return Response.json(
            { error: { code: 'internal', message: 'Something went wrong.', request_id: 'r' } },
            { status: 500 },
          );
        }
        return real(input, init);
      };
      await waitFor(() => expect(failed).toBe(2));
      const types = state.types as unknown as DocumentTypeView[];
      Object.assign(
        state.batches?.[0]?.items[1] as object,
        item('item-2', 'b.pdf', { proposal: PASSPORT('m-0') }, types),
      );
      expect(
        await screen.findByRole('heading', { level: 1, name: "Aisha's passport" }),
      ).toBeVisible();
    } finally {
      window.fetch = real;
      Object.assign(batchPolling, was);
    }
  });
});

/**
 * The owner's report: three files not recognised, and clicking them opened
 * nothing — only the small Accept did. A waiting file's name is the link to
 * its card; its first page and its row's empty space open it too; Accept is
 * for Ready, and anything else is opened to be reviewed.
 */
/**
 * The queue's rows are R2's grid (R5's list), as the Documents table and
 * the Trash are: one stop for Tab, the arrows between cells along a row and
 * between rows, Home and End, and with Control the corners.
 */
describe('the review queue is R2’s grid', () => {
  it('one stop for the table; the arrows, Home and End move between its cells, as in Documents and the Trash', async () => {
    at('/inbox/batches/batch-1');
    const table = await queueTable();
    // The first file's name (another proposes the same title further down).
    const name = within(table).getAllByRole('link', {
      name: "Mansoor's passport",
    })[0] as HTMLElement;
    await waitFor(() =>
      expect([...table.querySelectorAll('[tabindex="0"]')]).toEqual([name as Element]),
    );
    name.focus();
    // Along the row: End to its last cell, Remove; Left to Accept, a cell of its own.
    fireEvent.keyDown(name, { key: 'End' });
    const remove = within(table).getByRole('button', { name: 'Remove passport.pdf' });
    await waitFor(() => expect(remove).toHaveFocus());
    expect(remove).toHaveAttribute('tabindex', '0');
    expect(name).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(remove, { key: 'ArrowLeft' });
    const accept = within(table).getByRole('link', { name: 'Accept passport.pdf' });
    await waitFor(() => expect(accept).toHaveFocus());
    // Home: the row's first cell, its first page — the cell itself takes the focus.
    fireEvent.keyDown(accept, { key: 'Home' });
    await waitFor(() => expect(document.activeElement?.tagName).toBe('TD'));
    expect(document.activeElement?.closest('tr')).toHaveTextContent('passport.pdf');
    // Up, to the head; Control and End, the last row's last cell.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement?.tagName).toBe('TH'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End', ctrlKey: true });
    await waitFor(() =>
      expect(document.activeElement?.closest('tr')).toBe(
        within(table).getAllByRole('row').at(-1) as HTMLElement,
      ),
    );
    // Still one stop for Tab: wherever the focus last was.
    expect(table.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await expectAccessible();
  });
});

describe('a file opens from its name (the owner’s report)', () => {
  it('a waiting file’s name is the link to its card, with the level and the run; Review for anything not Ready', async () => {
    at('/inbox/batches/batch-1?level=unrecognised');
    const table = await queueTable();
    const name = within(table).getByRole('link', { name: 'note.pdf' });
    expect(name).toHaveAttribute('href', '/inbox/batches/batch-1/items/item-4?level=unrecognised');
    const review = within(table).getByRole('link', { name: 'Review note.pdf' });
    expect(review).toHaveTextContent(/^Review$/);
    expect(review).toHaveAttribute('href', name.getAttribute('href'));
    expect(within(table).queryByRole('link', { name: 'Accept note.pdf' })).toBeNull();
    // One stop for the table (R2's grid): the first file's name; its Review a cell away.
    await waitFor(() => expect(name).toHaveAttribute('tabindex', '0'));
    expect(review).toHaveAttribute('tabindex', '-1');
    await expectAccessible();
    fireEvent.click(name);
    expect(await screen.findByRole('heading', { level: 1, name: 'note.pdf' })).toBeVisible();
    // The run came with it: where it is in the queue, as the queue was shown.
    expect(screen.getByText(/^Item 1 of 1, Not recognised/)).toBeInTheDocument();
    expect(window.location.search).toBe('?level=unrecognised');
  });

  it('Accept for Ready, Review for Check, Not recognised and Problems; one stop for the rows', async () => {
    at('/inbox/batches/batch-1');
    const table = await queueTable();
    const actions = within(table)
      .getAllByRole('link', { name: /^(Accept|Review) / })
      .map((l) => [l.getAttribute('aria-label'), l.textContent]);
    expect(actions).toEqual([
      ['Accept passport.pdf', 'Accept'],
      ['Accept aisha.pdf', 'Accept'],
      ['Review unsure.pdf', 'Review'],
      ['Review note.pdf', 'Review'],
      ['Review blank.pdf', 'Review'],
    ]);
    // One stop for Tab in the whole table (R2's grid): the first file's name.
    await waitFor(() =>
      expect(
        [...table.querySelectorAll<HTMLElement>('[tabindex="0"]')].map(
          (x) => x.getAttribute('aria-label') ?? x.textContent,
        ),
      ).toEqual(["Mansoor's passport"]),
    );
    // Done: an accepted file's name is not a way to a card.
    fireEvent.click(within(filters()).getByRole('button', { name: /^Done/ }));
    await waitFor(() => expect(window.location.search).toBe('?level=done'));
    const done = await queueTable();
    expect(within(done).getByText('done.pdf', { exact: false })).toBeVisible();
    expect(within(done).queryByRole('link', { name: /done\.pdf|passport/ })).toBeNull();
  });

  it('its first page and its row’s empty space open it; its own buttons and an accepted row do not', async () => {
    at('/inbox/batches/batch-1');
    const rowOf = async (words: string) =>
      within(await queueTable())
        .getAllByRole('row')
        .find((r) => r.textContent?.includes(words)) as HTMLTableRowElement;
    // Remove is its own: it asks, and opens nothing.
    fireEvent.click(
      within(await rowOf('note.pdf')).getByRole('button', { name: 'Remove note.pdf' }),
    );
    const asked = await screen.findByRole('alertdialog', { name: 'Remove “note.pdf”?' });
    fireEvent.click(within(asked).getByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/inbox/batches/batch-1');
    // The first page.
    fireEvent.click((await rowOf('note.pdf')).querySelector('.firstpage') as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: 'note.pdf' })).toBeVisible();
    expect(window.location.pathname).toBe('/inbox/batches/batch-1/items/item-4');
    // Back, and the row's empty space: its Whose cell.
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/inbox/batches/batch-1'));
    fireEvent.click((await rowOf('unsure.pdf')).cells[3] as HTMLElement);
    await waitFor(() =>
      expect(window.location.pathname).toBe('/inbox/batches/batch-1/items/item-3'),
    );
    expect(await screen.findByRole('heading', { level: 1 })).toBeVisible();
    // An accepted row opens no card.
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/inbox/batches/batch-1'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Show' })).getByRole('button', {
        name: /^Done/,
      }),
    );
    await waitFor(() => expect(window.location.search).toBe('?level=done'));
    fireEvent.click((await rowOf('done.pdf')).cells[2] as HTMLElement);
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.pathname).toBe('/inbox/batches/batch-1');
  });

  it('at phone width, each waiting file’s name is the link, and its first page opens it', async () => {
    at('/inbox/batches/batch-1', QUEUE, { width: 320 });
    const list = await screen.findByRole('list', { name: 'Files in Scanned post' });
    const name = within(list).getByRole('link', { name: 'note.pdf' });
    expect(name).toHaveAttribute('href', '/inbox/batches/batch-1/items/item-4');
    expect(within(list).getByRole('link', { name: 'Review note.pdf' })).toBeVisible();
    expect(within(list).getByRole('link', { name: 'Accept passport.pdf' })).toBeVisible();
    await expectAccessible();
    const li = name.closest('li') as HTMLElement;
    fireEvent.click(li.querySelector('.firstpage') as HTMLElement);
    expect(await screen.findByRole('heading', { level: 1, name: 'note.pdf' })).toBeVisible();
  });

  it('a Not recognised file, with no pages drawn, opens with the batch’s choices and no kind; a kind chosen, it is accepted', async () => {
    const bare = (types: DocumentTypeView[]) => [
      {
        ...item('item-4', 'note.pdf', { proposal: {} }, types),
        preview_state: 'failed' as const,
        preview_pages: 0,
      },
    ];
    const state = at('/inbox/batches/batch-1', bare, { removed: 0 });
    fireEvent.click(await screen.findByRole('link', { name: 'note.pdf' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'note.pdf' })).toBeVisible();
    expect(screen.getByText('Not recognised', { selector: 'strong' })).toBeVisible();
    const kind = screen.getByLabelText(/What it is/);
    expect(kind).toHaveValue('');
    // Its pages: said, not drawn.
    expect(screen.getByText('Its pages could not be drawn.')).toBeVisible();
    // The batch's choices: Everyone, and its tag.
    expect(screen.getByRole('button', { name: 'Everyone' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Tags')).toHaveValue('post');
    await expectAccessible();
    fireEvent.change(kind, { target: { value: 'birth_certificate' } });
    await waitFor(() => expect(screen.getByLabelText('Name')).not.toHaveValue(''));
    fireEvent.click(screen.getByRole('button', { name: 'Accept and next' }));
    await waitFor(() => expect(state.batchAccepts).toHaveLength(1));
    expect(state.batchAccepts?.[0]?.body).toMatchObject({
      type_key: 'birth_certificate',
      visibility: 'household',
      tags: ['post'],
    });
    // The last: back to the queue, with what was done.
    expect(await screen.findByText(/“note.pdf” is a document now/)).toBeVisible();
    expect(window.location.pathname).toBe('/inbox/batches/batch-1');
  });

  it('a Not recognised file can be accepted with no kind at all', async () => {
    const one = (types: DocumentTypeView[]) => [
      item('item-4', 'note.pdf', { proposal: {} }, types),
    ];
    const state = at('/inbox/batches/batch-1/items/item-4', one, { removed: 0 });
    await screen.findByRole('heading', { level: 1, name: 'note.pdf' });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and next' }));
    await waitFor(() => expect(state.batchAccepts).toHaveLength(1));
    expect(state.batchAccepts?.[0]?.body).toMatchObject({ type_key: null });
  });

  it('what the card said, back on the queue, is said once: taken out of the history entry (R5)', async () => {
    const one = (types: DocumentTypeView[]) => [
      item('item-4', 'note.pdf', { proposal: {} }, types),
    ];
    at('/inbox/batches/batch-1/items/item-4', one, { removed: 0 });
    await screen.findByRole('heading', { level: 1, name: 'note.pdf' });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and next' }));
    const said = await screen.findByText(/“note.pdf” is a document now/);
    await waitFor(() => expect(said).toHaveFocus());
    expect(window.location.pathname).toBe('/inbox/batches/batch-1');
    // Back to this entry later, or a reload, finds nothing to say again.
    await waitFor(() =>
      expect((window.history.state as { usr?: unknown } | null)?.usr ?? null).toBeNull(),
    );
    expect(screen.getByText(/“note.pdf” is a document now/)).toBeVisible();
  });
});
