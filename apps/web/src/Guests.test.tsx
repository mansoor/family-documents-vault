import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { holdAccountLinkToken } from './link-token.js';
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
 * Someone outside the family, on the web (5.34): the invitation asks first
 * whether the person is family, and offers a link or a request before a
 * sign-in; a guest's invitation; the owners' list of the people outside the
 * family, renewed with a passkey or a code; and a guest's own Home, which
 * says when their access ends. And the 5.34 review: what an owner does with
 * a guest's sign-in, two guests' limits open at once, one prompt for an
 * owner's guest invitation, focus, the year, and the Join page for a guest.
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

const HERS = { ...PASSPORT, id: 'doc-a', title: 'Aisha’s passport', owner_member_id: 'm-0' };
const DAY = 24 * 60 * 60 * 1000;
const JANE = {
  id: 'g-1',
  display_name: 'Jane Smith',
  relationship: 'attorney',
  kind: 'guest',
  role: 'viewer',
  has_account: true,
  is_me: false,
  is_deceased: false,
  colour: 3,
  document_count: 0,
  access_expires_at: new Date(Date.now() + 10 * DAY).toISOString(),
  restriction: { summary: "Restricted: sees 1 person's documents." },
};

/** A guest's account card, as the owner reads it: limited to `people`. */
function cardOf(id: string, end: string, people: string[]) {
  return {
    member_id: id,
    role: 'viewer' as const,
    email: `${id}@example.test`,
    two_step: false,
    passkeys: 0,
    last_signed_in_at: null,
    devices: [],
    suspension: null,
    max_offline_days: 90,
    kind: 'guest' as const,
    access_expires_at: end,
    access: {
      member_id: id,
      people,
      types: people.length ? [] : ['tax_return'],
      collections: [],
      include_adults_only: false,
      include_no_person_docs: false,
      expires_at: null,
      limits_people: people.length > 0,
      limits_types: people.length === 0,
      summary: people.length
        ? "Restricted: sees 1 person's documents."
        : 'Restricted: sees 1 kind of document.',
      reconfirm_since: null,
      private_confirmed: false,
      updated_at: new Date().toISOString(),
    },
  };
}

/** "Friday 4 December 2026 at 23:59": a guest's end always says its year (W534-05). */
const WITH_YEAR = /\w+ \d{1,2} \w+ \d{4} at \d{2}:\d{2}/;

