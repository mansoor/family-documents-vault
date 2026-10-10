import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  fresh,
  installFakeApi,
  MISSING_BIRTH_CERTIFICATE,
  signedIn,
  type FakeState,
} from './test-api.js';

/**
 * "We noticed something missing" on Needs attention, from 768 px (the
 * owner's ask, Phase 6): a table as the Trash's — what is missing, its
 * kind, whose, why, then Add it and Not for us for whoever may add
 * documents — in R2's grid; a plain table for anybody with nothing to do.
 * The hidden ones behind "N hidden", a second table with Show it again.
 * What an action came to is said politely, and the focus goes to the next
 * row, or the toggle or the heading once there is none. On a phone, the
 * list as it was.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';
const PHONE = 320;
const MID = 900;
const WIDE = 1280;

let width = WIDE;
function atWidth(px: number) {
  width = px;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || width >= Number(minWidth[1])) &&
          (!minHeight || 900 >= Number(minHeight[1])) &&
          Boolean(minWidth || minHeight),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
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

const SARA_PASSPORT = {
  ...MISSING_BIRTH_CERTIFICATE,
  key: 'adult_needs_passport:m-2',
  rule_key: 'adult_needs_passport',
  member_id: 'm-2',
  member_name: 'Sara',
  type_key: 'passport',
  type_label: 'Passport',
  title: 'No passport for Sara',
  why: 'Travel abroad, and proving who she is.',
};
const HOME_INSURANCE = {
  ...MISSING_BIRTH_CERTIFICATE,
  key: 'owner_needs_home_insurance',
  rule_key: 'owner_needs_home_insurance',
  member_id: null,
  member_name: null,
  type_key: 'home_insurance',
  type_label: 'Home insurance',
  title: 'No home insurance on file',
  why: 'You said you own your home.',
};
const WILL = {
  ...HOME_INSURANCE,
  key: 'household_needs_will',
  rule_key: 'household_needs_will',
  type_key: 'will',
  type_label: 'Will',
  title: 'No will on file',
  why: 'Who looks after the children, and what goes where.',
  dismissed: true,
};
const PET = {
  ...HOME_INSURANCE,
  key: 'pets_need_records',
  rule_key: 'pets_need_records',
  type_key: 'pet_records',
  type_label: 'Pet records',
  title: 'No pet records on file',
  why: 'You said you have pets.',
  dismissed: true,
};

/** Three to add, two hidden. */
const suggestions = () => [
  { ...SARA_PASSPORT },
  { ...MISSING_BIRTH_CERTIFICATE },
  { ...HOME_INSURANCE },
  { ...WILL },
  { ...PET },
];

