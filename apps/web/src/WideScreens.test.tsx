import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BatchItemView } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeBatch,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * Home, People, Collections, Activity and the Trash for wide screens
 * (Phase 6, R4): from 1024 px Home is a dashboard of cards (two equal
 * columns from 768 px), People a table with its tabs, Collections a grid,
 * Activity a table with filters kept in the address, and the Trash R2's
 * grid with a bar for many at once. Every role sees what it saw before:
 * nothing added, nothing taken away. On a phone, each is as it was.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';
const PHONE = 320;
const MID = 900;
const WIDE = 1280;

let width = WIDE;
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
  window.history.replaceState({}, '', '/');
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

const SARA = {
  ...AISHA,
  id: 'm-2',
  display_name: 'Sara Seikh',
  has_account: true,
  role: 'adult',
  colour: 3,
  relationship: 'Wife',
  document_count: 2,
};
const ZAIN = {
  ...AISHA,
  id: 'm-3',
  display_name: 'Zain Seikh',
  has_account: true,
  role: 'teen',
  colour: 4,
  relationship: 'Son',
  document_count: 1,
};
const GRAN = { ...AISHA, id: 'm-4', display_name: 'Gran', relationship: 'Grandmother' };

const doc = (over: Record<string, unknown>) => ({
  ...PASSPORT,
  is_essential: false,
  tags: [],
  ...over,
  etag: `"${String(over.id)}"`,
});

const TRAVEL: FakeCollection = {
  id: 'collection-t',
  name: 'Travel',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"t.1"',
  items: ['doc-1'],
  shared_outside: { with: ['the visa agent'], following: false },
};
const HOUSE: FakeCollection = {
  id: 'collection-h',
  name: 'The house',
  description: null,
  audience: 'adults',
  owner_member_id: 'm-2',
  etag: '"h.1"',
  items: [],
};

const item = (id: string, level?: 'ready' | 'check'): BatchItemView => ({
  id,
  batch_id: 'batch-1',
  name: `${id}.pdf`,
  content_type: 'application/pdf',
  byte_size: 2048,
  sha256: '0'.repeat(64),
  arrived_at: '2026-10-06T09:05:00Z',
  state: 'waiting',
  reading: level ? 'read' : 'waiting',
  preview_state: 'ready',
  preview_pages: 1,
  duplicate: null,
  document_id: null,
  ...(level ? { level } : {}),
});
const BATCH = (): FakeBatch => ({
  id: 'batch-1',
  name: 'Old papers',
  created_at: '2026-10-06T09:00:00Z',
  ends_at: '2026-11-05T09:00:00Z',
  defaults: {
    owner_member_id: null,
    type_key: null,
    visibility: null,
    physical_location: null,
    collection_id: null,
    tags: [],
  } as never,
  items: [item('a', 'ready'), item('b', 'ready'), item('c', 'check'), item('d')],
});

function open(path: string, over: Partial<FakeState>, role: Role = 'owner') {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const main = () => document.querySelector('main') as HTMLElement;

// ------------------------------------------------------------------ Home

/** Who signs in, for Home: each role, a limited viewer and a guest. */
const HOMES: Array<{ name: string; role: Role; over: Partial<FakeState> }> = [
  { name: 'owner', role: 'owner', over: {} },
  { name: 'adult', role: 'adult', over: {} },
  { name: 'teen', role: 'teen', over: {} },
  { name: 'viewer', role: 'viewer', over: {} },
  {
    name: 'restricted viewer',
    role: 'viewer',
    over: {
      myRestriction: {
        summary: 'You can see: the collection “Travel” and your own.',
        people: [],
        types: [],
        collections: [{ id: 'collection-t', name: 'Travel' }],
        include_adults_only: false,
        include_no_person_docs: false,
        expires_at: null,
      },
    },
  },
  {
    name: 'guest',
    role: 'viewer',
    over: {
      myKind: 'guest',
      myAccessEnd: '2030-07-01T22:59:00Z',
      myRestriction: {
        summary: 'You can see: the collection “Travel”.',
        people: [],
        types: [],
        collections: [{ id: 'collection-t', name: 'Travel' }],
        include_adults_only: false,
        include_no_person_docs: false,
        expires_at: null,
      },
    },
  },
];

const homeState = (over: Partial<FakeState>): Partial<FakeState> => ({
  members: [ME, SARA, ZAIN, AISHA],
  documents: [PASSPORT, doc({ id: 'doc-2', title: 'Council tax bill', owner_member_id: null })],
  collections: [TRAVEL],
  batches: [BATCH()],
  ...over,
});

/** Home as it is drawn, loaded: its links, its buttons, its headings and its words. */
async function homeFacts(wide: boolean, uploads: boolean) {
  await screen.findByRole('heading', { name: 'Recently added' });
  await screen.findAllByText('Council tax bill');
  await screen.findByRole('link', { name: /Travel/ });
  if (wide && uploads) await screen.findByText('4 waiting for you');
  const m = main();
  return {
    hrefs: new Set([...m.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))),
    buttons: [...m.querySelectorAll('button')].map((b) => b.textContent).sort(),
    headings: [...m.querySelectorAll('h1, h2')].map((h) => h.textContent ?? ''),
    text: m.textContent ?? '',
  };
}

