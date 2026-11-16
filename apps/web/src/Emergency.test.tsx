import { EMERGENCY_NOT_ADVICE, type EmergencyView } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { SharePage } from './screens/SharePage.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * A person's emergency information (0.9.0, H4) on their page: what was
 * typed, its editor (made to the version read), who sees it, a wallet card
 * printed with what the person ticks, a clinician's link and each time it
 * was opened — and the page a clinician's link opens.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
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

const ALLERGY = 'Penicillin';
const MEDICATION = 'Warfarin';

function page(over: Partial<EmergencyView> = {}): EmergencyView {
  return {
    member_id: 'me',
    fields: {
      blood_type: 'O-',
      allergies: [{ id: 'a1', name: ALLERGY, note: 'hives' }],
      medications: [{ id: 'm1', name: MEDICATION, dose: '5 mg daily' }],
      emergency_contacts: [{ id: 'p1', name: 'Mona', role: 'sister', phone: '+44 7700 900123' }],
    },
    date_of_birth: '1980-04-02',
    audience: 'adults',
    chosen: [],
    documents: {
      advance_directive: [{ id: 'doc-ad', title: 'Living will 2024' }],
      healthcare_proxy: [],
      insurance_card: [],
    },
    version: 3,
    updated_at: '2026-11-15T10:00:00Z',
    can_edit: true,
    can_choose: true,
    can_see_links: true,
    caregiver: false,
    candidates: [{ member_id: 'm-0', name: 'Aisha', role: 'teen' }],
    ...over,
  };
}

