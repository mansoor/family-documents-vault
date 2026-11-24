import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DocumentTypeView, DocumentView, VersionView } from '@fdv/shared';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { documentFacts, printablePages } from './print-document.js';
import { SENSITIVE_PRINT_NOTICE } from './print.js';
import {
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  TYPES,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * Printing (0.9.0; the owner's backlog of 19 Nov 2026): a note, a document
 * (its pages and a sheet of its details), a collection's contents as a
 * table, and the activity log with its filters said at the top — each from
 * a Print beside the page's other actions, drawn in a root of its own that
 * alone is printed, with nothing of the app around it and nothing the
 * screen does not show.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';

let made = 0;
let printedWith: string[] = [];
let print = vi.fn();
let revoke = vi.fn();
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  made = 0;
  printedWith = [];
  revoke = vi.fn();
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:page-${++made}`),
    revokeObjectURL: revoke,
  });
  // What the page was as the printer was given it.
  print = vi.fn(() => {
    printedWith.push(document.body.className);
  });
  vi.spyOn(window, 'print').mockImplementation(print);
});
afterEach(() => {
  // Nothing left as printing for the next test.
  window.dispatchEvent(new Event('afterprint'));
  vi.restoreAllMocks();
});

function open(s: FakeState, path: string, role: Role = 'owner') {
  installFakeApi(s);
  signedIn(role);
  window.history.replaceState({}, '', path);
  return render(<App />);
}

const printRoot = () => document.querySelector<HTMLElement>('.print-root');

/** Printed: once, with the page as only the print root. */
async function printed(): Promise<HTMLElement> {
  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  expect(printedWith).toEqual(['printing']);
  const root = printRoot();
  expect(root).not.toBeNull();
  // At the end of the page, beside the app, never inside it.
  expect(root?.parentElement).toBe(document.body);
  // Nothing of the app's: no buttons, no fields, no navigation, no links to follow.
  expect(
    root?.querySelector('a, button, input, select, textarea, nav, [role="toolbar"]'),
  ).toBeNull();
  // Whose vault, and when.
  expect(root?.querySelector('.print-foot')?.textContent).toMatch(
    /^The Seikh family · Printed \d{1,2} \w{3} \d{4}, /,
  );
  return root as HTMLElement;
}

/** The browser has printed: the page is the app again, and the print root goes. */
async function afterPrint() {
  window.dispatchEvent(new Event('afterprint'));
  expect(document.body.classList.contains('printing')).toBe(false);
  await waitFor(() => expect(printRoot()).toBeNull());
}

const row = (name: 'Note' | 'Document') =>
  screen.findByRole('toolbar', { name: `${name} actions` });

describe('a note', () => {
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
    notes: '## Who to call\n\nRing **Ann** at Northgate Heating first.',
    notes_updated_at: '2026-09-25T15:12:00Z',
    notes_updated_by_name: 'Sara Seikh',
    etag: '"boiler"',
  };

  it('Print beside Download prints its title, who sees it and its words, and nothing else', async () => {
    open(fresh({ notes: true, documents: [{ ...BOILER }] }), '/notes/note-boiler');
    const actions = await row('Note');
    // Print acts at once: no section, nothing to choose.
    const print = within(actions).getByRole('button', { name: 'Print' });
    expect(print).not.toHaveAttribute('aria-expanded');
    expect(printRoot()).toBeNull();
    fireEvent.click(print);
    const root = await printed();
    expect(within(root).getByRole('heading', { level: 1, hidden: true })).toHaveTextContent(
      'Boiler',
    );
    expect(root).toHaveTextContent(/Note · Everyone in the family · changed /);
    expect(within(root).getByRole('heading', { level: 2, hidden: true })).toHaveTextContent(
      'Who to call',
    );
    expect(root).toHaveTextContent('Ring Ann at Northgate Heating first.');
    // Not Sensitive: nothing asked before it prints, and its heading says nothing of it.
    expect(screen.queryByText(SENSITIVE_PRINT_NOTICE)).toBeNull();
    expect(root).not.toHaveTextContent('Sensitive');
    await afterPrint();
  });

  const SECRET = { ...BOILER, sensitive: true, sensitive_effective: true };

  it('a Sensitive note: one notice first, with Print and Cancel; Cancel prints nothing', async () => {
    open(fresh({ notes: true, sensitive: true, documents: [{ ...SECRET }] }), '/notes/note-boiler');
    const actions = await row('Note');
    const button = within(actions).getByRole('button', { name: 'Print' });
    // Pressed, as a browser does: the focus on it.
    button.focus();
    fireEvent.click(button);
    const notice = await screen.findByRole('alertdialog', { name: 'Before you print' });
    expect(notice).toHaveTextContent(SENSITIVE_PRINT_NOTICE);
    // The app's "are you sure?": Cancel has the focus, so Enter never prints by accident.
    await waitFor(() =>
      expect(within(notice).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    );
    expect(printRoot()).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(print).not.toHaveBeenCalled();
    expect(printRoot()).toBeNull();
    await waitFor(() => expect(button).toHaveFocus());
    // Escape is Cancel too.
    fireEvent.click(button);
    fireEvent.keyDown(await screen.findByRole('alertdialog', { name: 'Before you print' }), {
      key: 'Escape',
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(print).not.toHaveBeenCalled();
  });

  it('a Sensitive note: Print on the notice prints it, its heading saying Sensitive', async () => {
    open(fresh({ notes: true, sensitive: true, documents: [{ ...SECRET }] }), '/notes/note-boiler');
    fireEvent.click(within(await row('Note')).getByRole('button', { name: 'Print' }));
    const notice = await screen.findByRole('alertdialog', { name: 'Before you print' });
    fireEvent.click(within(notice).getByRole('button', { name: 'Print' }));
    const root = await printed();
    expect(root.querySelector('.print-about')).toHaveTextContent(
      /^Note · Everyone in the family · Sensitive · changed /,
    );
    expect(root).toHaveTextContent('Ring Ann at Northgate Heating first.');
    await afterPrint();
  });
});

describe('a document', () => {
  it('its pages and a sheet of its details; its pages ask to confirm it’s you, as its page’s do', async () => {
    // An Essential document: its pages ask who is asking.
    const s = fresh({ documents: [{ ...PASSPORT }], stepUpNeeded: true });
    open(s, '/documents/doc-1');
    fireEvent.click(within(await row('Document')).getByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: "Print “Mansoor's passport”" });
    const pages = within(dialog).getByRole('checkbox', { name: 'Its pages' });
    expect(pages).toBeChecked();
    expect(within(dialog).getByText('2 pages.')).toBeVisible();
    expect(within(dialog).getByRole('checkbox', { name: 'A sheet of its details' })).toBeChecked();
    // Nothing is fetched until Print.
    expect(s.calls.some((c) => /\/pages\/\d+$/.test(c.url))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));

    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(within(prompt).getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));

    const root = await printed();
    // Its pages, as the vault drew them, by the request its page makes.
    const pictures = [...root.querySelectorAll('img')];
    expect(pictures.map((p) => p.getAttribute('alt'))).toEqual([
      "Page 1 of Mansoor's passport",
      "Page 2 of Mansoor's passport",
    ]);
    // Page 1 twice — refused until it was confirmed, then given — and page 2 once.
    expect(
      s.calls
        .filter((c) => c.method === 'GET' && /\/versions\/v-1\/pages\/\d+$/.test(c.url))
        .map((c) => c.url.split('/').at(-1)),
    ).toEqual(['1', '1', '2']);
    // The sheet first: what its details say, in the family's date format.
    const facts = Object.fromEntries(
      [...root.querySelectorAll('.print-fact')].map((f): [string, string] => [
        f.querySelector('dt')?.textContent ?? '',
        f.querySelector('dd')?.textContent ?? '',
      ]),
    );
    expect(facts).toMatchObject({
      Type: 'Passport',
      Person: 'Mansoor Seikh',
      Issued: '14 Mar 2021',
      Expires: 'March 2031',
      Status: 'Valid for 4 years 6 months',
      Visibility: 'Everyone in the family',
    });
    expect(root).toHaveTextContent('Bedroom safe, top shelf');
    expect(
      root.querySelector('.print-sheet')?.compareDocumentPosition(pictures[0] as Node) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await afterPrint();
    // The pictures are let go of once printed.
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:page-1'));
    // And the focus is back on Print.
    await waitFor(() =>
      expect(
        within(screen.getByRole('toolbar', { name: 'Document actions' })).getByRole('button', {
          name: 'Print',
        }),
      ).toHaveFocus(),
    );
  });

  it('“Confirm it’s you” turned down: nothing is printed', async () => {
    open(fresh({ documents: [{ ...PASSPORT }], stepUpNeeded: true }), '/documents/doc-1');
    fireEvent.click(within(await row('Document')).getByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: /^Print/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));
    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Print' })).toBeEnabled(),
    );
    expect(print).not.toHaveBeenCalled();
    expect(printRoot()).toBeNull();
  });

  it('a Sensitive document: its print dialog says first to keep the printout safe; Cancel prints nothing', async () => {
    const s = fresh({
      sensitive: true,
      documents: [{ ...PASSPORT, is_essential: false, sensitive: true, sensitive_effective: true }],
    });
    open(s, '/documents/doc-1');
    fireEvent.click(within(await row('Document')).getByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: /^Print/ });
    expect(within(dialog).getByText(SENSITIVE_PRINT_NOTICE)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Print' })).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Print/ })).toBeNull());
    expect(print).not.toHaveBeenCalled();
    expect(printRoot()).toBeNull();
    expect(s.calls.some((c) => /\/pages\/\d+$/.test(c.url))).toBe(false);
  });

  it('a Sensitive document printed: its heading says Sensitive, with its details or its pages alone', async () => {
    const s = fresh({
      sensitive: true,
      documents: [{ ...PASSPORT, is_essential: false, sensitive: true, sensitive_effective: true }],
    });
    open(s, '/documents/doc-1');
    fireEvent.click(within(await row('Document')).getByRole('button', { name: 'Print' }));
    let dialog = await screen.findByRole('dialog', { name: /^Print/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));
    let root = await printed();
    expect(root.querySelector('.print-about')).toHaveTextContent(/^Document · Sensitive$/);
    await afterPrint();
    // Its pages alone: still said.
    fireEvent.click(within(await row('Document')).getByRole('button', { name: 'Print' }));
    dialog = await screen.findByRole('dialog', { name: /^Print/ });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'A sheet of its details' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    root = printRoot() as HTMLElement;
    expect(root.querySelector('.print-sheet')).toBeNull();
    expect(root.querySelector('.print-about')).toHaveTextContent(/^Sensitive$/);
    await afterPrint();
  });

  it('a document that is not Sensitive: no notice in its print dialog', async () => {
    open(fresh({ documents: [{ ...PASSPORT, is_essential: false }] }), '/documents/doc-1');
    fireEvent.click(within(await row('Document')).getByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: /^Print/ });
    expect(within(dialog).queryByText(SENSITIVE_PRINT_NOTICE)).toBeNull();
  });

  it('a file the vault cannot draw: its details alone, and why not its pages', async () => {
    const s = fresh({
      documents: [{ ...PASSPORT, is_essential: false }],
      pagesDrawn: 'unsupported',
    });
    open(s, '/documents/doc-1');
    fireEvent.click(within(await row('Document')).getByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: /^Print/ });
    const pages = within(dialog).getByRole('checkbox', { name: 'Its pages' });
    expect(pages).toBeDisabled();
    expect(pages).not.toBeChecked();
    expect(
      within(dialog).getByText('The vault can’t draw this file’s pages. Download it to print it.'),
    ).toBeVisible();
    // Neither ticked: nothing to print.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'A sheet of its details' }));
    expect(within(dialog).getByRole('button', { name: 'Print' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'A sheet of its details' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));
    const root = await printed();
    expect(root.querySelector('img')).toBeNull();
    expect(root).toHaveTextContent('Passport');
    expect(s.calls.some((c) => /\/pages\/\d+$/.test(c.url))).toBe(false);
    await afterPrint();
  });
});

describe('a document’s details sheet and its pages, worked out', () => {
  const doc = PASSPORT as unknown as DocumentView;
  const type = TYPES[0] as unknown as DocumentTypeView;

  it('says where the original is kept only to whom its page says it', () => {
    const owner = documentFacts(doc, type, 'Mansoor Seikh', 'owner');
    expect(owner.find((f) => f.label === 'Original is kept')?.value).toBe(
      'Bedroom safe, top shelf',
    );
    for (const role of ['viewer'] as const) {
      expect(documentFacts(doc, type, 'Mansoor Seikh', role).map((f) => f.label)).not.toContain(
        'Original is kept',
      );
    }
  });

  it('says Sensitive, a caregiver’s mark, and “Nothing to renew” as the page does', () => {
    const facts = documentFacts(
      {
        ...doc,
        sensitive_effective: true,
        caregiver: true,
        status: { value: 'valid', label: 'Valid' },
      },
      type,
      'Gran',
      'adult',
    );
    expect(facts).toEqual(
      expect.arrayContaining([
        { label: 'Sensitive', value: 'Yes' },
        { label: 'Visibility', value: 'Shared with you as caregiver' },
        { label: 'Status', value: 'Nothing to renew' },
      ]),
    );
  });

  it('prints the pages the vault drew, at most the first 30, and says what it cannot', () => {
    const v = (over: Partial<VersionView>) =>
      ({
        id: 'v',
        mime: 'application/pdf',
        page_count: 3,
        preview_pages: 3,
        ...over,
      }) as VersionView;
    expect(printablePages(undefined)).toMatchObject({ pages: 0, none: true });
    expect(printablePages(v({}))).toEqual({ pages: 3, words: '3 pages.' });
    expect(printablePages(v({ page_count: 1, preview_pages: 1 }))).toEqual({
      pages: 1,
      words: '1 page.',
    });
    expect(printablePages(v({ page_count: 45, preview_pages: 30 }))).toEqual({
      pages: 30,
      words: 'The first 30 of its 45 pages. Download the file to print the rest.',
    });
    expect(printablePages(v({ preview_pages: null, page_count: 4 })).pages).toBe(4);
    expect(printablePages(v({ preview_pages: null, page_count: null })).pages).toBeNull();
    expect(printablePages(v({ preview_pages: 0 }))).toMatchObject({ pages: 0, none: true });
    expect(printablePages(v({ file_removed: true }))).toMatchObject({ none: true });
    expect(printablePages(v({ stored_as_is: true }))).toMatchObject({ none: true });
  });
});

describe('a collection', () => {
  const HOLIDAY: FakeCollection = {
    id: 'collection-h',
    name: 'Holiday',
    description: 'For the trip in May.',
    audience: 'everyone',
    owner_member_id: 'me',
    etag: '"holiday.1"',
    items: ['doc-1', 'doc-2'],
  };
  const VISA = {
    ...PASSPORT,
    id: 'doc-2',
    title: 'Visa',
    issued: null,
    expires: null,
    physical_location: null,
    is_essential: false,
    status: { value: 'valid', label: 'Valid' },
    etag: '"visa"',
  };

  it('a table of everything in it, with the columns its table shows, and a box to tick beside each', async () => {
    // This device's table hides Who can see it (and Collections, as it starts).
    localStorage.setItem(
      'fdv.collection.hidden-columns',
      JSON.stringify(['collections', 'visibility']),
    );
    const s = fresh({
      collections: [{ ...HOLIDAY, items: [...HOLIDAY.items] }],
      documents: [{ ...PASSPORT }, { ...VISA }],
    });
    open(s, '/collections/collection-h');
    fireEvent.click(await screen.findByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: 'Print “Holiday”' });
    expect(dialog).toHaveTextContent(
      'with the columns its table shows: Title, Kind, Person, Issued, Expires, Status, Location.',
    );
    const ticks = within(dialog).getByRole('checkbox', { name: 'A box beside each, to tick' });
    expect(ticks).not.toBeChecked();
    fireEvent.click(ticks);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));

    const root = await printed();
    expect(root).toHaveTextContent('For the trip in May.');
    expect(root).toHaveTextContent('Collection · 2 documents · sorted by title, A to Z');
    const table = root.querySelector('table') as HTMLTableElement;
    expect([...table.querySelectorAll('thead th')].map((h) => h.textContent)).toEqual([
      'Ticked',
      'Title',
      'Kind',
      'Person',
      'Issued',
      'Expires',
      'Status',
      'Location',
    ]);
    const rows = [...table.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].map((c) => c.textContent),
    );
    expect(rows).toEqual([
      [
        '',
        "Mansoor's passport",
        'Passport',
        'Mansoor',
        '14 Mar 2021',
        'Mar 2031',
        'Valid for 4 years 6 months',
        'Bedroom safe, top shelf',
      ],
      ['', 'Visa', 'Passport', 'Mansoor', '—', '—', 'Nothing to renew', '—'],
    ]);
    expect(table.querySelectorAll('.print-tick')).toHaveLength(2);
    await afterPrint();
  });

  it('a viewer’s: no Location, as their table has none', async () => {
    const s = fresh({
      members: [{ ...ME, role: 'viewer' }],
      collections: [{ ...HOLIDAY, items: [...HOLIDAY.items] }],
      documents: [{ ...PASSPORT }, { ...VISA }],
    });
    open(s, '/collections/collection-h', 'viewer');
    fireEvent.click(await screen.findByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: 'Print “Holiday”' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Print' })).toBeEnabled(),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));
    const root = await printed();
    const heads = [...root.querySelectorAll('thead th')].map((h) => h.textContent);
    expect(heads).toContain('Title');
    expect(heads).not.toContain('Location');
    expect(root).not.toHaveTextContent('Bedroom safe');
    await afterPrint();
  });

  it('its filters, said at the top', async () => {
    const s = fresh({
      collections: [{ ...HOLIDAY, items: [...HOLIDAY.items] }],
      documents: [{ ...PASSPORT }, { ...VISA }],
    });
    open(s, '/collections/collection-h?status=valid');
    fireEvent.click(await screen.findByRole('button', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: 'Print “Holiday”' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));
    const root = await printed();
    expect(root).toHaveTextContent('Filtered: Status: Nothing to renew');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(root.querySelector('.print-tick')).toBeNull();
    await afterPrint();
  });
});

describe('the activity log', () => {
  const SARA = { ...ME, id: 'm-2', display_name: 'Sara Seikh', role: 'adult', is_me: false };
  const line = (id: number, at: string, text: string, kind: string, actor: string | null) => ({
    id,
    at,
    text,
    notable: false,
    document_id: null,
    actor_member_id: actor,
    kind: kind as never,
  });
  const LINES = [
    line(9, '2026-10-07T12:00:00Z', 'Sara Seikh downloaded “Home insurance”', 'opened', 'm-2'),
    line(8, '2026-10-06T12:00:00Z', 'Mansoor Seikh signed in', 'sign_in', 'me'),
    line(7, '2026-10-05T12:00:00Z', 'Sara Seikh made a link to “Home insurance”', 'shared', 'm-2'),
    line(6, '2026-10-03T12:00:00Z', 'Sara Seikh signed in', 'sign_in', 'm-2'),
    line(5, '2026-10-01T12:00:00Z', 'Sara Seikh signed in', 'sign_in', 'm-2'),
  ];

  it('the lines the filters keep, who, what and which days said at the top; older ones loaded down to From first', async () => {
    const s = fresh({ members: [ME, SARA], activity: LINES, activityPage: 2 });
    open(s, '/activity?who=m-2&from=2026-10-02');
    await screen.findByText('Sara Seikh downloaded “Home insurance”');
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    const root = await printed();
    expect(root).toHaveTextContent(
      'Who: Sara Seikh · What happened: Everything · When: From 2 Oct 2026',
    );
    const rows = [...root.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].slice(1).map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ['Sara Seikh', 'Sara Seikh downloaded “Home insurance”'],
      ['Sara Seikh', 'Sara Seikh made a link to “Home insurance”'],
      ['Sara Seikh', 'Sara Seikh signed in'],
    ]);
    expect(root).toHaveTextContent('3 lines, newest first.');
    // Loaded down past the From day, and no further.
    const asked = s.calls.filter((c) => c.url.includes('/api/v1/audit')).map((c) => c.url);
    expect(asked.some((u) => u.includes('before=8'))).toBe(true);
    expect(asked.some((u) => u.includes('before=6'))).toBe(true);
    expect(root).not.toHaveTextContent('Older lines');
    await afterPrint();
  });

  it('with no From day: as far back as the lines loaded, and it says how far', async () => {
    const s = fresh({ members: [ME, SARA], activity: LINES, activityPage: 2 });
    open(s, '/activity');
    await screen.findByText('Mansoor Seikh signed in');
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    const root = await printed();
    expect(root).toHaveTextContent('Who: Everybody · What happened: Everything · When: Any day');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(root).toHaveTextContent(
      /2 lines, newest first\. Older lines weren’t loaded: this goes back to 6 Oct 2026/,
    );
    await afterPrint();
  });

  it('a To day older than the lines loaded: the older lines down to it first', async () => {
    const s = fresh({ members: [ME, SARA], activity: LINES, activityPage: 2 });
    open(s, '/activity?to=2026-10-03');
    await screen.findByText(
      'Nothing loaded matches these filters. Show older to look further back.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    const root = await printed();
    expect(root).toHaveTextContent('When: Up to 3 Oct 2026');
    expect(
      [...root.querySelectorAll('tbody tr')].map((r) => r.querySelectorAll('td')[2]?.textContent),
    ).toEqual(['Sara Seikh signed in', 'Sara Seikh signed in']);
    await afterPrint();
  });

  it('one Sensitive document’s lines: its chip stays neutral, its title never printed', async () => {
    const secret = { ...PASSPORT, title: 'Therapy notes', sensitive_effective: true };
    const s = fresh({
      members: [ME, SARA],
      documents: [secret],
      activity: LINES,
      documentActivity: {
        'doc-1': [
          line(
            3,
            '2026-10-02T12:00:00Z',
            'Sara Seikh opened a sensitive document',
            'opened',
            'm-2',
          ),
        ],
      },
    });
    open(s, '/activity?document=doc-1');
    await screen.findByText('Sara Seikh opened a sensitive document');
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    const root = await printed();
    expect(root.querySelector('.print-head')).toHaveTextContent('About a sensitive document');
    expect(root).toHaveTextContent('Sara Seikh opened a sensitive document');
    expect(root).not.toHaveTextContent('Therapy notes');
    await afterPrint();
  });

  it('Print says it is not to be pressed while it prepares, keeps the focus, and Show older waits', async () => {
    const s = fresh({ members: [ME, SARA], activity: LINES, activityPage: 2 });
    open(s, '/activity?from=2026-10-02');
    await screen.findByText('Sara Seikh downloaded “Home insurance”');
    const print = screen.getByRole('button', { name: 'Print' });
    expect(print).not.toHaveAttribute('aria-disabled');
    print.focus();
    fireEvent.click(print);
    // Preparing (older lines on their way): pressed again, nothing more.
    expect(print).toHaveAttribute('aria-disabled', 'true');
    expect(print).toHaveFocus();
    // Show older waits for it.
    expect(screen.getByRole('button', { name: 'Show older' })).toBeDisabled();
    await printed();
    await afterPrint();
    expect(print).toHaveFocus();
  });
});

describe('the print stylesheet (styles.css)', () => {
  const CSS = (() => {
    const file = ['src/styles.css', 'apps/web/src/styles.css']
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    return (file ? readFileSync(file, 'utf8') : '').replace(/\/\*[\s\S]*?\*\//g, '');
  })();

  it('gives the printer the print root alone, and shows it nowhere on the screen', () => {
    expect(CSS).toMatch(/\.print-root \{\s*display: none;\s*\}/);
    expect(CSS).toMatch(
      /@media print \{\s*body\.printing > :not\(\.print-root\) \{\s*display: none !important;\s*\}\s*body\.printing \{\s*background: var\(--paper\);\s*\}\s*body\.printing > \.print-root \{\s*display: block;\s*\}/,
    );
  });

  it('the browser’s own Print leaves out the app’s controls, never a column’s header', () => {
    const rule = /body:not\(\.printing\)[^{]*:is\(([^)]*)\)\s*\{\s*display: none !important;/.exec(
      CSS,
    );
    expect(rule).not.toBeNull();
    const hidden = (rule?.[1] ?? '').split(',').map((x) => x.trim());
    expect(hidden).toEqual(
      expect.arrayContaining([
        '.app-bar',
        '.sidebar',
        '.bottomnav',
        '.toast',
        '.btn',
        '.action-row-wrap',
      ]),
    );
    // A sortable header is a button: what it says is printed.
    expect(hidden).not.toContain('button');
    expect(hidden.some((x) => x.includes('th-sort') || x.includes('th '))).toBe(false);
  });

  it('prints black on white, whatever the theme', () => {
    expect(CSS).toMatch(
      /\.print-root \{[^}]*background: var\(--paper\);[^}]*color: var\(--paper-ink\);/,
    );
  });
});
