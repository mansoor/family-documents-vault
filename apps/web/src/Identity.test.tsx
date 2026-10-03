import { IDENTITY_TOO_LONG, type IdentityFields } from '@fdv/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { contactLabel, draftFrom, movedUnshown, ONLY_ME_LIMIT } from './identity.js';
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
 * A person's identity details on the web (5.27), over 5.26's API: the card
 * on the profile, masked numbers shown or copied only once whoever asks has
 * said who they are, the form that sends only what changed, Only me with
 * its honest limit, the notice of a wider audience, and the owners' switch
 * for who sees them.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const at = (path: string) => window.history.replaceState({}, '', path);

/** Aisha Khan, a child with no sign-in. */
const AISHA_KHAN = {
  ...AISHA,
  display_name: 'Aisha Khan',
  can_change_photo: true,
  document_count: 1,
};
/** Sara, an adult with a sign-in. */
const SARA = {
  ...AISHA,
  id: 'm-1',
  display_name: 'Sara Seikh',
  date_of_birth: null,
  has_account: true,
  role: 'adult',
  is_me: false,
};
/** Another owner, for whoever is signed in as somebody else. */
const OMAR = { ...SARA, id: 'm-2', display_name: 'Omar Seikh', role: 'owner' };

const HER_PASSPORT = {
  ...PASSPORT,
  id: 'doc-a',
  title: 'Aisha’s passport',
  owner_member_id: 'm-0',
  identifier: 'AK123456',
  issued_by: 'United Kingdom',
  issued: { date: '2021-03-14', precision: 'day' },
  expires: { date: '2031-03-31', precision: 'month' },
};

const aishaRecord = (): NonNullable<FakeState['identities']>[string] => ({
  shared: {
    version: 1,
    fields: {
      given_name: 'Aisha',
      family_name: 'Khan',
      ids: [
        {
          id: 'p1',
          kind: 'passport',
          number: 'AK123456',
          expires_on: '2031-03-31',
          document_id: 'doc-a',
        },
        // Linked to a document nobody here may see: no link is shown.
        { id: 'b1', kind: 'other', label: 'Birth certificate', document_id: 'doc-hidden' },
      ],
    },
  },
});

const myRecord = (): NonNullable<FakeState['identities']>[string] => ({
  shared: {
    version: 1,
    fields: {
      given_name: 'Mansoor',
      ids: [{ id: 'mp', kind: 'passport', number: '563914782', issuer: 'United Kingdom' }],
    },
  },
  only_me: {
    version: 3,
    fields: { custom: [{ id: 'c1', label: 'Locker code', value: '0419', hidden: true }] },
  },
});

/** Somebody else's record holds an Only me part too: the vault keeps it, and shows it to nobody. */
const saraRecord = (): NonNullable<FakeState['identities']>[string] => ({
  shared: { version: 2, fields: { given_name: 'Sara', place_of_birth: 'Lahore' } },
  only_me: {
    version: 5,
    fields: {
      notes: 'SECRET-ONLY-ME note',
      ids: [{ id: 's1', kind: 'tax_id', number: 'TAX-999' }],
    },
  },
});

const reveals = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/identity/reveal'));
const puts = (state: FakeState) =>
  state.calls
    .filter((c) => c.method === 'PUT' && /\/members\/[^/]+\/identity$/.test(c.url))
    .map((c) => c.body as { part: string; version: number; fields: IdentityFields });

const card = () => screen.findByRole('region', { name: 'Identity details' });

