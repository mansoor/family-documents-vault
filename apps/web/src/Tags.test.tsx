import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  type FakeState,
} from './test-api.js';

/**
 * Tags you can use, on the web (0.9.0, T1): a document's tags as chips —
 * added with type-ahead, taken off with ×, each opening Documents filtered
 * by it; detail tags ("locker: 12") shown "Locker · 12"; the filter by a
 * label; a tag added to or taken off many at once; and Settings → Tags,
 * where one is renamed, merged or deleted.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';
const WIDE = 1280;
const PHONE = 320;

let width = WIDE;
function atWidth(px: number) {
  width = px;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      return {
        matches: Boolean(minWidth) && width >= Number(minWidth?.[1]),
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

const SARA = { ...AISHA, id: 'm-2', display_name: 'Sara Seikh', has_account: true, role: 'adult' };

/** A document as the vault gives it, its ETag its own. */
const doc = (over: Record<string, unknown>) => ({
  ...PASSPORT,
  is_essential: false,
  tags: [],
  ...over,
  etag: `"${String(over.id)}"`,
});

const GYM = doc({
  id: 'doc-1',
  title: 'Gym membership',
  tags: ['locker: 12', 'travel'],
});
const POOL = doc({ id: 'doc-2', title: 'Pool pass', tags: ['locker: 7', 'policy holder: Ahmed'] });
const SARAS = doc({
  id: 'doc-3',
  title: "Sara's visa",
  owner_member_id: 'm-2',
  filed_by_me: false,
  tags: ['travel'],
});

/** The app again over the same vault, at the address now in the bar. */
function installFakeApiAgain(state: FakeState) {
  installFakeApi(state);
  render(<App />);
}