function open(over: Partial<FakeState> = {}, role: Role = 'owner') {
  const state = fresh({ suggestions: suggestions(), ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', '/reminders');
  render(<App />);
  return state;
}

const section = () => screen.findByRole('region', { name: /We noticed something missing/ });
const missingGrid = () => screen.findByRole('grid', { name: 'We noticed something missing' });
const hiddenGrid = () => screen.getByRole('grid', { name: 'Hidden: not for us' });
const toggle = () => screen.getByRole('button', { name: /^\d+ hidden$/ });
const headers = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);
const rowOf = (table: HTMLElement, title: string) =>
  within(table).getByText(title).closest('tr') as HTMLTableRowElement;
const titles = (table: HTMLElement) =>
  [...table.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent);
/** The outcome said, politely, in the table-grid's note. */
const outcome = () => document.querySelector('.bulk-outcome [role="status"]');

describe('"We noticed something missing" from 768 px: a table, as the Trash is', () => {
  it.each([
    ['owner', WIDE],
    ['adult', WIDE],
    ['owner', MID],
    ['adult', MID],
  ] as Array<[Role, number]>)(
    'an %s at %i px: what is missing, its kind, whose, why, then Add it and Not for us, in the grid',
    async (role, px) => {
      atWidth(px);
      open({}, role);
      const table = await missingGrid();
      await within(table).findByText('No passport for Sara');
      expect(headers(table)).toEqual([
        'What’s missing',
        'Kind',
        'Person',
        'Why',
        'Add it',
        'Not for us',
      ]);
      expect(titles(table)).toEqual([
        'No passport for Sara',
        'No birth certificate for Aisha',
        'No home insurance on file',
      ]);
      const sara = rowOf(table, 'No passport for Sara');
      expect([...sara.querySelectorAll('td')].slice(0, 4).map((c) => c.textContent)).toEqual([
        'No passport for Sara',
        'Passport',
        'Sara',
        'Travel abroad, and proving who she is.',
      ]);
      // Nobody's in particular: a blank, heard as None.
      const home = rowOf(table, 'No home insurance on file');
      expect(home.querySelectorAll('td')[2]).toHaveTextContent('None');
      // Each action its own cell, so each cell has one target.
      const cells = [...sara.querySelectorAll('td')];
      expect(
        within(cells[4] as HTMLElement).getByRole('link', { name: 'Add it: No passport for Sara' }),
      ).toHaveAttribute('href', '/add?type=passport&member=m-2');
      expect(
        within(cells[5] as HTMLElement).getByRole('button', {
          name: 'Not for us: No passport for Sara',
        }),
      ).toBeInTheDocument();
      // Across the page's width: no list.
      expect(document.querySelector('.missing-row')).toBeNull();
      expect(table.closest('.tbl-wrap')).not.toBeNull();
      await expectAccessible();
    },
  );

  it.each([WIDE, PHONE])(
    'a viewer at %i px: the vault tells them of nothing missing, so there is no section',
    async (px) => {
      atWidth(px);
      const state = open({}, 'viewer');
      await screen.findByText('Everything is fine. Nothing needs your attention.');
      await waitFor(() =>
        expect(state.calls.filter((c) => c.url.startsWith('/api/v1/suggestions'))).toHaveLength(2),
      );
      // As the vault (5.3): no suggestions, and no word on the questions.
      expect(screen.queryByText(/We noticed something missing/)).toBeNull();
      expect(screen.queryByRole('table', { name: 'We noticed something missing' })).toBeNull();
      expect(screen.queryByRole('grid', { name: 'We noticed something missing' })).toBeNull();
      expect(screen.queryByRole('button', { name: /hidden$/ })).toBeNull();
      await expectAccessible();
    },
  );

  it.each([WIDE, MID])(
    'a teen at %i px: Add it, but not Not for us; the hidden ones read, not shown again',
    async (px) => {
      atWidth(px);
      const state = open({}, 'teen');
      const table = await missingGrid();
      await within(table).findByText('No passport for Sara');
      expect(headers(table)).toEqual(['What’s missing', 'Kind', 'Person', 'Why', 'Add it']);
      expect(
        within(table).getByRole('link', { name: 'Add it: No passport for Sara' }),
      ).toHaveAttribute('href', '/add?type=passport&member=m-2');
      expect(screen.queryByRole('button', { name: /Not for us/ })).toBeNull();
      // Still the grid: Add it is in each row.
      await waitFor(() => expect(table.querySelectorAll('[tabindex="0"]')).toHaveLength(1));
      // What the family chose to hide, as the vault tells a teen: read, with nothing to do.
      fireEvent.click(toggle());
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByRole('grid', { name: 'Hidden: not for us' })).toBeNull();
      const hidden = screen.getByRole('table', { name: 'Hidden: not for us' });
      expect(headers(hidden)).toEqual(['What’s missing']);
      expect(titles(hidden)).toEqual(['No will on file', 'No pet records on file']);
      expect(within(hidden).queryAllByRole('button')).toEqual([]);
      expect(hidden.querySelector('[tabindex]')).toBeNull();
      expect(screen.queryByRole('button', { name: /Show it again/ })).toBeNull();
      await expectAccessible();
      expect(state.calls.some((c) => c.url.endsWith('/dismiss'))).toBe(false);
    },
  );

  it('the keyboard: one stop for Tab, the arrows between cells', async () => {
    atWidth(WIDE);
    open();
    const table = await missingGrid();
    await within(table).findByText('No passport for Sara');
    const first = () => rowOf(table, 'No passport for Sara').querySelector('td') as HTMLElement;
    // The first row's first cell is the table's one stop, until the focus moves on.
    await waitFor(() => expect(first()).toHaveAttribute('tabindex', '0'));
    expect(table.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    first().focus();
    fireEvent.keyDown(first(), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(document.activeElement).toBe(rowOf(table, 'No passport for Sara').cells[1]),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Not for us: No passport for Sara' }),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Add it: No passport for Sara' })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Add it: No birth certificate for Aisha' }),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        rowOf(table, 'No birth certificate for Aisha').querySelector('td'),
      ),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(table).getByRole('columnheader', { name: 'What’s missing' }),
      ),
    );
    // Still exactly one stop: where the focus last was.
    expect(table.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(document.activeElement).toHaveAttribute('tabindex', '0');
  });

  it('Not for us: said politely, and the focus goes to the next row, then the toggle', async () => {
    atWidth(WIDE);
    const state = open();
    const table = await missingGrid();
    await within(table).findByText('No passport for Sara');
    fireEvent.click(screen.getByRole('button', { name: 'Not for us: No passport for Sara' }));

    // Out of the list, and among the hidden ones (not shown until asked for).
    await waitFor(() =>
      expect(titles(screen.getByRole('grid', { name: 'We noticed something missing' }))).toEqual([
        'No birth certificate for Aisha',
        'No home insurance on file',
      ]),
    );
    expect(titles(document.getElementById('missing-hidden') as HTMLElement)).toContain(
      'No passport for Sara',
    );
    expect(
      state.calls.some(
        (c) =>
          c.method === 'POST' && c.url === '/api/v1/suggestions/adult_needs_passport%3Am-2/dismiss',
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(outcome()).toHaveTextContent(
        '“No passport for Sara” is hidden. You can show it again below.',
      ),
    );
    // The row now in its place, in the same column.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Not for us: No birth certificate for Aisha' }),
      ).toHaveFocus(),
    );
    expect(toggle()).toHaveTextContent('3 hidden');

    // The last row: the one before it, now the last.
    fireEvent.click(screen.getByRole('button', { name: 'Not for us: No home insurance on file' }));
    await waitFor(() =>
      expect(outcome()).toHaveTextContent('“No home insurance on file” is hidden.'),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Not for us: No birth certificate for Aisha' }),
      ).toHaveFocus(),
    );

    // The list empty: the toggle that shows them again.
    fireEvent.click(
      screen.getByRole('button', { name: 'Not for us: No birth certificate for Aisha' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('grid', { name: 'We noticed something missing' })).toBeNull(),
    );
    await waitFor(() => expect(toggle()).toHaveFocus());
    expect(toggle()).toHaveTextContent('5 hidden');
    expect(outcome()).toHaveTextContent('“No birth certificate for Aisha” is hidden.');
    await expectAccessible();
  });

  it('the hidden ones: behind "N hidden", a second table with Show it again', async () => {
    atWidth(WIDE);
    open();
    const table = await missingGrid();
    await within(table).findByText('No passport for Sara');
    // Not shown until asked for.
    expect(toggle()).toHaveTextContent('2 hidden');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('grid', { name: 'Hidden: not for us' })).toBeNull();
    expect(screen.queryByText('No will on file')).not.toBeVisible();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    // The same button, still there to put them away again.
    const hidden = hiddenGrid();
    expect(headers(hidden)).toEqual(['What’s missing', 'Show it again']);
    expect(titles(hidden)).toEqual(['No will on file', 'No pet records on file']);
    expect(
      within(rowOf(hidden, 'No will on file')).getByRole('button', {
        name: 'Show it again: No will on file',
      }),
    ).toBeInTheDocument();
    // A grid of its own: one stop for Tab, the arrows between its cells.
    await waitFor(() => expect(hidden.querySelectorAll('[tabindex="0"]')).toHaveLength(1));
    const will = rowOf(hidden, 'No will on file').querySelector('td') as HTMLElement;
    expect(will).toHaveAttribute('tabindex', '0');
    will.focus();
    fireEvent.keyDown(will, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show it again: No will on file' })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Show it again: No pet records on file' }),
      ).toHaveFocus(),
    );
    await expectAccessible();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('grid', { name: 'Hidden: not for us' })).toBeNull();
  });

  it('Show it again: said politely, back in the list, the focus to the next hidden one, then the heading', async () => {
    atWidth(WIDE);
    const state = open();
    await within(await missingGrid()).findByText('No passport for Sara');
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Show it again: No will on file' }));

    await waitFor(() =>
      expect(outcome()).toHaveTextContent('“No will on file” is on the list again.'),
    );
    expect(
      state.calls.some(
        (c) =>
          c.method === 'DELETE' && c.url === '/api/v1/suggestions/household_needs_will/dismiss',
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        within(screen.getByRole('grid', { name: 'We noticed something missing' })).getByText(
          'No will on file',
        ),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Show it again: No pet records on file' }),
      ).toHaveFocus(),
    );
    expect(toggle()).toHaveTextContent('1 hidden');

    // None left hidden: the toggle goes with them, and the section's heading has the focus.
    fireEvent.click(screen.getByRole('button', { name: 'Show it again: No pet records on file' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /hidden$/ })).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'We noticed something missing (5)' }),
      ).toHaveFocus(),
    );
    expect(outcome()).toHaveTextContent('“No pet records on file” is on the list again.');
    await expectAccessible();
  });

  it('the note put away: the focus back to the table where it was', async () => {
    atWidth(WIDE);
    open();
    await within(await missingGrid()).findByText('No passport for Sara');
    fireEvent.click(screen.getByRole('button', { name: 'Not for us: No passport for Sara' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Not for us: No birth certificate for Aisha' }),
      ).toHaveFocus(),
    );
    const note = document.querySelector('.bulk-outcome') as HTMLElement;
    // Reached from the keyboard, as a person would: the focus is on Dismiss as it goes.
    const dismiss = within(note).getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    expect(dismiss).toHaveFocus();
    fireEvent.click(dismiss);
    await waitFor(() => expect(document.querySelector('.bulk-outcome')).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Not for us: No birth certificate for Aisha' }),
      ).toHaveFocus(),
    );
  });

  it('refused: said as the error it is, nothing said done, and the focus stays put', async () => {
    atWidth(WIDE);
    open({
      refuseWith: (method, path) =>
        method === 'POST' && path.endsWith('/dismiss')
          ? {
              status: 403,
              code: 'forbidden',
              message: 'Only an owner or an adult can decide that.',
            }
          : undefined,
    });
    await within(await missingGrid()).findByText('No passport for Sara');
    const button = screen.getByRole('button', { name: 'Not for us: No passport for Sara' });
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an owner or an adult can decide that.',
    );
    expect(outcome()).toBeNull();
    expect(screen.getByText('No passport for Sara')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not for us: No passport for Sara' })).toHaveFocus();
  });

  it('Home’s card stays a card of tiles at 1280 px: it is not this table', async () => {
    atWidth(WIDE);
    installFakeApi(fresh({ suggestions: suggestions() }));
    signedIn('owner');
    render(<App />);
    const card = await screen.findByRole('region', { name: /We noticed something missing/ });
    expect(card.querySelector('.tiles')).not.toBeNull();
    expect(within(card).queryByRole('table')).toBeNull();
    expect(within(card).queryByRole('grid')).toBeNull();
  });
});

