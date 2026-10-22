import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  TYPES,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * A collection from a checklist on the web (0.9.0, C1): Fill from a
 * checklist on a collection's page and Start from a checklist as one is
 * made — paste, see what was understood and found, change a line, add what
 * is ticked (nothing before), keep the list, and ask for the missing ones.
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

const kind = (key: string, label: string, short?: string) => ({
  key,
  label,
  category: 'financial',
  fields: [],
  expiry_driver: null,
  reminder_leads: [],
  usually_essential: false,
  default_visibility: 'adults',
  issued_by_label: null,
  ...(short ? { short_label: short } : {}),
});
const KINDS = [
  ...TYPES.map((t) => (t.key === 'bank_statement' ? { ...t, label: 'Bank statement' } : t)),
  kind('pay_statement', 'Pay statement / payslip', 'Pay statement'),
  kind('investment_statement', 'Investment statement'),
  kind('tax_form', 'W-2 / 1099 / tax form', 'Tax form'),
];
const RICHA = { ...ME, id: 'm-richa', display_name: 'Richa', is_me: false, role: 'adult' };
const doc = (id: string, title: string, type_key: string, date: string, over = {}) => ({
  ...PASSPORT,
  id,
  title,
  type_key,
  visibility: 'adults',
  owner_member_id: 'me',
  issued: { date, precision: 'day' },
  expires: null,
  etag: `"${id}"`,
  ...over,
});
const DOCS = [
  doc('pay-sep', 'Acme payslip September', 'pay_statement', '2026-09-30'),
  doc('pay-aug', 'Acme payslip August', 'pay_statement', '2026-08-31'),
  doc('pay-jul', 'Acme payslip July', 'pay_statement', '2026-07-31'),
  doc('pay-jun', 'Acme payslip June', 'pay_statement', '2026-06-30'),
  doc('bank-sep', 'Harbour Bank statement', 'bank_statement', '2026-09-30'),
  doc('w2-2025', 'W-2 Acme 2025', 'tax_form', '2026-01-28', { extra: { tax_year: 2025 } }),
  doc('richa-pay', 'Richa payslip September', 'pay_statement', '2026-09-25', {
    owner_member_id: 'm-richa',
  }),
];
const REFI: FakeCollection = {
  id: 'col-refi',
  name: 'Refinance',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"refi.1"',
  items: [],
};
const LIST = `Documents for Mansoor
W2 for 2025 and 2024
Last 3 pay statements
Last 2 bank statements
Documents for Richa
Last 2 pay statements
and so on`;

