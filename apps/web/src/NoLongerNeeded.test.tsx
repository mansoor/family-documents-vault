import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * No longer needed (0.9.0), on the web: marked from a document's page, its
 * row's ⋯ and a reminder in Needs attention, with the same dialog — why,
 * and what replaced it, found as you type — and said on its page by a
 * banner with Needed again. A replacement the reader may not see is
 * "another document". A new version of one asks whether it is needed again.
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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

const EAD = {
  ...PASSPORT,
  id: 'doc-ead',
  type_key: 'visa',
  title: 'EAD card',
  category: 'identity',
  identifier: 'EAD-1',
  expires: { date: '2026-11-20', precision: 'day' },
  status: { value: 'expiring_soon', label: 'Expires in 28 days' },
  latest_version_id: 'v-ead',
  etag: '"ead"',
};
const GREEN = {
  ...PASSPORT,
  id: 'doc-green',
  type_key: 'visa',
  title: 'Green card',
  identifier: 'GC-1',
  expires: null,
  status: { value: 'valid', label: '' },
  latest_version_id: 'v-green',
  etag: '"green"',
};
const MARKED = {
  ...EAD,
  status: { value: 'no_longer_needed', label: 'No longer needed' },
  no_longer_needed: {
    at: '2026-10-23T10:00:00Z',
    by_name: 'Mansoor Seikh',
    reason: 'The green card came',
    has_reason: true,
    replaced_by: { id: 'doc-green', title: 'Green card' },
  },
};