describe('"We noticed something missing" on a phone: the list, as it was', () => {
  it.each(['owner', 'adult'] as Role[])(
    'an %s at 320 px: the rows, Add it and Not for us, then "N hidden"',
    async (role) => {
      atWidth(PHONE);
      const state = open({}, role);
      const missing = await section();
      await within(missing).findByText('No passport for Sara');
      expect(within(missing).queryByRole('table')).toBeNull();
      expect(within(missing).queryByRole('grid')).toBeNull();
      const rows = missing.querySelectorAll('li.missing-row');
      expect(rows).toHaveLength(3);
      const sara = within(missing).getByText('No passport for Sara').closest('li') as HTMLElement;
      expect(sara).toHaveTextContent('Travel abroad, and proving who she is.');
      expect(within(sara).getByRole('link', { name: 'Add it' })).toHaveAttribute(
        'href',
        '/add?type=passport&member=m-2',
      );
      // Today's names, exactly.
      fireEvent.click(within(sara).getByRole('button', { name: 'Not for us' }));
      await waitFor(() => expect(screen.queryByText('No passport for Sara')).toBeNull());
      expect(state.calls.some((c) => c.url.endsWith('adult_needs_passport%3Am-2/dismiss'))).toBe(
        true,
      );
      // No note, as before: the list itself says it.
      expect(outcome()).toBeNull();
      // "N hidden" opens the hidden list once, and goes.
      const more = await screen.findByRole('button', { name: '3 hidden' });
      expect(more).not.toHaveAttribute('aria-expanded');
      fireEvent.click(more);
      expect(screen.queryByRole('button', { name: /hidden$/ })).toBeNull();
      const again = await screen.findAllByRole('button', { name: 'Show it again' });
      expect(again).toHaveLength(3);
      await expectAccessible();
      // Show it again: back among the rows, as before.
      fireEvent.click(again[0] as HTMLElement);
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: 'Show it again' })).toHaveLength(2),
      );
      await waitFor(() =>
        expect(within(missing).getAllByRole('button', { name: 'Not for us' })).toHaveLength(3),
      );
      expect(state.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/dismiss'))).toBe(
        true,
      );
      expect(outcome()).toBeNull();
    },
  );

  it('a teen at 320 px: Add it on each row, no Not for us; the hidden ones read, not shown again', async () => {
    atWidth(PHONE);
    const state = open({}, 'teen');
    const missing = await section();
    await within(missing).findByText('No passport for Sara');
    expect(missing.querySelectorAll('li.missing-row')).toHaveLength(3);
    expect(within(missing).getAllByRole('link', { name: 'Add it' })).toHaveLength(3);
    expect(within(missing).queryByRole('button', { name: 'Not for us' })).toBeNull();
    // "N hidden" opens the hidden list once, as for anybody: what is hidden, nothing to do.
    fireEvent.click(within(missing).getByRole('button', { name: '2 hidden' }));
    await within(missing).findByText('No will on file');
    expect(missing.querySelectorAll('li.missing-row')).toHaveLength(5);
    expect(within(missing).queryByRole('button', { name: 'Show it again' })).toBeNull();
    await expectAccessible();
    expect(state.calls.some((c) => c.url.endsWith('/dismiss'))).toBe(false);
  });
});
