import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  ALWAYS_ASKED,
  DATES_HINT,
  EXPIRES_NOTE,
  LIBRARY_AT_ONCE,
  NO_DATE,
  NO_LEAD,
  ONLY_ME_DATE,
  PASSWORD_MANAGER,
  REMINDERS_INTRO,
  REMINDERS_OFF,
} from './screens/KindsOfDocument.js';
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

/** axe on the page, or on one part of it where the rest is as it was (the 5.16b review: it is slow). */
async function expectAccessible(context: Element = document.body) {
  const results = await axe.run(context, {
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

/** A household's own bill, reminded 7 days and 1 day before its due date (0.5.15). */
const COUNCIL = {
  key: 'h_council1',
  label: 'Council tax',
  category: 'financial',
  fields: [{ key: 'due_date', label: 'Due date', kind: 'date', required: true }],
  expiry_driver: null,
  reminder_leads: [],
  remind_from: 'due_date',
  remind_leads: [7, 1],
  usually_essential: false,
  default_visibility: 'household',
  issued_by_label: null,
  builtin: false,
  hidden: false,
  short_label: null,
  issuer_noun: null,
  etag: '"h_council1.1"',
  core: core({ expires: { shown: false } }),
};

const LIBRARY = [
  { key: 'executor', label: 'Executor', kind: 'text', choices: null, builtin: true },
  { key: 'last_reviewed', label: 'Last reviewed', kind: 'date', choices: null, builtin: true },
  { key: 'place_of_birth', label: 'Place of birth', kind: 'text', choices: null, builtin: true },
  { key: 'plate', label: 'Plate', kind: 'text', choices: null, builtin: true },
  { key: 'tax_year', label: 'Tax year', kind: 'year', choices: null, builtin: true },
  // What a bill reminds from (0.5.15).
  { key: 'due_date', label: 'Due date', kind: 'date', choices: null, builtin: true },
];

const UNSEEN = "Documents you can't see may also be affected.";

/** What a change to Passport would touch: 14 documents, 12 with no number. */
const PASSPORT_IMPACT = {
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

/** The web's stylesheet, read from disk: under Vitest an import of it is empty. */
const CSS = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();

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
/** Said by the editor as it happened, in a live status line. */
const said = (text: string) => {
  const line = screen.getByText(text);
  expect(line).toHaveAttribute('role', 'status');
  return line;
};
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
    open('/settings/kinds/passport', 'owner', { impact: { passport: PASSPORT_IMPACT } });
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

  it('the new-kind flow sends remind_from, not reminder_leads', async () => {
    const state = open('/settings/kinds/new');
    fireEvent.change(await screen.findByLabelText('Name of this kind'), {
      target: { value: '  Allotment   lease ' },
    });
    const category = screen.getByLabelText('Category');
    expect(within(category).getAllByRole('option')).toHaveLength(12);
    fireEvent.change(category, { target: { value: 'property' } });

    // Switching Expires on switches reminders on, 30 days before, and says so;
    // when to be reminded is in Reminders, not under Expires.
    const expires = group('Expires');
    const reminders = screen.getByRole('region', { name: 'Reminders' });
    expect(
      within(reminders).getByRole('switch', { name: 'Remind us before a date' }),
    ).not.toBeChecked();
    fireEvent.click(within(expires).getByRole('checkbox', { name: 'Show' }));
    expect(within(expires).queryByRole('group', { name: /Remind us/ })).toBeNull();
    expect(within(expires).getByText(EXPIRES_NOTE)).toBeInTheDocument();
    said('Reminders are on: 30 days before it expires.');
    const chips = within(reminders).getByRole('group', { name: 'How long before' });
    expect(within(chips).getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(chips).getByRole('button', { name: '2 months' }));
    expect(
      within(reminders).getByText("We'll remind you 2 months and 30 days before it expires."),
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
      fields: [{ key: `h_field${LIBRARY.length}`, required: false }],
      remind_from: 'expires',
      remind_leads: [60, 30],
      default_visibility: 'household',
      usually_essential: false,
    });
    expect(made?.body).not.toHaveProperty('reminder_leads');
    // Kept as the vault keeps it: from Expires, and Expires's lead times as
    // an older phone reads them.
    expect(state.types.at(-1)).toMatchObject({
      remind_from: 'expires',
      remind_leads: [60, 30],
      reminder_leads: [60, 30],
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

describe('Kinds of document: the 5.12 review', () => {
  it('a kind hidden with its switch is not offered on the Add card; a document filed under it keeps it', async () => {
    const state = open('/settings/kinds');
    fireEvent.click(await screen.findByRole('switch', { name: 'Hide Passport' }));
    await screen.findByText(/“Passport” is no longer offered for new documents/);
    // A passport is filed, so the vault still lists the kind, marked hidden.
    expect(state.types.find((t) => t.key === 'passport')?.hidden).toBe(true);
    expect(state.documents.some((d) => d.type_key === 'passport')).toBe(true);
    cleanup();

    // Not even from a link that names it.
    window.history.replaceState({}, '', '/add?type=passport');
    render(<App />);
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
    );
    expect(screen.queryByText(/Adding a passport/)).toBeNull();
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
    const what = screen.getByLabelText<HTMLSelectElement>('What it is');
    expect(what.value).toBe('');
    expect([...what.options].map((o) => o.text)).toEqual([
      'Not sure yet',
      'Will / trust / power of attorney',
      'Allotment tenancy',
    ]);
    cleanup();

    // The passport already filed still says what it is.
    window.history.replaceState({}, '', '/documents/doc-1/confirm');
    render(<App />);
    const kept = await screen.findByLabelText<HTMLSelectElement>('What it is');
    expect(kept.value).toBe('passport');
    expect([...kept.options].map((o) => o.text)).toContain('Passport');
  });

  it('Load the latest starts again from the saved copy, says so, and the place is on what it says', async () => {
    const state = open('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    // Somebody else renames its number meanwhile.
    state.types = state.types.map((t) =>
      t.key === 'passport'
        ? {
            ...t,
            etag: '"passport.2"',
            core: core({
              identifier: { label: 'Passport no.' },
              issued_by: { label: 'Issuing country' },
              expires: { required: true },
            }),
          }
        : t,
    );
    fireEvent.click(within(group('Number')).getByRole('checkbox', { name: 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this kind of document. Reload and try again.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load the latest' }));
    const said = await screen.findByText(
      'This is the latest, with the other change in it. Your changes weren’t kept: make them again, then save.',
    );
    expect(said).toHaveAttribute('role', 'status');
    await waitFor(() => expect(document.activeElement).toBe(said));
    // Theirs is in; what was ticked here is not.
    expect(within(group('Number')).getByLabelText('What the card calls it')).toHaveValue(
      'Passport no.',
    );
    expect(within(group('Number')).getByRole('checkbox', { name: 'Required' })).not.toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull();
    await expectAccessible();
  });

  it("a kind's own reminder time turned off stays a chip, and can be turned on again from where it was", async () => {
    // As Insurance and Vehicle are: 45 days, not one of the usual chips.
    open('/settings/kinds/passport', 'owner', {
      types: [{ ...PASSPORT, reminder_leads: [45, 7] }],
    });
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    const chip = within(group('How long before')).getByRole('button', {
      name: '45 days',
    });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    chip.focus();
    fireEvent.click(chip);
    // The same chip, off, with the place still on it.
    expect(within(group('How long before')).getByRole('button', { name: '45 days' })).toBe(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(document.activeElement).toBe(chip);
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('renaming a field a warning names does not say the warning again at every letter', async () => {
    open('/settings/kinds/passport', 'owner', { impact: { passport: PASSPORT_IMPACT } });
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    fireEvent.click(within(group('Number')).getByRole('checkbox', { name: 'Required' }));
    const warning = await screen.findByText(/^12 documents have nothing in “Passport number” yet/);
    const region = warning.closest('[aria-live]') as HTMLElement;
    expect(region).toHaveAttribute('aria-live', 'polite');

    const changes: MutationRecord[] = [];
    const watch = new MutationObserver((records) => changes.push(...records));
    watch.observe(region, { childList: true, subtree: true, characterData: true });
    const rename = within(group('Number')).getByLabelText('What the card calls it');
    for (const value of ['Passport numbe', 'Passport numb', 'Passport no', 'Passport no.']) {
      fireEvent.change(rename, { target: { value } });
    }
    await Promise.resolve();
    changes.push(...watch.takeRecords());
    watch.disconnect();
    // Nothing new in the live region: the warning is as it was, named as saved.
    expect(changes).toEqual([]);
    expect(warning.isConnected).toBe(true);
    expect(warning).toHaveTextContent(/^12 documents have nothing in “Passport number” yet/);
    // The preview follows the new name.
    const preview = screen.getByRole('region', { name: 'How the card will look' });
    expect(within(preview).getByText('Passport no.')).toBeInTheDocument();
  });

  it('adding a field says first that it goes into the library for good, and a name the library has is not added twice', async () => {
    const state = open('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    const own = screen.getByRole('region', { name: 'Add your own field' });
    const add = within(own).getByRole('button', { name: 'Add this field' });
    // Said before the button, and heard with it.
    const note = within(own).getByText(LIBRARY_AT_ONCE);
    expect(note.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add).toHaveAccessibleDescription(LIBRARY_AT_ONCE);

    fireEvent.change(within(own).getByLabelText('What it’s called'), {
      target: { value: '  place of  BIRTH ' },
    });
    fireEvent.click(add);
    expect(await within(own).findByRole('alert')).toHaveTextContent(
      'The library already has “Place of birth”. Tick Show beside it in the list above instead.',
    );
    expect(
      state.calls.some((c) => c.method === 'POST' && c.url.endsWith('/document-attributes')),
    ).toBe(false);
    expect(state.attributes).toHaveLength(LIBRARY.length);
    await expectAccessible();
  });

  it('a field the kind dropped, shown again as required, is counted as the vault counts it', async () => {
    // Executor was dropped from the will; 12 of its 14 documents keep a value.
    const will = { ...WILL, fields: [] };
    const impact = {
      ...PASSPORT_IMPACT,
      key: 'will',
      core: { ...PASSPORT_IMPACT.core, identifier: { with_value: 14, without_value: 0 } },
      fields: [{ key: 'executor', label: null, with_value: 12, without_value: 2 }],
    };
    open('/settings/kinds/will', 'owner', {
      types: [PASSPORT, will],
      impact: { will: impact },
    });
    await screen.findByRole('heading', { name: 'Will / trust / power of attorney', level: 1 });
    const executor = group('Executor');
    fireEvent.click(within(executor).getByRole('checkbox', { name: 'Show' }));
    fireEvent.click(within(executor).getByRole('checkbox', { name: 'Required' }));
    expect(
      await screen.findByText(
        '2 documents have nothing in “Executor” yet. They’ll show Needs info until someone fills it in.',
      ),
    ).toBeInTheDocument();
  });

  it('there is one switch: one set of rules, one knob', () => {
    expect(CSS.length).toBeGreaterThan(1000);
    expect(CSS.match(/^\.switch \{/gm)).toHaveLength(1);
    expect(CSS.match(/^\.switch input \{/gm)).toHaveLength(1);
    expect(CSS.match(/^\.switch input(:checked)?::(before|after) \{/gm)).toEqual([
      '.switch input::before {',
      '.switch input:checked::before {',
    ]);
  });

  it("on a narrow screen a field's Show and Required go under its name, and a long name breaks", () => {
    const rule = /^\.kind-field-name \{([^}]*)\}/m.exec(CSS)?.[1] ?? '';
    expect(rule).toMatch(/overflow-wrap: anywhere;/);
    const narrow =
      /@media \(max-width: (\d+)px\) \{\s*\.kind-field \{\s*grid-template-columns: minmax\(0, 1fr\);/.exec(
        CSS,
      );
    // 320px wide, and 1280 at 400% zoom, are among them.
    expect(Number(narrow?.[1] ?? 0)).toBeGreaterThanOrEqual(320);
  });
});

describe('Kinds of document: Reminders, from any date (5.16b)', () => {
  const reminders = () => screen.getByRole('region', { name: 'Reminders' });
  const theSwitch = () =>
    within(reminders()).getByRole('switch', { name: 'Remind us before a date' });
  const theDate = () => within(reminders()).getByLabelText<HTMLSelectElement>('The date');
  const chips = () => within(reminders()).getByRole('group', { name: 'How long before' });
  const pressed = () =>
    within(chips())
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent);
  const show = (name: string) =>
    fireEvent.click(within(group(name)).getByRole('checkbox', { name: 'Show' }));
  const withCouncil = { types: [PASSPORT, WILL, ALLOTMENT, COUNCIL] };

  it('Reminders offers only the dates the kind shows, in its words', async () => {
    open('/settings/kinds/will');
    await screen.findByRole('heading', { name: 'Will / trust / power of attorney', level: 1 });
    expect(within(reminders()).getByText(REMINDERS_INTRO)).toBeInTheDocument();
    expect(theSwitch()).toBeChecked();
    // Review by, in the Will's words, then its date field; never Issued,
    // which the Will shows, nor a year.
    const options = () => [...theDate().options].map((o) => o.text);
    expect(options()).toEqual(['Review by', 'Last reviewed']);
    expect(theDate()).toHaveValue('expires');
    expect(within(reminders()).getByText(DATES_HINT)).toBeInTheDocument();
    show('Tax year');
    expect(options()).toEqual(['Review by', 'Last reviewed']);
    // Another date shown is offered, in the kind's order.
    show('Due date');
    expect(options()).toEqual(['Review by', 'Last reviewed', 'Due date']);
    show('Last reviewed');
    expect(options()).toEqual(['Review by', 'Due date']);
    // The Will's Expires row points here, and still says Review by.
    expect(within(group('Review by')).getByText(EXPIRES_NOTE)).toBeInTheDocument();
    expect(within(group('Review by')).queryByRole('group', { name: /Remind us/ })).toBeNull();
  });

  it('switching on picks Expires, or the first date shown, with 30 days, or 7 for Due date', async () => {
    // A kind that asks for no date: on, it waits for one.
    open('/settings/kinds/h_allotment1', 'owner', withCouncil);
    await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
    expect(theSwitch()).not.toBeChecked();
    expect(within(reminders()).getByText(REMINDERS_OFF)).toBeInTheDocument();
    fireEvent.click(theSwitch());
    said(NO_DATE);
    expect(within(reminders()).queryByLabelText('The date')).toBeNull();
    // A date shown now is the one: Due date, 7 days before.
    show('Due date');
    said('Reminders are on: 7 days before its due date.');
    expect(theDate()).toHaveValue('due_date');
    expect(pressed()).toEqual(['7 days']);
    cleanup();

    // Any other date: 30 days.
    open('/settings/kinds/h_allotment1', 'owner', withCouncil);
    await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
    show('Last reviewed');
    expect(theSwitch()).not.toBeChecked();
    fireEvent.click(theSwitch());
    said('Reminders are on: 30 days before its last reviewed.');
    expect(theDate()).toHaveValue('last_reviewed');
    expect(pressed()).toEqual(['30 days']);
    // Another date, the chips untouched: that date's own times.
    show('Due date');
    fireEvent.change(theDate(), { target: { value: 'due_date' } });
    said('Reminders are on: 7 days before its due date.');
    expect(pressed()).toEqual(['7 days']);
    // Chips chosen by hand stay with the next date.
    fireEvent.click(within(chips()).getByRole('button', { name: '14 days' }));
    fireEvent.change(theDate(), { target: { value: 'last_reviewed' } });
    expect(pressed()).toEqual(['7 days', '14 days']);
    cleanup();

    // Expires first, when it shows: 30 days, or the times it kept.
    const kept = {
      ...ALLOTMENT,
      expiry_driver: 'expires_on',
      reminder_leads: [],
      remind_from: null,
      remind_leads: [],
      core: core(),
      fields: [{ key: 'due_date', label: 'Due date', kind: 'date', required: false }],
    };
    open('/settings/kinds/h_allotment1', 'owner', { types: [kept] });
    await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
    fireEvent.click(theSwitch());
    said('Reminders are on: 30 days before it expires.');
    expect(theDate()).toHaveValue('expires');
    expect(pressed()).toEqual(['30 days']);
  });

  it('ticking Expires on a kind with no reminders turns them on, and says so', async () => {
    const state = open('/settings/kinds/h_allotment1', 'owner', withCouncil);
    await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
    show('Expires');
    said('Reminders are on: 30 days before it expires.');
    expect(theSwitch()).toBeChecked();
    expect(theDate()).toHaveValue('expires');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Allotment tenancy” is saved.');
    expect(lastCall(state, 'PATCH')?.body).toEqual({
      core: { expires: { shown: true } },
      remind_from: 'expires',
      remind_leads: [30],
    });
    cleanup();

    // Never when another date reminds.
    open('/settings/kinds/h_council1', 'owner', withCouncil);
    await screen.findByRole('heading', { name: 'Council tax', level: 1 });
    show('Expires');
    expect(theDate()).toHaveValue('due_date');
    expect(screen.queryByText(/^Reminders are on/)).toBeNull();
  });

  it('hiding the reminding date switches them off, and says so', async () => {
    const state = open('/settings/kinds/h_council1', 'owner', withCouncil);
    await screen.findByRole('heading', { name: 'Council tax', level: 1 });
    expect(theDate()).toHaveValue('due_date');
    show('Due date');
    said('Reminders are off: this kind no longer asks for its due date.');
    expect(theSwitch()).not.toBeChecked();
    expect(within(reminders()).getByText(REMINDERS_OFF)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Council tax” is saved.');
    // The vault switches them off by itself, as the page did.
    expect(lastCall(state, 'PATCH')?.body).toEqual({ fields: [] });
    expect(state.types.find((t) => t.key === 'h_council1')).toMatchObject({
      remind_from: null,
      remind_leads: [],
    });
    cleanup();

    // Expires hidden on a passport: off, and the passport keeps its times.
    open('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    show('Expires');
    said('Reminders are off: this kind no longer asks for its expiry date.');
    show('Expires');
    said('Reminders are on: 9 months and 6 months before it expires.');
  });

  it('the reminding date is required and locked, with the reason', async () => {
    const state = open('/settings/kinds/h_council1', 'owner', withCouncil);
    await screen.findByRole('heading', { name: 'Council tax', level: 1 });
    const required = within(group('Due date')).getByRole('checkbox', { name: 'Required' });
    expect(required).toBeChecked();
    expect(required).toBeDisabled();
    expect(required).toHaveAccessibleDescription(ALWAYS_ASKED);
    fireEvent.click(required);
    expect(required).toBeChecked();
    // Moved to another date, it is the family's to choose again.
    show('Last reviewed');
    fireEvent.change(theDate(), { target: { value: 'last_reviewed' } });
    const now = within(group('Due date')).getByRole('checkbox', { name: 'Required' });
    expect(now).toBeEnabled();
    expect(now).toBeChecked();
    expect(
      within(group('Last reviewed')).getByRole('checkbox', { name: 'Required' }),
    ).toBeDisabled();
    fireEvent.click(now);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Council tax” is saved.');
    expect(lastCall(state, 'PATCH')?.body).toEqual({
      fields: [
        { key: 'due_date', required: false },
        { key: 'last_reviewed', required: true },
      ],
      remind_from: 'last_reviewed',
      remind_leads: [30],
    });
  });

  it('Save waits for a date and a lead time', async () => {
    const state = open('/settings/kinds/h_allotment1', 'owner', withCouncil);
    await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
    fireEvent.click(theSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(NO_DATE);
    expect(theSwitch()).toHaveFocus();

    show('Due date');
    fireEvent.click(within(chips()).getByRole('button', { name: '7 days' }));
    said(NO_LEAD);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(NO_LEAD));
    expect(within(chips()).getAllByRole('button')[0]).toHaveFocus();
    expect(state.calls.some((c) => c.method === 'PATCH')).toBe(false);

    // Or switched off: nothing to wait for.
    fireEvent.click(theSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Allotment tenancy” is saved.');
  });

  it('a kind showing two dates says which one reminds', async () => {
    const state = open('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    // One date: nothing to say.
    expect(screen.queryByText(/^Only .* reminds/)).toBeNull();
    show('Due date');
    expect(
      within(reminders()).getByText('Only Expires reminds: nobody is told before its due date.'),
    ).toBeInTheDocument();
    fireEvent.change(theDate(), { target: { value: 'due_date' } });
    const says = [
      "We'll remind you 7 days before its due date.",
      'Only Due date reminds: nobody is told before it expires, and its badge warns only on the day it expires.',
      'We remind you once for this date: nothing repeats. When the next one is due, change the date or add the next one.',
      'Every document of this kind needs its due date: without one it reads Needs a due date.',
      ONLY_ME_DATE,
    ];
    for (const s of says) expect(within(reminders()).getByText(s)).toBeInTheDocument();
    // Heard with the date chosen.
    expect(theDate()).toHaveAttribute('aria-describedby', 'k-rem-says');
    expect(theDate()).toHaveAccessibleDescription(/^We'll remind you 7 days before its due date\./);
    // The preview says it under the date it is about.
    const preview = screen.getByRole('region', { name: 'How the card will look' });
    const due = within(preview).getByText('Due date').closest('li') as HTMLElement;
    expect(within(due).getByText(says[0] as string)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Passport” is saved.');
    expect(lastCall(state, 'PATCH')?.body).toEqual({
      fields: [{ key: 'due_date', required: true }],
      remind_from: 'due_date',
      remind_leads: [7],
    });
    // Kept as the vault keeps it: an older phone reads no lead times for Expires.
    expect(state.types.find((t) => t.key === 'passport')).toMatchObject({
      remind_from: 'due_date',
      remind_leads: [7],
      reminder_leads: [],
    });
  });

  it('the warning gives both counts, the dropped reminders and the unseen sentence', async () => {
    // 25 not dealt with, 20 of them about Expires: the counts are by date.
    const impact = {
      ...PASSPORT_IMPACT,
      fields: [{ key: 'due_date', label: null, with_value: 2, without_value: 12 }],
      reminders: 25,
      reminders_by_source: { expires: 20, due_date: 5 },
    };
    open('/settings/kinds/passport', 'owner', { impact: { passport: impact } });
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    show('Due date');
    fireEvent.change(theDate(), { target: { value: 'due_date' } });
    expect(
      await screen.findByText(
        'Its reminders move to Due date. Of its 14 documents, 2 have a due date and are reminded from it; 12 have none yet and will read Needs a due date, on Home too, until someone adds it. 20 reminders from Expires not dealt with yet are dropped. Only reminders still to come are made.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(UNSEEN)).toBeInTheDocument();
    // Said once: not again as a field that needs information.
    expect(screen.queryByText(/nothing in “Due date” yet/)).toBeNull();

    // Switched off instead.
    fireEvent.click(theSwitch());
    expect(
      await screen.findByText('Its 20 reminders stop: nobody is reminded about these documents.'),
    ).toBeInTheDocument();
    expect(screen.getByText(UNSEEN)).toBeInTheDocument();
    cleanup();

    // The date they come from hidden: they stop, and why.
    open('/settings/kinds/h_council1', 'owner', {
      ...withCouncil,
      impact: {
        h_council1: {
          ...PASSPORT_IMPACT,
          key: 'h_council1',
          documents: 4,
          fields: [{ key: 'due_date', label: null, with_value: 0, without_value: 4 }],
          reminders: 3,
          reminders_by_source: { due_date: 3 },
        },
      },
    });
    await screen.findByRole('heading', { name: 'Council tax', level: 1 });
    show('Due date');
    expect(
      await screen.findByText('Its 3 reminders stop: it no longer asks for its due date.'),
    ).toBeInTheDocument();
    expect(screen.getByText(UNSEEN)).toBeInTheDocument();
  });

  it('Reminders passes axe with its own ids, and the chips keep focus', async () => {
    open('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    await expectAccessible();
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(ids).toEqual(
      expect.arrayContaining(['k-rem-h', 'k-rem-on', 'k-rem-from', 'k-rem-leads-l', 'k-rem-says']),
    );
    expect(ids).not.toContain('k-leads-l');
    expect(theDate()).toHaveAccessibleDescription(
      "We'll remind you 9 months and 6 months before it expires.",
    );
    const chip = within(chips()).getByRole('button', { name: '2 months' });
    chip.focus();
    fireEvent.click(chip);
    expect(within(chips()).getByRole('button', { name: '2 months' })).toBe(chip);
    expect(chip).toHaveFocus();
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    // With a date field reminding, and switched off, still: only Reminders,
    // and the field whose Required it locks, have changed.
    show('Due date');
    fireEvent.change(theDate(), { target: { value: 'due_date' } });
    await expectAccessible(reminders());
    await expectAccessible(group('Due date'));
    fireEvent.click(theSwitch());
    await expectAccessible(reminders());
  });

  it('without the flag the chips stay under Expires', async () => {
    const own = { key: 'h_field9', label: 'Due date', kind: 'date', choices: null, builtin: false };
    const state = open('/settings/kinds/passport', 'owner', {
      reminderDates: false,
      attributes: [...LIBRARY, own],
    });
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    expect(screen.queryByRole('region', { name: 'Reminders' })).toBeNull();
    const expires = group('Expires');
    const old = within(expires).getByRole('group', { name: 'Remind us before it expires' });
    fireEvent.click(within(old).getByRole('button', { name: '2 months' }));
    expect(
      within(expires).getByText(
        "We'll remind you 9 months, 6 months and 2 months before it expires.",
      ),
    ).toBeInTheDocument();
    // A household's own named like a built-in is not told apart either.
    expect(screen.queryByText(/\(your own\)/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Passport” is saved.');
    expect(lastCall(state, 'PATCH')?.body).toEqual({ reminder_leads: [270, 180, 60] });
  });

  it("a household's own Due date reads (your own)", async () => {
    const own = { key: 'h_field9', label: 'due date', kind: 'date', choices: null, builtin: false };
    open('/settings/kinds/h_allotment1', 'owner', {
      attributes: [...LIBRARY, own],
    });
    await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
    // Both are in Details, told apart.
    expect(group('Due date')).toBeInTheDocument();
    const mine = group('due date (your own)');
    fireEvent.click(within(mine).getByRole('checkbox', { name: 'Show' }));
    show('Due date');
    fireEvent.click(theSwitch());
    expect([...theDate().options].map((o) => o.text)).toEqual(['due date (your own)', 'Due date']);
    // Its own lead times: not a built-in's; and named apart from the built-in.
    said('Reminders are on: 30 days before its due date (your own).');
  });

  describe('the 5.16b review', () => {
    /** A passport that asks for a due date too, not required; it reminds from Expires. */
    const PASSPORT_DUE = {
      ...PASSPORT,
      fields: [{ key: 'due_date', label: 'Due date', kind: 'date', required: false }],
    };
    /** A gym membership: it shows Expires, and on purpose reminds nobody. */
    const GYM = {
      ...ALLOTMENT,
      key: 'h_gym1',
      label: 'Gym membership',
      expiry_driver: 'expires_on',
      remind_from: null,
      remind_leads: [],
      etag: '"h_gym1.1"',
      core: core(),
    };
    /** What a change to a kind would touch: `documents`, each with every fixed field filled. */
    const impactOf = (key: string, documents: number, over: Record<string, unknown> = {}) => ({
      ...PASSPORT_IMPACT,
      key,
      documents,
      core: Object.fromEntries(
        Object.keys(PASSPORT_IMPACT.core).map((f) => [
          f,
          { with_value: documents, without_value: 0 },
        ]),
      ),
      fields: [],
      reminders: 0,
      reminders_by_source: {},
      ...over,
    });
    const nothingSaved = async (state: FakeState) => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Nothing had changed.')).toBeInTheDocument();
      expect(state.calls.some((c) => c.method === 'PATCH')).toBe(false);
    };

    it('Select to Due date and back to Expires keeps [270,180], and Save sends nothing about reminders', async () => {
      const state = open('/settings/kinds/passport', 'owner', {
        types: [PASSPORT_DUE, WILL, ALLOTMENT],
      });
      await screen.findByRole('heading', { name: 'Passport', level: 1 });
      const required = () => within(group('Due date')).getByRole('checkbox', { name: 'Required' });
      expect(pressed()).toEqual(['6 months', '9 months']);
      expect(required()).not.toBeChecked();
      // Arrowing through the closed Select: Due date on the way…
      fireEvent.change(theDate(), { target: { value: 'due_date' } });
      expect(pressed()).toEqual(['7 days']);
      expect(required()).toBeChecked();
      expect(required()).toBeDisabled();
      // …and back: as saved, and said.
      fireEvent.change(theDate(), { target: { value: 'expires' } });
      said('Reminders are on: 9 months and 6 months before it expires.');
      expect(pressed()).toEqual(['6 months', '9 months']);
      // Due date is the family's to require again, as they had it.
      expect(required()).toBeEnabled();
      expect(required()).not.toBeChecked();
      await nothingSaved(state);
    });

    it('unticking and re-ticking the reminding date restores it', async () => {
      const state = open('/settings/kinds/h_council1', 'owner', withCouncil);
      await screen.findByRole('heading', { name: 'Council tax', level: 1 });
      show('Due date');
      said('Reminders are off: this kind no longer asks for its due date.');
      show('Due date');
      said('Reminders are on: 7 days and 1 day before its due date.');
      expect(theSwitch()).toBeChecked();
      expect(theDate()).toHaveValue('due_date');
      expect(pressed()).toEqual(['1 day', '7 days']);
      expect(within(group('Due date')).getByRole('checkbox', { name: 'Required' })).toBeDisabled();
      await nothingSaved(state);
    });

    it('the Gym case: Expires unticked and ticked again does not switch reminders on', async () => {
      const state = open('/settings/kinds/h_gym1', 'owner', { types: [GYM] });
      await screen.findByRole('heading', { name: 'Gym membership', level: 1 });
      expect(theSwitch()).not.toBeChecked();
      show('Expires');
      show('Expires');
      expect(theSwitch()).not.toBeChecked();
      expect(screen.queryByText(/^Reminders are on/)).toBeNull();
      await nothingSaved(state);
    });

    it('switched off and on again, a kind showing Expires and Due date keeps its saved date', async () => {
      // A bill that shows Expires too, and reminds from its due date.
      const both = { ...COUNCIL, expiry_driver: 'expires_on', core: core() };
      const state = open('/settings/kinds/h_council1', 'owner', { types: [both] });
      await screen.findByRole('heading', { name: 'Council tax', level: 1 });
      fireEvent.click(theSwitch());
      fireEvent.click(theSwitch());
      expect(theDate()).toHaveValue('due_date');
      expect(pressed()).toEqual(['1 day', '7 days']);
      said('Reminders are on: 7 days and 1 day before its due date.');
      await nothingSaved(state);
    });

    it('switched on first, a date field of their own added after is the date, 30 days before', async () => {
      const state = open('/settings/kinds/h_allotment1');
      await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
      fireEvent.click(theSwitch());
      said(NO_DATE);
      // The owner's own example: a car's MOT, a date.
      const own = screen.getByRole('region', { name: 'Add your own field' });
      fireEvent.change(within(own).getByLabelText('What it’s called'), {
        target: { value: 'MOT' },
      });
      fireEvent.change(within(own).getByLabelText('What it holds'), {
        target: { value: 'date' },
      });
      fireEvent.click(within(own).getByRole('button', { name: 'Add this field' }));
      await screen.findByText('“MOT” is on the card now, and in the library for every kind.');
      const mot = `h_field${LIBRARY.length}`;
      said('Reminders are on: 30 days before its MOT.');
      expect(theDate()).toHaveValue(mot);
      expect([...theDate().options].map((o) => o.text)).toEqual(['MOT']);
      expect(pressed()).toEqual(['30 days']);
      expect(screen.queryByText(NO_DATE)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByText('“Allotment tenancy” is saved.');
      expect(lastCall(state, 'PATCH')?.body).toEqual({
        fields: [{ key: mot, required: true }],
        remind_from: mot,
        remind_leads: [30],
      });
    });

    it('what is changed while a field is being added stays changed when it lands', async () => {
      let land = () => {};
      const landed = new Promise<void>((resolve) => {
        land = resolve;
      });
      open('/settings/kinds/h_allotment1', 'owner', {
        hold: (method, path) =>
          method === 'POST' && path === '/api/v1/document-attributes' ? landed : undefined,
      });
      await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
      const own = screen.getByRole('region', { name: 'Add your own field' });
      fireEvent.change(within(own).getByLabelText('What it’s called'), {
        target: { value: 'Plot' },
      });
      fireEvent.click(within(own).getByRole('button', { name: 'Add this field' }));
      await within(own).findByRole('button', { name: 'Adding…' });
      // While it is being added.
      show('Last reviewed');
      fireEvent.click(theSwitch());
      expect(theDate()).toHaveValue('last_reviewed');
      land();
      await screen.findByText('“Plot” is on the card now, and in the library for every kind.');
      expect(within(group('Plot')).getByRole('checkbox', { name: 'Show' })).toBeChecked();
      expect(within(group('Last reviewed')).getByRole('checkbox', { name: 'Show' })).toBeChecked();
      expect(theSwitch()).toBeChecked();
      expect(theDate()).toHaveValue('last_reviewed');
      expect(pressed()).toEqual(['30 days']);
    });

    it('switching reminders on says, before saving, what that does to the documents', async () => {
      open('/settings/kinds/h_gym1', 'owner', {
        types: [GYM],
        impact: { h_gym1: impactOf('h_gym1', 14) },
      });
      await screen.findByRole('heading', { name: 'Gym membership', level: 1 });
      expect(screen.queryByText(UNSEEN)).toBeNull();
      fireEvent.click(theSwitch());
      expect(
        await screen.findByText(
          'Its reminders will come from Expires. All 14 of its documents have an expiry date and are reminded from it. Only reminders still to come are made.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(UNSEEN)).toBeInTheDocument();
      cleanup();

      // Switched on by showing Expires: said once, with those that have none.
      const none = impactOf('h_allotment1', 14);
      open('/settings/kinds/h_allotment1', 'owner', {
        impact: {
          h_allotment1: {
            ...none,
            core: { ...none.core, expires: { with_value: 0, without_value: 14 } },
          },
        },
      });
      await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
      show('Expires');
      expect(
        await screen.findByText(
          'Its reminders will come from Expires. None of its 14 documents has an expiry date yet: they will read Needs an expiry date, on Home too, until someone adds it. Only reminders still to come are made.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/nothing in “Expires” yet/)).toBeNull();
      expect(screen.getByText(UNSEEN)).toBeInTheDocument();
    });

    it('an own Due date beside the built-in: each sentence names the one it means', async () => {
      const mine = {
        key: 'h_field9',
        label: 'Due date',
        kind: 'date',
        choices: null,
        builtin: false,
      };
      const WATER = {
        ...COUNCIL,
        key: 'h_water1',
        label: 'Water bill',
        etag: '"h_water1.1"',
        fields: [
          { key: 'h_field9', label: 'Due date', kind: 'date', required: true },
          { key: 'due_date', label: 'Due date', kind: 'date', required: false },
        ],
        remind_from: 'h_field9',
        remind_leads: [30],
      };
      // 4 bills, each with its own due date and 3 reminders from it; 1 has the built-in.
      const impact = impactOf('h_water1', 4, {
        fields: [
          { key: 'h_field9', label: null, with_value: 4, without_value: 0 },
          { key: 'due_date', label: null, with_value: 1, without_value: 3 },
        ],
        reminders: 3,
        reminders_by_source: { h_field9: 3 },
      });
      const water = () => {
        open('/settings/kinds/h_water1', 'owner', {
          types: [WATER],
          attributes: [...LIBRARY, mine],
          impact: { h_water1: impact },
        });
        return screen.findByRole('heading', { name: 'Water bill', level: 1 });
      };
      await water();
      expect([...theDate().options].map((o) => o.text)).toEqual([
        'Due date (your own)',
        'Due date',
      ]);
      const says = () =>
        [...(document.getElementById('k-rem-says')?.querySelectorAll('p') ?? [])].map(
          (p) => p.textContent,
        );
      expect(says()).toEqual(
        expect.arrayContaining([
          "We'll remind you 30 days before its due date (your own).",
          'Only Due date (your own) reminds: nobody is told before its due date.',
          'Every document of this kind needs its due date (your own): without one it reads Needs a due date.',
        ]),
      );
      fireEvent.change(theDate(), { target: { value: 'due_date' } });
      said('Reminders are on: 7 days before its due date.');
      expect(says()).toEqual(
        expect.arrayContaining([
          "We'll remind you 7 days before its due date.",
          'Only Due date reminds: nobody is told before its due date (your own).',
          'Every document of this kind needs its due date: without one it reads Needs a due date.',
        ]),
      );
      // Before saving, the reminders dropped are named as the chooser names their date.
      expect(
        await screen.findByText(
          /^Its reminders move to Due date\. .* 3 reminders from Due date \(your own\) not dealt with yet are dropped\./,
        ),
      ).toBeInTheDocument();
      cleanup();

      // Their own hidden while the built-in is still asked: which one, said.
      await water();
      show('Due date (your own)');
      said('Reminders are off: this kind no longer asks for its due date (your own).');
      expect(
        await screen.findByText(
          'Its 3 reminders stop: it no longer asks for its due date (your own).',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          '4 documents have something in “Due date (your own)”. It stays, under Other details; the card just stops asking for it.',
        ),
      ).toBeInTheDocument();
    });

    it('switched off by hand on a kind reminding from its due date, remind_from: null is saved', async () => {
      const state = open('/settings/kinds/h_council1', 'owner', withCouncil);
      await screen.findByRole('heading', { name: 'Council tax', level: 1 });
      fireEvent.click(theSwitch());
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByText('“Council tax” is saved.');
      expect(lastCall(state, 'PATCH')?.body).toEqual({ remind_from: null });
      expect(state.types.find((t) => t.key === 'h_council1')).toMatchObject({
        remind_from: null,
        remind_leads: [],
      });
    });

    it('Expires shown on a kind that reminds nobody, then switched off, stays off', async () => {
      const state = open('/settings/kinds/h_allotment1', 'owner', withCouncil);
      await screen.findByRole('heading', { name: 'Allotment tenancy', level: 1 });
      show('Expires');
      fireEvent.click(theSwitch());
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByText('“Allotment tenancy” is saved.');
      // Without it the vault would start reminding from Expires, as for older phones.
      expect(lastCall(state, 'PATCH')?.body).toEqual({
        core: { expires: { shown: true } },
        remind_from: null,
      });
      expect(state.types.find((t) => t.key === 'h_allotment1')).toMatchObject({
        remind_from: null,
      });
    });

    it('a new kind showing Expires with reminders off is made reminding nobody', async () => {
      const state = open('/settings/kinds/new');
      fireEvent.change(await screen.findByLabelText('Name of this kind'), {
        target: { value: 'Gym pass' },
      });
      show('Expires');
      fireEvent.click(theSwitch());
      fireEvent.click(screen.getByRole('button', { name: 'Add this kind' }));
      expect(await screen.findByText('“Gym pass” is ready to use.')).toBeInTheDocument();
      const made = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('document-types'));
      expect(made?.body).toMatchObject({ core: { expires: { shown: true } }, remind_from: null });
      expect(made?.body).not.toHaveProperty('remind_leads');
      expect(state.types.at(-1)).toMatchObject({ remind_from: null, remind_leads: [] });
    });
  });
});