function at(path: string, over: Partial<FakeState> = {}, role: Role = 'owner', px = WIDE) {
  atWidth(px);
  const state = fresh({
    members: [{ ...ME, role }, SARA],
    tagManagement: true,
    ...over,
    documents: (over.documents ?? [GYM, POOL, SARAS]).map((d) => ({
      ...d,
      tags: [...((d.tags as string[] | undefined) ?? [])],
    })),
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** A document's tags: a section of its action row (0.9.0), opened from its button. */
const tags = async () => {
  const opener = await screen.findByRole('button', { name: /^Tags: / });
  if (opener.getAttribute('aria-expanded') !== 'true') fireEvent.click(opener);
  return screen.findByRole('region', { name: 'Tags' });
};
const patches = (state: FakeState) =>
  state.calls
    .filter((c) => c.method === 'PATCH')
    .map((c) => [c.url, c.body, c.headers?.['if-match']]);

describe('a document’s tags on its page (0.9.0, T1)', () => {
  it('shows each as a chip, a detail tag as “Locker · 12”, each opening Documents filtered by it', async () => {
    at('/documents/doc-1');
    const section = await tags();
    const links = within(section).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Locker · 12Locker: 12', '/documents?tag=locker%3A+12'],
      ['travel', '/documents?tag=travel'],
    ]);
    // Read aloud as "Locker: 12".
    expect(links[0]).toHaveAccessibleName('Documents tagged Locker: 12');
    expect(
      within(section).getByRole('button', { name: 'Remove the tag Locker: 12' }),
    ).toBeVisible();
    // What the field says about who sees them, plainly.
    expect(within(section).getByRole('textbox', { name: 'Add a tag' })).toHaveAccessibleDescription(
      /Everyone who can see this document can see and search its tags; keep passwords and PINs in an Only me note\./,
    );
    await expectAccessible();
    fireEvent.click(links[0] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe('?tag=locker%3A+12'));
  });

  it('adds one with its ETag, offering the values used for a label after “locker: ”', async () => {
    const state = at('/documents/doc-1');
    const section = await tags();
    const field = within(section).getByRole('textbox', { name: 'Add a tag' });
    // Nothing asked of the vault's tags until the field has the focus (the review's H1)…
    const tagCalls = () => state.calls.filter((c) => c.url.startsWith('/api/v1/tags'));
    // Longer than the type-ahead waits for the typing to stop.
    await act(() => new Promise((r) => setTimeout(r, 500)));
    expect(tagCalls()).toEqual([]);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'locker: ' } });
    // …and then only those starting with what is typed.
    await waitFor(() =>
      expect(tagCalls().map((c) => c.url)).toContain('/api/v1/tags?q=locker%3A%20&limit=50'),
    );
    // Pool pass's locker: 7 is offered; this one's own 12 is not.
    const offered = await within(section).findByRole('group', { name: 'Tags already used' });
    expect(
      within(offered)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Locker · 7Locker: 7']);
    fireEvent.change(field, { target: { value: 'Agent :  Sam  Lee' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    await within(section).findByRole('link', { name: 'Documents tagged Agent: Sam Lee' });
    expect(patches(state)).toEqual([
      ['/api/v1/documents/doc-1', { tags: ['locker: 12', 'travel', 'agent: Sam Lee'] }, '"doc-1"'],
    ]);
    expect(within(section).getByRole('status')).toHaveTextContent('“Agent: Sam Lee” added.');
    expect(field).toHaveValue('');
  });

  it('takes one off with its ×', async () => {
    const state = at('/documents/doc-1');
    const section = await tags();
    fireEvent.click(within(section).getByRole('button', { name: 'Remove the tag travel' }));
    await waitFor(() =>
      expect(within(section).queryByRole('link', { name: 'Documents tagged travel' })).toBeNull(),
    );
    expect(patches(state)).toEqual([
      ['/api/v1/documents/doc-1', { tags: ['locker: 12'] }, '"doc-1"'],
    ]);
    expect(within(section).getByRole('status')).toHaveTextContent(
      '“travel” is no longer a tag here.',
    );
    expect(within(section).getByRole('heading', { name: 'Tags' })).toHaveFocus();
  });

  it('changed by somebody else meanwhile, keeps both: theirs, and this one made on top', async () => {
    const state = at('/documents/doc-1');
    const section = await tags();
    // Somebody tags it "house" while the page is open.
    const held = state.documents.find((d) => d.id === 'doc-1') as Record<string, unknown>;
    held.tags = ['locker: 12', 'travel', 'house'];
    held.etag = '"theirs"';
    const field = within(section).getByRole('textbox', { name: 'Add a tag' });
    fireEvent.change(field, { target: { value: 'gym' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    await within(section).findByRole('link', { name: 'Documents tagged gym' });
    expect(within(section).getByRole('link', { name: 'Documents tagged house' })).toBeVisible();
    expect(patches(state)).toEqual([
      ['/api/v1/documents/doc-1', { tags: ['locker: 12', 'travel', 'gym'] }, '"doc-1"'],
      ['/api/v1/documents/doc-1', { tags: ['locker: 12', 'travel', 'house', 'gym'] }, '"theirs"'],
    ]);
    expect(within(section).getByRole('status')).toHaveTextContent(
      'Someone else changed this document meanwhile. Your change was made on top of theirs: “gym” added.',
    );
  });

  it('says a label that looks like a secret before saving it, and saves it only when asked again', async () => {
    const state = at('/documents/doc-1');
    const section = await tags();
    const field = within(section).getByRole('textbox', { name: 'Add a tag' });
    fireEvent.change(field, { target: { value: 'PIN: 4821' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    const warning = await within(section).findByRole('alert');
    expect(warning).toHaveTextContent(
      '“Pin” looks like a secret. Everyone who can see this document can see and search its tags: keep passwords and PINs in an Only me note instead.',
    );
    expect(patches(state)).toEqual([]);
    expect(field).toHaveAccessibleDescription(/looks like a secret/);
    await expectAccessible();
    fireEvent.click(within(section).getByRole('button', { name: 'Add it anyway' }));
    await within(section).findByRole('link', { name: 'Documents tagged Pin: 4821' });
    expect(patches(state)).toEqual([
      ['/api/v1/documents/doc-1', { tags: ['locker: 12', 'travel', 'pin: 4821'] }, '"doc-1"'],
    ]);
  });

  it('refuses a tag too long in words, before sending it', async () => {
    const state = at('/documents/doc-1');
    const section = await tags();
    fireEvent.change(within(section).getByRole('textbox', { name: 'Add a tag' }), {
      target: { value: 'x'.repeat(41) },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    expect(await within(section).findByText(/^A tag can be 40 characters at most/)).toBeVisible();
    // Heard with the field (the review's L7).
    expect(within(section).getByRole('textbox', { name: 'Add a tag' })).toHaveAccessibleDescription(
      /^A tag can be 40 characters at most/,
    );
    expect(patches(state)).toEqual([]);
  });

  it('says a tag is there already, and spells one there in other letters as now typed (L5)', async () => {
    const state = at('/documents', {
      documents: [doc({ id: 'doc-1', title: 'Pension', tags: ['travel', 'agent: sam lee'] })],
    });
    window.history.replaceState({}, '', '/documents/doc-1');
    cleanup();
    installFakeApiAgain(state);
    const section = await tags();
    const field = within(section).getByRole('textbox', { name: 'Add a tag' });
    fireEvent.change(field, { target: { value: 'Travel' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(within(section).getByRole('status')).toHaveTextContent(
        '“travel” is already a tag here.',
      ),
    );
    expect(patches(state)).toEqual([]);
    fireEvent.change(field, { target: { value: 'Agent: Sam Lee' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    await within(section).findByRole('link', { name: 'Documents tagged Agent: Sam Lee' });
    expect(within(section).getByRole('status')).toHaveTextContent(
      '“Agent: sam lee” is now spelt “Agent: Sam Lee”.',
    );
    expect(patches(state)).toEqual([
      ['/api/v1/documents/doc-1', { tags: ['travel', 'agent: Sam Lee'] }, '"doc-1"'],
    ]);
  });

  it('for whoever may not change it — a viewer, a teen on somebody else’s — chips only', async () => {
    for (const [role, id] of [
      ['viewer', 'doc-1'],
      ['teen', 'doc-3'],
    ] as const) {
      at(`/documents/${id}`, {}, role);
      const section = await tags();
      expect(within(section).getAllByRole('link').length).toBeGreaterThan(0);
      expect(within(section).queryByRole('textbox')).toBeNull();
      expect(within(section).queryByRole('button')).toBeNull();
      await expectAccessible();
      cleanup();
    }
  });
});

describe('Documents: by a detail’s label, and a tag to many at once (0.9.0, T1)', () => {
  const table = () => screen.findByRole('grid', { name: /^Documents, sorted by/ });
  const rows = (t: HTMLElement) =>
    within(t)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('.cell-title')?.textContent ?? null);

  it('filters by a label, any value, and by the label and its value', async () => {
    const state = at('/documents');
    const t = await table();
    await waitFor(() => expect(rows(t)).toHaveLength(3));
    const detail = await screen.findByRole('combobox', { name: 'Detail' });
    expect(
      within(detail)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Any detail', 'Locker', 'Policy holder']);
    fireEvent.change(detail, { target: { value: 'locker' } });
    await waitFor(() => expect(window.location.search).toBe('?label=locker'));
    await waitFor(() => expect(rows(t)).toEqual(['Gym membership', 'Pool pass']));
    expect(state.calls.some((c) => c.url.includes('tag_label=locker'))).toBe(true);
    const tag = screen.getByRole('combobox', { name: 'Tag' });
    expect(within(tag).getByRole('option', { name: 'Locker · 7' })).toBeInTheDocument();
    fireEvent.change(tag, { target: { value: 'locker: 7' } });
    await waitFor(() => expect(rows(t)).toEqual(['Pool pass']));
    await expectAccessible();
  });

  it('adds a tag to those the person may change, names the rest, and lists one changed meanwhile', async () => {
    const state = at(
      '/documents',
      {
        documents: [
          doc({ id: 'doc-a', title: 'My library card', owner_member_id: 'me' }),
          doc({ id: 'doc-b', title: 'My gym card', owner_member_id: 'me', tags: ['locker: 3'] }),
          doc({ id: 'doc-c', title: 'My old card', owner_member_id: 'me' }),
          doc({ id: 'doc-d', title: "Sara's card", owner_member_id: 'm-2', filed_by_me: false }),
        ],
      },
      'teen',
    );
    const t = await table();
    await waitFor(() => expect(rows(t)).toHaveLength(4));
    for (const name of ['My library card', 'My gym card', 'My old card', "Sara's card"]) {
      fireEvent.click(within(t).getByRole('checkbox', { name: `Select “${name}”` }));
    }
    // My old card is changed somewhere else after the table was drawn.
    (state.documents.find((d) => d.id === 'doc-c') as Record<string, unknown>).etag = '"moved"';
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Tags' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add a tag…' }));
    const sheet = screen.getByRole('dialog', { name: 'Add a tag to 3 documents' });
    expect(sheet).toHaveTextContent(
      '1 of the 4 you chose isn’t yours to change: it is left as it is.',
    );
    await expectAccessible();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Tag' }), {
      target: { value: 'Locker: 3' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add to 3 documents' }));
    const outcome = await screen.findByText(/added to 1 document\./);
    expect(outcome).toHaveTextContent(
      `“Locker · 3” added to 1 document. 1 had it already. Left as it was, not yours to change: “Sara's card”.`,
    );
    const failed = await screen.findByRole('alert');
    expect(failed).toHaveTextContent('1 of the 3 could not be changed:');
    expect(failed).toHaveTextContent('“My old card”: Someone else changed this document.');
    // Each its own edit, with its own ETag; Sara's never asked for.
    expect(patches(state)).toEqual([
      ['/api/v1/documents/doc-a', { tags: ['locker: 3'] }, '"doc-a"'],
      ['/api/v1/documents/doc-c', { tags: ['locker: 3'] }, '"doc-c"'],
    ]);
  });

  it('keeps Add a tag and Remove a tag behind one Tags menu button, by keyboard too', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(rows(t)).toHaveLength(3));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “Gym membership”' }));
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    const tags = within(bar).getByRole('button', { name: 'Tags' });
    expect(tags).toHaveAttribute('aria-haspopup', 'menu');
    expect(tags).toHaveAttribute('aria-expanded', 'false');
    // Neither is in the bar itself: one button for both.
    expect(within(bar).queryByRole('button', { name: /a tag/ })).toBeNull();
    // Down opens it at the first item; the arrows move, round from the end.
    tags.focus();
    fireEvent.keyDown(tags, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu', { name: 'Tags' });
    expect(tags).toHaveAttribute('aria-expanded', 'true');
    expect(tags).toHaveAttribute('aria-controls', menu.id);
    const [add, remove] = within(menu).getAllByRole('menuitem') as [HTMLElement, HTMLElement];
    expect([add.textContent, remove.textContent]).toEqual(['Add a tag…', 'Remove a tag…']);
    await waitFor(() => expect(add).toHaveFocus());
    fireEvent.keyDown(add, { key: 'ArrowDown' });
    expect(remove).toHaveFocus();
    fireEvent.keyDown(remove, { key: 'ArrowDown' });
    expect(add).toHaveFocus();
    fireEvent.keyDown(add, { key: 'End' });
    expect(remove).toHaveFocus();
    await expectAccessible();
    // Escape shuts it, the focus back on Tags.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(tags).toHaveFocus());
    expect(tags).toHaveAttribute('aria-expanded', 'false');
    // Up opens it at the last; chosen, its sheet; put away, the focus on Tags again.
    fireEvent.keyDown(tags, { key: 'ArrowUp' });
    const again = await screen.findByRole('menu', { name: 'Tags' });
    const last = within(again).getByRole('menuitem', { name: 'Remove a tag…' });
    await waitFor(() => expect(last).toHaveFocus());
    fireEvent.click(last);
    const sheet = await screen.findByRole('dialog', { name: 'Remove a tag from 1 document' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(tags).toHaveFocus());
  });

  it('takes a tag off the chosen documents that carry it', async () => {
    const state = at('/documents');
    const t = await table();
    await waitFor(() => expect(rows(t)).toHaveLength(3));
    for (const name of ['Gym membership', 'Pool pass', "Sara's visa"]) {
      fireEvent.click(within(t).getByRole('checkbox', { name: `Select “${name}”` }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove a tag…' }));
    const sheet = screen.getByRole('dialog', { name: 'Remove a tag from 3 documents' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'travel (2)' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove from 3 documents' }));
    expect(
      await screen.findByText('“travel” taken off 2 documents. 1 did not have it.'),
    ).toBeVisible();
    expect(patches(state).map((p) => p[0])).toEqual([
      '/api/v1/documents/doc-1',
      '/api/v1/documents/doc-3',
    ]);
  });
});

describe('Settings → Tags (0.9.0, T1)', () => {
  it('lists every tag, details by their label, with how many carry each', async () => {
    at('/settings/tags', {}, 'owner');
    await screen.findByRole('heading', { level: 1, name: 'Tags' });
    const plain = await screen.findByRole('region', { name: 'Tags' });
    expect(within(plain).getByRole('link', { name: 'travel' })).toBeVisible();
    expect(within(plain).getByText('2 documents')).toBeVisible();
    const details = screen.getByRole('region', { name: 'Details' });
    const locker = within(details).getByRole('list', { name: 'Locker' });
    expect(
      within(locker)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Locker · 12Locker: 12', 'Locker · 7Locker: 7']);
    expect(within(details).getByRole('link', { name: 'Locker' })).toHaveAttribute(
      'href',
      '/documents?label=locker',
    );
    await expectAccessible();
  });

  it('renames into a tag that is there already only once a merge is confirmed', async () => {
    const state = at('/settings/tags');
    const plain = await screen.findByRole('region', { name: 'Tags' });
    await within(plain).findByRole('link', { name: 'travel' });
    fireEvent.click(screen.getByRole('button', { name: 'Rename Locker: 7' }));
    const sheet = screen.getByRole('dialog', { name: 'Rename “Locker · 7”' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'New name' }), {
      target: { value: 'Locker: 12' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Rename' }));
    const ask = await screen.findByRole('alertdialog', {
      name: 'Merge “Locker · 7” into “Locker · 12”?',
    });
    expect(ask).toHaveTextContent('“locker: 12” is a tag already.');
    await expectAccessible();
    fireEvent.click(within(ask).getByRole('button', { name: 'Merge them' }));
    expect(
      await screen.findByText('“Locker · 7” merged into “Locker · 12”. Changed on 1 document.'),
    ).toBeVisible();
    expect(state.tagChanges?.map((c) => c.body)).toEqual([
      { from: 'locker: 7', to: 'locker: 12' },
      { from: 'locker: 7', to: 'locker: 12', merge: true },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rename Locker: 7' })).toBeNull(),
    );
  });

  it('finds a tag past the first 1,000 with Find a tag, and says the list stops there (L4)', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `bulk-${String(i).padStart(4, '0')}`);
    const state = at('/settings/tags', {
      documents: [doc({ id: 'doc-1', title: 'Many', tags: many }), POOL],
    });
    // A thousand rows to draw: given time to.
    const slow = { timeout: 15_000 };
    await screen.findByRole('heading', { level: 1, name: 'Tags' });
    const find = screen.getByRole('searchbox', { name: 'Find a tag' });
    await waitFor(
      () =>
        expect(find).toHaveAccessibleDescription(
          'Showing the 1,000 used most. Find a tag to see one further down.',
        ),
      slow,
    );
    fireEvent.change(find, { target: { value: 'Policy' } });
    const details = await screen.findByRole('region', { name: 'Details' }, slow);
    await waitFor(
      () =>
        expect(
          within(details)
            .getAllByRole('link')
            .map((l) => l.textContent),
        ).toEqual(['Policy holder', 'Policy holder · AhmedPolicy holder: Ahmed']),
      slow,
    );
    expect(state.calls.some((c) => c.url === '/api/v1/tags?q=Policy&limit=1000')).toBe(true);
    expect(screen.queryByRole('region', { name: 'Tags' })).toBeNull();
    expect(find).toHaveAccessibleDescription('Those that start with what you type.');
    await expectAccessible();
  }, 60_000);

  it('says a new name that looks like a secret before renaming to it (L2)', async () => {
    const state = at('/settings/tags');
    await screen.findByRole('button', { name: 'Rename travel' });
    fireEvent.click(screen.getByRole('button', { name: 'Rename travel' }));
    const sheet = screen.getByRole('dialog', { name: 'Rename “travel”' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'New name' }), {
      target: { value: 'wifi_password: hunter2' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Rename' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      '“Wifi_password” looks like a secret.',
    );
    expect(state.tagChanges ?? []).toEqual([]);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Rename it anyway' }));
    await screen.findByText(/is now “Wifi_password · hunter2”\. Changed on 2 documents\./);
    expect(state.tagChanges?.map((c) => c.body)).toEqual([
      { from: 'travel', to: 'wifi_password: hunter2' },
    ]);
  });

  it('says how many it changed in the Trash (M2)', async () => {
    const state = at('/settings/tags', {
      documents: [GYM, POOL, { ...SARAS, deleted_at: '2026-10-01T10:00:00Z' }],
    });
    await screen.findByRole('button', { name: 'Delete travel' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete travel' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete it' }),
    );
    expect(
      await screen.findByText(
        '“travel” deleted. Changed on 2 documents, including 1 in the Trash.',
      ),
    ).toBeVisible();
    expect((state.documents.find((d) => d.id === 'doc-3') as { tags: string[] }).tags).toEqual([]);
  });

  it('deletes a tag after asking, and says where it stays that the person cannot change', async () => {
    const state = at('/settings/tags', { tagsNotMine: { travel: 1 } }, 'teen');
    const plain = await screen.findByRole('region', { name: 'Tags' });
    expect(await within(plain).findByText('2 documents · you can change 1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Delete travel' }));
    const ask = screen.getByRole('alertdialog', { name: 'Delete the tag “travel”?' });
    expect(ask).toHaveTextContent(
      'It is taken off the 1 document you can change. It stays on 1 document you can see but can’t change.',
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete it' }));
    expect(
      await screen.findByText(
        '“travel” deleted. Changed on 1 document. It stays on 1 document you can see but can’t change.',
      ),
    ).toBeVisible();
    expect(state.tagChanges?.map((c) => [c.path, c.body])).toEqual([
      ['/api/v1/tags/delete', { tag: 'travel' }],
    ]);
  });

  it('is a section after Kinds of document for owners, adults and teens; never a viewer', async () => {
    const sections = async () =>
      within(await screen.findByRole('navigation', { name: 'Settings sections' }))
        .getAllByRole('link')
        .map((l) => l.querySelector('.settings-nav-label')?.textContent);
    for (const role of ['owner', 'adult', 'teen', 'viewer'] as const) {
      at('/settings/account', {}, role);
      await screen.findByRole('heading', { level: 1, name: 'Your account' });
      const names = await sections();
      if (role === 'viewer') expect(names).not.toContain('Tags');
      else expect(names).toContain('Tags');
      if (role !== 'teen' && role !== 'viewer') {
        expect(names.indexOf('Tags')).toBe(names.indexOf('Kinds of document') + 1);
      }
      cleanup();
    }
    // A viewer who finds the address anyway is told why not.
    at('/settings/tags', {}, 'viewer');
    expect(
      await screen.findByText('Viewers can open and download documents, but not change them.'),
    ).toBeVisible();
  });

  it('at 320, is the same list, with Back to Settings', async () => {
    at('/settings/tags', {}, 'adult', PHONE);
    await screen.findByRole('heading', { level: 1, name: 'Tags' });
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    await screen.findByRole('region', { name: 'Details' });
    await expectAccessible();
  });
});
