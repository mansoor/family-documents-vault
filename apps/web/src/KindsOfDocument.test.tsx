import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PASSWORD_MANAGER } from './screens/KindsOfDocument.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * Settings → Kinds of document (5.12): the list with its Hide switches,
 * and the editor — what every card asks, what this kind's card asks, who
 * can see a new one, and what saving would do to the documents filed.
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

type Rule = { shown: boolean; required: boolean; label: string | null };

/** The seven fixed fields, each shown and not required, unless said otherwise. */
function core(over: Record<string, Partial<Rule>> = {}): Record<string, Rule> {
  const fields = ['identifier', 'issued_by', 'issued', 'expires', 'physical_location', 'tags'];
  return Object.fromEntries(
    [...fields, 'notes'].map((f) => [f, { shown: true, required: false, label: null, ...over[f] }]),
  );
}

const PASSPORT = {
  key: 'passport',
  label: 'Passport',
  category: 'identity',
  fields: [],
  expiry_driver: 'expires_on',
  reminder_leads: [270, 180],
  usually_essential: true,
  default_visibility: 'household',
  issued_by_label: 'Issuing country',
  builtin: true,
  hidden: false,
  short_label: null,
  issuer_noun: null,
  etag: '"passport.1"',
  core: core({
    identifier: { label: 'Passport number' },
    issued_by: { label: 'Issuing country' },
    expires: { required: true },
  }),
};

const WILL = {
  key: 'will',
  label: 'Will / trust / power of attorney',
  category: 'legal',
  fields: [
    { key: 'executor', label: 'Executor', kind: 'text', required: false },
    { key: 'last_reviewed', label: 'Last reviewed', kind: 'date', required: false },
  ],
  expiry_driver: 'review_on',
  reminder_leads: [0],
  usually_essential: false,
  default_visibility: 'adults',
  issued_by_label: null,
  builtin: true,
  hidden: false,
  short_label: null,
  issuer_noun: null,
  etag: '"will.1"',
  core: core(),
};

const ALLOTMENT = {
  key: 'h_allotment1',
  label: 'Allotment tenancy',
  category: 'property',
  fields: [],
  expiry_driver: null,
  reminder_leads: [],
  usually_essential: false,
  default_visibility: 'household',
  issued_by_label: null,
  builtin: false,
  hidden: false,
  short_label: null,
  issuer_noun: null,
  etag: '"h_allotment1.1"',
  core: core({ expires: { shown: false } }),
};

const LIBRARY = [
  { key: 'executor', label: 'Executor', kind: 'text', choices: null, builtin: true },
  { key: 'last_reviewed', label: 'Last reviewed', kind: 'date', choices: null, builtin: true },
  { key: 'place_of_birth', label: 'Place of birth', kind: 'text', choices: null, builtin: true },
  { key: 'plate', label: 'Plate', kind: 'text', choices: null, builtin: true },
  { key: 'tax_year', label: 'Tax year', kind: 'year', choices: null, builtin: true },
];

const UNSEEN = "Documents you can't see may also be affected.";