describe('Home from 768 px: a dashboard of cards (R4)', () => {
  it('an owner’s cards: what needs attention, what came, the kinds, their uploads, the people and the collections, each with the way to its screen', async () => {
    atWidth(WIDE);
    open(
      '/',
      homeState({
        documents: [
          doc({
            id: 'doc-1',
            title: 'Expired passport',
            status: { value: 'expired', label: 'Expired' },
          }),
        ],
      }),
    );
    const card = async (name: string) => screen.findByRole('region', { name });
    const attention = await card('Needs attention');
    expect(within(attention).getByRole('link', { name: 'See all' })).toHaveAttribute(
      'href',
      '/reminders',
    );
    expect(
      await within(attention).findByRole('link', { name: /1 thing needs attention/ }),
    ).toBeInTheDocument();
    const recent = await card('Recently added');
    expect(within(recent).getByRole('link', { name: 'All documents' })).toHaveAttribute(
      'href',
      '/documents',
    );
    const people = await card('People');
    expect(within(people).getByRole('link', { name: 'All people' })).toHaveAttribute(
      'href',
      '/people',
    );
    expect(within(people).getByRole('link', { name: 'Sara Seikh’s documents' })).toHaveAttribute(
      'href',
      '/people/m-2/documents',
    );
    const collections = await card('Collections');
    expect(within(collections).getByRole('link', { name: 'All collections' })).toHaveAttribute(
      'href',
      '/collections',
    );
    expect(await card('Categories')).toBeInTheDocument();
    const uploads = await card('Your uploads waiting');
    expect(await within(uploads).findByText('4 waiting for you')).toBeInTheDocument();
    // As the Inbox counts them (I3): by level, and those still to read.
    expect(within(uploads).getByText('2 Ready, 1 Check · 1 still to read')).toBeInTheDocument();
    expect(within(uploads).getByRole('link', { name: 'Open your Inbox' })).toHaveAttribute(
      'href',
      '/inbox',
    );
    // The household's name, then the cards: two columns, the wide one first.
    const columns = main().querySelectorAll('.dash > .dash-col');
    expect(columns).toHaveLength(2);
    expect(
      within(columns[0] as HTMLElement)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Needs attention', 'Recently added', 'Categories']);
    await expectAccessible();
  });

  it('the notices stay above the cards, as they were', async () => {
    atWidth(WIDE);
    open(
      '/',
      homeState({
        twoStep: false,
        resetNotice: { at: '2026-10-01T10:00:00Z', by: 'Sara Seikh' },
      }),
    );
    const grid = await waitFor(() => {
      const g = main().querySelector('.dash');
      expect(g).not.toBeNull();
      return g as HTMLElement;
    });
    const twoStep = await screen.findByRole('link', { name: /Switch on two-step sign-in/ });
    const reset = await screen.findByRole('region', {
      name: 'An owner made a link to reset your password',
    });
    for (const notice of [twoStep, reset]) {
      expect(grid.contains(notice)).toBe(false);
      expect(notice.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('768–1023 px: the same cards; on a phone, today’s Home with no cards at all', async () => {
    atWidth(MID);
    open('/', homeState({}));
    await screen.findByRole('region', { name: 'Recently added' });
    expect(main().querySelectorAll('.dash > .dash-col')).toHaveLength(2);
    cleanup();
    atWidth(PHONE);
    open('/', homeState({}));
    await screen.findByRole('heading', { name: 'Recently added' });
    expect(main().querySelector('.dash')).toBeNull();
    expect(main().querySelector('.dash-card')).toBeNull();
    expect(screen.queryByText('Your uploads waiting')).toBeNull();
    await expectAccessible();
  });

  for (const who of HOMES) {
    it(`every role sees what it saw: a ${who.name}`, async () => {
      const uploads = who.role !== 'viewer';
      atWidth(PHONE);
      open('/', homeState(who.over), who.role);
      const phone = await homeFacts(false, uploads);
      cleanup();
      atWidth(WIDE);
      open('/', homeState(who.over), who.role);
      const wide = await homeFacts(true, uploads);
      // Nothing taken away: every link and button is still there.
      for (const href of phone.hrefs) expect(wide.hrefs, href ?? '').toContain(href);
      expect(wide.buttons).toEqual(phone.buttons);
      // Nothing added but the way to each card's screen, for whom it is theirs.
      const may = new Set(['/documents']);
      if (who.role !== 'viewer') {
        may.add('/people');
        may.add('/reminders');
        may.add('/inbox');
        may.add('/add/many');
      }
      for (const href of wide.hrefs) {
        if (!phone.hrefs.has(href)) expect([...may], `${who.name}: ${href}`).toContain(href);
      }
      if (who.role === 'viewer') {
        expect(wide.hrefs.has('/people')).toBe(false);
        expect(wide.hrefs.has('/inbox')).toBe(false);
        expect(screen.queryByRole('region', { name: 'Your uploads waiting' })).toBeNull();
      }
      const extra = wide.headings.filter((h) => !phone.headings.includes(h));
      expect(extra.every((h) => ['Needs attention', 'Your uploads waiting'].includes(h))).toBe(
        true,
      );
      expect(phone.headings.every((h) => wide.headings.includes(h))).toBe(true);
      // What a limited viewer and a guest are told, said the same.
      if (who.name === 'restricted viewer' || who.name === 'guest') {
        expect(wide.text).toContain('You can see: the collection “Travel”');
        expect(phone.text).toContain('You can see: the collection “Travel”');
      }
      if (who.name === 'guest') {
        expect(wide.text).toContain('Your access to this vault ends');
        expect(phone.text).toContain('Your access to this vault ends');
      }
      await expectAccessible();
    });
  }
});

// ------------------------------------------------------------------ People

const PEOPLE: Partial<FakeState> = {
  members: [ME, SARA, ZAIN, GRAN],
  guests: [],
  invitations: [
    {
      id: 'inv-1',
      member_id: 'm-4',
      email: 'gran@example.test',
      role: 'adult',
      state: 'pending',
      kind: 'family',
      created_at: '2026-10-01T10:00:00Z',
      expires_at: '2030-10-08T10:00:00Z',
    },
  ],
};

describe('People from 768 px: the family as a table, and its tabs (R4)', () => {
  it('an owner: Family and Outside the family as links that are tabs, and the family as a table', async () => {
    atWidth(WIDE);
    open('/people', PEOPLE);
    const tabs = await screen.findByRole('navigation', { name: 'People' });
    const family = within(tabs).getByRole('link', { name: 'Family' });
    const outside = within(tabs).getByRole('link', { name: 'Outside the family' });
    expect(family).toHaveAttribute('aria-current', 'page');
    expect(outside).not.toHaveAttribute('aria-current');
    const table = await screen.findByRole('table', { name: 'The family' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Relationship', 'Role', 'Sign-in', 'Documents']);
    const sara = within(table).getByRole('link', { name: 'Sara Seikh' });
    expect(sara).toHaveAttribute('href', '/people/m-2');
    const row = (link: HTMLElement) =>
      [...(link.closest('tr') as HTMLElement).querySelectorAll('td')].map((c) => c.textContent);
    expect(row(sara)).toEqual(['SSara Seikh', 'Wife', 'Adult', 'Signs in', '2']);
    // Invited and not yet accepted: as the invitations below say.
    expect(row(within(table).getByRole('link', { name: 'Gran' }))).toEqual([
      'GGran',
      'Grandmother',
      '—None',
      'Invited',
      '0',
    ]);
    await expectAccessible();
    fireEvent.click(outside);
    await screen.findByRole('heading', { name: 'People outside the family' });
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'People' })).getByRole('link', {
          name: 'Outside the family',
        }),
      ).toHaveAttribute('aria-current', 'page'),
    );
  });

  it('nobody but an owner has the tabs; a teen is not told who is invited', async () => {
    atWidth(WIDE);
    open('/people', PEOPLE, 'adult');
    let table = await screen.findByRole('table', { name: 'The family' });
    expect(screen.queryByRole('navigation', { name: 'People' })).toBeNull();
    await within(table).findByText('Invited');
    cleanup();
    open('/people', PEOPLE, 'teen');
    table = await screen.findByRole('table', { name: 'The family' });
    await within(table).findByRole('link', { name: 'Gran' });
    expect(screen.queryByRole('navigation', { name: 'People' })).toBeNull();
    expect(within(table).queryByText('Invited')).toBeNull();
    expect(screen.getByRole('link', { name: 'Gran' }).closest('tr')).toHaveTextContent(
      'No sign-in',
    );
  });

  it('on a phone, today’s rows', async () => {
    atWidth(PHONE);
    open('/people', PEOPLE);
    await screen.findByRole('button', { name: /Sara Seikh/ });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'People' })).toBeInTheDocument();
    await expectAccessible();
  });
});

