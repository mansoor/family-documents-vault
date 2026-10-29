import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * No longer needed (0.9.0), on the web: set or cleared with a document's
 * details (Edit details, the one place on its page), never a menu's item;
 * marked beside a reminder in Needs attention with the dialog — why, and
 * what replaced it, found as you type; said on its page by a banner with
 * Needed again and Change why. A replacement the reader may not see is
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
  it('a document’s page offers no Mark (Edit is where it is set); marked, its banner says so, with Needed again (0.9.0)', async () => {
    const state = open('/documents/doc-ead', [{ ...EAD }, { ...GREEN }]);
    // Not marked: nothing of it here but Edit, which sets it.
    expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/documents/doc-ead/confirm',
    );
    await screen.findByRole('button', { name: 'Download' });
    expect(screen.queryByRole('button', { name: 'Mark as no longer needed' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'No longer needed' })).toBeNull();
    cleanup();

    // Marked: its banner, with what replaced it, why, and Needed again.
    const marked = open('/documents/doc-ead', [{ ...MARKED }, { ...GREEN }]);
    const said = await banner();
    expect(said).toHaveTextContent(
      'No longer needed since 23 Oct 2026 · Replaced by Green card · Needed again',
    );
    expect(within(said).getByRole('link', { name: 'Green card' })).toHaveAttribute(
      'href',
      '/documents/doc-green',
    );
    expect(said).toHaveTextContent('The green card came');
    expect(within(said).getByRole('button', { name: 'Change why' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as no longer needed' })).toBeNull();
    await expectAccessible();
    // Needed again: the banner goes, and nothing to mark it with comes back.
    fireEvent.click(within(said).getByRole('button', { name: 'Needed again' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'No longer needed' })).toBeNull(),
    );
    expect(marked.unneededCalls?.at(-1)).toMatchObject({ method: 'DELETE', id: 'doc-ead' });
    expect(screen.queryByRole('button', { name: 'Mark as no longer needed' })).toBeNull();
    expect(state.unneededCalls ?? []).toEqual([]);
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
    open('/documents/doc-ead', [{ ...MARKED }], 'owner', {
      unneededRefusal: {
        status: 422,
        code: 'validation_failed',
        message: 'That document is not in the vault.',
      },
    });
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Change why' }));
    const dialog = await screen.findByRole('dialog', { name: 'No longer needed' });
    fireEvent.change(within(dialog).getByLabelText('Why (optional)'), {
      target: { value: 'Kept for the lawyer' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That document is not in the vault.',
    );
    expect(screen.getByRole('dialog', { name: 'No longer needed' })).toBeVisible();
  });

  it('the ⋯ menus offer it no more, either way: it is set with the details (0.9.0)', async () => {
    open('/', [{ ...EAD }, { ...MARKED, id: 'doc-old', title: 'Old card' }]);
    for (const title of ['EAD card', 'Old card']) {
      const more = await screen.findByRole('button', { name: `Actions for “${title}”` });
      fireEvent.click(more);
      const menu = await screen.findByRole('menu', { name: `Actions for “${title}”` });
      const items = within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent);
      expect(items).toContain('Edit details');
      expect(items).not.toContain('Mark as no longer needed');
      expect(items).not.toContain('Needed again');
      fireEvent.keyDown(within(menu).getAllByRole('menuitem')[0] as HTMLElement, {
        key: 'Escape',
      });
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    }
  });

  it('Edit details sets it, with why and what replaced it, saved with the details', async () => {
    const state = open('/documents/doc-ead/confirm', [{ ...EAD }, { ...GREEN }]);
    const on = await screen.findByRole('switch', { name: 'No longer needed' });
    expect(on).not.toBeChecked();
    // Off, nothing of it is asked.
    expect(screen.queryByLabelText('Why (optional)')).toBeNull();
    fireEvent.click(on);
    const why = await screen.findByLabelText('Why (optional)');
    fireEvent.change(why, { target: { value: 'The green card came' } });
    const green = await screen.findByRole('radio', { name: 'Green card' });
    // Never itself.
    expect(screen.queryByRole('radio', { name: 'EAD card' })).toBeNull();
    fireEvent.click(green);
    await expectAccessible();
    // Nothing is marked until the card is saved.
    expect(state.unneededCalls ?? []).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(state.unneededCalls).toHaveLength(1));
    expect(state.unneededCalls).toEqual([
      {
        method: 'POST',
        id: 'doc-ead',
        body: { reason: 'The green card came', replaced_by: 'doc-green' },
      },
    ]);
    // The details went first, as ever.
    expect(state.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/doc-ead'))).toBe(true);
  });

  it('Edit details clears it — needed again — and saving it untouched sends nothing of it', async () => {
    const state = open('/documents/doc-ead/confirm', [{ ...MARKED }, { ...GREEN }]);
    const on = await screen.findByRole('switch', { name: 'No longer needed' });
    expect(on).toBeChecked();
    expect(await screen.findByLabelText('Why (optional)')).toHaveValue('The green card came');
    expect(await screen.findByRole('radio', { name: 'Green card' })).toBeChecked();
    // Saved untouched: nothing of it is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() =>
      expect(state.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/doc-ead'))).toBe(
        true,
      ),
    );
    expect(state.unneededCalls ?? []).toEqual([]);

    // Turned off: needed again, once saved.
    cleanup();
    const again = open('/documents/doc-ead/confirm', [{ ...MARKED }, { ...GREEN }]);
    const off = await screen.findByRole('switch', { name: 'No longer needed' });
    fireEvent.click(off);
    expect(
      screen.getByText('Needed again once you save: its reminders come back as its dates say.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Why (optional)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(again.unneededCalls).toHaveLength(1));
    expect(again.unneededCalls?.[0]).toMatchObject({ method: 'DELETE', id: 'doc-ead' });
  });

  it('Edit details offers it only to whoever may change the document', async () => {
    // A teen's card for somebody else's document: not theirs to mark.
    open('/documents/doc-ead/confirm', [{ ...EAD, owner_member_id: 'm-2' }], 'teen');
    await screen.findByRole('button', { name: 'Save to the vault' });
    expect(screen.queryByRole('switch', { name: 'No longer needed' })).toBeNull();
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

  it('the Documents table’s bulk bar offers it no more (0.9.0)', async () => {
    atWidth(1280);
    open('/documents', [{ ...EAD }, { ...GREEN }]);
    const table = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    fireEvent.click(await within(table).findByRole('checkbox', { name: 'Select “EAD card”' }));
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(within(bar).getByRole('button', { name: 'Move to the Trash' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'No longer needed' })).toBeNull();
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
    // Given as the sheet's effect runs, just after it is drawn: waited for.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(ask).getByRole('button', { name: 'Keep it no longer needed' }),
      ),
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
