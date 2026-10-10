import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * What the owner found trying the new web UI (Phase 6): Needs attention a
 * narrow column, and Home boxed, where Documents uses the window's width.
 * From 768 px Needs attention is tables across the width; Home, and every
 * screen that is a list or a table, uses the whole of the content's width;
 * forms keep a readable one. Under 768 px each is as it was.
 *
 * jsdom lays nothing out, but it cascades a stylesheet: styles.css is put
 * in the page, and each screen's main is held to the width it is given.
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

const CSS = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  // The shell's own classes say the width (shell-wide, shell-mid), as the
  // rules held here are written.
  return (file ? readFileSync(file, 'utf8') : '').replace(/\/\*[\s\S]*?\*\//g, '');
})();

let sheet: HTMLStyleElement | null = null;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  sheet = document.createElement('style');
  sheet.textContent = CSS;
  document.head.appendChild(sheet);
});
afterEach(() => {
  sheet?.remove();
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
};

const today = new Date().toISOString().slice(0, 10);
const reminder = (over: Record<string, unknown>) => ({
  kind: 'derived',
  fire_at: today,
  lead_days: 180,
  note: null,
  recurrence: null,
  snoozed_until: null,
  source: 'expires',
  ...over,
});

/** The household: Sara's passport expired, with a reminder due; a bill with no kind; Aisha's coming up. */
const household = (over: Partial<FakeState> = {}): Partial<FakeState> => ({
  members: [ME, SARA, AISHA],
  documents: [
    doc({
      id: 'doc-1',
      title: 'Sara’s passport',
      owner_member_id: 'm-2',
      status: { value: 'expired', label: 'Expired 1 Aug 2026' },
    }),
    doc({
      id: 'doc-2',
      title: 'Council tax bill',
      type_key: null,
      category: 'household',
      owner_member_id: null,
      status: { value: 'needs_info', label: 'Needs a kind' },
    }),
    doc({
      id: 'doc-3',
      title: 'Aisha’s passport',
      owner_member_id: 'm-0',
      status: { value: 'expiring_soon', label: 'Expires in 20 days' },
    }),
  ],
  reminders: [
    reminder({
      id: 'r-1',
      document_id: 'doc-1',
      document_title: 'Sara’s passport',
      status: 'due',
      label: 'Due today',
      about: 'Expiry date: 1 Aug 2026, ended 2 months ago',
    }),
    reminder({
      id: 'r-2',
      document_id: 'doc-3',
      document_title: 'Aisha’s passport',
      status: 'scheduled',
      fire_at: '2026-11-20',
      label: 'In 40 days',
      about: 'Expiry date: 29 Oct 2026, in 20 days',
    }),
  ],
  collections: [TRAVEL],
  profileAnswered: false,
  // The Inbox's two lists: your uploads, and what was sent to you.
  batches: [],
  incoming: [],
  ...over,
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
const widthOf = (el: HTMLElement) => getComputedStyle(el).maxWidth;

// ------------------------------------------------------- Needs attention

describe('Needs attention across the width (the owner’s report)', () => {
  it('at 1280: what needs doing now as a table — the document, whose, what is due, when, its status — with its snoozes, Done and ⋯', async () => {
    atWidth(WIDE);
    const state = open('/reminders', household());
    const now = await screen.findByRole('table', { name: 'Needs attention now' });
    expect(widthOf(main())).toBe('none');
    expect(
      within(now)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Document', 'Whose', 'What is due', 'When', 'Status', 'What to do']);
    // Each row headed by its document, the way to it.
    const sara = await within(now).findByRole('rowheader', { name: /Sara’s passport/ });
    expect(within(sara).getByRole('link', { name: 'Sara’s passport' })).toHaveAttribute(
      'href',
      '/documents/doc-1',
    );
    const row = sara.closest('tr') as HTMLElement;
    await waitFor(() => expect(within(row).getByText('Sara')).toBeInTheDocument());
    expect(row).toHaveTextContent('Expiry date: 1 Aug 2026, ended 2 months ago');
    expect(row).toHaveTextContent('Due today');
    expect(row).toHaveTextContent('Expired 1 Aug 2026');
    const actions = within(row).getByRole('group', { name: 'For “Sara’s passport”' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['A week', 'A month', 'Done']);
    // The bill, with no reminder: its status, and its ⋯ as on a phone.
    const bill = within(now).getByRole('rowheader', { name: /Council tax bill/ });
    const billRow = bill.closest('tr') as HTMLElement;
    expect(billRow).toHaveTextContent('Needs a kind');
    expect(
      within(billRow).getByRole('button', { name: /More for Council tax bill|Council tax bill/ }),
    ).toBeInTheDocument();
    // Coming up: its own table, under its heading.
    const upcoming = screen.getByRole('region', { name: 'Coming up' });
    const later = within(upcoming).getByRole('table', { name: 'Coming up' });
    const aisha = within(later).getByRole('rowheader', { name: /Aisha’s passport/ });
    expect(aisha.closest('tr')).toHaveTextContent('Expiry date: 29 Oct 2026, in 20 days');
    expect(aisha.closest('tr')).toHaveTextContent('Expires in 20 days');
    // The household questions stay, under the tables.
    expect(screen.getByRole('heading', { name: 'We noticed something missing' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Answer the questions' })).toHaveAttribute(
      'href',
      '/household-questions',
    );
    await expectAccessible();
    // Done does what it did.
    fireEvent.click(within(actions).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(state.calls.some((c) => c.url.endsWith('/reminders/r-1/acknowledge'))).toBe(true),
    );
    // Its reminder done, the passport is still expired: a row with its ⋯, no snoozes.
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'For “Sara’s passport”' })).toBeNull(),
    );
  });

  it('a snooze from the table sends what the list sends', async () => {
    atWidth(WIDE);
    const state = open('/reminders', household());
    const row = (await screen.findByRole('rowheader', { name: /Sara’s passport/ })).closest(
      'tr',
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'A week' }));
    await waitFor(() =>
      expect(state.calls.some((c) => c.url.endsWith('/reminders/r-1/snooze'))).toBe(true),
    );
    const sent = state.calls.find((c) => c.url.endsWith('/reminders/r-1/snooze'))?.body as {
      until: string;
    };
    // A week from the household's today.
    const days = (Date.parse(sent.until) - Date.parse(today)) / 864e5;
    expect(days).toBeGreaterThanOrEqual(6);
    expect(days).toBeLessThanOrEqual(8);
  });

  it('at 900, the same tables across the narrowed shell', async () => {
    atWidth(MID);
    open('/reminders', household());
    expect(await screen.findByRole('table', { name: 'Needs attention now' })).toBeVisible();
    expect(widthOf(main())).toBe('none');
    await expectAccessible();
  });

  it('at 320, the list as it was: no table, each row a button, its snoozes beside it', async () => {
    atWidth(PHONE);
    open('/reminders', household());
    await screen.findByText('Sara’s passport');
    expect(screen.queryByRole('table')).toBeNull();
    const li = screen.getByText('Sara’s passport').closest('li') as HTMLElement;
    expect(
      within(li)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining('Sara’s passport'), 'A week', 'A month', 'Done']);
    expect(screen.getByRole('region', { name: 'Coming up' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Answer the questions' })).toBeVisible();
    await expectAccessible();
  });

  it('a viewer, who has no reminders, is told everything is fine, and nothing more than before', async () => {
    atWidth(WIDE);
    open('/reminders', household({ reminders: [], documents: [] }), 'viewer');
    expect(
      await screen.findByText('Everything is fine. Nothing needs your attention.'),
    ).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    await expectAccessible();
  });
});

describe('Needs attention with nothing to do (the owner: “I don’t see that change”)', () => {
  const calm = 'Everything is fine. Nothing needs your attention.';
  const r2 = (over: Record<string, unknown> = {}) =>
    reminder({
      id: 'r-2',
      document_id: 'doc-3',
      document_title: 'Aisha’s passport',
      status: 'scheduled',
      fire_at: '2026-11-20',
      label: 'In 40 days',
      about: 'Expiry date: 29 Oct 2026, in 20 days',
      ...over,
    });
  const fine = (d: ReturnType<typeof doc>) => ({
    ...d,
    status: { value: 'valid', label: 'Valid' },
  });
  const quiet = (reminders: Array<Record<string, unknown>>) => {
    const h = household({ reminders });
    return { ...h, documents: (h.documents ?? []).map((d) => fine(d as ReturnType<typeof doc>)) };
  };

  it.each([WIDE, 1024, MID])(
    'at %i, nothing now and nothing coming up: a calm panel across the width, then Coming up says so; the questions keep their place',
    async (px) => {
      atWidth(px);
      open('/reminders', quiet([]));
      const said = await screen.findByText(calm);
      expect(said).toHaveAttribute('role', 'status');
      // In the tables' frame, not a short line in a narrow column.
      const panel = said.closest('.tbl-wrap') as HTMLElement;
      expect(panel).not.toBeNull();
      expect(panel).toHaveClass('att-calm');
      expect(widthOf(main())).toBe('none');
      const upcoming = screen.getByRole('region', { name: 'Coming up' });
      expect(upcoming).toHaveTextContent('Nothing coming up in the next 90 days.');
      expect(screen.queryByRole('table')).toBeNull();
      // Then the household questions, where they were: last.
      const questions = screen.getByRole('heading', { name: 'We noticed something missing' });
      expect(
        panel.compareDocumentPosition(upcoming) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        upcoming.compareDocumentPosition(questions) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await expectAccessible();
    },
  );

  it('nothing now, something coming up: the calm panel, what is next, and its table', async () => {
    atWidth(WIDE);
    open(
      '/reminders',
      quiet([
        r2(),
        r2({
          id: 'r-3',
          document_id: 'doc-1',
          document_title: 'Sara’s passport',
          status: 'snoozed',
          fire_at: '2026-10-01',
          snoozed_until: '2026-11-03',
        }),
      ]),
    );
    expect(await screen.findByText(calm)).toBeVisible();
    const upcoming = screen.getByRole('region', { name: 'Coming up' });
    // The soonest by when it is next heard of: a snooze's day, not its first.
    expect(
      within(upcoming).getByText('The next reminder is on 3 Nov, for Sara’s passport.'),
    ).toBeVisible();
    expect(within(upcoming).getByRole('table', { name: 'Coming up' })).toBeVisible();
    expect(screen.queryByRole('table', { name: 'Needs attention now' })).toBeNull();
    expect(screen.queryByText(/Nothing coming up/)).toBeNull();
    await expectAccessible();
  });

  it('something now, nothing coming up: the table, then Coming up says there is nothing', async () => {
    atWidth(WIDE);
    const h = household();
    open('/reminders', { ...h, reminders: (h.reminders ?? []).filter((r) => r.id === 'r-1') });
    expect(await screen.findByRole('table', { name: 'Needs attention now' })).toBeVisible();
    expect(screen.queryByText(calm)).toBeNull();
    expect(screen.getByRole('region', { name: 'Coming up' })).toHaveTextContent(
      'Nothing coming up in the next 90 days.',
    );
    expect(screen.queryByText(/The next reminder/)).toBeNull();
    await expectAccessible();
  });

  it('both: the table now, and Coming up says what is next above its own', async () => {
    atWidth(WIDE);
    open('/reminders', household());
    expect(await screen.findByRole('table', { name: 'Needs attention now' })).toBeVisible();
    expect(screen.getByText('The next reminder is on 20 Nov, for Aisha’s passport.')).toBeVisible();
  });

  it('at 320, as it was: the calm line on its own, no panel, nothing said of what is coming', async () => {
    atWidth(PHONE);
    open('/reminders', quiet([]));
    const said = await screen.findByText(calm);
    expect(said.tagName).toBe('P');
    expect(said).toHaveClass('attention', 'attention-calm');
    expect(said.closest('.tbl-wrap')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
    expect(screen.queryByText(/Nothing coming up/)).toBeNull();
    await expectAccessible();
  });
});

// ------------------------------------------------------------------ Home

describe('the bar on top’s Add stays on one line (it wrapped at 1024 px)', () => {
  it.each([
    [
      'a link to Add',
      (() => {
        // A vault from before batches: Add is a link, not a menu.
        const h = household();
        delete h.batches;
        return h;
      })(),
      'link',
    ],
    ['a menu, with many at once', household(), 'button'],
  ] as const)(
    'as %s: never wrapped, never shrunk; the search box gives way',
    async (_, over, role) => {
      for (const px of [MID, 1024, 1100, WIDE]) {
        atWidth(px);
        open('/', over);
        // The shell's bar (a screen's own header is a banner too, to Testing Library).
        const add = await waitFor(() =>
          within(document.querySelector('header.app-bar') as HTMLElement).getByRole(role, {
            name: 'Add',
          }),
        );
        const bar = add.closest('header.app-bar') as HTMLElement;
        const style = getComputedStyle(add);
        expect(style.whiteSpace).toBe('nowrap');
        expect(style.flexWrap).toBe('nowrap');
        expect(style.flexShrink).toBe('0');
        // Its box in the bar, as its only flex item, does not shrink either.
        const item = add.parentElement?.classList.contains('add-wrap') ? add.parentElement : add;
        expect(getComputedStyle(item).flexShrink).toBe('0');
        // What gives way: the search box, and the account's name.
        expect(getComputedStyle(bar.querySelector('.app-search') as HTMLElement).minWidth).toBe(
          '0px',
        );
        expect(getComputedStyle(bar.querySelector('.account') as HTMLElement).minWidth).toBe('0px');
        cleanup();
      }
    },
  );
});

describe('Home uses the width (the owner’s report)', () => {
  it('from 1024 px, the whole of the content’s width: its cards’ grid fills it', async () => {
    atWidth(WIDE);
    open('/', household());
    await screen.findByRole('region', { name: 'Recently added' });
    expect(main()).toHaveClass('page-dash');
    expect(widthOf(main())).toBe('none');
    const dash = main().querySelector('.dash') as HTMLElement;
    expect(getComputedStyle(dash).gridTemplateColumns).toBe('minmax(0, 2fr) minmax(0, 1fr)');
    await expectAccessible();
  });

  it('from 768 to 1023 px, two columns across the whole width', async () => {
    atWidth(MID);
    open('/', household());
    await screen.findByRole('region', { name: 'Recently added' });
    expect(widthOf(main())).toBe('none');
    const dash = main().querySelector('.dash') as HTMLElement;
    expect(getComputedStyle(dash).gridTemplateColumns).toBe('minmax(0, 1fr) minmax(0, 1fr)');
    await expectAccessible();
  });

  it('under 768 px, as it was: no cards', async () => {
    atWidth(PHONE);
    open('/', household());
    await screen.findByRole('heading', { name: 'Recently added' });
    expect(main()).not.toHaveClass('page-dash');
    expect(main().querySelector('.dash')).toBeNull();
  });
});

// ------------------------------------------------------------ the sweep

/** Every signed-in screen that is a list or a table, by who reaches it. */
const LISTS: Array<[string, string, Role, string]> = [
  ['Activity', '/activity', 'owner', 'What has been happening'],
  ['the Trash', '/trash', 'adult', 'Trash'],
  ['People', '/people', 'owner', 'People'],
  ['Outside the family', '/people/outside', 'owner', 'People outside the family'],
  ['a person’s documents', '/people/m-2/documents', 'adult', 'Sara’s documents'],
  ['Collections', '/collections', 'owner', 'Collections'],
  ['a collection’s page', '/collections/collection-t', 'adult', 'Travel'],
  ['Search', '/search?q=passport', 'viewer', 'Search'],
  ['Sharing', '/sharing', 'adult', 'Sharing'],
  ['the Inbox', '/inbox', 'owner', 'Inbox'],
  ['Inbox → Files sent to you', '/inbox/sent', 'owner', 'Inbox'],
  ['After a restore', '/after-restore', 'owner', 'After a restore'],
];

/** Forms, and what is read as one: a readable width, as they were. */
const FORMS: Array<[string, string, Role, string]> = [
  ['Settings → Your account', '/settings/account', 'owner', 'Your account'],
  ['Settings → Household', '/settings/household', 'adult', 'Household'],
  ['Ask for documents', '/sharing/ask', 'adult', 'Ask for documents'],
  ['a profile', '/people/m-2', 'owner', 'Sara Seikh'],
  ['the add card', '/add', 'adult', 'Add a document'],
  ['the household questions', '/household-questions', 'owner', 'A few quick questions'],
];

describe('every list and table uses the width; forms keep a readable one (the sweep)', () => {
  for (const [name, path, role, heading] of LISTS) {
    it(`${name}, at 1280 and 900: the whole of the content’s width`, async () => {
      for (const px of [WIDE, MID]) {
        atWidth(px);
        open(path, household(), role);
        await screen.findByRole('heading', { level: 1, name: heading });
        expect(main()).toHaveClass('page-wide');
        expect(widthOf(main())).toBe('none');
        // What the page says about itself stays a readable line.
        for (const p of main().querySelectorAll<HTMLElement>(':scope > p')) {
          expect(widthOf(p)).not.toBe('none');
        }
        if (px === WIDE) await expectAccessible();
        cleanup();
      }
    });
  }

  for (const [name, path, role, heading] of FORMS) {
    it(`${name}: a readable width`, async () => {
      atWidth(WIDE);
      open(path, household(), role);
      await screen.findByRole('heading', { level: 1, name: heading });
      expect(widthOf(main())).toBe('720px');
    });
  }

  it('Search’s field and its filters keep a form’s width over results across the window', async () => {
    atWidth(WIDE);
    open('/search?q=passport', household(), 'owner');
    await screen.findByRole('heading', { level: 1, name: 'Search' });
    expect(
      widthOf(screen.getByLabelText('Search everything').closest('.field') as HTMLElement),
    ).toBe('720px');
    expect(widthOf(screen.getByLabelText('Filters'))).toBe('720px');
  });
});

// ------------------------------------------- Sharing and After a restore

/** A link outside the family, as GET /shares gives it. */
const link = (over: Record<string, unknown> = {}) => ({
  id: 'sh-1',
  document_id: 'doc-1',
  document_title: 'Sara’s passport',
  recipient_label: 'the visa agent',
  created_by_name: ME.display_name,
  created_at: '2026-10-01T09:00:00Z',
  expires_at: new Date(Date.now() + 9 * 864e5).toISOString(),
  has_pin: false,
  open_count: 1,
  last_opened_at: null,
  state: 'active',
  summary: 'Shared with the visa agent, opened once. Stops working on 18 October at 17:00.',
  ...over,
});
const ENDED = link({
  id: 'sh-2',
  document_title: 'Council tax bill',
  recipient_label: null,
  state: 'expired',
  summary: 'Shared by link, not opened. Expired on 1 October.',
});
const PAUSED_REQUEST = {
  id: 'req-a',
  title: 'Tax papers for 2025',
  message: null,
  items: [{ id: 'i1', label: 'W-2' }],
  recipient_label: 'Jane, accountant',
  recipient_email: null,
  requested_by_name: ME.display_name,
  mine: true,
  created_at: '2026-09-30T10:00:00Z',
  expires_at: new Date(Date.now() + 10 * 864e5).toISOString(),
  protection: ['password'],
  max_visits: 3,
  visits_used: 1,
  max_files: 10,
  files_used: 2,
  max_total_bytes: 200 * 1024 * 1024,
  bytes_used: 2048,
  accept_types: 'standard',
  review_by: 'me',
  suggested_member_id: null,
  suggested_type_key: null,
  close_after_submit: false,
  state: 'paused',
  paused_reason: 'restored',
  closed_reason: null,
  files_received: 2,
};
const headsOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);

describe('Sharing and After a restore are tables from 768 px (the prototype’s)', () => {
  it.each([WIDE, MID])(
    'Sharing at %i: the links and their details, each taken back from its row; the ended a plain table',
    async (px) => {
      atWidth(px);
      open('/sharing', household({ shares: [link(), ENDED] }));
      const live = await screen.findByRole('grid', { name: 'Links that work now' });
      expect(headsOf(live)).toEqual([
        'Link to',
        'For',
        'Where it stands',
        'Made by',
        'Take it back',
      ]);
      const row = within(live).getAllByRole('row')[1] as HTMLElement;
      expect(row).toHaveTextContent('“Sara’s passport”');
      expect(row).toHaveTextContent('the visa agent');
      expect(row).toHaveTextContent('Stops working on 18 October at 17:00.');
      expect(row).toHaveTextContent(ME.display_name);
      // R2's grid: one stop for Tab.
      await waitFor(() => expect(live.querySelectorAll('[tabindex="0"]')).toHaveLength(1));
      const ended = screen.getByRole('table', { name: 'Links that no longer work' });
      expect(headsOf(ended)).toEqual(['Link to', 'For', 'Where it stands', 'Made by']);
      expect(within(ended).queryByRole('button')).toBeNull();
      expect(ended).toHaveTextContent('Expired on 1 October.');
      await expectAccessible();
      // Taken back as before: asked first.
      fireEvent.click(
        within(row).getByRole('button', {
          name: 'Take back the link to “Sara’s passport”, shared with the visa agent',
        }),
      );
      expect(
        await screen.findByRole('alertdialog', { name: 'Take this link back?' }),
      ).toBeVisible();
    },
  );

  it('Sharing at 320: the lists, as before', async () => {
    atWidth(PHONE);
    open('/sharing', household({ shares: [link(), ENDED] }));
    expect(await screen.findByRole('list', { name: 'Links that no longer work' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Links that work now' })).toHaveTextContent(
      'Sara’s passport',
    );
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  const restored = () =>
    household({
      shares: [link({ state: 'paused', paused_reason: 'restored' })],
      uploadRequests: [PAUSED_REQUEST],
      accounts: {
        'm-0': {
          member_id: 'm-0',
          role: 'teen',
          suspension: {
            reason: 'restored',
            since: '2026-10-01T09:00:00Z',
            until: null,
            note: null,
            by: null,
          },
        },
      } as never,
    });

  it.each([WIDE, MID])(
    'After a restore at %i: what was paused, as tables, each row with what can be done about it',
    async (px) => {
      atWidth(px);
      const state = open('/after-restore', restored());
      const signIns = await screen.findByRole('grid', { name: 'Paused sign-ins' });
      expect(headsOf(signIns)).toEqual(['Name', 'Role', 'What they can see', 'Turn back on']);
      expect(within(signIns).getByRole('button', { name: /Turn back on .*sign-in/ })).toBeVisible();
      const links = screen.getByRole('grid', { name: 'Links waiting for you' });
      expect(headsOf(links)).toEqual([
        'Link to',
        'For',
        'Made by',
        'Would work until',
        'Turn back on',
        'Take it back',
      ]);
      expect(links).toHaveTextContent('Sara’s passport');
      const requests = screen.getByRole('grid', { name: 'Paused requests' });
      expect(requests).toHaveTextContent('“Tax papers for 2025”');
      expect(requests).toHaveTextContent('Paused after a restore');
      await expectAccessible();
      // Turned back on from its row, as from the list.
      fireEvent.click(
        within(links).getByRole('button', { name: 'Turn back on the link to “Sara’s passport”' }),
      );
      await waitFor(() =>
        expect(state.calls.some((c) => c.url === '/api/v1/shares/sh-1/resume')).toBe(true),
      );
    },
  );

  it('After a restore at 320: the lists, as before', async () => {
    atWidth(PHONE);
    open('/after-restore', restored());
    expect(await screen.findByRole('list', { name: 'Paused sign-ins' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Paused requests' })).toBeVisible();
    expect(screen.queryByRole('grid')).toBeNull();
  });
});

// ------------------------------------------------ what the screenshots found

describe('what the screenshots of the small fixes found', () => {
  it('a panel that could not load has its Try again as wide as its words, not the panel', async () => {
    atWidth(WIDE);
    open('/settings/account', { ...household(), offline: true });
    const again = await screen.findByRole('button', { name: 'Try again: passkeys' });
    expect(getComputedStyle(again).alignSelf).toBe('flex-start');
  });

  it('a screen not theirs says its two lines together, not a gap apart', async () => {
    atWidth(WIDE);
    open('/people/outside', household(), 'adult');
    const said = await screen.findByText('This isn’t something you can open.');
    expect(getComputedStyle(said).marginBottom).toBe('0px');
    expect(getComputedStyle(said).marginTop).toBe('0px');
  });

  it('a renewal’s wait is said at the foot of the page, never over the search box at its top', () => {
    const rule = /\.renewal-wait\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(rule).toMatch(/bottom:/);
    expect(rule).not.toMatch(/\btop:/);
  });
});