// ------------------------------------------------------------------ Collections

describe('Collections from 768 px: a grid of cards (R4)', () => {
  it('each a link: how many, whose, who it is for, and whom it is shared with', async () => {
    atWidth(WIDE);
    open('/collections', { members: [ME, SARA], collections: [TRAVEL, HOUSE] });
    const list = await screen.findByRole('list', { name: 'Collections' });
    const travel = await within(list).findByRole('link', { name: /Travel/ });
    expect(travel).toHaveAttribute('href', '/collections/collection-t');
    expect(travel).toHaveTextContent('1 document · Yours');
    expect(travel).toHaveTextContent('Everyone in the family');
    expect(travel).toHaveTextContent('Shared with the visa agent');
    const house = within(list).getByRole('link', { name: /The house/ });
    expect(house).toHaveTextContent('Made by Sara Seikh');
    expect(house).not.toHaveTextContent('Shared');
    expect(main().querySelector('.coll-grid')).not.toBeNull();
    await expectAccessible();
  });

  it('a viewer is given only what was given to them; on a phone, rows', async () => {
    atWidth(WIDE);
    open(
      '/collections',
      {
        members: [{ ...ME, role: 'viewer' }],
        collections: [TRAVEL],
        myRestriction: {
          summary: 'You can see: the collection “Travel”.',
          people: [],
          types: [],
          collections: [{ id: 'collection-t', name: 'Travel' }],
          include_adults_only: false,
          include_no_person_docs: false,
          expires_at: null,
        },
      },
      'viewer',
    );
    const list = await screen.findByRole('list', { name: 'Collections' });
    await within(list).findByRole('link', { name: /Travel/ });
    expect(screen.queryByRole('button', { name: 'Make a collection' })).toBeNull();
    cleanup();
    atWidth(PHONE);
    open('/collections', { members: [ME], collections: [TRAVEL] });
    const rows = await screen.findByRole('list', { name: 'Collections' });
    await within(rows).findByRole('link', { name: /Travel/ });
    expect(main().querySelector('.coll-grid')).toBeNull();
  });
});