describe("a person's identity details (5.27)", () => {
  it("masked until revealed; revealing asks to confirm it's you", async () => {
    const state = fresh({
      members: [ME, AISHA_KHAN],
      documents: [
        PASSPORT,
        HER_PASSPORT,
        { ...PASSPORT, id: 'doc-hidden', visibility: 'private', owner_member_id: 'm-9' },
      ],
      identities: { 'm-0': aishaRecord() },
      stepUpNeeded: true,
    });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    const region = await card();
    expect(within(region).getByText('Aisha')).toBeInTheDocument();
    expect(within(region).getByText('Passport')).toBeInTheDocument();
    // Masked: not in the page at all, only that there is one.
    expect(region).not.toHaveTextContent('AK123456');
    expect(within(region).getByText('Passport number, hidden')).toBeInTheDocument();
    expect(within(region).getByText('Expires 31 Mar 2031')).toBeInTheDocument();
    // A government ID's document, only where the vault gave it.
    const links = within(region).getAllByRole('link', { name: 'Open the document' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/documents/doc-a']);
    expect(reveals(state)).toEqual([]);
    await expectAccessible();

    fireEvent.click(within(region).getByRole('button', { name: 'Show passport number' }));
    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    // Somebody else's numbers: a passkey or a code, never the password (A54).
    expect(within(prompt).queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(region).not.toHaveTextContent('AK123456');
    fireEvent.change(within(prompt).getByLabelText(/code from your authenticator app/i), {
      target: { value: '123456' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    const value = await within(region).findByText('AK123456');
    // The number takes the focus, so it is heard as soon as it is there.
    await waitFor(() => expect(value).toHaveFocus());
    expect(value).toHaveTextContent('Passport number: AK123456');
    // Asked once, refused for who is asking, asked again: by key, never more.
    expect(reveals(state).map((c) => c.body)).toEqual([{ keys: ['ids.p1'] }, { keys: ['ids.p1'] }]);
    // Hidden again by the same button, which keeps the focus.
    const toggle = within(region).getByRole('button', { name: 'Hide passport number' });
    toggle.focus();
    fireEvent.click(toggle);
    expect(region).not.toHaveTextContent('AK123456');
    expect(within(region).getByRole('button', { name: 'Show passport number' })).toBe(toggle);
    expect(toggle).toHaveFocus();
  });

  it('copy counts as a reveal', async () => {
    const copied = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } });
    const state = fresh({ members: [ME, AISHA_KHAN], identities: { 'm-0': aishaRecord() } });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    const region = await card();
    const copy = within(region).getByRole('button', { name: 'Copy passport number' });
    copy.focus();
    fireEvent.click(copy);
    expect(await within(region).findByText('Passport number copied.')).toBeInTheDocument();
    // Copied through a reveal, which the vault writes in the activity log.
    expect(reveals(state).map((c) => c.body)).toEqual([{ keys: ['ids.p1'] }]);
    expect(copied).toHaveBeenCalledWith('AK123456');
    // And not shown on the screen for it.
    expect(region).not.toHaveTextContent('AK123456');
    expect(copy).toHaveFocus();
  });

  it("another person's Only me fields are absent", async () => {
    const state = fresh({
      members: [ME, SARA],
      identities: { me: myRecord(), 'm-1': saraRecord() },
    });
    installFakeApi(state);
    signedIn();
    at('/people/m-1');
    const { unmount } = render(<App />);
    const region = await card();
    expect(within(region).getByText('Lahore')).toBeInTheDocument();
    for (const absent of ['SECRET-ONLY-ME', 'Tax number', 'Only me', 'Notes']) {
      expect(region, absent).not.toHaveTextContent(absent);
    }
    // Her shared details only, with no switch to make anything Only me.
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Sara’s identity details' });
    expect(within(form).queryByRole('switch', { name: /Only me/ })).not.toBeInTheDocument();
    expect(form).not.toHaveTextContent(ONLY_ME_LIMIT);
    expect(within(form).getByLabelText('Notes')).toHaveValue('');
    fireEvent.change(within(form).getByLabelText('Place of birth'), {
      target: { value: 'Karachi' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(region).findByText('Identity details saved.')).toBeInTheDocument();
    // The shared part alone was sent; her Only me part is as it was.
    expect(puts(state).map((b) => b.part)).toEqual(['shared']);
    expect(state.identities?.['m-1']?.only_me).toEqual(saraRecord().only_me);
    unmount();

    // Her own Only me fields are hers to see, marked so.
    at('/people/me');
    render(<App />);
    const mine = await card();
    expect(within(mine).getByText('Only me')).toBeInTheDocument();
    expect(within(mine).getByText('Locker code, hidden')).toBeInTheDocument();
  });

  it('the pending-widening banner shows to everyone told and names the date', async () => {
    const pending = {
      to: 'adults' as const,
      requested_at: '2099-10-03T14:00:00Z',
      notice_until: '2099-10-06T14:00:00Z',
    };
    for (const role of ['owner', 'adult', 'teen', 'viewer'] as const) {
      installFakeApi(
        fresh({
          members: [{ ...ME, role }],
          identities: {},
          identityPending: pending,
          timezone: 'America/Los_Angeles',
        }),
      );
      signedIn(role);
      at('/');
      const r = render(<App />);
      // On the household's clock: 14:00 UTC is 07:00 in Los Angeles.
      const banner = await screen.findByText(
        'From 6 October at 07:00, all adults will see your shared identity details.',
      );
      const notice = banner.closest('.identity-notice') as HTMLElement;
      expect(within(notice).getByRole('link', { name: 'Look at yours' }), role).toHaveAttribute(
        'href',
        '/people/me#identity',
      );
      // Whoever may change their own is asked to mark anything Only me; a
      // viewer changes none of theirs.
      if (role === 'viewer') {
        expect(notice).not.toHaveTextContent('Mark anything Only me');
      } else {
        expect(notice, role).toHaveTextContent('Mark anything Only me before then.');
      }
      // The owners have the way to the setting itself.
      expect(
        within(notice).queryByRole('link', { name: 'Who can see identity details' }) !== null,
        role,
      ).toBe(role === 'owner');
      r.unmount();
    }
    // Nothing waiting: no banner.
    installFakeApi(fresh({ identities: {} }));
    signedIn('adult');
    at('/');
    render(<App />);
    await screen.findByRole('heading', { name: 'People' });
    await waitFor(() =>
      expect(screen.queryByText(/will see your shared identity details/)).toBeNull(),
    );
  });

  it('the edit form sends only changes, and never clears a masked value', async () => {
    const state = fresh({ members: [ME], identities: { me: myRecord() } });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    const edit = within(region).getByRole('button', { name: 'Edit identity details' });
    fireEvent.click(edit);
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    // The form opens at its first field.
    await waitFor(() => expect(within(form).getByLabelText('Title')).toHaveFocus());
    // The masked number is not in the form: kept unless typed anew.
    const number = within(form).getByLabelText('Passport number');
    expect(number).toHaveValue('');
    expect(number).toHaveAttribute('placeholder', 'Kept, and hidden');
    fireEvent.change(within(form).getByLabelText('First name'), {
      target: { value: 'Mansoor A.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(region).findByText('Identity details saved.')).toBeInTheDocument();
    // One part changed, one PUT: made from the version read, the passport's
    // number left out (kept), and nothing anywhere sent as null.
    const sent = puts(state);
    expect(sent).toEqual([
      {
        part: 'shared',
        version: 1,
        fields: {
          given_name: 'Mansoor A.',
          ids: [{ id: 'mp', kind: 'passport', issuer: 'United Kingdom' }],
        },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain('null');
    expect(state.identities?.me?.shared?.fields.ids?.[0]?.number).toBe('563914782');
    expect(state.identities?.me?.only_me?.version).toBe(3);
    // Back on the button that opened it.
    await waitFor(() =>
      expect(within(region).getByRole('button', { name: 'Edit identity details' })).toHaveFocus(),
    );
    // Saved with nothing changed: nothing is sent.
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    fireEvent.click(await within(region).findByRole('button', { name: 'Save' }));
    await within(region).findByRole('button', { name: 'Edit identity details' });
    expect(puts(state)).toHaveLength(1);
  });

  it('a field marked Only me says the honest limit, and goes to Only me before it leaves the shared part', async () => {
    const state = fresh({ members: [ME], identities: { me: myRecord() }, stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    expect(form).toHaveTextContent('Mark a field Only me to keep it to yourself.');
    fireEvent.change(within(form).getByLabelText('Place of birth'), {
      target: { value: 'Lahore' },
    });
    const place = within(form).getByRole('switch', { name: 'Only me: Place of birth' });
    expect(place).not.toHaveAttribute('aria-describedby');
    fireEvent.click(place);
    // Under the switch, and heard with it.
    const limit = document.getElementById(place.getAttribute('aria-describedby') ?? '');
    expect(limit).toHaveTextContent(ONLY_ME_LIMIT);
    expect(ONLY_ME_LIMIT).toBe(
      'No one in the family can open these. Whoever runs your vault’s server could.',
    );
    await expectAccessible();
    // The passport, masked, moves only once it is shown: its own, so any
    // credential will do.
    fireEvent.click(within(form).getByRole('switch', { name: 'Only me: Passport' }));
    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(within(prompt).getByLabelText(/password/i), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(within(form).getByRole('switch', { name: 'Only me: Passport' })).toBeChecked(),
    );
    expect(reveals(state).at(-1)?.body).toEqual({ keys: ['ids.mp'] });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    // Only me first, holding all of it; then the shared part, without it.
    const sent = puts(state);
    expect(sent.map((b) => b.part)).toEqual(['only_me', 'shared']);
    expect(sent[0]?.fields).toEqual({
      place_of_birth: 'Lahore',
      ids: [{ id: 'mp', kind: 'passport', number: '563914782', issuer: 'United Kingdom' }],
      custom: [{ id: 'c1', label: 'Locker code', hidden: true }],
    });
    expect(sent[1]?.fields).toEqual({ given_name: 'Mansoor' });
    expect(state.identities?.me?.only_me?.fields.custom?.[0]?.value).toBe('0419');
  });

  it('a part saved before the other was refused keeps its new version, and saving again is no conflict', async () => {
    const record = myRecord();
    if (record.shared) record.shared.fields.place_of_birth = 'Lahore';
    const state = fresh({ members: [ME], identities: { me: record }, identityTooLong: 'shared' });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    fireEvent.click(within(form).getByRole('switch', { name: 'Only me: Place of birth' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    // Only me was written first, and kept; the shared part was refused.
    expect(await within(form).findByRole('alert')).toHaveTextContent(IDENTITY_TOO_LONG);
    expect(state.identities?.me?.only_me?.version).toBe(4);
    expect(state.identities?.me?.shared?.fields.place_of_birth).toBe('Lahore');
    state.identityTooLong = false;
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    // Again: Only me, written already, is no change and is not sent; the
    // shared part goes from the version it was read at.
    expect(puts(state).map((b) => [b.part, b.version])).toEqual([
      ['only_me', 3],
      ['shared', 1],
      ['shared', 1],
    ]);
    expect(state.identities?.me?.only_me?.version).toBe(4);
    expect(state.identities?.me?.only_me?.fields.place_of_birth).toBe('Lahore');
    expect(state.identities?.me?.shared?.fields.place_of_birth).toBeUndefined();
  });

  it('each part is written from the version it was read at: a save elsewhere meanwhile is a 409, not written over (C527-01)', async () => {
    const record = myRecord();
    if (record.shared) record.shared.fields.place_of_birth = 'Lahore';
    const state = fresh({ members: [ME], identities: { me: record } });
    // The first write lands, and in that moment somebody else saves the
    // shared part (another device).
    let writes = 0;
    state.hold = (method, path) => {
      if (method !== 'PUT' || path !== '/api/v1/members/me/identity') return undefined;
      writes += 1;
      const shared = state.identities?.me?.shared;
      if (writes === 1 && shared) {
        shared.version = 2;
        shared.fields = { ...shared.fields, family_name: 'Jones-Smith' };
      }
      return undefined;
    };
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    fireEvent.click(within(form).getByRole('switch', { name: 'Only me: Place of birth' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/^Someone else changed your identity details/);
    await waitFor(() => expect(alert).toHaveFocus());
    // The shared part went at the version this form read, and was refused:
    // the other save stands.
    expect(puts(state).map((b) => [b.part, b.version])).toEqual([
      ['only_me', 3],
      ['shared', 1],
    ]);
    expect(state.identities?.me?.shared?.version).toBe(2);
    expect(state.identities?.me?.shared?.fields.family_name).toBe('Jones-Smith');
  });

  it('a masked number typed over, moved and cleared moves with its ID: it is shown first, and never lost (C527-02)', async () => {
    const state = fresh({ members: [ME], identities: { me: myRecord() }, stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    const number = within(form).getByLabelText('Passport number');
    fireEvent.change(number, { target: { value: 'X' } });
    fireEvent.click(within(form).getByRole('switch', { name: 'Only me: Passport' }));
    // Moved, it is shown first, whatever is typed over it.
    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(within(prompt).getByLabelText(/password/i), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(within(form).getByRole('switch', { name: 'Only me: Passport' })).toBeChecked(),
    );
    expect(reveals(state).at(-1)?.body).toEqual({ keys: ['ids.mp'] });
    // What was typed stays; and it is not said to be kept where it was.
    expect(number).toHaveValue('X');
    expect(form).toHaveTextContent('It moves with this ID unless you type a new one here.');
    expect(number).not.toHaveAttribute('placeholder', 'Kept, and hidden');
    fireEvent.change(number, { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    expect(state.identities?.me?.only_me?.fields.ids).toEqual([
      { id: 'mp', kind: 'passport', number: '563914782', issuer: 'United Kingdom' },
    ]);
    expect(state.identities?.me?.shared?.fields.ids).toBeUndefined();
  });

  it('fields moving both ways at once are never stored nowhere; closed after a refusal, the card shows what is kept (C527-03, C527-05)', async () => {
    const state = fresh({
      members: [ME],
      identities: {
        me: {
          shared: { version: 1, fields: { given_name: 'Mansoor', place_of_birth: 'Lahore' } },
          only_me: { version: 3, fields: { middle_name: 'Secretmiddle' } },
        },
      },
      identityTooLong: 'shared',
    });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    let region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    fireEvent.click(within(form).getByRole('switch', { name: 'Only me: Place of birth' }));
    fireEvent.click(within(form).getByRole('switch', { name: 'Only me: Middle name' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(IDENTITY_TOO_LONG);
    // Only me was written holding what it gains and still what it gives:
    // the middle name, refused its new place, is not lost.
    expect(puts(state).map((b) => b.part)).toEqual(['only_me', 'shared']);
    expect(state.identities?.me?.only_me?.fields).toEqual({
      middle_name: 'Secretmiddle',
      place_of_birth: 'Lahore',
    });
    // Closed: the card reads the record again, and shows what is kept.
    const looks = state.calls.filter(
      (c) => c.method === 'GET' && c.url === '/api/v1/members/me/identity',
    ).length;
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        state.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/members/me/identity')
          .length,
      ).toBe(looks + 1),
    );
    region = await card();
    await waitFor(() => expect(within(region).getAllByText('Lahore')).toHaveLength(2));
    // And the next edit starts from it: no conflict with its own save.
    state.identityTooLong = false;
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const again = await screen.findByRole('form', { name: 'Your identity details' });
    fireEvent.change(within(again).getByLabelText('Job title'), { target: { value: 'Engineer' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    expect(state.identities?.me?.shared?.fields.job_title).toBe('Engineer');
  });

  it('an entry read from the vault is kept unless Remove takes it, its hidden link too (C527-04)', async () => {
    const state = fresh({
      members: [ME, AISHA_KHAN],
      documents: [
        PASSPORT,
        HER_PASSPORT,
        { ...PASSPORT, id: 'doc-hidden', visibility: 'private', owner_member_id: 'm-9' },
      ],
      identities: { 'm-0': aishaRecord() },
    });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Aisha’s identity details' });
    fireEvent.change(within(form).getByLabelText('First name'), { target: { value: 'Aishah' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    // The birth certificate holds nothing the owner can see but its name:
    // sent as it is, and its document stays linked.
    expect(puts(state)[0]?.fields.ids).toContainEqual({
      id: 'b1',
      kind: 'other',
      label: 'Birth certificate',
    });
    expect(state.identities?.['m-0']?.shared?.fields.ids?.find((i) => i.id === 'b1')).toMatchObject(
      {
        kind: 'other',
        label: 'Birth certificate',
        document_id: 'doc-hidden',
      },
    );
  });

  it('a value the vault no longer has is said, on the card and in the form, and the focus goes to what is said (C527-06)', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    const state = fresh({ members: [ME, AISHA_KHAN], identities: { 'm-0': aishaRecord() } });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    let shown = render(<App />);
    let region = await card();
    // Cleared elsewhere since the card was read.
    const clear = () => {
      const ids = state.identities?.['m-0']?.shared?.fields.ids ?? [];
      for (const i of ids) delete i.number;
    };
    clear();
    fireEvent.click(within(region).getByRole('button', { name: 'Show passport number' }));
    let alert = await within(region).findByRole('alert');
    expect(alert).toHaveTextContent('There is no passport number to show any more.');
    await waitFor(() => expect(alert).toHaveFocus());
    // Read again: there is nothing to show.
    await waitFor(() =>
      expect(within(region).queryByRole('button', { name: 'Show passport number' })).toBeNull(),
    );
    shown.unmount();
    // Copy, the same.
    state.identities = { 'm-0': aishaRecord() };
    shown = render(<App />);
    region = await card();
    clear();
    fireEvent.click(within(region).getByRole('button', { name: 'Copy passport number' }));
    alert = await within(region).findByRole('alert');
    expect(alert).toHaveTextContent('There is no passport number to show any more.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(region).not.toHaveTextContent('copied');
    shown.unmount();
    // And in the form.
    state.identities = { 'm-0': aishaRecord() };
    render(<App />);
    region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Aisha’s identity details' });
    clear();
    fireEvent.click(within(form).getByRole('button', { name: 'Show passport number' }));
    const said = await within(form).findByRole('alert');
    expect(said).toHaveTextContent('There is no passport number to show any more.');
    await waitFor(() => expect(said).toHaveFocus());
  });

  it('where this browser cannot copy, Copy is not offered, and nothing is revealed for it (C527-07)', async () => {
    // jsdom has no clipboard, as a vault at a plain http:// address has none.
    const state = fresh({ members: [ME, AISHA_KHAN], identities: { 'm-0': aishaRecord() } });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    const { unmount } = render(<App />);
    let region = await card();
    expect(
      within(region).getByRole('button', { name: 'Show passport number' }),
    ).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /^Copy/ })).toBeNull();
    expect(reveals(state)).toEqual([]);
    unmount();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    render(<App />);
    region = await card();
    expect(
      within(region).getByRole('button', { name: 'Copy passport number' }),
    ).toBeInTheDocument();
  });

  it('two IDs that would be called the same are told apart, by who issued them or by number (C527-09)', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    const state = fresh({
      members: [ME],
      identities: {
        me: {
          shared: {
            version: 1,
            fields: {
              ids: [
                { id: 'p1', kind: 'passport', number: 'PK-1', issuer: 'Pakistan' },
                { id: 'p2', kind: 'passport', number: 'GB-2', issuer: 'United Kingdom' },
                { id: 'd1', kind: 'driving_licence', number: 'D-1' },
                { id: 'd2', kind: 'driving_licence', number: 'D-2' },
              ],
            },
          },
        },
      },
    });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    for (const name of [
      'Show passport number, issued by Pakistan',
      'Copy passport number, issued by United Kingdom',
      'Show driving licence number 1',
      'Copy driving licence number 2',
    ]) {
      expect(within(region).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(region).getByText('Passport, issued by Pakistan')).toBeInTheDocument();
    expect(within(region).getByText('Driving licence 2')).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    expect(
      within(form).getByRole('switch', { name: 'Only me: Passport, issued by Pakistan' }),
    ).toBeInTheDocument();
    expect(
      within(form).getByRole('button', { name: 'Remove Driving licence 1' }),
    ).toBeInTheDocument();
    expect(
      within(form).getByRole('group', { name: 'Passport, issued by United Kingdom' }),
    ).toBeInTheDocument();
  });

  it('the notice’s link goes to the Identity card once it is there, and its heading takes the focus (S527-3)', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    installFakeApi(fresh({ members: [ME], identities: { me: myRecord() } }));
    signedIn();
    at('/people/me#identity');
    render(<App />);
    const heading = await screen.findByRole('heading', { name: 'Identity details' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrolled).toHaveBeenCalled();
  });

  it('a hidden field unhidden is shown first, and sent with its value', async () => {
    const state = fresh({ members: [ME], identities: { me: myRecord() }, stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    const code = within(form).getByLabelText('Locker code');
    expect(code).toHaveValue('');
    fireEvent.click(
      within(form).getByRole('switch', { name: 'Hide Locker code until it is shown' }),
    );
    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(within(prompt).getByLabelText(/password/i), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(code).toHaveValue('0419'));
    expect(
      within(form).getByRole('switch', { name: 'Hide Locker code until it is shown' }),
    ).not.toBeChecked();
    expect(reveals(state).at(-1)?.body).toEqual({ part: 'only_me', keys: ['custom.c1'] });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    expect(puts(state)).toEqual([
      {
        part: 'only_me',
        version: 3,
        fields: { custom: [{ id: 'c1', label: 'Locker code', value: '0419' }] },
      },
    ]);
    // No longer hidden, so no longer masked: shown as it is.
    expect(state.identities?.me?.only_me?.fields.custom?.[0]).toEqual({
      id: 'c1',
      label: 'Locker code',
      value: '0419',
    });
    expect(await within(region).findByText('0419')).toBeInTheDocument();
  });

  it('a stale version is a conflict: what was saved is shown, to make the changes again', async () => {
    const state = fresh({ members: [ME], identities: { me: myRecord() } });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    // Somebody else saves first.
    const shared = state.identities?.me?.shared;
    if (shared) {
      shared.version = 2;
      shared.fields = { ...shared.fields, given_name: 'Mansur' };
    }
    fireEvent.change(within(form).getByLabelText('Job title'), { target: { value: 'Engineer' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Someone else changed your identity details while you were editing. What they saved is shown now: make your changes again, then save.',
    );
    await waitFor(() => expect(alert).toHaveFocus());
    expect(within(form).getByLabelText('First name')).toHaveValue('Mansur');
    expect(within(form).getByLabelText('Job title')).toHaveValue('');
    // Made again, on top of it.
    fireEvent.change(within(form).getByLabelText('Job title'), { target: { value: 'Engineer' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    expect(puts(state).map((b) => b.version)).toEqual([1, 2]);
    expect(state.identities?.me?.shared?.fields).toMatchObject({
      given_name: 'Mansur',
      job_title: 'Engineer',
    });
  });

  it('details too long to keep are said in the form, and nothing closes', async () => {
    const state = fresh({ members: [ME], identities: { me: myRecord() }, identityTooLong: true });
    installFakeApi(state);
    signedIn();
    at('/people/me');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    fireEvent.change(within(form).getByLabelText('Notes'), { target: { value: 'x'.repeat(5000) } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(IDENTITY_TOO_LONG);
    expect(IDENTITY_TOO_LONG).toBe('These details are too long to keep. Shorten some of them.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(within(form).getByLabelText('Notes')).toHaveValue('x'.repeat(5000));
  });

  it('without two-step sign-in, another person’s numbers are refused, with the way to turn it on', async () => {
    // An adult, once the audience is all adults: two_step_required.
    const adultState = fresh({
      members: [{ ...ME, role: 'adult' }, OMAR],
      identities: {
        'm-2': {
          shared: { version: 1, fields: { ids: [{ id: 'o1', kind: 'passport', number: 'OM-1' }] } },
        },
      },
      identityAudience: 'adults',
      twoStep: false,
    });
    installFakeApi(adultState);
    signedIn('adult');
    at('/people/m-2');
    const { unmount } = render(<App />);
    let region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Show passport number' }));
    let alert = await within(region).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Turn on two-step sign-in to see another person’s identity numbers.',
    );
    expect(within(region).getByRole('link', { name: 'Set up two-step sign-in' })).toHaveAttribute(
      'href',
      '/settings#two-step',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(region).not.toHaveTextContent('OM-1');
    unmount();

    // An owner: totp_required_for_owner, said the same way.
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    const ownerState = fresh({
      members: [ME, AISHA_KHAN],
      identities: { 'm-0': aishaRecord() },
      twoStep: false,
    });
    installFakeApi(ownerState);
    signedIn();
    at('/people/m-0');
    render(<App />);
    region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Copy passport number' }));
    alert = await within(region).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Turn on two-step sign-in to see another person’s identity numbers.',
    );
    expect(within(region).getByRole('link', { name: 'Set up two-step sign-in' })).toHaveAttribute(
      'href',
      '/settings#two-step',
    );
    expect(region).not.toHaveTextContent('copied');
  });

  it('a record not given is no card at all; a viewer reads their own, and changes none of it', async () => {
    const state = fresh({
      members: [{ ...ME, role: 'viewer' }, AISHA_KHAN],
      identities: {
        me: { shared: { version: 1, fields: { given_name: 'Mansoor' } } },
        'm-0': aishaRecord(),
      },
    });
    installFakeApi(state);
    signedIn('viewer');
    at('/people/m-0');
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Aisha Khan' });
    await waitFor(() =>
      expect(state.calls.some((c) => c.url === '/api/v1/members/m-0/identity')).toBe(true),
    );
    expect(screen.queryByRole('region', { name: 'Identity details' })).not.toBeInTheDocument();
    unmount();
    at('/people/me');
    render(<App />);
    const region = await card();
    expect(within(region).getByText('Mansoor')).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /identity details/ })).toBeNull();
    expect(region).toHaveTextContent('Seen by you and the owners.');
  });

  it('Fill from documents suggests a number and an expiry, and copies nothing until chosen', async () => {
    const state = fresh({
      members: [ME, AISHA_KHAN],
      documents: [PASSPORT, HER_PASSPORT],
      identities: {},
    });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    const region = await card();
    expect(region).toHaveTextContent('Nothing kept here for Aisha yet.');
    fireEvent.click(within(region).getByRole('button', { name: 'Add identity details' }));
    const form = await screen.findByRole('form', { name: 'Aisha’s identity details' });
    fireEvent.click(within(form).getByRole('button', { name: 'Fill from documents' }));
    const heading = await within(form).findByRole('heading', { name: 'From documents' });
    await waitFor(() => expect(heading).toHaveFocus());
    // Her identity documents the editor can see, asked of the vault.
    expect(
      state.calls.some(
        (c) =>
          c.url.startsWith('/api/v1/documents?') &&
          c.url.includes('member_id=m-0') &&
          c.url.includes('category=identity'),
      ),
    ).toBe(true);
    const words = 'Passport from “Aisha’s passport”: number AK123456, expires March 2031';
    expect(within(form).getByText(words)).toBeInTheDocument();
    // Nothing is filled in yet.
    expect(within(form).queryByRole('group', { name: 'Passport' })).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: `Use this: ${words}` }));
    expect(
      await within(form).findByText('Added from “Aisha’s passport”. Save to keep it.'),
    ).toBeInTheDocument();
    const added = within(form).getByRole('group', { name: 'Passport' });
    expect(within(added).getByLabelText('Passport number')).toHaveValue('AK123456');
    expect(within(added).getByLabelText('Expires on')).toHaveValue('2031-03-31');
    await waitFor(() =>
      expect(within(form).getByRole('button', { name: 'Fill from documents' })).toHaveFocus(),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    const sent = puts(state);
    // An entry id the vault takes, chosen here.
    expect(sent[0]?.fields.ids?.[0]?.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    const id = sent[0]?.fields.ids?.[0]?.id ?? '';
    expect(sent).toEqual([
      {
        part: 'shared',
        version: 0,
        fields: {
          ids: [
            {
              id,
              kind: 'passport',
              number: 'AK123456',
              expires_on: '2031-03-31',
              issued_on: '2021-03-14',
              issuer: 'United Kingdom',
              document_id: 'doc-a',
            },
          ],
        },
      },
    ]);
    // Asked again, the passport is there already: nothing to suggest.
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    const again = await screen.findByRole('form', { name: 'Aisha’s identity details' });
    fireEvent.click(within(again).getByRole('button', { name: 'Fill from documents' }));
    expect(
      await within(again).findByRole('heading', { name: 'Nothing to suggest' }),
    ).toBeInTheDocument();
    expect(again).toHaveTextContent(
      'None of Aisha’s identity documents that you can see has a number or an expiry date that isn’t here already.',
    );
  });

  it('Fill from documents: an Only me document’s number goes into Only me, and says so (S527-1)', async () => {
    const mine = {
      ...PASSPORT,
      id: 'doc-p',
      title: 'My passport',
      owner_member_id: 'me',
      visibility: 'private',
      identifier: '563914782',
    };
    const state = fresh({ members: [{ ...ME, role: 'adult' }], documents: [mine], identities: {} });
    installFakeApi(state);
    signedIn('adult');
    at('/people/me');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Add identity details' }));
    const form = await screen.findByRole('form', { name: 'Your identity details' });
    fireEvent.click(within(form).getByRole('button', { name: 'Fill from documents' }));
    const note = await within(form).findByText(
      'From an Only me document: it goes into your Only me details.',
    );
    const use = within(form).getByRole('button', {
      name: /^Use this: Passport from “My passport”/,
    });
    expect(use).toHaveAttribute('aria-describedby', note.id);
    fireEvent.click(use);
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(region).findByText('Identity details saved.');
    expect(puts(state).map((b) => b.part)).toEqual(['only_me']);
    expect(state.identities?.me?.only_me?.fields.ids?.[0]).toMatchObject({
      kind: 'passport',
      number: '563914782',
      document_id: 'doc-p',
    });
    expect(state.identities?.me?.shared).toBeUndefined();
  });

  it('Fill from documents: an Adults only document, where teens see the shared part, says so (S527-1)', async () => {
    const theirs = { ...HER_PASSPORT, visibility: 'adults' };
    const state = fresh({
      members: [ME, AISHA_KHAN],
      documents: [theirs],
      identities: {},
      identityAudience: 'family',
    });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Add identity details' }));
    const form = await screen.findByRole('form', { name: 'Aisha’s identity details' });
    fireEvent.click(within(form).getByRole('button', { name: 'Fill from documents' }));
    expect(
      await within(form).findByText(
        'From an Adults only document: in the shared details, teens can see it too.',
      ),
    ).toBeInTheDocument();
  });

  it('Fill from documents offers no document an ID is linked to, and no number twice (S527-2)', async () => {
    const twin = { ...HER_PASSPORT, id: 'doc-b', title: 'Aisha’s old passport' };
    const record = aishaRecord();
    // Linked already, its number masked, no expiry kept.
    if (record.shared?.fields.ids?.[0]) delete record.shared.fields.ids[0].expires_on;
    const state = fresh({
      members: [ME, AISHA_KHAN],
      documents: [HER_PASSPORT],
      identities: { 'm-0': record },
    });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    const { unmount } = render(<App />);
    let region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit identity details' }));
    let form = await screen.findByRole('form', { name: 'Aisha’s identity details' });
    fireEvent.click(within(form).getByRole('button', { name: 'Fill from documents' }));
    expect(
      await within(form).findByRole('heading', { name: 'Nothing to suggest' }),
    ).toBeInTheDocument();
    unmount();
    // Two documents with one number: the second is not added again.
    state.identities = {};
    state.documents = [HER_PASSPORT, twin];
    render(<App />);
    region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Add identity details' }));
    form = await screen.findByRole('form', { name: 'Aisha’s identity details' });
    fireEvent.click(within(form).getByRole('button', { name: 'Fill from documents' }));
    await within(form).findByRole('heading', { name: 'From documents' });
    for (const button of within(form).getAllByRole('button', { name: /^Use this/ })) {
      fireEvent.click(button);
    }
    expect(
      await within(form).findByText(
        'That number is here already. “Aisha’s old passport” left out.',
      ),
    ).toBeInTheDocument();
    expect(within(form).getAllByRole('group', { name: 'Passport' })).toHaveLength(1);
  });

  it('Fill from documents, every suggestion used or left out: that is all of them, not nothing found (S527-9)', async () => {
    installFakeApi(fresh({ members: [ME, AISHA_KHAN], documents: [HER_PASSPORT], identities: {} }));
    signedIn();
    at('/people/m-0');
    render(<App />);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Add identity details' }));
    const form = await screen.findByRole('form', { name: 'Aisha’s identity details' });
    fireEvent.click(within(form).getByRole('button', { name: 'Fill from documents' }));
    fireEvent.click(await within(form).findByRole('button', { name: /^Not this/ }));
    expect(
      await within(form).findByRole('heading', { name: 'That’s all of them' }),
    ).toBeInTheDocument();
    expect(form).not.toHaveTextContent('None of Aisha’s identity documents');
    expect(within(form).getByText('Left out.')).toBeInTheDocument();
  });

  it('Add someone offers "Add their details now", which opens their Identity details form', async () => {
    const state = fresh({ members: [ME], identities: {} });
    installFakeApi(state);
    signedIn();
    at('/people');
    const { unmount } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Zara' },
    });
    fireEvent.click(screen.getByLabelText('Add their details now'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const form = await screen.findByRole('form', { name: 'Zara’s identity details' });
    expect(window.location.pathname).toBe('/people/m-1');
    await waitFor(() => expect(within(form).getByLabelText('Title')).toHaveFocus());
    // No Only me for somebody else's.
    expect(within(form).queryByRole('switch', { name: /Only me/ })).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add identity details' })).toHaveFocus(),
    );
    // Used once: the history entry no longer asks for the form, so Back to
    // it, or a reload, shows the card (the 5.27 review).
    expect((window.history.state as { usr?: unknown } | null)?.usr ?? null).toBeNull();
    unmount();
    const reloaded = render(<App />);
    await screen.findByRole('button', { name: 'Add identity details' });
    expect(screen.queryByRole('form', { name: 'Zara’s identity details' })).toBeNull();
    reloaded.unmount();
    // An adult changes nobody else's identity details: not offered.
    installFakeApi(fresh({ members: [{ ...ME, role: 'adult' }], identities: {} }));
    signedIn('adult');
    at('/people');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    expect(screen.queryByLabelText('Add their details now')).not.toBeInTheDocument();
  });
});

describe('what the form will not save (5.27)', () => {
  it('a masked value moved to the other part, never shown nor typed over, is found before saving (C527-02)', () => {
    const view = {
      member_id: 'me',
      audience: 'owners_and_self' as const,
      can_edit: { shared: true, only_me: true },
      versions: { shared: 1, only_me: 0 },
      shared: {
        fields: { ids: [{ id: 'mp', kind: 'passport' as const }] },
        masked: ['ids.mp'],
        filled: ['ids.mp'],
        version: 1,
        updated_at: null,
      },
      only_me: { fields: {}, masked: [], filled: [], version: 0, updated_at: null },
    };
    const draft = draftFrom(view);
    expect(movedUnshown(draft)).toEqual([]);
    const moved = { ...draft, entries: draft.entries.map((e) => ({ ...e, onlyMe: true })) };
    expect(movedUnshown(moved).map((e) => e.id)).toEqual(['mp']);
    const typed = {
      ...moved,
      entries: moved.entries.map((e) => ({ ...e, f: { ...e.f, number: 'NEW-1' } })),
    };
    expect(movedUnshown(typed)).toEqual([]);
    const shown = { ...moved, entries: moved.entries.map((e) => ({ ...e, known: 'OLD-1' })) };
    expect(movedUnshown(shown)).toEqual([]);
  });
});

describe('the words of a record (5.27)', () => {
  it('a contact is named by what it is, with what it is for', () => {
    expect(contactLabel('Home', 'email')).toBe('Home email');
    expect(contactLabel('Work phone', 'phone')).toBe('Work phone');
    expect(contactLabel('', 'address')).toBe('Address');
  });
});

describe('who can see identity details (5.27, A34)', () => {
  it('the audience setting is owner only', async () => {
    for (const role of ['adult', 'teen', 'viewer'] as const) {
      installFakeApi(fresh({ members: [{ ...ME, role }], identities: {} }));
      signedIn(role);
      at('/settings');
      const r = render(<App />);
      await screen.findByRole('heading', { name: 'Settings' });
      expect(screen.queryByRole('link', { name: /Family/ }), role).not.toBeInTheDocument();
      r.unmount();
      at('/settings/family');
      const s = render(<App />);
      await screen.findByText('The owners, and each person their own');
      expect(screen.queryByRole('group', { name: 'Who can see them' }), role).toBeNull();
      expect(
        screen.getByText('Only an owner can change who sees identity details.'),
      ).toBeInTheDocument();
      s.unmount();
    }
  });

  it('an owner widens it after 72 hours’ notice, confirming with a code, and can withdraw it', async () => {
    const state = fresh({ members: [ME], identities: {}, stepUpNeeded: true, timezone: 'UTC' });
    installFakeApi(state);
    signedIn();
    at('/settings');
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: /Family/ }));
    await screen.findByRole('heading', { name: 'Who can see identity details' });
    // Viewers change nothing of theirs: the owner is not told they can (the 5.27 review).
    expect(
      screen.getByText(
        /waits 72 hours: everyone with a sign-in is told first, and all but viewers can mark anything Only me before then\./,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All adults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tell everyone, and wait 72 hours' }));
    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(within(prompt).queryByLabelText(/password/i)).not.toBeInTheDocument();
    fireEvent.change(within(prompt).getByLabelText(/code from your authenticator app/i), {
      target: { value: '123456' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    const said = await screen.findByText(/^Asked\. From /);
    await waitFor(() => expect(said).toHaveFocus());
    expect(state.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { audience: 'adults' },
      { audience: 'adults' },
    ]);
    expect(
      screen.getByText(
        /has been told, and all but viewers can mark anything Only me before then\./,
      ),
    ).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw this' }));
    expect(await screen.findByText('Withdrawn. Nobody else will see them.')).toBeInTheDocument();
    expect(state.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({
      audience: 'owners_and_self',
    });
    expect(
      screen.queryByText(/has been told, and all but viewers can mark anything Only me/),
    ).not.toBeInTheDocument();
  });

  it('a widening is refused while somebody cannot be told; an owner without two-step sign-in is sent to turn it on', async () => {
    installFakeApi(fresh({ members: [ME], identities: {}, cannotBeTold: ['Tariq'] }));
    signedIn();
    at('/settings/family');
    const { unmount } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Everyone in the family' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tell everyone, and wait 72 hours' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^Tariq cannot sign in just now/);
    await waitFor(() => expect(alert).toHaveFocus());
    unmount();
    installFakeApi(fresh({ members: [ME], identities: {}, twoStep: false }));
    signedIn();
    at('/settings/family');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'All adults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tell everyone, and wait 72 hours' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Turn on two-step sign-in to change who can see identity details.',
    );
    expect(screen.getByRole('link', { name: 'Set up two-step sign-in' })).toHaveAttribute(
      'href',
      '/settings#two-step',
    );
  });

  it('after a restore, the screen says what a restore does to who can see identity details, and how it is now', async () => {
    const share = {
      id: 'sh-1',
      document_id: 'doc-1',
      document_title: "Mansoor's passport",
      recipient_label: 'Notary',
      expires_at: '2099-01-01T00:00:00Z',
      has_pin: false,
    };
    installFakeApi(
      fresh({
        identities: {},
        identityAudience: 'adults',
        shares: [{ ...share, state: 'paused' }],
      }),
    );
    signedIn();
    at('/settings/after-restore');
    render(<App />);
    const said = await screen.findByTestId('restore-identity');
    // The rule, true after any restore; then the vault as it is now — widened
    // again since, here — never a claim that something was withdrawn.
    await waitFor(() =>
      expect(said).toHaveTextContent(
        'A restore sets who can see identity details back to the owners and each person, and withdraws any wider audience that was waiting. It is now: All adults.',
      ),
    );
    expect(said).not.toHaveTextContent('was withdrawn');
  });
});
