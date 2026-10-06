import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ONLY_ME_NOT_SHARED, ONLY_ME_SHARE_WARNING, type OwnLinkToEnd } from '@fdv/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { holdAccountLinkToken } from './link-token.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Only me documents and links outside the family (5.41; the owner's
 * decision of 6 Oct 2026): what making one Only me asks about the links
 * that send it, the household's rule in Settings → Household, and what the
 * share sheet says of an Only me document.
 */

const ATTORNEY: OwnLinkToEnd = {
  id: 's-1',
  kind: 'document',
  recipient_label: 'the attorney',
  collection_name: null,
  expires_at: '2026-10-09T16:00:00Z',
  protection: ['password'],
};
const SURVEYOR: OwnLinkToEnd = {
  id: 's-2',
  kind: 'collection',
  recipient_label: 'the surveyor',
  collection_name: 'Flat papers',
  expires_at: '2026-10-12T09:00:00Z',
  protection: [],
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  holdAccountLinkToken();
});

// Each test its own copy of the document: the fake changes the one it is given.
const visibilityCalls = (state: FakeState) =>
  state.calls
    .filter((c) => c.method === 'POST' && c.url.endsWith('/visibility'))
    .map((c) => c.body);

const makeItOnlyMe = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Change who can see this' }));
  fireEvent.click(screen.getByRole('button', { name: 'Only me' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  return screen.findByRole('alertdialog', { name: 'Your links to this document' });
};

describe('making a document Only me, with links of your own', () => {
  it('asks first, lists them, starts on End, and the notice says they ended', async () => {
    const state = fresh({
      documents: [{ ...PASSPORT }],
      ownLinks: [ATTORNEY, SURVEYOR],
      timezone: 'UTC',
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    const dialog = await makeItOnlyMe();
    // Which, and what each asks for: never more.
    expect(dialog).toHaveTextContent('For the attorney: ends');
    expect(dialog).toHaveTextContent('asks for a password.');
    expect(dialog).toHaveTextContent('For the surveyor (the collection “Flat papers”): ends');
    expect(dialog).toHaveTextContent('asks for nothing more.');
    const end = within(dialog).getByRole('radio', { name: 'End these links' });
    const keep = within(dialog).getByRole('radio', {
      name: 'Keep them: the people they are for can still open it',
    });
    expect(end).toBeChecked();
    expect(keep).not.toBeChecked();
    // The focus is in it, on the way out: Cancel.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    );
    // Asked, and nothing changed yet.
    expect(visibilityCalls(state)).toEqual([{ visibility: 'private' }]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make it Only me' }));
    await screen.findByRole('heading', {
      name: 'Only you can open this. Your 2 links to it have ended.',
    });
    expect(visibilityCalls(state)).toEqual([
      { visibility: 'private' },
      { visibility: 'private', own_links: 'end' },
    ]);
  });

  it('Keep keeps them, and the notice says who else can open it', async () => {
    const state = fresh({ documents: [{ ...PASSPORT }], ownLinks: [ATTORNEY] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    const dialog = await makeItOnlyMe();
    fireEvent.click(
      within(dialog).getByRole('radio', {
        name: 'Keep them: the people they are for can still open it',
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make it Only me' }));
    await screen.findByRole('heading', {
      name: 'Only you, and the people your 1 link is for, can open this.',
    });
    expect(visibilityCalls(state).at(-1)).toEqual({ visibility: 'private', own_links: 'keep' });
  });

  it('while the household shares no Only me documents, Keep is not offered; Escape changes nothing', async () => {
    const state = fresh({
      documents: [{ ...PASSPORT }],
      ownLinks: [ATTORNEY],
      onlyMeShareable: false,
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    const dialog = await makeItOnlyMe();
    expect(within(dialog).queryByRole('radio', { name: /Keep them/ })).toBeNull();
    expect(dialog).toHaveTextContent(
      'This household doesn’t share Only me documents outside the family, so they end.',
    );
    // Once it holds the focus, it listens: the focus is given as it starts to.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Your links to this document' })).toBeNull(),
    );
    expect(visibilityCalls(state)).toEqual([{ visibility: 'private' }]);
    expect(state.documents.find((d) => d.id === 'doc-1')?.visibility).toBe('household');
  });
});

describe('the same choice, wherever Only me is chosen (the third round)', () => {
  const patches = (state: FakeState) =>
    state.calls
      .filter((c) => c.method === 'PATCH' && c.url === '/api/v1/documents/doc-1')
      .map((c) => c.body as Record<string, unknown>);

  it('the edit card asks it, and saves with the answer; put away, nothing is saved and nothing is said to have changed (W1)', async () => {
    const state = fresh({ documents: [{ ...PASSPORT }], ownLinks: [ATTORNEY] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1/confirm');
    render(<App />);
    const who = await screen.findByRole('group', { name: 'Who can see this' });
    fireEvent.click(within(who).getByRole('button', { name: 'Only me' }));
    const save = screen.getByRole('button', { name: 'Save to the vault' });
    fireEvent.click(save);
    let dialog = await screen.findByRole('alertdialog', { name: 'Your links to this document' });
    expect(dialog).toHaveTextContent('For the attorney: ends');
    // Put away: the card stays as typed, and says nothing changed elsewhere.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Your links to this document' })).toBeNull(),
    );
    expect(screen.queryByText(/Someone else changed this document/)).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save to the vault' })).toHaveFocus(),
    );
    expect(state.documents[0]?.visibility).toBe('household');
    // Saved again, and answered: End.
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Your links to this document' });
    expect(within(dialog).getByRole('radio', { name: 'End these links' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make it Only me' }));
    await waitFor(() => expect(state.documents[0]?.visibility).toBe('private'));
    const sent = patches(state);
    expect(sent.at(-1)).toMatchObject({ visibility: 'private', own_links: 'end' });
    expect(sent.slice(0, -1).every((b) => !('own_links' in b))).toBe(true);
    expect(screen.queryByText(/Someone else changed this document/)).toBeNull();
  });

  it('from a row’s ⋯, Escape on the question puts away the question, not the sheet (W2)', async () => {
    installFakeApi(fresh({ documents: [{ ...PASSPORT }], ownLinks: [ATTORNEY] }));
    signedIn();
    render(<App />);
    const more = await screen.findByRole('button', { name: "Actions for “Mansoor's passport”" });
    more.focus();
    fireEvent.click(more);
    const menu = await screen.findByRole('menu', { name: "Actions for “Mansoor's passport”" });
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Who can see' }));
    const sheet = await screen.findByRole('dialog', { name: "Who can see “Mansoor's passport”" });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Only me' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Your links to this document' });
    // Once it holds the focus, it listens: the focus is given as it starts to.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Your links to this document' })).toBeNull(),
    );
    expect(
      screen.getByRole('dialog', { name: "Who can see “Mansoor's passport”" }),
    ).toBeInTheDocument();
  });

  /**
   * As a browser runs it (the fourth round): what a listener queues runs
   * while `window.event` is still that event, so React makes it at once —
   * before the card's own work is done, while Save is still switched off.
   */
  async function asBrowser(type: string, fire: () => void) {
    const event = new Event(type);
    Object.defineProperty(window, 'event', { configurable: true, get: () => event });
    try {
      fire();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    } finally {
      delete (window as unknown as { event?: unknown }).event;
    }
  }

  for (const [how, put] of [
    [
      'Cancel',
      (dialog: HTMLElement) =>
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })),
    ],
    ['Escape', (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: 'Escape' })],
  ] as const) {
    it(`the edit card's question put away with ${how}, as a browser runs it, gives the focus back to Save (W3, the edit card)`, async () => {
      installFakeApi(fresh({ documents: [{ ...PASSPORT }], ownLinks: [ATTORNEY] }));
      signedIn();
      window.history.replaceState({}, '', '/documents/doc-1/confirm');
      render(<App />);
      const who = await screen.findByRole('group', { name: 'Who can see this' });
      fireEvent.click(within(who).getByRole('button', { name: 'Only me' }));
      const save = screen.getByRole('button', { name: 'Save to the vault' });
      save.focus();
      fireEvent.click(save);
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Your links to this document',
      });
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
      );
      await asBrowser(how === 'Cancel' ? 'click' : 'keydown', () => put(dialog));
      await waitFor(() =>
        expect(
          screen.queryByRole('alertdialog', { name: 'Your links to this document' }),
        ).toBeNull(),
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save to the vault' })).toHaveFocus(),
      );
    });
  }

  it('a link a restore paused is said to end either way; Keep is offered only for one it would keep (API-1)', async () => {
    const PAUSED = { ...SURVEYOR, will_end: true as const };
    // Only that one: no Keep, and why.
    const state = fresh({ documents: [{ ...PASSPORT }], ownLinks: [PAUSED] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    const { unmount } = render(<App />);
    let dialog = await makeItOnlyMe();
    expect(dialog).toHaveTextContent(
      'It ends either way: paused after a restore, it cannot be turned back on while this is Only me.',
    );
    expect(within(dialog).queryByRole('radio', { name: /Keep them/ })).toBeNull();
    expect(dialog).toHaveTextContent('They end either way.');
    unmount();
    cleanup();

    // Beside one that can send: Keep keeps that one, and the notice counts it alone.
    const both = fresh({ documents: [{ ...PASSPORT }], ownLinks: [ATTORNEY, PAUSED] });
    installFakeApi(both);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    dialog = await makeItOnlyMe();
    fireEvent.click(
      within(dialog).getByRole('radio', {
        name: 'Keep them: the people they are for can still open it',
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make it Only me' }));
    await screen.findByRole('heading', {
      name: 'Only you, and the people your 1 link is for, can open this.',
    });
  });

  it('on the document, the question put away gives the focus back to Save (W3)', async () => {
    installFakeApi(fresh({ documents: [{ ...PASSPORT }], ownLinks: [ATTORNEY] }));
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    const dialog = await makeItOnlyMe();
    // Once it holds the focus, it listens: the focus is given as it starts to.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus());
  });
});

describe('Settings → Household', () => {
  it('an owner turns sharing Only me documents off, with a code; the screen says what it did', async () => {
    const state = fresh({ accountStepUp: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);
    // Settings' own row: the shell's bar on a phone says "Household" too (R1).
    const settings = (await screen.findByRole('heading', { name: 'Settings', level: 1 })).closest(
      'main',
    ) as HTMLElement;
    fireEvent.click(await within(settings).findByRole('link', { name: /^Household/ }));
    const toggle = await screen.findByRole('checkbox', {
      name: 'Only me documents can be shared outside the family',
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    const ask = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(within(ask).queryByLabelText(/password/i)).not.toBeInTheDocument();
    fireEvent.change(within(ask).getByLabelText(/code from your authenticator app/i), {
      target: { value: '123456' },
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Confirm' }));
    const said = await screen.findByText(
      'Turned off. Any link that sent an Only me document is paused, and whoever made it is told.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(
      screen.getByRole('checkbox', { name: 'Only me documents can be shared outside the family' }),
    ).not.toBeChecked();
    expect(state.onlyMeShareable).toBe(false);
  });

  it('an adult reads it, and changes nothing', async () => {
    installFakeApi(fresh({ onlyMeShareable: false }));
    signedIn('adult');
    window.history.replaceState({}, '', '/settings/household');
    render(<App />);
    await screen.findByText(/Nobody, owners included, can send an Only me document/);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(
      screen.getByText(
        'Only an owner can change whether Only me documents can be shared outside the family.',
      ),
    ).toBeInTheDocument();
  });
});

describe('the share sheet of an Only me document', () => {
  it('says who will see it; and while the household shares none, offers no link and says why', async () => {
    const onlyMe = { ...PASSPORT, visibility: 'private' };
    installFakeApi(fresh({ documents: [onlyMe] }));
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    const { unmount } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    expect(await screen.findByText(ONLY_ME_SHARE_WARNING)).toBeInTheDocument();
    unmount();
    cleanup();

    installFakeApi(fresh({ documents: [onlyMe], onlyMeShareable: false }));
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    expect(await screen.findByText(ONLY_ME_NOT_SHARED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share a link' })).toBeNull();
  });
});
