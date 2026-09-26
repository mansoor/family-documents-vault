import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Quick actions on every document (5.4): the ⋯ beside each row, what it
 * offers to whom, and the keyboard's way through it.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const PASSPORT_MENU = "Actions for “Mansoor's passport”";

/** A council tax bill in the family's name, not the signed-in person's. */
const COUNCIL_TAX = {
  ...PASSPORT,
  id: 'doc-3',
  type_key: null,
  title: 'Council tax bill',
  owner_member_id: 'm-0',
  category: 'home',
  is_essential: false,
  latest_version_id: 'v-3',
  etag: '"tax"',
};

/** Home and its "Recently added", signed in as `role`. */
function home(
  documents: Array<Record<string, unknown>>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
  over: Partial<FakeState> = {},
): FakeState {
  const state = fresh({ documents, ...over });
  installFakeApi(state);
  signedIn(role);
  render(<App />);
  return state;
}

/** The ⋯ for one row, focused and pressed, and the menu it opens. */
async function openMenu(name = PASSPORT_MENU) {
  const more = await screen.findByRole('button', { name });
  more.focus();
  fireEvent.click(more);
  const menu = await screen.findByRole('menu', { name });
  return { more, menu };
}

const offered = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent);

describe('quick actions on every document (5.4)', () => {
  it('the menu button is a sibling of the row button', async () => {
    home([{ ...PASSPORT }]);
    const more = await screen.findByRole('button', { name: PASSPORT_MENU });
    const item = more.closest('li') as HTMLElement;
    const row = within(item).getByText("Mansoor's passport").closest('button') as HTMLElement;

    // Two buttons side by side in the row, neither inside the other.
    expect(row).not.toBe(more);
    expect(row.parentElement).toBe(item);
    expect(more.parentElement).toBe(item);
    expect(row.contains(more)).toBe(false);
    expect(row.querySelector('button, a, input')).toBeNull();
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await expectAccessible();

    // Pressing the row still opens the document.
    fireEvent.click(row);
    expect(
      await screen.findByRole('heading', { name: "Mansoor's passport", level: 1 }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/documents/doc-1');
  });

  it('a viewer sees Open and Download only', async () => {
    home([{ ...PASSPORT }], 'viewer');
    const { menu } = await openMenu();
    expect(offered(menu)).toEqual(['Open', 'Download']);
    await expectAccessible();
  });

  it('a teen sees no Share or Who can see, and Edit and Move to Trash only on their own', async () => {
    // The teen is member "me": the passport is theirs, the bill is not.
    home([{ ...PASSPORT }, { ...COUNCIL_TAX }], 'teen');

    const { menu } = await openMenu();
    expect(offered(menu)).toEqual([
      'Open',
      'Download',
      'Read full size',
      'Edit details',
      'Stop it being Essential',
      'Add a new version',
      'Move to Trash',
    ]);
    fireEvent.keyDown(within(menu).getByRole('menuitem', { name: 'Open' }), { key: 'Escape' });

    const theirs = await openMenu('Actions for “Council tax bill”');
    expect(offered(theirs.menu)).toEqual(['Open', 'Download', 'Read full size']);
    for (const never of ['Share a link', 'Who can see', 'Edit details', 'Move to Trash']) {
      expect(within(theirs.menu).queryByRole('menuitem', { name: never })).not.toBeInTheDocument();
    }
  });

  it('Download of an Only me document asks to confirm it’s you', async () => {
    // jsdom has no object URLs, and no downloads: what would be saved is noted.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:file'), revokeObjectURL: vi.fn() });
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const state = home([{ ...PASSPORT, visibility: 'private', is_essential: false }], 'owner', {
      stepUpNeeded: true,
    });

    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Download' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(screen.getByText(/to open a document only you can see/)).toBeInTheDocument();
    expect(saved).toEqual([]);

    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    // Confirmed, it carries on by itself: the current version is saved.
    await waitFor(() => expect(saved).toEqual(['passport.pdf']));
    expect(state.calls.filter((c) => c.url === '/api/v1/versions/v-1/content')).toHaveLength(2);
  });

  it('a stale etag reloads and says so', async () => {
    const passport = { ...PASSPORT };
    const state = home([passport]);
    const lists = () =>
      state.calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/v1/documents?'))
        .length;
    const { menu } = await openMenu();
    // Somebody else changes it after the list was drawn.
    passport.etag = '"elsewhere"';
    const before = lists();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stop it being Essential' }));
    expect(
      await screen.findByText(/was changed somewhere else, so it has been loaded again/),
    ).toBeInTheDocument();
    expect(state.calls.find((c) => c.method === 'PATCH')?.headers?.['if-match']).toBe('"abc"');
    expect(lists()).toBeGreaterThan(before);
    // Nothing was overwritten.
    expect(passport.is_essential).toBe(true);

    // The next try is made on what is there now.
    const again = await openMenu();
    fireEvent.click(within(again.menu).getByRole('menuitem', { name: 'Stop it being Essential' }));
    expect(
      await screen.findByText("“Mansoor's passport” is not Essential any more."),
    ).toBeInTheDocument();
    expect(
      state.calls.filter((c) => c.method === 'PATCH').map((c) => c.headers?.['if-match']),
    ).toEqual(['"abc"', '"elsewhere"']);
    expect(passport.is_essential).toBe(false);
  });

  it('Esc closes and focus returns to ⋯', async () => {
    home([{ ...PASSPORT }]);
    const { more, menu } = await openMenu();
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const open = within(menu).getByRole('menuitem', { name: 'Open' });
    expect(open).toHaveFocus();

    fireEvent.keyDown(open, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute('aria-expanded', 'false');

    // A browser that does not focus a pressed button (Safari) gets it back too,
    // and a tap outside the menu closes it as Escape does.
    more.blur();
    fireEvent.click(more);
    await screen.findByRole('menu');
    fireEvent.click(document.querySelector('.menu-layer') as HTMLElement);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it('arrow keys move between items', async () => {
    home([{ ...PASSPORT }]);
    const { more, menu } = await openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Open',
      'Download',
      'Read full size',
      'Edit details',
      'Share a link',
      'Who can see',
      'Stop it being Essential',
      'Add a new version',
      'Move to Trash',
    ]);
    await expectAccessible();
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const press = (key: string) =>
      fireEvent.keyDown(document.activeElement as HTMLElement, { key });

    expect(first).toHaveFocus();
    press('ArrowDown');
    expect(items[1]).toHaveFocus();
    press('ArrowUp');
    expect(first).toHaveFocus();
    // Round the ends, both ways.
    press('ArrowUp');
    expect(last).toHaveFocus();
    press('ArrowDown');
    expect(first).toHaveFocus();
    press('End');
    expect(last).toHaveFocus();
    press('Home');
    expect(first).toHaveFocus();
    // Tab stays inside the menu, as it does in the app's other sheets.
    press('End');
    press('Tab');
    expect(first).toHaveFocus();

    // Up on the ⋯ opens the menu at its bottom.
    press('Escape');
    expect(more).toHaveFocus();
    fireEvent.keyDown(more, { key: 'ArrowUp' });
    const reopened = await screen.findByRole('menu');
    expect(within(reopened).getByRole('menuitem', { name: 'Move to Trash' })).toHaveFocus();
  });

  it('a search hit’s menu fetches the document when it opens', async () => {
    const state = fresh({ documents: [{ ...PASSPORT }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/search?q=passport');
    render(<App />);
    const fetches = () =>
      state.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/documents/doc-1');

    const { menu } = await openMenu();
    // A hit has no version or ETag: what may be done is decided on the document itself.
    expect(await within(menu).findByRole('menuitem', { name: 'Edit details' })).toBeInTheDocument();
    expect(fetches()).toHaveLength(1);
    await expectAccessible();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stop it being Essential' }));
    expect(
      await screen.findByText("“Mansoor's passport” is not Essential any more."),
    ).toBeInTheDocument();
    expect(state.calls.find((c) => c.method === 'PATCH')?.headers?.['if-match']).toBe('"abc"');
  });

  it('Move to Trash asks in the app’s own dialog, and the row goes', async () => {
    const state = home([{ ...PASSPORT }, { ...COUNCIL_TAX, owner_member_id: 'me' }]);
    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to Trash' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move to Trash?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expectAccessible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: PASSPORT_MENU })).not.toBeInTheDocument(),
    );
    expect(
      state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop()),
    ).toEqual(['doc-1']);
    // Focus went to the row that is left, not to nowhere.
    expect(document.activeElement?.closest('li')).toHaveTextContent('Council tax bill');
  });

  it('Share a link and Who can see open the document page’s own panels over the list', async () => {
    const state = home([{ ...PASSPORT }]);
    const first = await openMenu();
    fireEvent.click(within(first.menu).getByRole('menuitem', { name: 'Share a link' }));
    const share = await screen.findByRole('dialog', { name: "Share “Mansoor's passport”" });
    expect(within(share).getByLabelText('Who is it for?')).toHaveFocus();
    await expectAccessible();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(first.more).toHaveFocus();

    const second = await openMenu();
    fireEvent.click(within(second.menu).getByRole('menuitem', { name: 'Who can see' }));
    const who = await screen.findByRole('dialog', { name: "Who can see “Mansoor's passport”" });
    fireEvent.click(within(who).getByRole('button', { name: 'Adults only' }));
    fireEvent.click(within(who).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      state.calls.some((c) => c.method === 'POST' && c.url.endsWith('/documents/doc-1/visibility')),
    ).toBe(true);
    // The list was loaded again, and says so.
    expect(await screen.findByText('· Adults only', { exact: false })).toBeInTheDocument();
  });

  it('Add a new version sends the file with a key of its own', async () => {
    const chooser = vi.spyOn(HTMLInputElement.prototype, 'click');
    const state = home([{ ...PASSPORT }]);
    const { more, menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add a new version' }));
    expect(chooser).toHaveBeenCalled();

    const input = more.closest('li')?.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.4'], 'renewed.pdf', { type: 'application/pdf' })] },
    });
    expect(
      await screen.findByText("A new version of “Mansoor's passport” was added."),
    ).toBeInTheDocument();
    const upload = state.calls.find(
      (c) => c.method === 'POST' && c.url === '/api/v1/documents/doc-1/versions',
    );
    expect(upload?.headers?.['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