function at(path: string, over: Partial<FakeState>, role: 'owner' | 'adult' | 'viewer' = 'owner') {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const posted = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/invitations').at(-1)?.body as
    Record<string, unknown> | undefined;

describe('someone outside the family (5.34)', () => {
  it('the invitation asks first whether they are family, and offers a link or a request before a sign-in', async () => {
    const state = at('/people', {
      members: [ME, AISHA],
      documents: [HERS],
      guests: [],
      collections: [],
      incoming: [],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Invite someone to sign in' }));
    const asked = screen.getByRole('group', { name: 'Is this person family?' });
    // Nothing else until it is answered.
    expect(screen.queryByLabelText('Their email address')).toBeNull();
    fireEvent.click(within(asked).getByRole('button', { name: 'No, from outside' }));
    const outside = screen.getByRole('region', { name: 'Someone outside the family' });
    expect(
      within(outside).getByRole('link', { name: /Share a collection instead/ }),
    ).toHaveAttribute('href', '/collections');
    expect(
      within(outside).getByRole('link', { name: /Ask them to send documents/ }),
    ).toHaveAttribute('href', '/settings/sharing/ask');
    await expectAccessible();
    // Family after all: the invitation as ever.
    fireEvent.click(within(asked).getByRole('button', { name: 'Yes, family' }));
    expect(screen.getByLabelText('Their email address')).toBeInTheDocument();
    fireEvent.click(within(asked).getByRole('button', { name: 'No, from outside' }));

    // A sign-in, last: a guest's invitation.
    fireEvent.click(screen.getByRole('button', { name: /Give them a sign-in/ }));
    const heading = await screen.findByRole('heading', {
      name: 'Give someone outside the family a sign-in',
    });
    await waitFor(() => expect(heading).toHaveFocus());
    fireEvent.change(screen.getByLabelText('Their name'), { target: { value: 'Jane Smith' } });
    fireEvent.change(screen.getByLabelText('What they are to the family (optional)'), {
      target: { value: 'attorney' },
    });
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'jane@example.test' },
    });
    const ends = screen.getByLabelText('Their access ends');
    expect((ends as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The limits have no end of their own: the sign-in's is the one.
    expect(screen.queryByLabelText('Until (optional)')).toBeNull();
    const limits = screen.getByRole('region', { name: 'What they can see' });
    fireEvent.click(await within(limits).findByLabelText('Aisha'));
    expect(await within(limits).findByText('They will see 1 document.')).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Jane Smith' });
    expect(posted(state)).toMatchObject({
      display_name: 'Jane Smith',
      relationship: 'attorney',
      email: 'jane@example.test',
      role: 'viewer',
      kind: 'guest',
      restriction: { people: ['m-0'], include_adults_only: false },
      access_expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
    });
    const end = Date.parse(posted(state)?.access_expires_at as string);
    expect(end).toBeGreaterThan(Date.now() + 80 * DAY);
    expect(end).toBeLessThan(Date.now() + 100 * DAY);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/Guest, from outside the family ·/)).toBeInTheDocument();
  });

  it('an adult gives a guest only what they can, never Adults only documents', async () => {
    const state = at(
      '/people',
      { members: [{ ...ME, role: 'adult' }, AISHA], documents: [HERS], guests: [] },
      'adult',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Invite someone to sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'No, from outside' }));
    fireEvent.click(screen.getByRole('button', { name: /Give them a sign-in/ }));
    await screen.findByRole('heading', { name: 'Give someone outside the family a sign-in' });
    expect(screen.queryByLabelText('Adults only documents too')).toBeNull();
    expect(screen.getByText(/Only an owner can give Adults only documents/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Their name'), { target: { value: 'Ann' } });
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'ann@example.test' },
    });
    fireEvent.click(await screen.findByLabelText('Aisha'));
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Ann' });
    expect(posted(state)).toMatchObject({
      kind: 'guest',
      restriction: { include_adults_only: false },
    });
  });

  it('owners see the people outside the family apart, with their limits and end, and renew one with a code', async () => {
    const state = at('/settings', {
      members: [ME, AISHA],
      guests: [JANE],
      accountStepUp: true,
      accounts: {
        'g-1': {
          member_id: 'g-1',
          role: 'viewer',
          email: 'jane@example.test',
          two_step: false,
          passkeys: 0,
          last_signed_in_at: null,
          devices: [],
          suspension: null,
          max_offline_days: 90,
          kind: 'guest',
          access_expires_at: JANE.access_expires_at,
          access: {
            member_id: 'g-1',
            people: ['m-0'],
            types: [],
            collections: [],
            include_adults_only: false,
            include_no_person_docs: false,
            expires_at: null,
            limits_people: true,
            limits_types: false,
            summary: "Restricted: sees 1 person's documents.",
            reconfirm_since: null,
            private_confirmed: false,
            updated_at: new Date().toISOString(),
          },
        },
      },
    });
    fireEvent.click(await screen.findByRole('link', { name: /People outside the family/ }));
    await screen.findByRole('heading', { name: 'People outside the family' });
    expect(await screen.findByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('· attorney')).toBeInTheDocument();
    expect(screen.getByText("Restricted: sees 1 person's documents.")).toBeInTheDocument();
    expect(screen.getByText(/^Their access ends /)).toHaveTextContent(WITH_YEAR);
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Renew their access' }));
    const field = screen.getByLabelText('Jane Smith’s access ends');
    await waitFor(() => expect(field).toHaveFocus());
    const later = new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10);
    fireEvent.change(field, { target: { value: later } });
    fireEvent.click(screen.getByRole('button', { name: 'Renew' }));
    // A passkey or a code, never the password (A54).
    const ask = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(within(ask).queryByLabelText(/password/i)).not.toBeInTheDocument();
    fireEvent.change(within(ask).getByLabelText('Code from your authenticator app'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Confirm' }));
    const said = await screen.findByText(/^Jane Smith’s access now ends /);
    expect(said).toHaveTextContent(WITH_YEAR);
    expect(said).toHaveTextContent(new RegExp(` ${later.slice(0, 4)} at 23:59\\.$`));
    expect(state.renewals).toHaveLength(1);
    expect(state.renewals?.[0]?.access_expires_at.slice(0, 10)).toBe(later);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Renew their access' })).toHaveFocus(),
    );
    await expectAccessible();

    // What they can see: changed, never taken off — a guest is always limited.
    // Focus goes to it as it opens (W534-04).
    fireEvent.click(screen.getByRole('button', { name: 'What they can see' }));
    const limits = await screen.findByRole('region', { name: 'What Jane Smith can see' });
    await waitFor(() =>
      expect(
        within(limits).getByRole('heading', { name: 'What Jane Smith can see' }),
      ).toHaveFocus(),
    );
    expect(within(limits).getByText("Restricted: sees 1 person's documents.")).toBeInTheDocument();
    expect(within(limits).queryByRole('button', { name: 'Take the limits off' })).toBeNull();
    await expectAccessible();
    fireEvent.click(within(limits).getByRole('button', { name: 'Change what they can see' }));
    // The sign-in's end is a guest's only one: the limits offer none (W534-06).
    await within(limits).findByRole('heading', { name: 'Choose what Jane Smith can see' });
    expect(within(limits).queryByLabelText(/Until/)).toBeNull();
    fireEvent.click(within(limits).getByRole('button', { name: 'Save these limits' }));
    // Saved: focus to what is said, not lost (W534-04).
    const saved = await screen.findByText(/^Jane Smith’s limits are saved\./);
    await waitFor(() => expect(saved).toHaveFocus());
    expect(state.accessWrites?.map((w) => w.id)).toEqual(['g-1']);
    // Closed, focus back to the button that opened it.
    fireEvent.click(screen.getByRole('button', { name: 'Close what they can see' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'What they can see' })).toHaveFocus(),
    );
  });

  it("two guests' limits open at once each change their own guest (W534-01)", async () => {
    const end = new Date(Date.now() + 10 * DAY).toISOString();
    const KIM = {
      ...JANE,
      id: 'g-2',
      display_name: 'Kim Lee',
      relationship: 'accountant',
      restriction: { summary: 'Restricted: sees 1 kind of document.' },
    };
    const state = at('/settings/guests', {
      members: [ME, AISHA],
      guests: [JANE, KIM],
      accounts: { 'g-1': cardOf('g-1', end, ['m-0']), 'g-2': cardOf('g-2', end, []) },
    });
    await screen.findByText('Kim Lee');
    const [first] = screen.getAllByRole('button', { name: 'What they can see' });
    fireEvent.click(first as HTMLElement);
    const jane = await screen.findByRole('region', { name: 'What Jane Smith can see' });
    fireEvent.click(screen.getByRole('button', { name: 'What they can see' }));
    const kim = await screen.findByRole('region', { name: 'What Kim Lee can see' });
    fireEvent.click(within(jane).getByRole('button', { name: 'Change what they can see' }));
    fireEvent.click(within(kim).getByRole('button', { name: 'Change what they can see' }));
    const janes = await within(jane).findByRole('checkbox', { name: 'Aisha' });
    const kims = await within(kim).findByRole('checkbox', { name: 'Aisha' });
    expect(janes).toBeChecked();
    expect(kims).not.toBeChecked();
    // Kim's label changes Kim's box, and Jane's is as it was.
    fireEvent.click(within(kim).getByText('Aisha'));
    expect(kims).toBeChecked();
    expect(janes).toBeChecked();
    fireEvent.click(within(kim).getByText('Adults only documents too'));
    expect(within(kim).getByRole('checkbox', { name: 'Adults only documents too' })).toBeChecked();
    expect(
      within(jane).getByRole('checkbox', { name: 'Adults only documents too' }),
    ).not.toBeChecked();
    await expectAccessible();
    fireEvent.click(within(kim).getByRole('button', { name: 'Save these limits' }));
    await screen.findByText(/^Kim Lee’s limits are saved\./);
    expect(state.accessWrites).toEqual([
      {
        id: 'g-2',
        method: 'PUT',
        body: expect.objectContaining({ people: ['m-0'], include_adults_only: true }) as unknown,
      },
    ]);
  });

  it("an owner's guest invitation asks once, for a code, when both step-ups are due (W534-02)", async () => {
    const state = at('/people', {
      members: [ME, AISHA],
      documents: [HERS],
      guests: [],
      stepUpNeeded: true,
      accountStepUp: true,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Invite someone to sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'No, from outside' }));
    fireEvent.click(screen.getByRole('button', { name: /Give them a sign-in/ }));
    await screen.findByRole('heading', { name: 'Give someone outside the family a sign-in' });
    fireEvent.change(screen.getByLabelText('Their name'), { target: { value: 'Jane Smith' } });
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'jane@example.test' },
    });
    fireEvent.click(await screen.findByLabelText('Aisha'));
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    // The owner's decision first: a code, never the password.
    const ask = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(within(ask).queryByLabelText(/password/i)).not.toBeInTheDocument();
    fireEvent.change(within(ask).getByLabelText('Code from your authenticator app'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Confirm' }));
    // That one confirmation covers the invitation: made, nothing refused.
    await screen.findByRole('heading', { name: 'Send these to Jane Smith' });
    expect(
      state.calls.filter((c) => c.url === '/api/v1/auth/step-up' && c.method === 'POST'),
    ).toHaveLength(1);
    expect(screen.queryByText(/Please confirm it is you/)).toBeNull();
  });

  it("an owner takes a guest's sign-in away, gives it back until a day, signs them out, corrects them, and removes who never signed in (W534-03)", async () => {
    const end = new Date(Date.now() + 10 * DAY).toISOString();
    const REX = {
      ...JANE,
      id: 'g-2',
      display_name: 'Rex Ray',
      relationship: null,
      has_account: false,
      role: null,
      sign_in_removed: true,
      access_expires_at: null,
      version: 4,
    };
    const NED = {
      ...REX,
      id: 'g-3',
      display_name: 'Ned Nolan',
      sign_in_removed: false,
    };
    const PAT = { ...NED, id: 'g-4', display_name: 'Pat Price' };
    const state = at('/settings/guests', {
      members: [ME, AISHA],
      guests: [JANE, REX, NED, PAT],
      accountStepUp: true,
      accounts: { 'g-1': cardOf('g-1', end, ['m-0']) },
      invitations: [
        {
          id: 'inv-pat',
          member_id: 'g-4',
          display_name: 'Pat Price',
          email: 'pat@example.test',
          role: 'viewer',
          kind: 'guest',
          access_expires_at: end,
          invited_by: 'Mansoor Seikh',
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
          state: 'pending',
          attempts_left: 5,
        },
      ],
    });
    const row = async (name: string) =>
      (await screen.findByRole('heading', { name: new RegExp(`^${name}`) })).closest(
        'li',
      ) as HTMLElement;
    await screen.findByText('Jane Smith');
    // Who never signed in may be removed; anybody who has had a sign-in may not.
    expect(within(await row('Rex Ray')).queryByRole('button', { name: 'Remove them' })).toBeNull();
    expect(
      within(await row('Jane Smith')).queryByRole('button', { name: 'Remove them' }),
    ).toBeNull();
    expect(within(await row('Rex Ray')).getByText(/^Their sign-in was taken away/)).toBeVisible();
    await expectAccessible();

    // Taken away, once asked.
    fireEvent.click(
      within(await row('Jane Smith')).getByRole('button', { name: 'Take their sign-in away' }),
    );
    const away = await screen.findByRole('alertdialog', {
      name: 'Take Jane Smith’s sign-in away?',
    });
    fireEvent.click(within(away).getByRole('button', { name: 'Take it away' }));
    const taken = await screen.findByText(/^Jane Smith’s sign-in is taken away\./);
    await waitFor(() => expect(taken).toHaveFocus());
    expect(
      state.calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/members/g-1/sign-in'),
    ).toBe(true);

    // Given back, until a day: a passkey or a code, as renewing is.
    fireEvent.click(
      await within(await row('Jane Smith')).findByRole('button', {
        name: 'Give their sign-in back',
      }),
    );
    const field = screen.getByLabelText('Jane Smith’s access ends');
    await waitFor(() => expect(field).toHaveFocus());
    const later = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    fireEvent.change(field, { target: { value: later } });
    fireEvent.click(screen.getByRole('button', { name: 'Give it back' }));
    const ask = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(within(ask).queryByLabelText(/password/i)).not.toBeInTheDocument();
    fireEvent.change(within(ask).getByLabelText('Code from your authenticator app'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Confirm' }));
    const back = await screen.findByText(/^Jane Smith can sign in again, until /);
    expect(back).toHaveTextContent(WITH_YEAR);
    await waitFor(() => expect(back).toHaveFocus());
    const given = state.calls.filter(
      (c) => c.method === 'POST' && c.url === '/api/v1/members/g-1/sign-in',
    );
    expect(given.at(-1)?.body).toMatchObject({ role: 'viewer' });
    expect(
      (given.at(-1)?.body as { access_expires_at: string }).access_expires_at.slice(0, 10),
    ).toBe(later);

    // Signed out everywhere, once asked; the sign-in stays.
    fireEvent.click(
      await within(await row('Jane Smith')).findByRole('button', {
        name: 'Sign them out everywhere',
      }),
    );
    const out = await screen.findByRole('alertdialog', { name: 'Sign Jane Smith out everywhere?' });
    fireEvent.click(within(out).getByRole('button', { name: 'Sign them out' }));
    const signedOut = await screen.findByText(/^Jane Smith is signed out everywhere\./);
    await waitFor(() => expect(signedOut).toHaveFocus());
    expect(state.signedOut).toEqual(['g-1']);

    // Corrected: their name and what they are to the family.
    const edit = within(await row('Rex Ray')).getByRole('button', { name: 'Change their details' });
    fireEvent.click(edit);
    const name = screen.getByLabelText('Their name');
    await waitFor(() => expect(name).toHaveFocus());
    fireEvent.change(name, { target: { value: 'Rex Rayner' } });
    fireEvent.change(screen.getByLabelText('What they are to the family (optional)'), {
      target: { value: 'accountant' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Rex Rayner’s details are saved.');
    expect(state.memberEdits?.at(-1)).toEqual({
      id: 'g-2',
      body: { display_name: 'Rex Rayner', relationship: 'accountant' },
      ifMatch: '"4"',
    });
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('heading', { name: /^Rex Rayner/ }).closest('li') as HTMLElement,
        ).getByRole('button', { name: 'Change their details' }),
      ).toHaveFocus(),
    );

    // Removed: who never signed in.
    fireEvent.click(within(await row('Ned Nolan')).getByRole('button', { name: 'Remove them' }));
    const remove = await screen.findByRole('alertdialog', { name: 'Remove Ned Nolan?' });
    fireEvent.click(within(remove).getByRole('button', { name: 'Remove them' }));
    const gone = await screen.findByText('Ned Nolan is removed.');
    await waitFor(() => expect(gone).toHaveFocus());
    expect(state.calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/members/g-3')).toBe(
      true,
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ned Nolan' })).toBeNull());

    // An invitation not accepted: cancelled, and the guest with it.
    const waiting = screen.getByRole('region', { name: 'Invited, not yet accepted' });
    expect(within(waiting).getByText(/pat@example\.test · until /)).toHaveTextContent(WITH_YEAR);
    fireEvent.click(within(waiting).getByRole('button', { name: 'Cancel and remove' }));
    const cancel = await screen.findByRole('alertdialog', {
      name: 'Cancel Pat Price’s invitation?',
    });
    await expectAccessible();
    fireEvent.click(within(cancel).getByRole('button', { name: 'Cancel it and remove them' }));
    const cancelled = await screen.findByText(
      'Pat Price’s invitation is cancelled, and they are removed.',
    );
    await waitFor(() => expect(cancelled).toHaveFocus());
    expect(state.calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/members/g-4')).toBe(
      true,
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Invited, not yet accepted' })).toBeNull(),
    );
    await expectAccessible();
  });

  it("an ended guest's access says so, and nobody but an owner is offered the list", async () => {
    at('/settings/guests', {
      members: [ME],
      guests: [{ ...JANE, access_expires_at: new Date(Date.now() - DAY).toISOString() }],
    });
    expect(
      await screen.findByText(/^Their access ended .+\. Renew it to let them back in\.$/),
    ).toHaveTextContent(WITH_YEAR);
    cleanup();
    at('/settings', { members: [{ ...ME, role: 'adult' }], guests: [] }, 'adult');
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('link', { name: /People outside the family/ })).toBeNull();
  });

  it("a guest's Home says what they can see, and when their access ends", async () => {
    at(
      '/',
      {
        members: [{ ...ME, role: 'viewer', kind: 'guest' }],
        myKind: 'guest',
        myAccessEnd: new Date(Date.now() + 30 * DAY).toISOString(),
        myRestriction: {
          summary: 'You can see: Tax return documents for Ahmed.',
          people: [],
          types: [],
          collections: [],
          include_adults_only: false,
          include_no_person_docs: false,
          expires_at: null,
        },
      },
      'viewer',
    );
    expect(
      await screen.findByText(
        /^You can see: Tax return documents for Ahmed\. Your access to this vault ends .+\.$/,
      ),
    ).toHaveTextContent(WITH_YEAR);
    await expectAccessible();
  });

  it("a guest's invitation says they are a guest and until when, and promises nothing of their own (W534-07)", async () => {
    const end = new Date(Date.now() + 30 * DAY).toISOString();
    const preview = {
      kind: 'guest',
      access_expires_at: end,
      role: 'viewer',
      role_label: 'Viewer',
      display_name: 'Jane Smith',
    };
    installFakeApi(fresh({ invitationPreview: preview }));
    window.history.replaceState({}, '', '/join#link-secret-0123456789abcdef');
    holdAccountLinkToken();
    render(<App />);
    await screen.findByRole('heading', { name: 'A guest’s sign-in to The Seikh family' });
    expect(screen.getByText(/a guest from outside the family\./)).toBeInTheDocument();
    expect(
      screen.getByText(/^You will see only what they choose to give you, until /),
    ).toHaveTextContent(WITH_YEAR);
    // Nothing of their own, and nothing said of the family's members.
    expect(screen.queryByText(/private documents/)).toBeNull();
    expect(screen.queryByText(/Can open and download/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join the family vault' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Accept the invitation' })).toBeInTheDocument();
    await expectAccessible();
    cleanup();

    // Ended already: said before anything is typed, and nothing to type.
    installFakeApi(
      fresh({
        invitationPreview: {
          ...preview,
          access_expires_at: new Date(Date.now() - DAY).toISOString(),
        },
      }),
    );
    window.history.replaceState({}, '', '/join#link-secret-0123456789abcdef');
    holdAccountLinkToken();
    render(<App />);
    expect(await screen.findByText(/^The access this invitation gives ended /)).toHaveTextContent(
      WITH_YEAR,
    );
    expect(screen.queryByLabelText('Choose a password')).toBeNull();
    await expectAccessible();
  });
});
