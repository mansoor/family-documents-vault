import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * Requests as a table, and ended links and requests removed after a while
 * (0.9.0, RQ; the owner's ask of 16 Nov 2026): on a wide screen Sharing's
 * requests are a grid like its links, Working now apart from No longer
 * working; on a phone, the list as before. What no longer works shows its
 * first 20 and "Show N more", and says how long it is kept. Settings →
 * Privacy has the household's choice: an owner's to change, an adult's to
 * read.
 */

const PHONE = 320;
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
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** A request as GET /upload-requests gives it (UploadRequestView). */
function request(over: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  return {
    id: 'req-a',
    title: 'Tax papers for 2025',
    message: null,
    items: [{ id: 'i1', label: 'W-2' }],
    recipient_label: 'Jane, accountant',
    recipient_email: null,
    requested_by_name: ME.display_name,
    mine: true,
    created_at: '2026-09-30T10:00:00Z',
    expires_at: new Date(Date.now() + 10 * 864e5).toISOString(),
    protection: ['password'],
    max_visits: 3,
    visits_used: 1,
    max_files: 10,
    files_used: 2,
    max_total_bytes: 200 * 1024 * 1024,
    bytes_used: 2048,
    accept_types: 'standard',
    review_by: 'me',
    suggested_member_id: null,
    suggested_type_key: null,
    close_after_submit: false,
    state: 'active',
    paused_reason: null,
    closed_reason: null,
    files_received: 2,
    revealable: true,
    changeable: true,
    ...over,
  };
}

/** A link outside the family that no longer works, as GET /shares gives it. */
const endedLink = (n: number) => ({
  id: `sh-${n}`,
  document_id: `doc-${n}`,
  document_title: `Bill ${n}`,
  recipient_label: null,
  created_by_name: ME.display_name,
  created_at: '2026-10-01T09:00:00Z',
  expires_at: '2026-10-02T09:00:00Z',
  has_pin: false,
  open_count: 0,
  last_opened_at: null,
  state: 'expired',
  summary: 'Shared by link, not opened. Expired on 2 October.',
});

function open(path: string, over: Partial<FakeState>, role: 'owner' | 'adult' = 'owner') {
  const state = fresh({ timezone: 'Europe/London', ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const headsOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);

describe('requests on Sharing (0.9.0, RQ)', () => {
  it('at 1280: a grid of those working now, each acted on from its row; the ended a plain table', async () => {
    atWidth(WIDE);
    const state = open('/sharing', {
      uploadRequests: [
        request(),
        request({
          id: 'req-b',
          title: 'Lease papers',
          recipient_label: null,
          mine: false,
          requested_by_name: 'Sam',
          review_by: 'adults',
          revealable: false,
          changeable: false,
          files_received: 0,
          visits_used: 0,
          max_visits: null,
        }),
        request({
          id: 'req-c',
          title: 'Old request',
          state: 'revoked',
          revealable: false,
          changeable: false,
        }),
      ],
    });
    const live = await screen.findByRole('grid', { name: 'Requests that work now' });
    expect(headsOf(live)).toEqual([
      'Asked for',
      'For',
      'Where it stands',
      'Received',
      'Asked by',
      'Show the link',
      'Change',
      'Take it back',
    ]);
    const [, mine, theirs] = within(live).getAllByRole('row');
    expect(mine).toHaveTextContent('“Tax papers for 2025”');
    expect(mine).toHaveTextContent('Jane, accountant');
    expect(mine).toHaveTextContent(/Working until/);
    expect(mine).toHaveTextContent('2 files received · 1 of 3 visits used');
    expect(mine).toHaveTextContent('You');
    expect(theirs).toHaveTextContent('Any adult looks at what comes in');
    expect(theirs).toHaveTextContent('No files yet · Not opened yet');
    expect(theirs).toHaveTextContent('Sam');
    expect(
      within(theirs as HTMLElement).queryByRole('button', { name: /^Show the link/ }),
    ).toBeNull();
    expect(
      within(mine as HTMLElement).getByRole('link', {
        name: 'Change the request “Tax papers for 2025” to Jane, accountant',
      }),
    ).toHaveAttribute('href', '/sharing/ask/req-a');
    // R2's grid: one stop for Tab.
    await waitFor(() => expect(live.querySelectorAll('[tabindex="0"]')).toHaveLength(1));

    // No longer working: named as the links' are, with no actions.
    expect(screen.getAllByRole('heading', { name: 'No longer working' })).toHaveLength(1);
    const ended = screen.getByRole('table', { name: 'Requests that no longer work' });
    expect(within(ended).getByText('Taken back')).toBeInTheDocument();
    expect(within(ended).queryByRole('button')).toBeNull();
    expect(ended.querySelectorAll('[tabindex]')).toHaveLength(0);
    await expectAccessible();

    // Taken back as before: asked first, focus back on its button.
    fireEvent.click(
      within(mine as HTMLElement).getByRole('button', {
        name: 'Take back the request “Tax papers for 2025” to Jane, accountant',
      }),
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Take this request back?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take it back' }));
    await screen.findByText(/The request “Tax papers for 2025” to Jane, accountant is taken back/);
    expect(
      state.calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/upload-requests/req-a'),
    ).toBe(true);
  });

  it('at 1280: an owner turns a request a restore paused back on from its row', async () => {
    atWidth(WIDE);
    const state = open('/sharing', {
      uploadRequests: [request({ state: 'paused', paused_reason: 'restored' })],
    });
    const live = await screen.findByRole('grid', { name: 'Requests that work now' });
    expect(within(live).getByText('Paused after a restore')).toBeInTheDocument();
    fireEvent.click(
      within(live).getByRole('button', {
        name: 'Turn back on the request “Tax papers for 2025” to Jane, accountant',
      }),
    );
    await screen.findByText(/works again\./);
    expect(state.calls.some((c) => c.url === '/api/v1/upload-requests/req-a/resume')).toBe(true);
  });

  it('at 320: the lists, as before', async () => {
    atWidth(PHONE);
    open('/sharing', {
      uploadRequests: [request(), request({ id: 'req-c', state: 'expired' })],
    });
    // The list is there before the requests are: wait for the ended ones.
    expect(await screen.findByRole('list', { name: 'Requests that no longer work' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Requests that work now' })).toHaveTextContent(
      'Tax papers for 2025',
    );
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('what no longer works: 20 first, the rest on asking, and how long it is kept (0.9.0, RQ)', () => {
  it('shows 20 ended links and 20 ended requests, then Show N more for the rest', async () => {
    atWidth(PHONE);
    open('/sharing', {
      shares: Array.from({ length: 23 }, (_, i) => endedLink(i + 1)),
      uploadRequests: Array.from({ length: 21 }, (_, i) =>
        request({ id: `req-${i}`, title: `Request ${i}`, state: 'expired' }),
      ),
      endedSharing: { days: 90 },
    });
    const links = await screen.findByRole('list', { name: 'Links that no longer work' });
    expect(within(links).getAllByRole('listitem')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more links that no longer work' }));
    expect(within(links).getAllByRole('listitem')).toHaveLength(23);
    // The focus goes to the first one it showed.
    expect(within(links).getAllByRole('listitem')[20]).toHaveFocus();
    expect(screen.queryByRole('button', { name: /more links that no longer work/ })).toBeNull();

    const asked = screen.getByRole('list', { name: 'Requests that no longer work' });
    expect(within(asked).getAllByRole('listitem')).toHaveLength(20);
    fireEvent.click(
      screen.getByRole('button', { name: 'Show 1 more requests that no longer work' }),
    );
    expect(within(asked).getAllByRole('listitem')).toHaveLength(21);
    expect(within(asked).getAllByRole('listitem')[20]).toHaveFocus();

    // How long they are kept, and what stays, said beside each.
    expect(
      await screen.findAllByText(
        /Links and requests that no longer work are removed 90 days after they end\. The activity log keeps its record of each/,
      ),
    ).toHaveLength(2);
    await expectAccessible();
  });

  it('says nothing of keeping to a vault that does not remove them', async () => {
    atWidth(PHONE);
    open('/sharing', { shares: [endedLink(1)] });
    await screen.findByRole('list', { name: 'Links that no longer work' });
    expect(screen.queryByText(/removed .* after they end/)).toBeNull();
  });
});

describe('Settings → Privacy: links and requests that no longer work (0.9.0, RQ)', () => {
  it('an owner chooses 30 days, a year or never; 90 is the default', async () => {
    atWidth(WIDE);
    const state = open('/settings/privacy', { endedSharing: { days: 90 } });
    const card = (
      await screen.findByRole('heading', { name: 'Links and requests that no longer work' })
    ).closest('section') as HTMLElement;
    const choice = await within(card).findByRole('group', { name: 'Remove them from Sharing' });
    expect(within(choice).getByLabelText('After 90 days (the default)')).toBeChecked();
    expect(card).toHaveTextContent(
      'The activity log keeps its record of each: when it was made, opened and taken back, and what came in.',
    );
    const save = within(card).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    // Choosing saves nothing (arrow keys pass over every choice): Save does.
    fireEvent.click(within(choice).getByLabelText('After 1 year'));
    fireEvent.click(within(choice).getByLabelText('After 30 days'));
    expect(state.endedSharing?.saves ?? []).toEqual([]);
    // Sooner than before: asked first, saying what goes, and Cancel keeps it.
    fireEvent.click(save);
    let ask = await screen.findByRole('alertdialog', { name: 'Remove them sooner?' });
    expect(ask).toHaveTextContent(
      'Links and requests that ended more than 30 days ago will be removed from Sharing the next night',
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(state.endedSharing?.saves ?? []).toEqual([]);
    fireEvent.click(save);
    ask = await screen.findByRole('alertdialog', { name: 'Remove them sooner?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove after 30 days' }));
    expect(await within(card).findByText('Saved: After 30 days.')).toBeInTheDocument();
    // Longer, or never: saved at once, nothing to ask.
    fireEvent.click(within(choice).getByLabelText('Never'));
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText('Saved: Never.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // From never, any time at all removes sooner.
    fireEvent.click(within(choice).getByLabelText('After 1 year'));
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alertdialog', { name: 'Remove them sooner?' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(state.endedSharing?.saves).toEqual([
      { remove_after_days: 30 },
      { remove_after_days: null },
    ]);
    await expectAccessible();
  });

  it('an adult reads it, and is told an owner changes it', async () => {
    atWidth(WIDE);
    open('/settings/privacy', { endedSharing: { days: 365 } }, 'adult');
    const card = (
      await screen.findByRole('heading', { name: 'Links and requests that no longer work' })
    ).closest('section') as HTMLElement;
    expect(
      await within(card).findByText(
        'Links and requests that no longer work are removed 1 year after they end.',
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('radio')).toBeNull();
    expect(card).toHaveTextContent(
      'Only an owner can change how long ended links and requests are kept.',
    );
  });
});
