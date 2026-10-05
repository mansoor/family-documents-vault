import type { MemberAccess, MemberAccount } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
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
 * Limiting what a viewer can see, on the web (5.33): the viewer's account
 * card, an invitation's limits, the owners' banner (A29), a restricted
 * viewer's Home, and a viewer's way to the collections given to them
 * (U515-11).
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** Val, a viewer with a sign-in. */
const VAL = { ...AISHA, id: 'm-3', display_name: 'Val', has_account: true, role: 'viewer' };
/** Aisha's own passport, for the count. */
const HERS = { ...PASSPORT, id: 'doc-a', title: 'Aisha’s passport', owner_member_id: 'm-0' };
/** Val's card, as an owner is shown it: no limits, unless a test says. */
const card = (access: MemberAccess | null = null): MemberAccount => ({
  member_id: 'm-3',
  role: 'viewer',
  email: 'val@example.test',
  two_step: false,
  passkeys: 0,
  last_signed_in_at: new Date().toISOString(),
  devices: [],
  suspension: null,
  max_offline_days: 90,
  access,
});
const LIMITED: MemberAccess = {
  member_id: 'm-3',
  people: ['m-0'],
  types: [],
  collections: [],
  include_adults_only: false,
  include_no_person_docs: false,
  expires_at: null,
  summary: "Restricted: sees 1 person's documents.",
  reconfirm_since: null,
  private_confirmed: false,
  updated_at: new Date().toISOString(),
};

