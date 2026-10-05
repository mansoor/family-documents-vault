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
  type FakeState,
} from './test-api.js';

/**
 * Someone outside the family, on the web (5.34): the invitation asks first
 * whether the person is family, and offers a link or a request before a
 * sign-in; a guest's invitation; the owners' list of the people outside the
 * family, renewed with a passkey or a code; and a guest's own Home, which
 * says when their access ends.
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
    expect(screen.getByText(/^Their access ends /)).toBeInTheDocument();
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
    expect(said).toBeInTheDocument();
    expect(state.renewals).toHaveLength(1);
    expect(state.renewals?.[0]?.access_expires_at.slice(0, 10)).toBe(later);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Renew their access' })).toHaveFocus(),
    );
    await expectAccessible();

    // What they can see: changed, never taken off — a guest is always limited.
    fireEvent.click(screen.getByRole('button', { name: 'What they can see' }));
    const limits = await screen.findByRole('region', { name: 'What they can see' });
    expect(within(limits).getByText("Restricted: sees 1 person's documents.")).toBeInTheDocument();
    expect(
      within(limits).getByRole('button', { name: 'Change what they can see' }),
    ).toBeInTheDocument();
    expect(within(limits).queryByRole('button', { name: 'Take the limits off' })).toBeNull();
    await expectAccessible();
  });

  it("an ended guest's access says so, and nobody but an owner is offered the list", async () => {
    at('/settings/guests', {
      members: [ME],
      guests: [{ ...JANE, access_expires_at: new Date(Date.now() - DAY).toISOString() }],
    });
    expect(
      await screen.findByText(/^Their access ended .+\. Renew it to let them back in\.$/),
    ).toBeInTheDocument();
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
    ).toBeInTheDocument();
    await expectAccessible();
  });
});