// ------------------------------------------------------------------ Activity

const line = (
  id: number,
  at: string,
  text: string,
  kind: string,
  actor: string | null,
  documentId: string | null = null,
) => ({
  id,
  at,
  text,
  notable: false,
  document_id: documentId,
  actor_member_id: actor,
  kind: kind as never,
});
const LINES = [
  line(
    9,
    '2026-10-07T12:00:00Z',
    'Sara Seikh downloaded “Home insurance”',
    'opened',
    'm-2',
    'doc-1',
  ),
  line(
    8,
    '2026-10-06T12:00:00Z',
    'Shared link (the visa agent) opened “Home insurance”',
    'shared',
    null,
    'doc-1',
  ),
  line(7, '2026-10-05T12:00:00Z', 'Mansoor Seikh signed in', 'sign_in', 'me'),
  line(6, '2026-10-04T12:00:00Z', 'Jane Smith, attorney signed in', 'sign_in', 'g-9'),
  line(
    5,
    '2026-10-03T12:00:00Z',
    'Sara Seikh made a link to “Home insurance”',
    'shared',
    'm-2',
    'doc-1',
  ),
  line(4, '2026-10-01T12:00:00Z', 'Zain Seikh signed in', 'sign_in', 'm-3'),
];
const ACTIVITY: Partial<FakeState> = { members: [ME, SARA, ZAIN], activity: LINES };