/** The vault, signed in as `role`, with the page at `path`. */
function open(
  path: string,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
  over: Partial<FakeState> = {},
): FakeState {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const state = fresh({
    types: clone([PASSPORT, WILL, ALLOTMENT]),
    attributes: clone(LIBRARY),
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const group = (name: string) => screen.getByRole('group', { name });
const lastCall = (state: FakeState, method: string) =>
  [...state.calls].reverse().find((c) => c.method === method && c.url.includes('document-'));

describe('Settings → Kinds of document (5.12)', () => {
  it('is offered to owners and adults, and to nobody else', async () => {
    for (const [role, offered] of [
      ['owner', true],
      ['adult', true],
      ['teen', false],
      ['viewer', false],
    ] as const) {
      open('/settings', role);
      await screen.findByRole('heading', { name: 'Settings', level: 1 });
      const link = screen.queryByRole('link', { name: /Kinds of document/ });
      expect(link !== null, role).toBe(offered);
      if (link) expect(link).toHaveAttribute('href', '/settings/kinds');
      cleanup();
    }
  });

  it('says who may, to a teen who finds their way there', async () => {
    open('/settings/kinds', 'teen');
    expect(
      await screen.findByText('Only an adult can change the kinds of document the family keeps.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('lists the kinds, and a built-in is hidden and offered again with its switch', async () => {
    const state = open('/settings/kinds');
    const hide = await screen.findByRole('switch', { name: 'Hide Passport' });
    expect(hide).not.toBeChecked();
    expect(screen.getByRole('link', { name: 'Add a kind' })).toHaveAttribute(
      'href',
      '/settings/kinds/new',
    );
    // The family's own are listed apart, and have no switch: they are archived instead.
    const own = screen.getByRole('region', { name: 'Your own' });
    expect(within(own).getByRole('link', { name: /Allotment tenancy/ })).toBeInTheDocument();
    expect(within(own).queryByRole('switch')).toBeNull();
    await expectAccessible();

    fireEvent.click(hide);
    expect(
      await screen.findByText(
        '“Passport” is no longer offered for new documents. Those already filed keep it.',
      ),
    ).toBeInTheDocument();
    expect(lastCall(state, 'POST')?.url).toContain('/document-types/passport/archive');
    expect(screen.getByRole('switch', { name: 'Hide Passport' })).toBeChecked();

    fireEvent.click(screen.getByRole('switch', { name: 'Hide Passport' }));
    expect(await screen.findByText('“Passport” is offered again.')).toBeInTheDocument();
    expect(lastCall(state, 'POST')?.url).toContain('/document-types/passport/restore');
  });

  it('the four locked rows cannot be unchecked', async () => {
    open('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    for (const name of ['What it is', 'Name', 'Whose it is', 'Who can see']) {
      const row = group(name);
      const box = within(row).getByRole('checkbox', { name: 'Always asked' });
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
      fireEvent.click(box);
      expect(box).toBeChecked();
      // With the reason it is there.
      expect(box).toHaveAccessibleDescription(/\w/);
      // Never "Required": it is not the family's to choose.
      expect(within(row).queryByRole('checkbox', { name: 'Required' })).toBeNull();
    }
    expect(within(group('Who can see')).getByText('Who may open it.')).toBeInTheDocument();
    await expectAccessible();
  });

  it('Required only on a shown field', async () => {
    const state = open('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });

    // A detail from the library this kind does not ask for: no Required.
    const place = group('Place of birth');
    expect(within(place).getByRole('checkbox', { name: 'Show' })).not.toBeChecked();
    expect(within(place).queryByRole('checkbox', { name: 'Required' })).toBeNull();
    fireEvent.click(within(place).getByRole('checkbox', { name: 'Show' }));
    fireEvent.click(within(place).getByRole('checkbox', { name: 'Required' }));
    expect(within(place).getByRole('checkbox', { name: 'Required' })).toBeChecked();
    // Hidden again, it cannot be required, and its Required goes with it.
    fireEvent.click(within(place).getByRole('checkbox', { name: 'Show' }));
    expect(within(place).queryByRole('checkbox', { name: 'Required' })).toBeNull();
    fireEvent.click(within(place).getByRole('checkbox', { name: 'Show' }));
    expect(within(place).getByRole('checkbox', { name: 'Required' })).not.toBeChecked();
    fireEvent.click(within(place).getByRole('checkbox', { name: 'Required' }));

    // The same for the fixed fields: a passport's number is required…
    const number = group('Number');
    expect(within(number).getByRole('checkbox', { name: 'Required' })).not.toBeChecked();
    fireEvent.click(within(number).getByRole('checkbox', { name: 'Required' }));
    // …until it is not shown.
    fireEvent.click(within(number).getByRole('checkbox', { name: 'Show' }));
    expect(within(number).queryByRole('checkbox', { name: 'Required' })).toBeNull();
    expect(within(number).queryByLabelText('What the card calls it')).toBeNull();
    // Expires is asked for whenever it is shown: there is no Required to choose.
    expect(within(group('Expires')).queryByRole('checkbox', { name: 'Required' })).toBeNull();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Passport” is saved.');
    const patch = lastCall(state, 'PATCH');
    expect(patch?.url).toContain('/document-types/passport');
    expect(patch?.headers?.['if-match']).toBe('"passport.1"');
    // Only what changed, and nothing required that is not shown.
    expect(patch?.body).toEqual({
      core: { identifier: { shown: false } },
      fields: [{ key: 'place_of_birth', required: true }],
    });
  });

  it('the warning says how many documents would need information', async () => {
    const impact = {
      key: 'passport',
      documents: 14,
      in_trash: 0,
      core: {
        ...Object.fromEntries(
          ['issued_by', 'issued', 'expires', 'physical_location', 'tags', 'notes'].map((f) => [
            f,
            { with_value: 14, without_value: 0 },
          ]),
        ),
        identifier: { with_value: 2, without_value: 12 },
      },
      fields: [],
      reminders: 20,
      unseen: UNSEEN,
    };
    open('/settings/kinds/passport', 'owner', { impact: { passport: impact } });
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    // Nothing changed yet: nothing to say.
    expect(screen.queryByText(UNSEEN)).toBeNull();

    fireEvent.click(within(group('Number')).getByRole('checkbox', { name: 'Required' }));
    expect(
      await screen.findByText(
        '12 documents have nothing in “Passport number” yet. They’ll show Needs info until someone fills it in.',
      ),
    ).toBeInTheDocument();
    // Counted among what the reader can see, and said so.
    expect(screen.getByText(UNSEEN)).toBeInTheDocument();

    // Not required after all: the warning goes.
    fireEvent.click(within(group('Number')).getByRole('checkbox', { name: 'Required' }));
    await waitFor(() => expect(screen.queryByText(/Needs info until/)).toBeNull());
    expect(screen.queryByText(UNSEEN)).toBeNull();

    // Stopping it expiring: its reminders stop, and the reader is told.
    fireEvent.click(within(group('Expires')).getByRole('checkbox', { name: 'Show' }));
    expect(
      await screen.findByText('Its 20 reminders stop: its documents no longer expire.'),
    ).toBeInTheDocument();
    expect(screen.getByText(UNSEEN)).toBeInTheDocument();
  });

  it('an adult is not offered a wider default visibility', async () => {
    open('/settings/kinds/will', 'adult');
    await screen.findByRole('heading', { name: 'Will / trust / power of attorney', level: 1 });
    const who = group('Who can see a new one');
    expect(within(who).getByRole('button', { name: 'Adults only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(who).getByRole('button', { name: 'Everyone' })).toBeDisabled();
    // Narrower is theirs to choose.
    expect(within(who).getByRole('button', { name: 'Only me' })).toBeEnabled();
    expect(
      within(who).getByText(
        'Only an owner can let more people see a kind of document from now on.',
      ),
    ).toBeInTheDocument();
    // A review date, reminded on the day, as a will is.
    expect(group('Review by')).toBeInTheDocument();
    expect(
      screen.getAllByText("We'll remind you on the day it's due for review.").length,
    ).toBeGreaterThan(0);
    await expectAccessible();
  });

  it('an owner widens it once they have confirmed it is them', async () => {
    const state = open('/settings/kinds/will', 'owner', { stepUpNeeded: true });
    await screen.findByRole('heading', { name: 'Will / trust / power of attorney', level: 1 });
    const everyone = within(group('Who can see a new one')).getByRole('button', {
      name: 'Everyone',
    });
    expect(everyone).toBeEnabled();
    fireEvent.click(everyone);
    expect(screen.getByText(/Saving asks you to confirm it’s you/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(
      within(prompt).getByText(
        'Please confirm it is you to let more people see a kind of document.',
      ),
    ).toBeInTheDocument();
    fireEvent.change(within(prompt).getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText('“Will / trust / power of attorney” is saved.'),
    ).toBeInTheDocument();
    const patches = state.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]?.body).toEqual({ default_visibility: 'household' });
    expect(state.types.find((t) => t.key === 'will')?.default_visibility).toBe('household');
  });

  it('a new kind: its name, one of the twelve categories, its reminders and a field of its own', async () => {
    const state = open('/settings/kinds/new');
    fireEvent.change(await screen.findByLabelText('Name of this kind'), {
      target: { value: '  Allotment   lease ' },
    });
    const category = screen.getByLabelText('Category');
    expect(within(category).getAllByRole('option')).toHaveLength(12);
    fireEvent.change(category, { target: { value: 'property' } });

    // Switching Expires on offers when to be reminded.
    const expires = group('Expires');
    expect(within(expires).queryByRole('group', { name: /Remind us/ })).toBeNull();
    fireEvent.click(within(expires).getByRole('checkbox', { name: 'Show' }));
    const chips = within(expires).getByRole('group', { name: 'Remind us before it expires' });
    expect(within(chips).getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(chips).getByRole('button', { name: '2 months' }));
    expect(
      within(expires).getByText("We'll remind you 2 months and 30 days before it expires."),
    ).toBeInTheDocument();

    // A field of their own, with no room for a password.
    const own = screen.getByRole('region', { name: 'Add your own field' });
    expect(within(own).getByText(PASSWORD_MANAGER)).toBeInTheDocument();
    fireEvent.change(within(own).getByLabelText('What it’s called'), {
      target: { value: 'Plot number' },
    });
    fireEvent.click(within(own).getByRole('button', { name: 'Add this field' }));
    expect(
      await screen.findByText(
        '“Plot number” is on the card now, and in the library for every kind.',
      ),
    ).toBeInTheDocument();
    expect(within(group('Plot number')).getByRole('checkbox', { name: 'Show' })).toBeChecked();

    // The card, as it will ask.
    const preview = screen.getByRole('region', { name: 'How the card will look' });
    expect(within(preview).getByText('Allotment lease')).toBeInTheDocument();
    expect(within(preview).getByText('Plot number')).toBeInTheDocument();
    expect(within(preview).getByText('Expires')).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Add this kind' }));
    expect(await screen.findByText('“Allotment lease” is ready to use.')).toBeInTheDocument();
    const attribute = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('attributes'));
    expect(attribute?.body).toEqual({ label: 'Plot number', kind: 'text' });
    const made = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('document-types'));
    expect(made?.body).toMatchObject({
      label: 'Allotment lease',
      category: 'property',
      core: { expires: { shown: true }, identifier: { shown: true, required: false, label: null } },
      fields: [{ key: 'h_field5', required: false }],
      reminder_leads: [30, 60],
      default_visibility: 'household',
      usually_essential: false,
    });
    // Listed as the family's own.
    const listed = within(screen.getByRole('region', { name: 'Your own' }));
    expect(await listed.findByRole('link', { name: /Allotment lease/ })).toBeInTheDocument();
  });

  it("archiving one of the family's own asks in the app's own dialog first", async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const state = open('/settings/kinds/h_allotment1');
    fireEvent.click(await screen.findByRole('button', { name: 'Archive this kind' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive “Allotment tenancy”?' });
    expect(within(dialog).getByText(/Every document filed under it keeps it/)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(state.calls.some((c) => c.url.endsWith('/archive'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Archive this kind' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive' }),
    );
    expect(
      await screen.findByText(
        '“Allotment tenancy” is archived. Every document filed under it keeps it.',
      ),
    ).toBeInTheDocument();
    expect(state.calls.some((c) => c.url.endsWith('/document-types/h_allotment1/archive'))).toBe(
      true,
    );
    expect(
      await within(screen.getByRole('region', { name: 'Your own' })).findByText(/Archived/),
    ).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });
});