function at(path: string, over: Partial<FakeState>, role: 'owner' | 'adult' | 'teen' = 'owner') {
  const state = fresh({ emergency: true, members: [ME, AISHA], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const card = async () =>
  (await screen.findByRole('heading', { name: 'Emergency information' })).closest(
    'section',
  ) as HTMLElement;

describe('Emergency information on a person’s page (0.9.0, H4)', () => {
  it('shows what was typed and the papers it links to, and saves an edit made to the version read', async () => {
    const state = at('/people/me', { emergencyOf: { me: page() } });
    const c = await card();
    expect(within(c).getByText(/Penicillin · hives/)).toBeInTheDocument();
    expect(within(c).getByText('O-')).toBeInTheDocument();
    expect(within(c).getByRole('link', { name: 'Living will 2024' })).toHaveAttribute(
      'href',
      '/documents/doc-ad',
    );
    expect(within(c).getByText(EMERGENCY_NOT_ADVICE)).toBeInTheDocument();
    expect(
      within(c).getByText('Who can see it: You, the owners and every adult.'),
    ).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(within(c).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(c).getByRole('button', { name: 'Add condition' }));
    fireEvent.change(within(c).getByLabelText('Condition 1'), { target: { value: 'Asthma' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Save' }));
    expect(await within(c).findByText('Saved.')).toBeInTheDocument();
    const write = state.emergencyWrites?.[0];
    expect(write?.ifMatch).toBe('"3"');
    expect(write?.fields.conditions?.map((x) => x.name)).toEqual(['Asthma']);
    // What was there stays as it was.
    expect(write?.fields.allergies).toEqual([{ id: 'a1', name: ALLERGY, note: 'hives' }]);
    expect(await within(c).findByText(/Asthma/)).toBeInTheDocument();
  });

  it('says so when somebody else changed it meanwhile', async () => {
    const state = at('/people/me', { emergencyOf: { me: page() } });
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Edit' }));
    // Moved on by somebody else.
    (state.emergencyOf?.me as EmergencyView).version = 4;
    fireEvent.click(within(c).getByRole('button', { name: 'Save' }));
    expect(await within(c).findByRole('alert')).toHaveTextContent(/Someone else changed this/);
  });

  it('is not there for somebody not given it, and offers nothing that would be refused', async () => {
    at('/people/m-0', { emergencyOf: {} });
    await screen.findByRole('heading', { name: 'Aisha’s documents' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Emergency information' })).toBeNull(),
    );
    cleanup();
    at(
      '/people/m-0',
      {
        emergencyOf: {
          'm-0': page({
            member_id: 'm-0',
            can_edit: false,
            can_choose: false,
            can_see_links: false,
            caregiver: true,
            candidates: [],
          }),
        },
      },
      'adult',
    );
    const c = await card();
    expect(within(c).getByText('You see this as Aisha’s caregiver.')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Who can see it' })).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Share with a clinician' })).toBeNull();
    expect(within(c).getByRole('button', { name: 'Print a wallet card' })).toBeInTheDocument();
  });

  it('who can see it: an audience, and people named besides', async () => {
    const state = at('/people/me', { emergencyOf: { me: page() } });
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Who can see it' }));
    fireEvent.click(within(c).getByLabelText('Only them and the owners'));
    fireEvent.click(within(c).getByLabelText('Aisha'));
    await expectAccessible();
    fireEvent.click(within(c).getByRole('button', { name: 'Save' }));
    expect(await within(c).findByText('Who can see it is saved.')).toBeInTheDocument();
    const put = state.calls.find(
      (x) => x.method === 'PUT' && x.url === '/api/v1/members/me/emergency/audience',
    );
    expect(put?.body).toEqual({ audience: 'owners_and_self', chosen_member_ids: ['m-0'] });
    expect(
      within(c).getByText('Who can see it: You and the owners, and Aisha.'),
    ).toBeInTheDocument();
  });

  it('a wallet card holds only what is ticked, and prints the card alone', async () => {
    at('/people/me', { emergencyOf: { me: page() } });
    const c = await card();
    fireEvent.click(within(c).getByRole('button', { name: 'Print a wallet card' }));
    const sheet = await screen.findByRole('dialog', { name: 'Print a wallet card' });
    const preview = within(sheet).getByLabelText('Wallet card for Mansoor Seikh');
    expect(within(preview).getByText(/Penicillin/)).toBeInTheDocument();
    // Medications left off.
    fireEvent.click(within(sheet).getByLabelText('Medications'));
    expect(within(preview).queryByText(/Warfarin/)).toBeNull();
    expect(within(preview).getByText(EMERGENCY_NOT_ADVICE)).toBeInTheDocument();
    await expectAccessible();
    let printedWith = '';
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      printedWith = document.body.className;
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(printedWith).toContain('printing-wallet-card');
    // A phone's browser returns from print() at once and prints later: the
    // page stays the card's until the browser says it has printed.
    await new Promise((r) => setTimeout(r, 20));
    expect(document.body.classList.contains('printing-wallet-card')).toBe(true);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.body.classList.contains('printing-wallet-card')).toBe(false);
    // The printer's copy is the card, with no link and nothing to scan.
    const printed = document.querySelector('.wallet-print-root') as HTMLElement;
    expect(printed.textContent).toContain(ALLERGY);
    expect(printed.textContent).not.toContain(MEDICATION);
    expect(printed.querySelector('a, img, svg, canvas')).toBeNull();
  });

  it('a clinician’s link: the parts ticked, for hours, with a PIN; and each time it was opened', async () => {
    const state = at('/people/me', {
      emergencyOf: { me: page() },
      emergencyLinksOf: {
        me: [
          {
            id: 'old-link',
            document_id: null,
            document_title: null,
            recipient_label: 'St Mary’s A&E',
            created_by_name: 'Mansoor Seikh',
            created_at: '2026-11-15T08:00:00Z',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            has_pin: true,
            open_count: 1,
            last_opened_at: '2026-11-15T08:30:00Z',
            state: 'active',
            summary: 'Shared with St Mary’s A&E',
            changeable: true,
            version: 1,
            latest_end: new Date(Date.now() + 20 * 3_600_000).toISOString(),
            emergency_fields: ['allergies'],
            openings: [
              {
                at: '2026-11-15T08:30:00Z',
                network: '10.1.2.0/24',
                user_agent: 'Mozilla/5.0 Chrome/131.0',
              },
            ],
          },
        ],
      },
    });
    const c = await card();
    const links = (await within(c).findByRole('heading', { name: 'Links for clinicians' })).closest(
      'section',
    ) as HTMLElement;
    expect(
      within(links).getByText(/Opened .* from Chrome on the network 10\.1\.2\.0\/24/),
    ).toBeInTheDocument();

    fireEvent.click(within(c).getByRole('button', { name: 'Share with a clinician' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share with a clinician' });
    fireEvent.click(within(sheet).getByLabelText('Medications'));
    fireEvent.change(within(sheet).getByLabelText('Who it is for (only you see this)'), {
      target: { value: 'Dr Patel' },
    });
    await expectAccessible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make the link' }));
    expect(
      await within(sheet).findByText('https://share.example.test/s#emergency-token-1'),
    ).toBeInTheDocument();
    expect(within(sheet).getByText('2468')).toBeInTheDocument();
    const made = state.emergencyLinksMade?.[0]?.body;
    expect(made).toMatchObject({
      expires_in_hours: 4,
      with_pin: true,
      recipient_label: 'Dr Patel',
    });
    expect(made?.fields).not.toContain('medications');
    expect(made?.fields).toContain('allergies');

    // Done: the focus goes back to the button that opened the sheet.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(c).getByRole('button', { name: 'Share with a clinician' }),
      ),
    );
    // Changed (0.9.0, LK): the form it was made with, to view always.
    fireEvent.click(
      await within(c).findByRole('button', { name: 'Change the link for St Mary’s A&E' }),
    );
    const change = await screen.findByRole('dialog', {
      name: 'Change the link for a clinician',
    });
    expect(within(change).getByLabelText('Who is it for?')).toHaveValue('St Mary’s A&E');
    expect(within(change).getByText(/It is to view, always/)).toBeInTheDocument();
    expect(within(change).queryByRole('button', { name: 'View and download' })).toBeNull();
    await expectAccessible();
    fireEvent.change(within(change).getByLabelText('Who is it for?'), {
      target: { value: 'Dr Patel at St Mary’s' },
    });
    fireEvent.click(within(change).getByRole('button', { name: 'Save the changes' }));
    expect(
      await within(c).findByText(/^The link to .*’s emergency information is changed.$/),
    ).toBeInTheDocument();
    expect(state.calls.filter((x) => x.method === 'PATCH').map((x) => [x.url, x.body])).toEqual([
      ['/api/v1/shares/old-link', { recipient_label: 'Dr Patel at St Mary’s' }],
    ]);
    // Taken back, after asking.
    fireEvent.click(
      await within(c).findByRole('button', {
        name: 'Take back the link for Dr Patel at St Mary’s',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take back' }));
    await waitFor(() =>
      expect(
        state.calls.some(
          (x) => x.method === 'DELETE' && x.url === '/api/v1/members/me/emergency/links/old-link',
        ),
      ).toBe(true),
    );
  });
});

describe('the page a clinician’s link opens (0.9.0, H4)', () => {
  it('names nobody before Open, is never indexed, and shows only what was ticked, as typed', async () => {
    const state = fresh({
      sharePin: '2468',
      shareEmergency: {
        person_name: 'Zain',
        date_of_birth: '1980-04-02',
        fields: { allergies: [{ id: 'a1', name: ALLERGY, note: 'hives' }] },
        shown: ['allergies', 'blood_type'],
        updated_at: '2026-11-15T10:00:00Z',
      },
    });
    installFakeApi(state);
    render(<SharePage token="share-secret-0123456789abcdef" />);
    // Behind its PIN: what any withheld link's page says, and nobody named.
    expect(await screen.findByRole('heading', { name: 'A shared document' })).toBeInTheDocument();
    expect(screen.queryByText(/Zain/)).toBeNull();
    expect(screen.queryByText(/emergency/i)).toBeNull();
    expect(screen.queryByText('Mansoor Seikh')).toBeNull();
    const robots = document.head.querySelector('meta[name="robots"]');
    expect(robots?.getAttribute('content')).toMatch(/noindex/);

    fireEvent.change(screen.getByLabelText(/four-digit PIN they gave you/), {
      target: { value: '2468' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(
      await screen.findByRole('heading', { name: 'Emergency information for Zain' }),
    ).toBeInTheDocument();
    // The window's title never says what it is.
    expect(document.title).toMatch(/^Shared information/);
    expect(screen.getByText('Penicillin · hives')).toBeInTheDocument();
    // Ticked but empty: said, never left to look like nothing is known.
    expect(screen.getByText('Nothing entered')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(EMERGENCY_NOT_ADVICE.slice(0, 30)))).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    await expectAccessible();
  });

  it('with no PIN, says it is some information, never whose, and titles the window neutrally', async () => {
    const state = fresh({
      shareEmergency: {
        person_name: 'Zain',
        date_of_birth: null,
        fields: { allergies: [{ id: 'a1', name: ALLERGY }] },
        shown: ['allergies'],
        updated_at: null,
      },
    });
    installFakeApi(state);
    render(<SharePage token="share-secret-0123456789abcdef" />);
    expect(
      await screen.findByRole('heading', { name: 'Information shared with you' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/shared some information with you/)).toBeInTheDocument();
    expect(screen.queryByText(/Zain/)).toBeNull();
    expect(screen.queryByText(/its pages/)).toBeNull();
    expect(document.title).toMatch(/^Shared information/);
  });
});

describe('after a restore (0.9.0, H4)', () => {
  it('says each person’s emergency information went back to them and the owners', async () => {
    installFakeApi(
      fresh({
        emergency: true,
        shares: [
          {
            id: 'sh-1',
            document_id: 'doc-1',
            document_title: 'Lease',
            recipient_label: 'Agent',
            expires_at: '2099-01-01T00:00:00Z',
            has_pin: false,
            state: 'paused',
          },
        ],
      }),
    );
    signedIn();
    window.history.replaceState({}, '', '/after-restore');
    render(<App />);
    const said = await screen.findByTestId('restore-emergency');
    expect(said).toHaveTextContent(
      'A restore also sets who can see each person’s emergency information back to the person and the owners, with nobody named.',
    );
    expect(said).not.toHaveTextContent(/allerg|medication|condition/i);
  });
});
