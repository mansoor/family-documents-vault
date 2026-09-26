import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { beside } from './DocActions.js';
import {
  fresh,
  installFakeApi,
  PASSPORT,
  SEALED_HIT,
  signedIn,
  type FakeState,
} from './test-api.js';

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

/** A request held until `open()`: a slow vault, to see what is on screen meanwhile. */
function gate() {
  let open = () => {};
  const until = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { until, open: () => open() };
}

const STEP_UP = 'Just checking it is you';

async function confirmItsMe() {
  const prompt = await screen.findByRole('dialog', { name: STEP_UP });
  fireEvent.change(within(prompt).getByLabelText('Or your password'), {
    target: { value: 'correct horse battery' },
  });
  fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
}

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

  it('confirm it’s you over the Share sheet has the keyboard, and Escape there answers only it', async () => {
    const state = home([{ ...PASSPORT }], 'owner', { stepUpNeeded: true });
    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share a link' }));
    const share = await screen.findByRole('dialog', { name: "Share “Mansoor's passport”" });
    fireEvent.click(within(share).getByRole('button', { name: 'Make the link' }));

    // The passport is Essential: the prompt comes over the sheet, and takes focus.
    const prompt = await screen.findByRole('dialog', { name: STEP_UP });
    const password = within(prompt).getByLabelText('Or your password');
    const cancel = within(prompt).getByRole('button', { name: 'Cancel' });
    expect(password).toHaveFocus();
    // Tab goes round inside it, both ways, never back into the sheet.
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(password).toHaveFocus();
    fireEvent.keyDown(password, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
    await expectAccessible();

    // Escape answers the prompt, not the sheet under it: nothing is made,
    // and the sheet is still there to try again from.
    fireEvent.keyDown(cancel, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: STEP_UP })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: "Share “Mansoor's passport”" })).toBe(share);
    expect(share).toContainElement(document.activeElement as HTMLElement);
    expect(state.shares).toHaveLength(0);

    fireEvent.click(within(share).getByRole('button', { name: 'Make the link' }));
    await confirmItsMe();
    // Confirmed, the link is made and shown, in the sheet it was asked from.
    expect(
      await within(share).findByText(/\/shared\/share-secret-0123456789abcdef/),
    ).toBeInTheDocument();
    expect(state.shares).toHaveLength(1);
  });

  it('Escape and Cancel leave the Share sheet open while the link is being made', async () => {
    const held = gate();
    const state = home([{ ...PASSPORT }], 'owner', {
      hold: (method, path) =>
        method === 'POST' && path.endsWith('/share') ? held.until : undefined,
    });
    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share a link' }));
    const share = await screen.findByRole('dialog', { name: "Share “Mansoor's passport”" });
    fireEvent.click(within(share).getByRole('button', { name: 'Make the link' }));
    await within(share).findByRole('button', { name: 'Making the link…' });

    fireEvent.keyDown(within(share).getByLabelText('Who is it for?'), { key: 'Escape' });
    const cancel = within(share).getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(screen.getByRole('dialog', { name: "Share “Mansoor's passport”" })).toBe(share);

    // The link is made while the sheet is still there to show it: the one
    // place it is ever shown.
    held.open();
    expect(await within(share).findByText(/\/shared\/share-secret/)).toBeInTheDocument();
    expect(state.shares).toHaveLength(1);
  });

  it('the same search again keeps the private results, and the note on the row that acted', async () => {
    const notes = {
      ...PASSPORT,
      id: 'doc-sealed',
      type_key: null,
      title: 'Notes to myself',
      visibility: 'private',
      is_essential: false,
      latest_version_id: 'v-9',
      etag: '"notes"',
    };
    const state = fresh({ documents: [notes], sealed: [SEALED_HIT] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/search?q=estate');
    render(<App />);
    const { more, menu } = await openMenu('Actions for “Notes to myself”');
    const secondPasses = () =>
      state.calls.filter((c) => c.url.startsWith('/api/v1/search/sealed')).length;
    const before = secondPasses();

    // The second pass is the slow one, as it is on a real vault.
    const held = gate();
    state.hold = (_, path) => (path === '/api/v1/search/sealed' ? held.until : undefined);
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Make it Essential' }));
    const said = '“Notes to myself” is Essential now.';
    expect(await screen.findByText(said)).toBeInTheDocument();

    // The search runs again; while its second pass is on its way, the row
    // that acted is still there, with what it said and the focus.
    await waitFor(() => expect(secondPasses()).toBe(before + 1));
    expect(screen.getByText(said)).toBeInTheDocument();
    expect(more).toHaveFocus();
    held.open();
    await waitFor(() =>
      expect(screen.queryByText('Looking inside your private documents…')).not.toBeInTheDocument(),
    );
    expect(screen.getByText(said)).toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it('the menu beside the ⋯ is never taller than the room on its side', () => {
    vi.stubGlobal('innerWidth', 1366);
    vi.stubGlobal('innerHeight', 650);
    const at = (top: number) =>
      beside({
        getBoundingClientRect: () => ({ top, bottom: top + 44, right: 1300 }),
      } as HTMLElement) as Record<string, string>;
    const px = (v: string | undefined) => (v === undefined ? undefined : parseFloat(v));
    for (let top = 8; top <= 598; top += 10) {
      const place = at(top);
      // What the CSS allows: no taller than 60vh, or than the room given.
      const tall = Math.min(650 * 0.6, px(place['--menu-max']) as number);
      const from = px(place['--menu-top']);
      const upTo = px(place['--menu-bottom']);
      const [edgeTop, edgeBottom] =
        from !== undefined
          ? [from, from + tall]
          : [650 - (upTo as number) - tall, 650 - (upTo as number)];
      expect(edgeTop, `⋯ at ${top}`).toBeGreaterThanOrEqual(0);
      expect(edgeBottom, `⋯ at ${top}`).toBeLessThanOrEqual(650);
    }
    // Under the ⋯ when there is room for all of it, above it near the bottom.
    expect(at(40)['--menu-top']).toBe('88px');
    expect(at(540)['--menu-bottom']).toBe('114px');
  });

  it('Move to Trash on the only row leaves focus on the list’s heading', async () => {
    home([{ ...PASSPORT }]);
    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to Trash' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move to Trash?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: PASSPORT_MENU })).not.toBeInTheDocument(),
    );
    // Something that stays, which says where the person is: not nowhere.
    expect(screen.getByRole('heading', { name: 'Recently added' })).toHaveFocus();
  });

  it('Essential turned off and on again before the list is back uses the copy it saved', async () => {
    const passport = { ...PASSPORT };
    const state = home([passport]);
    const first = await openMenu();
    // The list is slow to come back after the change.
    const held = gate();
    state.hold = (method, path) =>
      method === 'GET' && path === '/api/v1/documents' ? held.until : undefined;
    fireEvent.click(within(first.menu).getByRole('menuitem', { name: 'Stop it being Essential' }));
    expect(
      await screen.findByText("“Mansoor's passport” is not Essential any more."),
    ).toBeInTheDocument();

    // Opened again before the list is back: it says what is there now, and
    // changes that copy, not the one the list was drawn from.
    const second = await openMenu();
    fireEvent.click(within(second.menu).getByRole('menuitem', { name: 'Make it Essential' }));
    expect(await screen.findByText("“Mansoor's passport” is Essential now.")).toBeInTheDocument();
    expect(screen.queryByText(/changed somewhere else/)).not.toBeInTheDocument();
    const matches = state.calls
      .filter((c) => c.method === 'PATCH')
      .map((c) => c.headers?.['if-match']);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe('"abc"');
    expect(matches[1]).not.toBe('"abc"');
    expect(passport.is_essential).toBe(true);
    held.open();
  });

  it('a search hit made Only me keeps its notice until it has been read', async () => {
    const state = fresh({ documents: [{ ...PASSPORT }] });
    installFakeApi(state);
    signedIn();
    // Found by the words in its pages, not by its name.
    window.history.replaceState({}, '', '/search?q=4471');
    render(<App />);
    const name = 'Actions for “Home insurance policy”';
    const searches = () => state.calls.filter((c) => c.url.startsWith('/api/v1/search?')).length;
    const { menu } = await openMenu(name);
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Who can see' }));
    const who = await screen.findByRole('dialog', { name: 'Who can see “Home insurance policy”' });
    fireEvent.click(within(who).getByRole('button', { name: 'Only me' }));
    fireEvent.click(within(who).getByRole('button', { name: 'Save' }));
    const notice = { name: 'Only you can open this' };
    expect(await within(who).findByRole('heading', notice)).toBeInTheDocument();

    // Its pages are sealed now, so the same search would not find it. The
    // vault says this once, so the search is not run again under it.
    const before = searches();
    await new Promise((settle) => setTimeout(settle, 400));
    expect(within(who).getByRole('heading', notice)).toBeInTheDocument();
    expect(searches()).toBe(before);

    // Read, the search runs again: it is gone from the results, and focus
    // is on the line that says what they hold now.
    fireEvent.click(within(who).getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(screen.queryByRole('button', { name })).not.toBeInTheDocument());
    expect(screen.getByText('0 documents, searched inside the pages too')).toHaveFocus();
  });

  it('turning Essential off from the ⋯ asks to confirm it’s you; turning it on does not', async () => {
    const passport = { ...PASSPORT };
    const state = home([passport], 'owner', { stepUpNeeded: true });
    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stop it being Essential' }));
    // Off, opening it would not ask any more: so it asks now.
    const prompt = await screen.findByRole('dialog', { name: STEP_UP });
    expect(within(prompt).getByText(/to open an Essential document/)).toBeInTheDocument();
    expect(passport.is_essential).toBe(true);
    await confirmItsMe();
    // Confirmed, it carries on by itself.
    expect(
      await screen.findByText("“Mansoor's passport” is not Essential any more."),
    ).toBeInTheDocument();
    expect(passport.is_essential).toBe(false);

    // On again takes nothing away: not asked, even with the question due.
    state.stepUpNeeded = true;
    const again = await openMenu();
    fireEvent.click(within(again.menu).getByRole('menuitem', { name: 'Make it Essential' }));
    expect(await screen.findByText("“Mansoor's passport” is Essential now.")).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: STEP_UP })).not.toBeInTheDocument();
    expect(passport.is_essential).toBe(true);
  });

  it('taking a document out of Only me from the ⋯ asks to confirm it’s you', async () => {
    const passport = { ...PASSPORT, visibility: 'private' };
    home([passport], 'owner', { stepUpNeeded: true });
    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Who can see' }));
    const who = await screen.findByRole('dialog', { name: "Who can see “Mansoor's passport”" });
    fireEvent.click(within(who).getByRole('button', { name: 'Everyone in the family' }));
    fireEvent.click(within(who).getByRole('button', { name: 'Save' }));
    const prompt = await screen.findByRole('dialog', { name: STEP_UP });
    expect(within(prompt).getByText(/to open a document only you can see/)).toBeInTheDocument();
    expect(passport.visibility).toBe('private');
    await confirmItsMe();
    await waitFor(() => expect(passport.visibility).toBe('household'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Share a link is offered only for a document with a file, as the vault refuses the rest', async () => {
    home([{ ...PASSPORT, latest_version_id: null }], 'adult');
    const { menu } = await openMenu();
    expect(offered(menu)).toEqual([
      'Open',
      'Edit details',
      'Who can see',
      'Stop it being Essential',
      'Add a new version',
      'Move to Trash',
    ]);
    // The document's own page does not offer it either.
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }));
    expect(await screen.findByText('No file yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share a link' })).not.toBeInTheDocument();

    // The stand-in refuses as the vault does: nothing to send, or somebody
    // who may not send anything.
    const share = () => fetch('/api/v1/documents/doc-1/share', { method: 'POST', body: '{}' });
    const empty = await share();
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe(
      'nothing_to_share',
    );
    signedIn('teen');
    expect((await share()).status).toBe(403);
  });
});