const rowsOf = () =>
  within(screen.getByRole('table', { name: /What has been happening/ }))
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelectorAll('td')[2]?.textContent ?? r.textContent);

describe('Activity from 768 px: a table, with filters kept in the address (R4)', () => {
  it('when, who and what happened: who to their page, a line about a document to the document', async () => {
    atWidth(WIDE);
    open('/activity', ACTIVITY);
    const table = await screen.findByRole('table', { name: /What has been happening/ });
    await within(table).findByText('Zain Seikh signed in');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['When', 'Who', 'What happened']);
    const first = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(first).getByRole('link', { name: 'Sara Seikh' })).toHaveAttribute(
      'href',
      '/people/m-2',
    );
    expect(
      within(first).getByRole('link', { name: 'Sara Seikh downloaded “Home insurance”' }),
    ).toHaveAttribute('href', '/documents/doc-1');
    // A link, and somebody not in the family the reader is given: said by
    // the line itself, never looked up.
    for (const words of [
      'Shared link (the visa agent) opened “Home insurance”',
      'Jane Smith, attorney signed in',
    ]) {
      const row = within(table).getByText(words).closest('tr') as HTMLElement;
      const who = row.querySelectorAll('td')[1] as HTMLElement;
      expect(within(who).queryByRole('link')).toBeNull();
      expect(who).toHaveTextContent('Said in the line');
    }
    await expectAccessible();
  });

  it('filters by who, what sort of thing and between which days, each in the address', async () => {
    atWidth(WIDE);
    open('/activity', ACTIVITY);
    await screen.findByText('Zain Seikh signed in');
    fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'm-2' } });
    await waitFor(() =>
      expect(rowsOf()).toEqual([
        'Sara Seikh downloaded “Home insurance”',
        'Sara Seikh made a link to “Home insurance”',
      ]),
    );
    expect(window.location.search).toBe('?who=m-2');
    expect(screen.getByText('2 of the 6 loaded match')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'shared' } });
    await waitFor(() => expect(rowsOf()).toEqual(['Sara Seikh made a link to “Home insurance”']));
    expect(new URLSearchParams(window.location.search).get('kind')).toBe('shared');
    // Anybody else: a link, or somebody the reader is not given.
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Who'), { target: { value: 'else' } });
    await waitFor(() =>
      expect(rowsOf()).toEqual([
        'Shared link (the visa agent) opened “Home insurance”',
        'Jane Smith, attorney signed in',
      ]),
    );
    fireEvent.change(screen.getByLabelText('Who'), { target: { value: '' } });
    // Between two days, both kept.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-03' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });
    await waitFor(() =>
      expect(rowsOf()).toEqual([
        'Mansoor Seikh signed in',
        'Jane Smith, attorney signed in',
        'Sara Seikh made a link to “Home insurance”',
      ]),
    );
    expect(window.location.search).toBe('?from=2026-10-03&to=2026-10-05');
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(rowsOf()).toHaveLength(6));
    expect(window.location.search).toBe('');
  });

  it('a link with filters shows them on arrival; what matches further back comes with Show older', async () => {
    atWidth(WIDE);
    open('/activity?who=m-3', { ...ACTIVITY, activityPage: 3 });
    expect(
      await screen.findByText(
        'Nothing loaded matches these filters. Show older to look further back.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Who')).toHaveValue('m-3');
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(rowsOf()).toEqual(['Zain Seikh signed in']));
  });

  it('on a phone, today’s two columns, filtered the same way', async () => {
    atWidth(PHONE);
    open('/activity?kind=sign_in', ACTIVITY);
    await screen.findByText('Zain Seikh signed in');
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['When', 'What happened']);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    await expectAccessible();
  });
});