function at(path: string, over: Partial<FakeState>, role: 'owner' | 'adult' | 'viewer' = 'owner') {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** Val's account card, opened. */
async function openCard() {
  const region = await screen.findByRole('region', { name: 'Account' });
  fireEvent.click(within(region).getByRole('button', { name: 'Show their account' }));
  await within(region).findByText('val@example.test');
  return within(region).getByRole('region', { name: 'What they can see' });
}

describe('what a viewer can see (5.33)', () => {
  it('an owner limits a viewer from their card, counting as they choose, and confirms for somebody with Only me documents', async () => {
    const state = at('/people/m-3', {
      members: [ME, AISHA, VAL],
      documents: [PASSPORT, HERS],
      accounts: { 'm-3': card() },
      keepsPrivate: ['m-3'],
    });
    const limits = await openCard();
    expect(
      within(limits).getByText('Val can see every family document but the Adults only ones.'),
    ).toBeInTheDocument();
    fireEvent.click(within(limits).getByRole('button', { name: 'Limit what they can see' }));
    // Not Val, among whose: their own are always theirs.
    expect(await within(limits).findByLabelText('Aisha')).toBeInTheDocument();
    expect(within(limits).queryByLabelText('Val')).not.toBeInTheDocument();
    fireEvent.click(within(limits).getByLabelText('Aisha'));
    // The vault counts it, a moment after the change.
    expect(
      await within(limits).findByText('They will see 1 document, and their own Only me documents.'),
    ).toBeInTheDocument();
    expect(within(limits).getByLabelText('Adults only documents too')).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(limits).getByRole('button', { name: 'Save these limits' }));
    // Val keeps Only me documents: asked first, and told.
    const ask = await screen.findByRole('alertdialog', { name: 'Limit what Val can see?' });
    expect(within(ask).getByText(/Val keeps documents only they can see/)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(ask).getByRole('button', { name: 'Limit them' }));
    expect(
      await screen.findByText('Val’s limits are saved, and they have been told.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Val’s limits are saved, and they have been told.')).toHaveFocus(),
    );
    expect(state.accessWrites?.map((w) => [w.method, w.body])).toEqual([
      [
        'PUT',
        {
          people: ['m-0'],
          types: [],
          collections: [],
          include_adults_only: false,
          include_no_person_docs: false,
          expires_at: null,
        },
      ],
      [
        'PUT',
        {
          people: ['m-0'],
          types: [],
          collections: [],
          include_adults_only: false,
          include_no_person_docs: false,
          expires_at: null,
          confirm_private: true,
        },
      ],
    ]);
    expect(within(limits).getByText("Restricted: sees 1 person's documents.")).toBeInTheDocument();
  });

  it('after their sign-in was given back, the owner keeps the limits as they are, or takes them off', async () => {
    const state = at('/people/m-3', {
      members: [ME, AISHA, VAL],
      accounts: { 'm-3': card({ ...LIMITED, reconfirm_since: new Date().toISOString() }) },
    });
    const limits = await openCard();
    expect(
      within(limits).getByText(/Val’s sign-in was given back since these limits were set/),
    ).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(limits).getByRole('button', { name: 'Keep these limits' }));
    expect(await screen.findByText('Val’s limits are confirmed.')).toBeInTheDocument();
    // The same limits, put again.
    expect(state.accessWrites?.[0]).toMatchObject({
      method: 'PUT',
      body: { people: ['m-0'], types: [], collections: [] },
    });
    expect(within(limits).queryByText(/was given back/)).not.toBeInTheDocument();

    fireEvent.click(within(limits).getByRole('button', { name: 'Take the limits off' }));
    const off = await screen.findByRole('alertdialog', {
      name: 'Let Val see every family document?',
    });
    await expectAccessible();
    fireEvent.click(within(off).getByRole('button', { name: 'Take the limits off' }));
    expect(await screen.findByText('Val can see every family document again.')).toBeInTheDocument();
    expect(state.accessWrites?.at(-1)?.method).toBe('DELETE');
  });

  it('a vault from before shows no limits on the card', async () => {
    at('/people/m-3', {
      members: [ME, AISHA, VAL],
      accounts: { 'm-3': card() },
      accessRestrictions: false,
    });
    const region = await screen.findByRole('region', { name: 'Account' });
    fireEvent.click(within(region).getByRole('button', { name: 'Show their account' }));
    await within(region).findByText('val@example.test');
    expect(within(region).queryByRole('region', { name: 'What they can see' })).toBeNull();
  });

  it('an adult inviting a viewer chooses what they can see; an owner may let one see everything', async () => {
    const invite = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Invite someone to sign in' }));
      fireEvent.change(screen.getByLabelText('Their name'), { target: { value: 'Una' } });
      fireEvent.change(screen.getByLabelText('Their email address'), {
        target: { value: 'una@example.test' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Viewer' }));
      return screen.getByRole('region', { name: 'Limit what they can see' });
    };
    const posted = (state: FakeState) =>
      state.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/invitations').at(-1)
        ?.body as Record<string, unknown> | undefined;

    // An adult: always limited, never with Adults only documents (A27).
    const adult = at(
      '/people',
      { members: [{ ...ME, role: 'adult' }, AISHA], documents: [HERS] },
      'adult',
    );
    let limits = await invite();
    expect(
      within(limits).getByText(/Only an owner can invite a viewer who sees every family document/),
    ).toBeInTheDocument();
    expect(within(limits).queryByLabelText('Only what I choose')).toBeNull();
    expect(within(limits).queryByLabelText('Adults only documents too')).toBeNull();
    fireEvent.click(await within(limits).findByLabelText('Aisha'));
    expect(await within(limits).findByText('They will see 1 document.')).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Una' });
    expect(posted(adult)).toMatchObject({
      role: 'viewer',
      restriction: { people: ['m-0'], include_adults_only: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/Viewer · limited ·/)).toBeInTheDocument();
    cleanup();

    // An owner: limited unless they say; switched off, every family document.
    const owner = at('/people', { members: [ME, AISHA], documents: [HERS] });
    limits = await invite();
    const choose = within(limits).getByLabelText('Only what I choose');
    expect(choose).toBeChecked();
    expect(await within(limits).findByLabelText('Adults only documents too')).toBeInTheDocument();
    fireEvent.click(choose);
    expect(within(limits).queryByLabelText('Aisha')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Una' });
    expect(posted(owner)).not.toHaveProperty('restriction');
  });

  it('owners are asked to limit viewers who see everything; nobody else is', async () => {
    at('/', { members: [ME, { ...VAL, restriction: null }] });
    const banner = await screen.findByRole('link', {
      name: /Viewers can see every family document — restrict them\?/,
    });
    expect(banner).toHaveAttribute('href', '/people/m-3');
    expect(banner).toHaveTextContent('Val is a viewer with no limits.');
    await expectAccessible();
    cleanup();
    // Once limited, nothing to ask.
    at('/', { members: [ME, { ...VAL, restriction: { summary: 'Restricted: sees nothing.' } }] });
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.queryByText(/restrict them\?/)).toBeNull();
    cleanup();
    // An adult is told nothing of who is limited (the vault leaves it out).
    at('/', { members: [{ ...ME, role: 'adult' }, VAL] }, 'adult');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.queryByText(/restrict them\?/)).toBeNull();
  });

  it("a restricted viewer's Home says what they can see, and leads to the collections given to them", async () => {
    const given: FakeCollection = {
      id: 'collection-g',
      name: 'For the accountant',
      description: null,
      audience: 'everyone',
      owner_member_id: 'm-9',
      etag: '"g.1"',
      items: ['doc-1'],
    };
    at(
      '/',
      {
        members: [{ ...ME, role: 'viewer' }],
        collections: [given],
        myRestriction: {
          summary:
            'You can see: Tax return documents for Ahmed, the collection “For the accountant” and your own.',
          people: [],
          types: [],
          collections: [{ id: 'collection-g', name: 'For the accountant' }],
          include_adults_only: false,
          include_no_person_docs: false,
          expires_at: null,
        },
      },
      'viewer',
    );
    expect(
      await screen.findByText(
        'You can see: Tax return documents for Ahmed, the collection “For the accountant” and your own.',
      ),
    ).toBeInTheDocument();
    const collections = await screen.findByRole('region', { name: 'Collections' });
    expect(within(collections).getByRole('link', { name: /For the accountant/ })).toHaveAttribute(
      'href',
      '/collections/collection-g',
    );
    // A viewer makes none: no tile to start one.
    expect(within(collections).queryByText('Make a collection')).toBeNull();
    await expectAccessible();
    cleanup();
    // None given: no Collections at all.
    at('/', { members: [{ ...ME, role: 'viewer' }], collections: [] }, 'viewer');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.queryByRole('region', { name: 'Collections' })).toBeNull();
  });

  it('putting a document in a collection says which viewer will now see it', async () => {
    at('/documents/doc-1', {
      collections: [
        {
          id: 'collection-g',
          name: 'For the accountant',
          description: null,
          audience: 'everyone',
          owner_member_id: 'me',
          etag: '"g.1"',
          items: [],
        },
      ],
      collectionWarnings: ['Val (viewer) will be able to see this.'],
    });
    const region = await screen.findByRole('region', { name: 'Collections' });
    fireEvent.click(within(region).getByRole('button', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', {
      name: "Add “Mansoor's passport” to a collection",
    });
    fireEvent.click(
      await within(sheet).findByRole('button', { name: 'Add to “For the accountant”' }),
    );
    expect(
      await within(sheet).findByText(
        "“Mansoor's passport” is in “For the accountant” now. Val (viewer) will be able to see this.",
      ),
    ).toBeInTheDocument();
  });
});
