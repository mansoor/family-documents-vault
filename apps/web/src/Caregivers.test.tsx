import { CAREGIVER_MARK, GROWN_UP_QUESTION } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { bulkOffer } from './documents-table.js';
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
 * Caregivers for somebody's medical papers, and turning 18 (0.9.0, H1b):
 * the Caregivers card on a person's page and in Settings, a paper seen as a
 * caregiver (marked, and nothing offered that would change or send it), and
 * the turning-18 question on Home.
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

const SARA = {
  ...AISHA,
  id: 'm-sara',
  display_name: 'Sara',
  date_of_birth: null,
  has_account: true,
  role: 'adult',
};
const ZAIN = {
  ...AISHA,
  id: 'm-zain',
  display_name: 'Zain',
  date_of_birth: null,
  has_account: true,
  role: 'adult',
};

function at(
  path: string,
  over: Partial<FakeState>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh({ caregivers: true, members: [ME, AISHA, SARA, ZAIN], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const posted = (state: FakeState, url: string) =>
  state.calls.filter((c) => c.method === 'POST' && c.url === url);

describe('the Caregivers card (0.9.0, H1b)', () => {
  it('on your own page: let someone see your medical papers, then revoke after asking', async () => {
    const state = at('/people/me', {
      caregiversOf: {
        me: {
          items: [],
          may_add: true,
          candidates: [{ member_id: 'm-sara', display_name: 'Sara' }],
        },
      },
      caregiverLooks: [
        {
          caregiver_name: 'Zain',
          document_id: 'doc-9',
          title: null,
          sensitive: true,
          action: 'opened',
          at: '2026-11-14T10:00:00Z',
        },
      ],
    });
    const card = (await screen.findByRole('heading', { name: 'Caregivers' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(card).getByText('Nobody yet.')).toBeInTheDocument();
    // Who looked, a sensitive paper never by its title.
    expect(await within(card).findByText('Zain opened a sensitive document')).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText('Let someone see my medical papers'), {
      target: { value: 'm-sara' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Let them see' }));
    expect(
      await within(card).findByText('Sara can now see your medical papers.'),
    ).toBeInTheDocument();
    expect(posted(state, '/api/v1/members/me/caregivers')).toHaveLength(1);
    expect(
      within(card).getByText('Can see your medical papers, Only me ones included.'),
    ).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(card).getByRole('button', { name: 'Revoke Sara' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/won’t see your Only me medical papers/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(
      await within(card).findByText('Sara no longer sees your medical papers.'),
    ).toBeInTheDocument();
    expect(posted(state, '/api/v1/members/me/caregivers/m-sara/revoke')).toHaveLength(1);
  });

  it('on somebody else’s page the vault refuses: no card at all', async () => {
    at('/people/m-zain', { caregiversOf: {} }, 'adult');
    await screen.findByRole('heading', { name: 'Zain', level: 1 });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Caregivers' })).not.toBeInTheDocument(),
    );
  });

  it('without the vault saying so, nothing is drawn', async () => {
    at('/people/me', { caregivers: false });
    await screen.findByRole('heading', { name: 'Mansoor Seikh', level: 1 });
    expect(screen.queryByRole('heading', { name: 'Caregivers' })).not.toBeInTheDocument();
  });

  it('in Settings: whose papers you can see, and Stop seeing them after asking', async () => {
    const state = at('/settings/caregivers', {
      caregiversOf: { me: { items: [], may_add: false, candidates: [] } },
      myCaregivers: {
        about_me: [],
        for_others: [
          {
            id: 'g-1',
            person_member_id: 'm-zain',
            person_name: 'Zain',
            caregiver_member_id: 'me',
            caregiver_name: 'Mansoor Seikh',
            granted_at: '2026-11-14T09:00:00Z',
            granted_by_name: 'Zain',
            confirmed: true,
            may_revoke: false,
            may_keep: false,
            may_give_up: true,
          },
        ],
      },
    });
    await screen.findByRole('heading', { name: 'Papers you can see as a caregiver' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop seeing Zain’s medical papers' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop seeing them' }));
    await waitFor(() =>
      expect(posted(state, '/api/v1/members/m-zain/caregivers/me/revoke')).toHaveLength(1),
    );
  });
});

describe('a paper seen as a caregiver (0.9.0, H1b)', () => {
  it('is marked so, and offers nothing that changes or sends it', async () => {
    const paper = {
      ...PASSPORT,
      id: 'doc-care',
      type_key: null,
      title: 'Blood test results',
      category: 'medical',
      owner_member_id: 'm-zain',
      visibility: 'private',
      filed_by_me: false,
      caregiver: true as const,
    };
    at('/documents/doc-care', { documents: [paper] }, 'adult');
    expect(await screen.findByText(`${CAREGIVER_MARK}.`)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Zain lets you see their medical papers\. You can read this and save a copy/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Share a link/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Collections/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Visibility/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move to the Trash/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Add a new version')).not.toBeInTheDocument();
    await expectAccessible();
  });
});

describe('who looked, to an owner (0.9.0, H1b; the owner’s decision of 14 Nov 2026)', () => {
  it('on somebody’s page: who looked and when, never which Only me paper', async () => {
    at('/people/m-zain', {
      caregiversOf: {
        'm-zain': {
          items: [
            {
              id: 'g-1',
              person_member_id: 'm-zain',
              person_name: 'Zain',
              caregiver_member_id: 'm-sara',
              caregiver_name: 'Sara',
              granted_at: '2026-11-14T09:00:00Z',
              granted_by_name: 'Zain',
              confirmed: true,
              may_revoke: false,
              may_keep: false,
              may_give_up: false,
            },
          ],
          may_add: false,
          candidates: [],
        },
      },
      caregiverLooks: [
        {
          caregiver_name: 'Sara',
          document_id: null,
          title: null,
          sensitive: false,
          only_me: true,
          action: 'downloaded',
          at: '2026-11-14T10:00:00Z',
        },
      ],
    });
    const card = (await screen.findByRole('heading', { name: 'Caregivers' })).closest(
      'section',
    ) as HTMLElement;
    expect(
      await within(card).findByText('Sara saved a copy of one of their Only me papers'),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /saved a copy/ })).not.toBeInTheDocument();
  });

  it('another adult is shown no looks: the vault refuses them', async () => {
    const state = at('/people/m-zain', { caregiversOf: {} }, 'adult');
    await screen.findByRole('heading', { name: 'Zain', level: 1 });
    await waitFor(() => expect(state.calls.some((c) => c.url.includes('/caregivers'))).toBe(true));
    expect(state.calls.some((c) => c.url.includes('/caregiver-views'))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Who looked' })).not.toBeInTheDocument();
  });
});

describe('many at once (0.9.0, H1b)', () => {
  it('a paper seen as a caregiver goes in no collection, and is changed by nothing done to many', () => {
    const mine = { ...PASSPORT, id: 'd-mine', owner_member_id: 'me' };
    const theirs = {
      ...PASSPORT,
      id: 'd-care',
      owner_member_id: 'm-zain',
      visibility: 'private',
      filed_by_me: false,
      caregiver: true as const,
    };
    const who = { role: 'adult' as const, memberId: 'me', collections: true };
    const offer = bulkOffer(who, [mine, theirs] as never);
    expect(offer.collect).toBe(false);
    expect(offer.trash).toBe(false);
    expect(offer.location).toBe(false);
    expect(offer.visibility).toEqual([]);
    expect(offer.notes.join(' ')).toMatch(/shared with you as a caregiver/);
    expect(bulkOffer(who, [mine] as never).collect).toBe(true);
  });
});

describe('turning 18 on Home (0.9.0, H1b)', () => {
  it('somebody 18 who still signs in as a teen: the owners are told to change their role, with no answer offered', async () => {
    at('/', {
      grownUp: [
        {
          member_id: 'm-0',
          display_name: 'Aisha',
          turned_on: '2026-11-14',
          papers: 1,
          asks: 'role_first',
          title: 'Aisha is 18 or over and still signs in as a teen',
          label: 'Change Aisha’s role to adult on their page.',
        },
      ],
    });
    expect(
      await screen.findByText('Aisha is 18 or over and still signs in as a teen'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Aisha’s page' })).toHaveAttribute(
      'href',
      '/people/m-0',
    );
    expect(
      screen.queryByRole('button', { name: 'They want them kept as they are' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make them Only me' })).not.toBeInTheDocument();
  });

  it('asks the person once; Make them Only me asks first, then says what it did', async () => {
    const state = at(
      '/',
      {
        grownUp: [
          {
            member_id: 'me',
            display_name: 'Mansoor Seikh',
            turned_on: '2026-11-14',
            papers: 3,
            asks: 'self',
            title: GROWN_UP_QUESTION,
            label: 'You’re 18 now.',
          },
        ],
      },
      'adult',
    );
    expect(await screen.findByText(GROWN_UP_QUESTION)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make them Only me' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Your 3 medical papers become Only me/)).toBeInTheDocument();
    expect(posted(state, '/api/v1/members/me/grown-up-answer')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make them Only me' }));
    expect(
      await screen.findByText('Done. Your 3 medical papers are Only me now.'),
    ).toBeInTheDocument();
    expect(posted(state, '/api/v1/members/me/grown-up-answer')[0]?.body).toEqual({
      answer: 'only_me',
    });
  });

  it('an owner asks somebody without a sign-in in person: keep, or name a caregiver', async () => {
    const state = at('/', {
      grownUp: [
        {
          member_id: 'm-0',
          display_name: 'Aisha',
          turned_on: '2026-11-14',
          papers: 1,
          asks: 'in_person',
          title: 'Aisha is 18 today',
          label: 'Ask them in person whether their medical papers stay visible to the family.',
        },
      ],
    });
    expect(await screen.findByText('Aisha is 18 today')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Name a caregiver' })).toHaveAttribute(
      'href',
      '/people/m-0',
    );
    expect(screen.queryByRole('button', { name: 'Make them Only me' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'They want them kept as they are' }));
    expect(
      await screen.findByText('Aisha’s medical papers stay visible to the family.'),
    ).toBeInTheDocument();
    expect(posted(state, '/api/v1/members/m-0/grown-up-answer')[0]?.body).toEqual({
      answer: 'keep',
    });
  });
});
