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
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Your links to this document' })).toBeNull(),
    );
    expect(visibilityCalls(state)).toEqual([{ visibility: 'private' }]);
    expect(state.documents.find((d) => d.id === 'doc-1')?.visibility).toBe('household');
  });
});

describe('Settings → Household', () => {
  it('an owner turns sharing Only me documents off, with a code; the screen says what it did', async () => {
    const state = fresh({ accountStepUp: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: /^Household/ }));
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
      'Turned off. 2 links that send an Only me document are paused, and their makers are told.',
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