function at(
  path: string,
  over: Partial<FakeState> = {},
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh({
    types: KINDS,
    members: [ME, RICHA],
    documents: DOCS.map((d) => ({ ...d })),
    collections: [{ ...REFI }],
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** The sheet, opened from the page, with the list pasted and read. */
async function readTheList(list = LIST) {
  fireEvent.click(await screen.findByRole('button', { name: 'Fill from a checklist' }));
  const sheet = await screen.findByRole('dialog', { name: 'Fill “Refinance” from a checklist' });
  fireEvent.change(within(sheet).getByLabelText('The list'), { target: { value: list } });
  fireEvent.click(within(sheet).getByRole('button', { name: 'Read the list' }));
  await within(sheet).findByRole('heading', { name: 'What it found' });
  return sheet;
}
const item = (sheet: HTMLElement, summary: string) =>
  within(sheet).getByText(summary).closest('li') as HTMLElement;

describe('a collection from a checklist (C1)', () => {
  it('reads the list, shows what it found ticked, adds only what is ticked, and keeps the list', async () => {
    const state = at('/collections/col-refi');
    const sheet = await readTheList();
    await waitFor(() =>
      expect(
        within(sheet).getByText('W-2s for 2025 and 2024, Mansoor Seikh’s'),
      ).toBeInTheDocument(),
    );
    // Each line as understood, with how it stands.
    const w2 = item(sheet, 'W-2s for 2025 and 2024, Mansoor Seikh’s');
    expect(within(w2).getByText('Found 1 of 2')).toBeInTheDocument();
    expect(within(w2).getByText('Missing: W-2 for 2024, Mansoor Seikh’s')).toBeInTheDocument();
    const pay = item(sheet, '3 most recent pay statements, Mansoor Seikh’s');
    expect(within(pay).getByText('Found 3 of 3')).toBeInTheDocument();
    // Ticked, with title, date and person; one more offered unticked.
    const boxes = within(pay).getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, true, true, false]);
    expect(
      within(pay).getByLabelText(/Acme payslip September · 30 Sept 2026 · Mansoor Seikh/),
    ).toBeChecked();
    const bank = item(sheet, '2 most recent bank statements, Mansoor Seikh’s');
    expect(within(bank).getByText('Found 1 of 2')).toBeInTheDocument();
    // Richa's part is hers.
    const hers = item(sheet, '2 most recent pay statements, Richa’s');
    expect(within(hers).getByLabelText(/Richa payslip September/)).toBeChecked();
    // A line it cannot read says so, with what to choose.
    const unread = within(sheet).getByText('and so on').closest('li') as HTMLElement;
    expect(within(unread).getByText('Not understood')).toBeInTheDocument();
    expect(within(unread).getByLabelText('Kind')).toBeInTheDocument();
    await expectAccessible();

    // Nothing is in the collection yet.
    expect(state.collections?.[0]?.items).toEqual([]);
    // One unticked; the rest added, and the list kept.
    fireEvent.click(within(pay).getByLabelText(/Acme payslip July/));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add all found (5)' }));
    const said = await screen.findByText(
      '5 documents added to “Refinance”. The checklist is kept on the collection.',
    );
    await waitFor(() => expect(said.closest('.bulk-outcome')).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(state.checklistAdds).toEqual([
      ['w2-2025', 'pay-sep', 'pay-aug', 'bank-sep', 'richa-pay'],
    ]);
    expect(state.collections?.[0]?.checklist?.items).toHaveLength(5);

    // The page shows the list kept, matched again as it opens.
    const section = await screen.findByRole('region', { name: 'Checklist' });
    const lines = await within(section).findByRole('list', { name: 'What the checklist asks for' });
    expect(
      within(lines)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual([
      'Documents for MansoorW-2s for 2025 and 2024, Mansoor Seikh’sFound 1 of 2Missing: W-2 for 2024, Mansoor Seikh’s',
      'Documents for Mansoor3 most recent pay statements, Mansoor Seikh’sFound 3 of 3',
      'Documents for Mansoor2 most recent bank statements, Mansoor Seikh’sFound 1 of 2Missing: 1 more bank statement, Mansoor Seikh’s',
      'Documents for Richa2 most recent pay statements, Richa’sFound 1 of 2Missing: 1 more pay statement, Richa’s',
      'Documents for Richaand so onNot understood',
    ]);
    // The one left out still matches: offered, never added by itself.
    expect(
      within(section).getByText(
        '1 document now matches this checklist and is not in the collection yet. Nothing is added until you choose.',
      ),
    ).toBeInTheDocument();
    expect(state.collections?.[0]?.items).toHaveLength(5);
    await expectAccessible();
  });

  it('a line it could not read is told its kind, whose it is and how many, and found again', async () => {
    at('/collections/col-refi');
    const sheet = await readTheList('Payslips for the lender');
    const line = item(sheet, 'The most recent pay statement, anyone’s');
    // Read as anyone's: told whose, and how many, it is found again.
    fireEvent.click(within(line).getByRole('button', { name: 'Change “Payslips for the lender”' }));
    fireEvent.change(within(line).getByLabelText('Whose'), { target: { value: 'm-richa' } });
    await within(sheet).findByText('The most recent pay statement, Richa’s');
    const again = item(sheet, 'The most recent pay statement, Richa’s');
    // The focus stays on what was changed, and nothing is shut while it is looked at again.
    const howMany = within(again).getByLabelText('How many');
    howMany.focus();
    fireEvent.change(howMany, { target: { value: 'n:2' } });
    expect(howMany).not.toBeDisabled();
    await within(sheet).findByText('2 most recent pay statements, Richa’s');
    expect(document.activeElement).toBe(howMany);
    // Months, and more than twelve, are there to choose too.
    expect(
      within(howMany)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(expect.arrayContaining(['n:24', 'm:3', 'm:24']));
    // A line skipped is left out of what is added.
    const skip = item(sheet, '2 most recent pay statements, Richa’s');
    // Still open to change, as it was being changed.
    fireEvent.click(within(skip).getByLabelText('Skip this line'));
    await within(sheet).findByText('Skipped');
    expect(within(sheet).getByRole('button', { name: 'Keep the list' })).toBeInTheDocument();
  });

  it('a line not understood, once its kind is chosen, stays open with the focus where it was', async () => {
    at('/collections/col-refi');
    const sheet = await readTheList('Something for the lender');
    const line = within(sheet)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('Something for the lender')) as HTMLElement;
    const kindOf = within(line).getByLabelText('Kind');
    kindOf.focus();
    fireEvent.change(kindOf, { target: { value: 'pay_statement' } });
    await within(sheet).findByText('The most recent pay statement, anyone’s');
    expect(kindOf).toBeInTheDocument();
    expect(document.activeElement).toBe(kindOf);
  });

  it('asks for the missing ones: what the sender will see first, the names changeable', async () => {
    at('/collections/col-refi');
    const sheet = await readTheList();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ask for the missing ones' }));
    expect(await within(sheet).findByRole('heading', { name: 'What they will see' })).toHaveFocus();
    // A title that names no collection, and each line, to change.
    expect(within(sheet).getByLabelText('Title')).toHaveValue('Documents we need');
    expect(within(sheet).getByLabelText('What to send, 1')).toHaveValue(
      'W-2 for 2024, Mansoor Seikh’s',
    );
    fireEvent.change(within(sheet).getByLabelText('What to send, 1'), {
      target: { value: 'W-2 for 2024' },
    });
    await expectAccessible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Continue to Ask for documents' }));
    expect(await screen.findByRole('heading', { name: 'Ask for documents' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Documents we need');
    const asked = screen
      .getAllByRole('textbox')
      .map((b) => (b as HTMLInputElement).value)
      .filter((v) => /W-2|more/.test(v));
    expect(asked).toEqual([
      'W-2 for 2024',
      '1 more bank statement, Mansoor Seikh’s',
      '1 more pay statement, Richa’s',
    ]);
  });

  it('Add all found, for a collection shared outside, says so and asks first (5.19)', async () => {
    const shared = {
      ...REFI,
      shared_outside: { with: ['the lender'], following: true },
    };
    const state = at('/collections/col-refi', { collections: [shared] });
    const sheet = await readTheList('Documents for Mansoor\nLast 2 pay statements');
    expect(
      within(sheet).getByText(
        'This collection is shared with the lender. What you put in it goes to them too, if everybody the collection is for may see it.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add all found (2)' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Add 2 documents to “Refinance”?',
    });
    expect(state.checklistAdds ?? []).toEqual([]);
    // Cancelled: nothing goes in.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(state.checklistAdds ?? []).toEqual([]);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add all found (2)' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Add 2 documents',
      }),
    );
    await screen.findByText(/2 documents added to “Refinance”/);
    expect(state.checklistAdds).toEqual([['pay-sep', 'pay-aug']]);
  });

  it('tells its maker who reads it; keeps the pasted list out of the history; adds nothing twice', async () => {
    const state = at('/collections', { collections: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Make a collection' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Refinance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Everyone in the family' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start from a checklist (optional)' }));
    fireEvent.change(screen.getByLabelText('Start from a checklist (optional)'), {
      target: { value: 'Documents for Mansoor\nLast 2 pay statements' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make the collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Fill “Refinance” from a checklist' });
    await within(sheet).findByText('2 most recent pay statements, Mansoor Seikh’s');
    expect(
      within(sheet).getByText(
        'Everyone in the family who can see this collection — teens too — can read its checklist. Viewers, guests and links never can.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(JSON.stringify(window.history.state)).not.toContain('pay statements'),
    );
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add all found (2)' }));
    await screen.findByText(/2 documents added to “Refinance”/);
    const puts = () =>
      state.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/checklist'));
    expect(puts()).toHaveLength(1);
    // What was saved is the lines and what they ask for, never what was found.
    expect(JSON.stringify(puts()[0]?.body)).not.toContain('matches');
    // Opened again, the list is not read again, and kept as it was: nothing is saved.
    fireEvent.click(await screen.findByRole('button', { name: 'Change the checklist' }));
    const again = await screen.findByRole('dialog', { name: 'Fill “Refinance” from a checklist' });
    expect(within(again).getByLabelText('The list')).toHaveValue('');
    fireEvent.click(within(again).getByRole('button', { name: 'Keep the list' }));
    await screen.findByText(/Nothing was added/);
    expect(puts()).toHaveLength(1);
  });

  it('adds more than 200 found in calls of 200; says how many lines or items were left out', async () => {
    // Thirty payslips a year for seven years: 210 found, one line too many.
    const many = Array.from({ length: 210 }, (_, i) =>
      doc(
        `pay-${i}`,
        `Payslip ${i}`,
        'pay_statement',
        `${2020 + Math.floor(i / 30)}-0${1 + (i % 9)}-1${i % 9}`,
      ),
    );
    const years = Array.from({ length: 7 }, (_, y) => `Pay statements for ${2020 + y}`);
    const list = [...years, ...Array.from({ length: 94 }, () => 'Passport')].join('\n');
    const state = at('/collections/col-refi', { documents: many });
    const sheet = await readTheList(list);
    expect(
      within(sheet).getByText(
        'One line or item was left out: a checklist reads 100 lines and keeps 100 items at most.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add all found (210)' }));
    await screen.findByText(/210 documents added to “Refinance”/);
    expect(state.checklistAdds?.map((a) => a.length)).toEqual([200, 10]);
  }, 60_000);

  it('Start from a checklist as a collection is made: what it found, shown at once', async () => {
    const state = at('/collections', { collections: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Make a collection' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Refinance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Everyone in the family' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start from a checklist (optional)' }));
    fireEvent.change(screen.getByLabelText('Start from a checklist (optional)'), {
      target: { value: 'Documents for Mansoor\nLast 2 pay statements' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Fill “Refinance” from a checklist' });
    await within(sheet).findByText('2 most recent pay statements, Mansoor Seikh’s');
    // The list never went with the collection itself; nothing is in it yet.
    const made = state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/collections');
    expect(made?.body).toEqual({ name: 'Refinance', audience: 'everyone', description: null });
    expect(state.collections?.[0]?.items).toEqual([]);
  });

  it('says so when the list could not be read in time', async () => {
    at('/collections/col-refi', { checklistUnavailable: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Fill from a checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Fill “Refinance” from a checklist' });
    fireEvent.change(within(sheet).getByLabelText('The list'), { target: { value: 'Passport' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Read the list' }));
    expect(
      await within(sheet).findByText('The list could not be read just now. Try again in a moment.'),
    ).toBeInTheDocument();
  });

  it('is read, not changed, by somebody who did not make it; never shown to a viewer', async () => {
    const kept = {
      items: [
        {
          line: 'Last 2 pay statements',
          heading: null,
          type_key: 'pay_statement',
          member_id: null,
          count: 2,
          months: null,
          years: [],
          current: false,
          form: null,
          skipped: false,
        },
      ],
      saved_at: '2026-10-18T09:00:00Z',
    };
    const theirs = { ...REFI, owner_member_id: 'm-richa', checklist: kept };
    at('/collections/col-refi', { collections: [theirs] }, 'adult');
    const section = await screen.findByRole('region', { name: 'Checklist' });
    await within(section).findByText('2 most recent pay statements, anyone’s');
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    cleanup();
    localStorage.clear();
    at('/collections/col-refi', { collections: [{ ...theirs, owner_member_id: 'me' }] }, 'viewer');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Checklist' })).not.toBeInTheDocument();
  });
});