function open(
  path: string,
  documents: Array<Record<string, unknown>>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
  over: Partial<FakeState> = {},
): FakeState {
  const state = fresh({ members: [ME], documents, ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const banner = () => screen.findByRole('region', { name: 'No longer needed' });

/** A screen `px` wide, as the shell asks it (the Documents table is from 768 px). */
function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const min = /\(min-width:\s*(\d+)px\)/.exec(query);
      return {
        matches: Boolean(min) && px >= Number(min?.[1]),
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

describe('no longer needed, on the web (0.9.0)', () => {
  it('a document’s page: Mark as no longer needed, the dialog, then the banner with Needed again', async () => {
    const state = open('/documents/doc-ead', [{ ...EAD }, { ...GREEN }]);
    const mark = await screen.findByRole('button', { name: 'Mark as no longer needed' });
    expect(screen.queryByRole('region', { name: 'No longer needed' })).toBeNull();
    fireEvent.click(mark);
    const dialog = await screen.findByRole('dialog', { name: 'Mark as no longer needed' });
    // Why first, with its count; then what replaced it, the same person's first.
    const why = within(dialog).getByLabelText('Why (optional)');
    expect(document.activeElement).toBe(why);
    fireEvent.change(why, { target: { value: 'The green card came' } });
    expect(within(dialog).getByText('19 of 200 characters')).toBeInTheDocument();
    const green = await within(dialog).findByRole('radio', { name: 'Green card' });
    // Never itself.
    expect(within(dialog).queryByRole('radio', { name: 'EAD card' })).toBeNull();
    expect(within(dialog).getByRole('radio', { name: 'Nothing in particular' })).toBeChecked();
    fireEvent.click(green);
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as no longer needed' }));
    const said = await banner();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.unneededCalls).toEqual([
      {
        method: 'POST',
        id: 'doc-ead',
        body: { reason: 'The green card came', replaced_by: 'doc-green' },
      },
    ]);
    expect(said).toHaveTextContent(
      'No longer needed since 23 Oct 2026 · Replaced by Green card · Needed again',
    );
    expect(within(said).getByRole('link', { name: 'Green card' })).toHaveAttribute(
      'href',
      '/documents/doc-green',
    );
    expect(said).toHaveTextContent('The green card came');
    // Its status says it too, and the button to mark it has gone.
    expect(screen.getAllByText('No longer needed').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Mark as no longer needed' })).toBeNull();
    await expectAccessible();
    // Needed again: the banner goes, and Mark is back.
    fireEvent.click(within(said).getByRole('button', { name: 'Needed again' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'No longer needed' })).toBeNull(),
    );
    expect(state.unneededCalls?.at(-1)).toMatchObject({ method: 'DELETE', id: 'doc-ead' });
    expect(await screen.findByRole('button', { name: 'Mark as no longer needed' })).toBeVisible();
  });

  it('a replacement the reader may not see is "another document", named and linked never', async () => {
    open('/documents/doc-ead', [
      {
        ...MARKED,
        no_longer_needed: { ...MARKED.no_longer_needed, replaced_by: { id: null, title: null } },
      },
    ]);
    const said = await banner();
    expect(said).toHaveTextContent('Replaced by another document');
    expect(within(said).queryByRole('link')).toBeNull();
  });

  it('changing why keeps a replacement the reader may not see: "Another document (kept as it is)", never sent (the review, M1)', async () => {
    const state = open('/documents/doc-ead', [
      {
        ...MARKED,
        no_longer_needed: { ...MARKED.no_longer_needed, replaced_by: { id: null, title: null } },
      },
    ]);
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Change why' }));
    const dialog = await screen.findByRole('dialog', { name: 'No longer needed' });
    expect(
      within(dialog).getByRole('radio', { name: 'Another document (kept as it is)' }),
    ).toBeChecked();
    // Saved untouched: nothing sent, so nothing changes.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.unneededCalls).toHaveLength(1));
    expect(state.unneededCalls?.[0]?.body).toEqual({});
    // Why changed, and only why.
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Change why' }));
    const again = await screen.findByRole('dialog', { name: 'No longer needed' });
    fireEvent.change(within(again).getByLabelText('Why (optional)'), {
      target: { value: 'Kept for the lawyer' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.unneededCalls).toHaveLength(2));
    expect(state.unneededCalls?.[1]?.body).toEqual({ reason: 'Kept for the lawyer' });
    expect(await banner()).toHaveTextContent('Replaced by another document');
  });

  it('a viewer reads the banner, and is offered neither Mark nor Needed again', async () => {
    open(
      '/documents/doc-ead',
      [{ ...MARKED, no_longer_needed: { ...MARKED.no_longer_needed, by_name: null } }],
      'viewer',
    );
    const said = await banner();
    expect(said).toHaveTextContent('No longer needed since 23 Oct 2026 · Replaced by Green card');
    expect(within(said).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as no longer needed' })).toBeNull();
    await expectAccessible();
  });

  it('what the vault refuses is said in the dialog, which stays open', async () => {
    open('/documents/doc-ead', [{ ...EAD }], 'owner', {
      unneededRefusal: {
        status: 422,
        code: 'validation_failed',
        message: 'That document is not in the vault.',
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as no longer needed' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as no longer needed' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as no longer needed' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That document is not in the vault.',
    );
    expect(screen.getByRole('dialog', { name: 'Mark as no longer needed' })).toBeVisible();
  });

  it('the ⋯ menu marks it, and once marked offers Needed again', async () => {
    const state = open('/', [{ ...EAD }, { ...GREEN }]);
    const more = await screen.findByRole('button', { name: 'Actions for “EAD card”' });
    fireEvent.click(more);
    const menu = await screen.findByRole('menu', { name: 'Actions for “EAD card”' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark as no longer needed' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as no longer needed' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as no longer needed' }));
    await waitFor(() => expect(state.unneededCalls).toHaveLength(1));
    expect(
      await screen.findByText('“EAD card” is marked no longer needed. Nobody is reminded of it.'),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for “EAD card”' }));
    const again = await screen.findByRole('menu', { name: 'Actions for “EAD card”' });
    expect(within(again).getByRole('menuitem', { name: 'Needed again' })).toBeVisible();
    expect(within(again).queryByRole('menuitem', { name: 'Mark as no longer needed' })).toBeNull();
  });

  it('Needs attention: a reminder’s Not needed any more marks its document, and it leaves the list', async () => {
    const state = open('/reminders', [{ ...EAD }], 'owner', {
      reminders: [
        {
          id: 'r-ead',
          document_id: 'doc-ead',
          document_title: 'EAD card',
          kind: 'derived',
          fire_at: '2026-10-21',
          lead_days: 30,
          note: null,
          recurrence: null,
          status: 'due',
          snoozed_until: null,
          label: 'Due',
          source: 'expires',
          about: 'Expires: 20 Nov, in 28 days',
        },
      ],
    });
    const button = await screen.findByRole('button', { name: 'Not needed any more: “EAD card”' });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Mark as no longer needed' });
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as no longer needed' }));
    await waitFor(() => expect(state.unneededCalls).toHaveLength(1));
    // Nothing touched, nothing sent: a reminder's row may be older than a
    // marking made elsewhere, whose why and replacement stay (M1).
    expect(state.unneededCalls?.[0]?.body).toEqual({});
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Not needed any more: “EAD card”' })).toBeNull(),
    );
    expect(
      await screen.findByText('Everything is fine. Nothing needs your attention.'),
    ).toBeVisible();
  });

  it('a viewer is offered no Not needed any more beside a reminder', async () => {
    open('/reminders', [{ ...EAD }], 'viewer', {
      reminders: [
        {
          id: 'r-ead',
          document_id: 'doc-ead',
          document_title: 'EAD card',
          kind: 'manual',
          fire_at: '2026-10-21',
          lead_days: null,
          note: 'Renew it',
          recurrence: null,
          status: 'due',
          snoozed_until: null,
          label: 'Due',
          source: null,
          about: null,
        },
      ],
    });
    await screen.findByText('EAD card');
    expect(screen.queryByRole('button', { name: /Not needed any more/ })).toBeNull();
  });

  it('the Documents table’s bulk bar marks many at once — one reason for all — and leaves, and names, those not theirs', async () => {
    atWidth(1280);
    const state = open(
      '/documents',
      [
        { ...EAD, owner_member_id: 'me', filed_by_me: true },
        { ...GREEN, id: 'doc-sara', title: "Sara's permit", owner_member_id: 'm-2' },
      ],
      'teen',
    );
    const table = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    fireEvent.click(await within(table).findByRole('checkbox', { name: 'Select “EAD card”' }));
    fireEvent.click(within(table).getByRole('checkbox', { name: "Select “Sara's permit”" }));
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    fireEvent.click(within(bar).getByRole('button', { name: 'No longer needed' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as no longer needed' });
    expect(dialog).toHaveTextContent('1 document stays in the vault');
    // Never one of the chosen as their own replacement.
    await within(dialog).findByRole('radio', { name: 'Nothing in particular' });
    expect(within(dialog).queryByRole('radio', { name: 'EAD card' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Why (optional)'), {
      target: { value: 'The green cards came' },
    });
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as no longer needed' }));
    await waitFor(() => expect(state.unneededCalls).toHaveLength(1));
    expect(state.unneededCalls).toEqual([
      { method: 'POST', id: 'doc-ead', body: { reason: 'The green cards came' } },
    ]);
    expect(
      await screen.findByText(/1 document marked no longer needed\. Nobody is reminded of it\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/not yours to change: “Sara's permit”/)).toBeInTheDocument();
  });

  it('the Documents table filters by it, among Any status', async () => {
    atWidth(1280);
    const state = open('/documents', [{ ...MARKED }, { ...GREEN }]);
    const filters = await screen.findByRole('group', { name: 'Filters' });
    const filter = within(filters).getByRole('combobox', { name: 'Status' });
    const choices = within(filter)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(choices).toContain('No longer needed');
    expect(choices[0]).toBe('Any status');
    // Any status: it is listed, with its status.
    await screen.findByText('EAD card');
    fireEvent.change(filter, { target: { value: 'no_longer_needed' } });
    await waitFor(() =>
      expect(state.calls.some((c) => c.url.includes('status=no_longer_needed'))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Green card')).toBeNull());
    expect(screen.getByText('EAD card')).toBeInTheDocument();
    // Expiring soon: not among them.
    fireEvent.change(filter, { target: { value: 'expiring_soon' } });
    await waitFor(() => expect(screen.queryByText('EAD card')).toBeNull());
  });

  it('a new version of one no longer needed asks whether it is needed again, and keeps it so unless told', async () => {
    const state = open('/documents/doc-ead', [{ ...MARKED }]);
    await banner();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'ead-again.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    const ask = await screen.findByRole('alertdialog', { name: 'Is it needed again?' });
    // The likelier answer has the focus: a late scan of the old card is still the old card.
    expect(document.activeElement).toBe(
      within(ask).getByRole('button', { name: 'Keep it no longer needed' }),
    );
    await expectAccessible();
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it no longer needed' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.unneededCalls ?? []).toEqual([]);
    expect(await banner()).toBeVisible();
    // Asked again with the next one, and answered Needed again.
    fireEvent.change(input, { target: { files: [file] } });
    const again = await screen.findByRole('alertdialog', { name: 'Is it needed again?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Needed again' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'No longer needed' })).toBeNull(),
    );
    expect(state.unneededCalls?.map((c) => [c.method, c.id])).toEqual([['DELETE', 'doc-ead']]);
  });
});
