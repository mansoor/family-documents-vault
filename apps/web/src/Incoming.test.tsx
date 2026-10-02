import { NOT_SCANNED } from '@fdv/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * Incoming on the web (5.23): the inbox of what came in through a request,
 * a file's pages, the form that files it — starting from the request's
 * hints — and refusing it, which asks first (5.1's dialog). Every file
 * says it was not scanned for viruses: this vault scans nothing (A42).
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  let made = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:incoming-${++made}`),
    revokeObjectURL: vi.fn(),
  });
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

/** A W-2, sent by the accountant through a request with hints for whoever reviews it. */
const W2 = {
  id: 'in-1',
  request_id: 'req-1',
  request_title: 'Your tax papers',
  recipient_label: 'Jane, accountant',
  item_label: 'W-2',
  name: 'W-2 2025.pdf',
  content_type: 'application/pdf',
  byte_size: 120 * 1024,
  sender_note: 'The 1099 follows next week.',
  sent_at: '2026-10-01T09:00:00Z',
  removed_at: '2026-10-31T09:00:00Z',
  scan_state: 'unscanned',
  preview_state: 'ready',
  preview_pages: 2,
  suggested_member_id: 'm-0',
  suggested_type_key: 'passport',
  review_by: 'me',
  moved_to_owners: false,
};

/** The app at `path`, signed in as `role`, with these files waiting. */
function at(
  path: string,
  over: Partial<FakeState> = {},
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'adult',
): FakeState {
  const state = fresh({ members: [ME, AISHA], incoming: [{ ...W2 }], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** The screen called `title`, once it has drawn: its own main, never the gate's. */
async function screenCalled(title: string | RegExp): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 1, name: title });
  return heading.closest('main') as HTMLElement;
}

describe('incoming on the web (5.23)', () => {
  it(
    'the inbox lists what is waiting, each saying it was not scanned',
    { timeout: 15_000 },
    async () => {
      at('/incoming');
      const list = await screen.findByRole('list', { name: 'Waiting for you' });
      const row = await within(list).findByRole('link', { name: /W-2 2025\.pdf/ });
      expect(row).toHaveAttribute('href', '/incoming/in-1');
      expect(within(row).getByText(NOT_SCANNED)).toBeInTheDocument();
      expect(
        within(row).getByText('From Jane, accountant, for “Your tax papers” — W-2'),
      ).toBeInTheDocument();
      expect(within(row).getByText(/removed on 31 October unless you file it/)).toBeInTheDocument();
      await expectAccessible();
    },
  );

  it('nothing waiting says so', { timeout: 15_000 }, async () => {
    at('/incoming', { incoming: [] });
    const main = await screenCalled('Files sent to you');
    expect(await within(main).findByText('Nothing is waiting for you.')).toBeInTheDocument();
  });

  it(
    "a file: its pages, the warning, and a form started from the request's hints",
    { timeout: 15_000 },
    async () => {
      const state = at('/incoming/in-1');
      const main = await screenCalled('W-2 2025.pdf');
      expect(
        await within(main).findByRole('img', { name: 'Page 1 of 2 of W-2 2025.pdf' }),
      ).toHaveAttribute('src', 'blob:incoming-1');
      expect(within(main).getByText(NOT_SCANNED)).toBeInTheDocument();
      expect(within(main).getByText(/does not check files for viruses/)).toBeInTheDocument();
      expect(within(main).getByText(/The 1099 follows next week\./)).toBeInTheDocument();
      // The next page, when asked.
      fireEvent.click(within(main).getByRole('button', { name: 'Next page' }));
      expect(
        await within(main).findByRole('img', { name: 'Page 2 of 2 of W-2 2025.pdf' }),
      ).toBeInTheDocument();
      expect(state.calls.some((c) => c.url === '/api/v1/incoming/in-1/pages/2')).toBe(true);
      // Started from the hints: the kind and the person the requester guessed.
      const form = within(main).getByRole('form', { name: 'File it' });
      expect(within(form).getByLabelText('Name')).toHaveValue('W-2 2025');
      expect(within(form).getByLabelText('Kind of document')).toHaveValue('passport');
      expect(within(form).getByLabelText('Whose is it?')).toHaveValue('m-0');
      // Only me is for one's own: not offered for Aisha's.
      expect(within(form).getByRole('button', { name: 'Only me' })).toBeDisabled();
      await expectAccessible();
    },
  );

  it('filing it sends what was chosen, and opens the document', { timeout: 15_000 }, async () => {
    const state = at('/incoming/in-1');
    const main = await screenCalled('W-2 2025.pdf');
    const form = await within(main).findByRole('form', { name: 'File it' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'W-2 for 2025' } });
    fireEvent.change(within(form).getByLabelText('Whose is it?'), { target: { value: 'me' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Adults only' }));
    fireEvent.click(within(form).getByRole('button', { name: 'File it' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/documents\/doc-incoming-/));
    const sent = state.calls.find((c) => c.url === '/api/v1/incoming/in-1/accept');
    expect(sent?.body).toEqual({
      title: 'W-2 for 2025',
      type_key: 'passport',
      owner_member_id: 'me',
      visibility: 'adults',
    });
    // Its history says where it came from.
    expect(
      await screen.findByText(/Sent through a request link \(Jane, accountant\)/),
    ).toBeInTheDocument();
  });

  it('filing it as a new version of a document sends only that', { timeout: 15_000 }, async () => {
    const state = at('/incoming/in-1');
    const main = await screenCalled('W-2 2025.pdf');
    const form = await within(main).findByRole('form', { name: 'File it' });
    fireEvent.click(within(form).getByRole('button', { name: 'A new version of one' }));
    fireEvent.change(await within(form).findByLabelText('A new version of'), {
      target: { value: 'doc-1' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'File it' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-1'));
    expect(state.calls.find((c) => c.url === '/api/v1/incoming/in-1/accept')?.body).toEqual({
      into_document_id: 'doc-1',
    });
  });

  it('refusing asks first, and Cancel gives focus back', { timeout: 15_000 }, async () => {
    const state = at('/incoming/in-1');
    const main = await screenCalled('W-2 2025.pdf');
    const refuse = await within(main).findByRole('button', { name: 'Refuse it' });
    refuse.focus();
    fireEvent.click(refuse);
    const dialog = await screen.findByRole('alertdialog', { name: 'Refuse this file?' });
    expect(
      within(dialog).getByText(
        /“W-2 2025\.pdf” is removed from the vault.*Jane, accountant is not told/,
      ),
    ).toBeInTheDocument();
    // Focus starts on Cancel, so Enter never refuses by accident.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(refuse).toHaveFocus();
    expect(state.calls.some((c) => c.url.endsWith('/reject'))).toBe(false);

    // Asked again, and refused: gone, and said so.
    fireEvent.click(refuse);
    const again = await screen.findByRole('alertdialog', { name: 'Refuse this file?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Refuse it' }));
    await waitFor(() => expect(window.location.pathname).toBe('/incoming'));
    expect(state.calls.some((c) => c.url === '/api/v1/incoming/in-1/reject')).toBe(true);
    const inbox = await screenCalled('Files sent to you');
    expect(
      await within(inbox).findByText('“W-2 2025.pdf” was refused, and removed.'),
    ).toHaveFocus();
    expect(await within(inbox).findByText('Nothing is waiting for you.')).toBeInTheDocument();
  });

  it(
    'Settings leads to it for whoever reviews, and for nobody else',
    { timeout: 15_000 },
    async () => {
      at('/settings');
      const main = await screenCalled('Settings');
      expect(await within(main).findByRole('link', { name: /Files sent to you/ })).toHaveAttribute(
        'href',
        '/incoming',
      );
    },
  );

  it('a teen is shown no way to it', { timeout: 15_000 }, async () => {
    at('/settings', {}, 'teen');
    const main = await screenCalled('Settings');
    await within(main).findByRole('link', { name: /How you hear about things/ });
    expect(within(main).queryByRole('link', { name: /Files sent to you/ })).toBeNull();
  });

  it(
    'a teen who asks for it by its address is given nothing, and nothing is asked of the vault',
    { timeout: 15_000 },
    async () => {
      const state = at('/incoming', {}, 'teen');
      const main = await screenCalled('Files sent to you');
      expect(await within(main).findByText('Nothing is waiting for you.')).toBeInTheDocument();
      expect(state.calls.some((c) => c.url.startsWith('/api/v1/incoming'))).toBe(false);
    },
  );
});
