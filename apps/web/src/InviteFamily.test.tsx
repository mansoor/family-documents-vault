import { localToday, UNDER_13_NOTE } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { WHO_NOTE } from './screens/Invite.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * Inviting family members to sign up (after 0.7.0): as somebody is added
 * (People and the first-run wizard), from their page, and on Invite's "Who
 * is it for?"; and the owners' reminder on Home that somebody has turned
 * 13. Ages are worked out on the household's calendar, UTC here.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const TODAY = localToday('UTC');
/** A date of birth `years` before today (the 28th for a 29 February). */
function born(years: number): string {
  const [y, m, d] = TODAY.split('-').map(Number) as [number, number, number];
  const day = Math.min(d, new Date(Date.UTC(y - years, m, 0)).getUTCDate());
  return `${y - years}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const person = (id: string, display_name: string, over: Record<string, unknown> = {}) => ({
  ...AISHA,
  id,
  display_name,
  colour: 2,
  ...over,
});
const TEEN = person('m-teen', 'Tom', { date_of_birth: born(15) });
const GROWN = person('m-grown', 'Gita', { date_of_birth: born(30) });
const NO_DOB = person('m-nodob', 'Nadia', { date_of_birth: null });
const INVITED = person('m-invited', 'Ian', { date_of_birth: born(20) });
const SIGNED = person('m-signed', 'Sam', {
  date_of_birth: born(40),
  has_account: true,
  role: 'adult',
});
const TAKEN = person('m-taken', 'Tara', { date_of_birth: born(25), sign_in_removed: true });
const LATE = person('m-late', 'Grandad', { date_of_birth: born(90), is_deceased: true });
const PENDING = {
  id: 'inv-ian',
  member_id: 'm-invited',
  display_name: 'Ian',
  email: 'ian@example.test',
  role: 'adult',
  invited_by: 'Mansoor Seikh',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 5 * 864e5).toISOString(),
  state: 'pending',
  attempts_left: 5,
  limited: false,
  kind: 'family',
  access_expires_at: null,
};
const FAMILY = [ME, AISHA, TEEN, GROWN, NO_DOB, INVITED, SIGNED, TAKEN, LATE];

function at(
  path: string,
  over: Partial<FakeState>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const posted = (state: FakeState, url: string) =>
  state.calls.filter((c) => c.method === 'POST' && c.url === url);

describe('adding a person, with an invitation (after 0.7.0)', () => {
  it('offers it at 13 and over, unticked; ticked, saving them makes the invitation for them and shows the link once', async () => {
    const state = at('/people', { members: [ME, AISHA], invitations: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Zara' },
    });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(15) } });
    const box = await screen.findByRole('checkbox', { name: 'Invite them to sign up now' });
    expect(box).not.toBeChecked();
    expect(screen.queryByLabelText('Their email address')).toBeNull();
    fireEvent.click(box);
    expect(box).toBeChecked();
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'zara@example.test' },
    });
    // At 15, a teen's sign-in and nothing else.
    const roles = screen.getByRole('group', { name: 'What they can do' });
    expect(
      within(roles)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Teen']);
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const heading = await screen.findByRole('heading', { name: 'Send these to Zara' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(posted(state, '/api/v1/members').at(-1)?.body).toMatchObject({
      display_name: 'Zara',
      date_of_birth: born(15),
    });
    const added = state.members.find((m) => m.display_name === 'Zara') as { id: string };
    expect(posted(state, '/api/v1/invitations')).toHaveLength(1);
    expect(posted(state, '/api/v1/invitations')[0]?.body).toEqual({
      member_id: added.id,
      email: 'zara@example.test',
      role: 'teen',
    });
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();
    // Offered by email from their own mail: the link, never the code.
    const mail = screen.getByRole('link', { name: 'Email the link' });
    const href = decodeURIComponent(mail.getAttribute('href') ?? '');
    expect(href).toMatch(/^mailto:zara@example\.test\?/);
    expect(href).toContain('/join#link-secret-0123456789abcdef');
    expect(href).not.toContain('ABCD-EFGH');
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/Teen · zara@example\.test/)).toBeInTheDocument();
  });

  it('left unticked, saving them invites nobody', async () => {
    const state = at('/people', { members: [ME], invitations: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Omar' },
    });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(40) } });
    expect(screen.getByRole('checkbox', { name: 'Invite them to sign up now' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('button', { name: 'Add someone' });
    expect(posted(state, '/api/v1/members')).toHaveLength(1);
    expect(posted(state, '/api/v1/invitations')).toHaveLength(0);
  });

  it('under 13, a note instead: no box, no address', async () => {
    at('/people', { members: [ME], invitations: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(12) } });
    expect(await screen.findByText(UNDER_13_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Invite them to sign up now' })).toBeNull();
    expect(screen.queryByLabelText('Their email address')).toBeNull();
    await expectAccessible();
    // Thirteen today: the box.
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(13) } });
    expect(screen.queryByText(UNDER_13_NOTE)).toBeNull();
    expect(
      screen.getByRole('checkbox', { name: 'Invite them to sign up now' }),
    ).toBeInTheDocument();
  });

  it('with no date of birth, offered for someone 13 or over, with every role the inviter may give', async () => {
    at('/people', { members: [ME], invitations: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    const box = await screen.findByRole('checkbox', { name: 'Invite them to sign up now' });
    expect(box).toHaveAccessibleDescription(/for someone 13 or over/);
    fireEvent.click(box);
    const roles = screen.getByRole('group', { name: 'What they can do' });
    expect(
      within(roles)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Owner', 'Adult', 'Teen', 'Viewer']);
  });

  it('an adult gives an 18-year-old only a viewer’s sign-in, limited to what they choose (5.33)', async () => {
    const state = at(
      '/people',
      { members: [{ ...ME, role: 'adult' }, AISHA], invitations: [], documents: [] },
      'adult',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Rafi' },
    });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(18) } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Invite them to sign up now' }));
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'rafi@example.test' },
    });
    const roles = screen.getByRole('group', { name: 'What they can do' });
    expect(
      within(roles)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Viewer']);
    expect(
      screen.getByText(/Only an owner can invite a viewer who sees every/),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByLabelText('Aisha'));
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('heading', { name: 'Send these to Rafi' });
    expect(posted(state, '/api/v1/invitations')[0]?.body).toMatchObject({
      role: 'viewer',
      restriction: { people: ['m-0'], include_adults_only: false },
    });
  });

  it('ticked with no address, nothing is saved, and it says what is missing', async () => {
    const state = at('/people', { members: [ME], invitations: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Pia' },
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Invite them to sign up now' }));
    fireEvent.submit(
      screen.getByRole('button', { name: 'Add' }).closest('form') as HTMLFormElement,
    );
    expect(await screen.findByText(/Give their email address, or untick/)).toBeInTheDocument();
    expect(posted(state, '/api/v1/members')).toHaveLength(0);
  });

  it('the first-run wizard offers it too, and shows the link before the next person', async () => {
    const state = fresh({ setupRequired: true, members: [] });
    installFakeApi(state);
    render(<App />);
    await screen.findByRole('heading', { name: /Set up your family/ });
    fireEvent.change(screen.getByLabelText(/call your family/), { target: { value: 'Khans' } });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mansoor' } });
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'm@example.test' } });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create my vault' }));
    await screen.findByRole('heading', { name: 'A few quick questions' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await screen.findByRole('heading', { name: 'Who is in the family?' });
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Hana' },
    });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(10) } });
    expect(await screen.findByText(UNDER_13_NOTE)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(16) } });
    const box = screen.getByRole('checkbox', { name: 'Invite them to sign up now' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'hana@example.test' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const heading = await screen.findByRole('heading', { name: 'Send these to Hana' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(posted(state, '/api/v1/invitations')[0]?.body).toMatchObject({
      email: 'hana@example.test',
      role: 'teen',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByLabelText('Name of another family member')).toHaveValue('');
  });
});

describe('“Invite to sign up”, on a profile (after 0.7.0)', () => {
  it('for somebody 13 or over with no sign-in: the invitation’s card with them fixed, then the link once', async () => {
    const state = at('/people/m-teen', { members: FAMILY, invitations: [PENDING] });
    const open = await screen.findByRole('button', { name: 'Invite to sign up' });
    await expectAccessible();
    fireEvent.click(open);
    const heading = await screen.findByRole('heading', { name: 'Invite Tom to sign up' });
    await waitFor(() => expect(heading).toHaveFocus());
    // The person is fixed: nobody is asked who, nor their name.
    expect(screen.queryByLabelText('Who is it for?')).toBeNull();
    expect(screen.queryByLabelText('Their name')).toBeNull();
    const roles = screen.getByRole('group', { name: 'What they can do' });
    expect(
      within(roles)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Teen']);
    await expectAccessible();
    // Cancelled, back on the button that opened it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Invite to sign up' })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Invite to sign up' }));
    fireEvent.change(await screen.findByLabelText('Their email address'), {
      target: { value: 'tom@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Tom' });
    expect(posted(state, '/api/v1/invitations').at(-1)?.body).toEqual({
      member_id: 'm-teen',
      email: 'tom@example.test',
      role: 'teen',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const said = await screen.findByText('Tom is invited. They can sign in once they accept.');
    await waitFor(() => expect(said).toHaveFocus());
    // Invited now: no second invitation offered.
    expect(screen.queryByRole('button', { name: 'Invite to sign up' })).toBeNull();
  });

  it('is not offered under 13, to somebody invited, signed in, given back, passed away, or by a teen', async () => {
    for (const id of ['m-0', 'm-invited', 'm-signed', 'm-taken', 'm-late']) {
      at(`/people/${id}`, { members: FAMILY, invitations: [PENDING] });
      await screen.findByRole('heading', { name: /’s documents$/ });
      expect(screen.queryByRole('button', { name: 'Invite to sign up' })).toBeNull();
      cleanup();
      localStorage.clear();
    }
    at('/people/m-teen', { members: FAMILY, invitations: [] }, 'teen');
    await screen.findByRole('heading', { name: /’s documents$/ });
    expect(screen.queryByRole('button', { name: 'Invite to sign up' })).toBeNull();
  });

  it('for an adult, somebody grown is offered a viewer’s sign-in, limited (5.33)', async () => {
    const state = at(
      '/people/m-grown',
      {
        members: FAMILY.map((m) => (m.id === 'me' ? { ...ME, role: 'adult' } : m)),
        invitations: [],
      },
      'adult',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Invite to sign up' }));
    const roles = await screen.findByRole('group', { name: 'What they can do' });
    expect(
      within(roles)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Viewer']);
    const limits = screen.getByRole('region', { name: 'Limit what they can see' });
    fireEvent.click(await within(limits).findByLabelText('Aisha'));
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'gita@example.test' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Gita' });
    expect(posted(state, '/api/v1/invitations').at(-1)?.body).toMatchObject({
      member_id: 'm-grown',
      role: 'viewer',
      restriction: { people: ['m-0'], include_adults_only: false },
    });
  });
});

describe('Invite → Family → “Who is it for?” (after 0.7.0)', () => {
  it('lists exactly the family with no sign-in and no invitation waiting, 13 or over or of no known age, and says who is not', async () => {
    // Family or not is asked first, where the vault has guests (5.34).
    const state = at('/people', { members: FAMILY, invitations: [PENDING], guests: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Invite someone to sign in' }));
    expect(screen.queryByLabelText('Who is it for?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, family' }));
    // The people come with the invitations; under load the list can be
    // asked for before they are in.
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Who is it for?'))
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Someone new', 'Tom', 'Gita', 'Nadia']),
    );
    const who = screen.getByLabelText('Who is it for?');
    expect(who).toHaveValue('new');
    expect(who).toHaveAccessibleDescription(WHO_NOTE);
    // Somebody new: today's flow, with their name.
    expect(screen.getByLabelText('Their name')).toBeInTheDocument();
    await expectAccessible();
    // Tom, 15: no name to type, and a teen's sign-in.
    fireEvent.change(who, { target: { value: 'm-teen' } });
    expect(screen.queryByLabelText('Their name')).toBeNull();
    const roles = screen.getByRole('group', { name: 'What they can do' });
    expect(
      within(roles)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Teen']);
    // Gita, 30: an owner's roles, a teen's not among them.
    fireEvent.change(who, { target: { value: 'm-grown' } });
    expect(
      within(screen.getByRole('group', { name: 'What they can do' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Owner', 'Adult', 'Viewer']);
    fireEvent.click(screen.getByRole('button', { name: 'Viewer' }));
    // A viewer's limits, chosen now (5.33): an owner may let them see everything.
    expect(screen.getByRole('checkbox', { name: 'Only what I choose' })).toBeChecked();
    fireEvent.click(await screen.findByLabelText('Aisha'));
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'gita@example.test' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Gita' });
    expect(posted(state, '/api/v1/invitations').at(-1)?.body).toMatchObject({
      member_id: 'm-grown',
      email: 'gita@example.test',
      role: 'viewer',
      restriction: { people: ['m-0'] },
    });
    expect(posted(state, '/api/v1/invitations').at(-1)?.body).not.toHaveProperty('display_name');
  });
});

describe('the owners told that somebody turned 13 (after 0.7.0)', () => {
  const SARA = {
    id: 'pr-1',
    kind: 'turned_13',
    member_id: 'm-teen',
    display_name: 'Sara',
    fire_at: TODAY,
    title: 'Sara is 13 today',
    label: 'They can now have their own sign-in.',
  };

  it('in Needs attention, once, with the way to invite them and to dismiss it', async () => {
    const state = at('/', {
      members: FAMILY,
      invitations: [],
      personReminders: [SARA],
    });
    const words = await screen.findByText('Sara is 13 today.');
    const block = words.closest('section') as HTMLElement;
    expect(block).toHaveTextContent('Sara is 13 today. They can now have their own sign-in.');
    expect(screen.getAllByText('Sara is 13 today.')).toHaveLength(1);
    // Not "Everything is fine" beside it.
    expect(screen.queryByText(/Everything is fine/)).toBeNull();
    expect(within(block).getByRole('link', { name: 'Invite Sara to sign up' })).toHaveAttribute(
      'href',
      '/people/m-teen',
    );
    await expectAccessible();
    fireEvent.click(within(block).getByRole('button', { name: 'Dismiss the reminder about Sara' }));
    const said = await screen.findByText('Dismissed. You can still invite Sara from their page.');
    await waitFor(() => expect(said).toHaveFocus());
    expect(posted(state, '/api/v1/reminders/people/pr-1/dismiss')).toHaveLength(1);
    expect(screen.queryByText('Sara is 13 today.')).toBeNull();
  });

  it('its link opens their page at “Invite to sign up”', async () => {
    at('/', { members: FAMILY, invitations: [], personReminders: [SARA] });
    fireEvent.click(await screen.findByRole('link', { name: 'Invite Sara to sign up' }));
    const heading = await screen.findByRole('heading', { name: 'Invite Tom to sign up' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByLabelText('Their email address')).toBeInTheDocument();
  });

  it('is the owners’ alone: an adult’s Home neither asks for it nor shows it', async () => {
    const state = at(
      '/',
      {
        members: FAMILY.map((m) => (m.id === 'me' ? { ...ME, role: 'adult' } : m)),
        invitations: [],
        personReminders: [SARA],
      },
      'adult',
    );
    await screen.findByText(/Everything is fine/);
    expect(screen.queryByText('Sara is 13 today.')).toBeNull();
    expect(state.calls.some((c) => c.url.startsWith('/api/v1/reminders/people'))).toBe(false);
  });
});

describe('the review’s findings (after 0.7.0)', () => {
  it('the invitation’s step-up cancelled once the person is saved: said so, on People (INV-4)', async () => {
    const state = at('/people', { members: [ME], invitations: [], stepUpNeeded: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Zara' },
    });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(15) } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Invite them to sign up now' }));
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'zara@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByText(
        'Zara was added, but no invitation was made. You can invite them from their page.',
      ),
    ).toBeInTheDocument();
    expect(posted(state, '/api/v1/members')).toHaveLength(1);
    expect(state.invitations).toHaveLength(0);
  });

  it('… and in the first-run wizard (INV-4)', async () => {
    const state = fresh({ setupRequired: true, members: [], stepUpNeeded: true });
    installFakeApi(state);
    render(<App />);
    await screen.findByRole('heading', { name: /Set up your family/ });
    fireEvent.change(screen.getByLabelText(/call your family/), { target: { value: 'Khans' } });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mansoor' } });
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'm@example.test' } });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create my vault' }));
    await screen.findByRole('heading', { name: 'A few quick questions' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await screen.findByRole('heading', { name: 'Who is in the family?' });
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Hana' },
    });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: born(16) } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Invite them to sign up now' }));
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'hana@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByText(
        'Hana was added, but no invitation was made. You can invite them from their page.',
      ),
    ).toBeInTheDocument();
    expect(state.invitations).toHaveLength(0);
  });

  it('Home stands when the owners’ reminders cannot be had, refused or failed (INV-5)', async () => {
    for (const status of [403, 500]) {
      at('/', {
        members: FAMILY,
        invitations: [],
        personReminders: [],
        refuseWith: (_method, path) =>
          path === '/api/v1/reminders/people'
            ? { status, code: status === 403 ? 'forbidden' : 'internal', message: 'No.' }
            : undefined,
      });
      expect(await screen.findByText(/Everything is fine/)).toBeInTheDocument();
      expect(screen.queryByText('No.')).toBeNull();
      cleanup();
      localStorage.clear();
    }
  });
});

describe('a child’s birthday, to those who may not change it (INV-6)', () => {
  const patched = (state: FakeState) =>
    state.calls.filter((c) => c.method === 'PATCH' && c.url === '/api/v1/members/m-0');

  it('an adult sees a 10-year-old’s date of birth, is not offered it, and saves a new name', async () => {
    const state = at(
      '/people/m-0',
      { members: FAMILY.map((m) => (m.id === 'me' ? { ...ME, role: 'adult' } : m)) },
      'adult',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    const form = await screen.findByRole('form', { name: 'Aisha’s details' });
    expect(within(form).queryByLabelText('Date of birth (optional)')).toBeNull();
    const shown = within(form).getByRole('group', { name: 'Date of birth' });
    expect(shown).toHaveTextContent('2 April 2016');
    expect(shown).toHaveTextContent('Only an owner can change a child’s date of birth.');
    await expectAccessible();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Aisha Seikh' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
    expect(patched(state)).toHaveLength(1);
    expect(patched(state)[0]?.body).toEqual({ display_name: 'Aisha Seikh' });
  });

  it('an owner still changes it', async () => {
    const state = at('/people/m-0', { members: FAMILY });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    const field = await screen.findByLabelText('Date of birth (optional)');
    expect(screen.queryByText('Only an owner can change a child’s date of birth.')).toBeNull();
    fireEvent.change(field, { target: { value: '2015-04-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
    expect(patched(state)[0]?.body).toEqual({ date_of_birth: '2015-04-02' });
  });

  it('an adult is offered the date of birth of somebody 13 or over, as before', async () => {
    at(
      '/people/m-teen',
      { members: FAMILY.map((m) => (m.id === 'me' ? { ...ME, role: 'adult' } : m)) },
      'adult',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    expect(await screen.findByLabelText('Date of birth (optional)')).toBeInTheDocument();
  });
});