// ------------------------------------------------------------------ Trash

const BINNED = '2026-09-26T10:04:00Z';
const MINE = doc({ id: 'doc-1', title: 'My gas bill', deleted_at: BINNED, purge_at_once: true });
const THEIRS = doc({
  id: 'doc-2',
  title: 'Alex payslip',
  owner_member_id: 'm-2',
  filed_by_me: false,
  deleted_at: BINNED,
});
const ASKED = doc({
  id: 'doc-3',
  title: 'Old lease',
  owner_member_id: 'm-2',
  filed_by_me: false,
  deleted_at: BINNED,
  purge_requested_at: new Date(Date.now() - 36e5).toISOString(),
  purge_allowed_from: new Date(Date.now() + 23 * 36e5).toISOString(),
});
/** Fresh copies each time: the fake changes the documents it is given. */
const trash = (): Partial<FakeState> => ({
  members: [ME, SARA],
  documents: [{ ...MINE }, { ...THEIRS }, { ...ASKED }],
});

const grid = () => screen.findByRole('grid', { name: /In the Trash/ });
const box = (title: string) => screen.getByRole('checkbox', { name: `Select “${title}”` });

describe('the Trash from 768 px: a grid, and many at once (R4)', () => {
  it('title, kind, person, when it was moved, and when it goes for good; each row’s own buttons', async () => {
    atWidth(WIDE);
    open('/trash', trash());
    const table = await grid();
    await within(table).findByText('Alex payslip');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Select all 3 shown',
      'Title',
      'Kind',
      'Person',
      'Moved to the Trash',
      'Removed for good',
      'Bring it back',
      'Remove for good',
    ]);
    const lease = within(table).getByText('Old lease').closest('tr') as HTMLElement;
    expect(lease).toHaveTextContent('Sara');
    expect(lease).toHaveTextContent('An owner asked to remove this for good');
    // Waiting its day: when, and no button.
    expect(within(lease).queryByRole('button', { name: /Remove for good/ })).toBeNull();
    expect(lease).toHaveTextContent(/From /);
    expect(
      within(table).getByRole('button', { name: 'Ask to remove for good: Alex payslip' }),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('brings many back, one by one, and names the one it could not', async () => {
    atWidth(WIDE);
    const state = open('/trash', {
      ...trash(),
      refuseWith: (method, path) =>
        method === 'POST' && path === '/api/v1/documents/doc-2/restore'
          ? { status: 409, code: 'conflict', message: 'Somebody changed it meanwhile.' }
          : undefined,
    });
    await grid();
    await screen.findByText('Alex payslip');
    fireEvent.click(box('My gas bill'));
    fireEvent.click(box('Alex payslip'));
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(bar).toHaveTextContent('2 selected');
    fireEvent.click(within(bar).getByRole('button', { name: 'Bring them back' }));
    const failed = await screen.findByRole('alert');
    expect(failed).toHaveTextContent('1 of the 2 could not be brought back:');
    expect(failed).toHaveTextContent('“Alex payslip”: Somebody changed it meanwhile.');
    expect(await screen.findByText(/1 document brought back/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('My gas bill')).toBeNull());
    // What failed is still chosen, to try again; the note has the focus.
    await waitFor(() => expect(box('Alex payslip')).toBeChecked());
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('.bulk-outcome')),
    );
    expect(
      state.calls
        .filter((c) => c.method === 'POST' && c.url.endsWith('/restore'))
        .map((c) => c.url),
    ).toEqual(['/api/v1/documents/doc-1/restore', '/api/v1/documents/doc-2/restore']);
    await expectAccessible();
  });

  it('an owner removes many for good: one at once, one asked about, confirming it’s them once', async () => {
    atWidth(WIDE);
    const state = open('/trash', { ...trash(), stepUpNeeded: true });
    await screen.findByText('Alex payslip');
    fireEvent.click(box('My gas bill'));
    fireEvent.click(box('Old lease'));
    // One waiting its day: not offered, and said why.
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(within(bar).queryByRole('button', { name: 'Remove for good' })).toBeNull();
    expect(bar).toHaveTextContent(
      'Remove for good is offered when every one you chose can be removed or asked about now.',
    );
    fireEvent.click(box('Old lease'));
    fireEvent.click(box('Alex payslip'));
    fireEvent.click(within(bar).getByRole('button', { name: 'Remove for good' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Remove 1 document for good, and ask about 1 more?',
    });
    expect(dialog).toHaveTextContent('Nobody can bring it back.');
    expect(dialog).toHaveTextContent('Whoever added each is told now');
    expect(dialog).toHaveTextContent('You will be asked to confirm it’s you.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove and ask' }));
    const asked = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(within(asked).getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(asked).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/1 document removed for good\./)).toHaveTextContent(
      'You asked to remove 1 document for good',
    );
    // Asked once, for both.
    expect(screen.queryByRole('dialog', { name: 'Just checking it is you' })).toBeNull();
    expect(state.documents.some((d) => d.id === 'doc-1')).toBe(false);
    expect(state.documents.find((d) => d.id === 'doc-2')?.purge_requested_at).toBeTruthy();
  });

  it('one row’s Remove for good asks as 5.24 does, and gives the focus back', async () => {
    atWidth(WIDE);
    open('/trash', trash());
    const remove = await screen.findByRole('button', { name: 'Remove for good: My gas bill' });
    fireEvent.click(remove);
    await screen.findByRole('alertdialog', { name: 'Remove for good?' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(remove).toHaveFocus());
  });

  it('nobody but an owner removes anything; a teen brings back only their own', async () => {
    atWidth(WIDE);
    open('/trash', trash(), 'adult');
    const table = await grid();
    await within(table).findByText('Alex payslip');
    expect(
      within(table).queryByRole('button', { name: /Remove for good|Ask to remove/ }),
    ).toBeNull();
    expect(within(table).getAllByRole('columnheader')).toHaveLength(7);
    fireEvent.click(box('Alex payslip'));
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(within(bar).getByRole('button', { name: 'Bring them back' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Remove for good' })).toBeNull();
    cleanup();
    open(
      '/trash',
      { ...trash(), documents: [doc({ ...MINE, owner_member_id: 'me' }), THEIRS] },
      'teen',
    );
    await screen.findByText('Alex payslip');
    const theirs = screen.getByText('Alex payslip').closest('tr') as HTMLElement;
    expect(within(theirs).queryByRole('button', { name: /Bring it back/ })).toBeNull();
    fireEvent.click(box('Alex payslip'));
    fireEvent.click(box('My gas bill'));
    const teenBar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(within(teenBar).queryByRole('button', { name: 'Bring them back' })).toBeNull();
    expect(teenBar).toHaveTextContent(
      '1 of these isn’t yours to bring back: Bring back is offered when every one you chose is.',
    );
  });

  it('the keyboard: one stop for Tab, the arrows between cells', async () => {
    atWidth(WIDE);
    open('/trash', trash());
    const table = await grid();
    await within(table).findByText('Alex payslip');
    const all = within(table).getByRole('checkbox', { name: 'Select all 3 shown' });
    // The first row's box is the table's one stop, until the focus moves on.
    await waitFor(() => expect(box('My gas bill')).toHaveAttribute('tabindex', '0'));
    expect(table.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    box('My gas bill').focus();
    fireEvent.keyDown(box('My gas bill'), { key: 'ArrowUp' });
    await waitFor(() => expect(all).toHaveFocus());
    expect(all).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(all, { key: 'ArrowDown' });
    await waitFor(() => expect(box('My gas bill')).toHaveFocus());
    fireEvent.keyDown(box('My gas bill'), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByText('My gas bill').closest('td') as HTMLElement,
      ),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove for good: My gas bill' })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    await waitFor(() => expect(box('My gas bill')).toHaveFocus());
    expect(table.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('on a phone, today’s rows', async () => {
    atWidth(PHONE);
    open('/trash', trash());
    await screen.findByText('Alex payslip');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.getByRole('button', { name: 'Bring it back: Alex payslip' })).toBeInTheDocument();
    await expectAccessible();
  });
});
