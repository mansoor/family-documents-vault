import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { SharePage } from './screens/SharePage.js';
import {
  fresh,
  installFakeApi,
  PASSPORT,
  signedIn,
  STATEMENT,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * Sharing a collection outside the family, on the web (5.19): the sheet on
 * a collection's page, what the person it is for sees, the family's list of
 * links in Settings → Sharing, and the warning where documents are put in a
 * collection that is shared.
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

/** The signed-in member's own private diary. */
const DIARY = {
  ...PASSPORT,
  id: 'doc-4',
  title: 'My diary',
  visibility: 'private',
  owner_member_id: 'me',
  is_essential: false,
  latest_version_id: 'v-4',
  etag: '"diary"',
};
/** Kept on paper for now: no file to send. */
const PAPER = {
  ...PASSPORT,
  id: 'doc-5',
  title: 'Deeds, on paper',
  is_essential: false,
  latest_version_id: null,
  etag: '"paper"',
};

/** The signed-in member's collection for everyone, with one of each. */
const BROKER: FakeCollection = {
  id: 'collection-b',
  name: 'For the broker',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"broker.1"',
  items: [PASSPORT.id, STATEMENT.id, DIARY.id, PAPER.id],
};

function at(
  path: string,
  over: Partial<FakeState> = {},
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
): FakeState {
  const state = fresh({
    documents: [PASSPORT, STATEMENT, DIARY, PAPER],
    collections: [BROKER],
    timezone: 'Europe/London',
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('sharing a collection (5.19)', () => {
  it('the share sheet ticks what everybody may see, asks about the rest, and confirms it is you', async () => {
    const state = at(`/collections/${BROKER.id}`, { stepUpNeeded: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Share this collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share “For the broker”' });
    const box = (title: string) => within(sheet).getByRole('checkbox', { name: title });
    await within(sheet).findByRole('checkbox', { name: /Mansoor's passport/ });

    // The sheet starts where the choosing is: the first box has the focus.
    await waitFor(() => expect(box("Mansoor's passport")).toHaveFocus());
    // Everybody may see the passport: ticked. The adults' statement asks;
    // the diary is mine alone and says so; the deeds have no file to send.
    expect(box("Mansoor's passport")).toBeChecked();
    expect(box('Barclays statement, September 2026')).not.toBeChecked();
    expect(box('Barclays statement, September 2026')).toHaveAccessibleDescription(
      'Adults only — include anyway?',
    );
    expect(box('My diary')).not.toBeChecked();
    expect(box('My diary')).toHaveAccessibleDescription('Only you can see this. It is private.');
    expect(box('Deeds, on paper')).toBeDisabled();
    expect(within(sheet).getByText('1 document ticked.')).toBeInTheDocument();

    // Include the statement anyway, and keep it up to date.
    fireEvent.click(box('Barclays statement, September 2026'));
    expect(within(sheet).getByText('2 documents ticked.')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('checkbox', { name: /Keep it up to date/ }));
    expect(within(sheet).getByText(/lasts 30 days at most/)).toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText('Who is it for?'), {
      target: { value: 'Jane Smith' },
    });
    await expectAccessible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make the link' }));

    // Every collection shared asks who is asking, whatever is in it.
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(screen.getByText(/to share a collection outside the family/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    // Then the link, once, and what it gives.
    expect(
      await within(sheet).findByText(/\/s#share-secret-0123456789abcdef$/),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole('heading', { name: 'The link to “For the broker”' }),
    ).toBeInTheDocument();
    expect(within(sheet).getByText(/It keeps up with the collection/)).toBeInTheDocument();
    const made = state.calls.filter(
      (c) => c.method === 'POST' && c.url === `/api/v1/collections/${BROKER.id}/shares`,
    );
    // Asked twice: refused for the credential, then made.
    expect(made).toHaveLength(2);
    expect(made[1]?.body).toMatchObject({
      document_ids: [PASSPORT.id, STATEMENT.id],
      follow_collection: true,
      recipient_label: 'Jane Smith',
      permission: 'download',
      with_pin: false,
    });
    await expectAccessible();

    // Done: the collection says it is shared, and with whom.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByText(
        'This collection is shared with Jane Smith. What you put in it goes to them too, if everybody the collection is for may see it.',
      ),
    ).toBeInTheDocument();
  });

  it('a teen is not offered to share a collection, nor is anybody an Only me one', async () => {
    at(`/collections/${BROKER.id}`, {}, 'teen');
    await screen.findByRole('heading', { name: 'In this collection' });
    expect(screen.queryByRole('button', { name: 'Share this collection' })).toBeNull();
  });

  it('an Only me collection offers no sharing', async () => {
    at(`/collections/${BROKER.id}`, { collections: [{ ...BROKER, audience: 'only_me' }] });
    await screen.findByRole('heading', { name: 'In this collection' });
    expect(screen.queryByRole('button', { name: 'Share this collection' })).toBeNull();
  });

  it('the recipient sees the collection by its name, and the documents it gives', async () => {
    const state = fresh({
      shareCollection: {
        name: 'For the broker',
        items: [
          { id: 'doc-a', title: 'Payslip, August', filename: 'payslip.pdf' },
          { id: 'doc-b', title: 'Bank statement, August', filename: 'statement.pdf' },
        ],
      },
    });
    installFakeApi(state);
    render(<SharePage token="share-secret-0123456789abcdef" />);
    expect(await screen.findByRole('heading', { name: 'For the broker' })).toBeInTheDocument();
    expect(
      screen.getByText(/shared this collection with you from The Seikh family/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('list', { name: 'What was shared' });
    const list = screen.getByRole('list', { name: 'What was shared' });
    expect(within(list).getByText('Payslip, August')).toBeInTheDocument();
    expect(within(list).getByText('Bank statement, August')).toBeInTheDocument();
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Download payslip.pdf', 'Download statement.pdf']);
    expect(screen.getByText(/shared these documents with you/)).toBeInTheDocument();
    // Nothing on the page counts what was not sent.
    expect(document.body.textContent).not.toMatch(/\bof \d+ documents|hidden|left out/);
    await expectAccessible();
  });

  it('behind a PIN, the collection’s name waits too', async () => {
    installFakeApi(
      fresh({
        sharePin: '4821',
        shareCollection: { name: 'Divorce', items: [] },
      }),
    );
    render(<SharePage token="share-secret-0123456789abcdef" />);
    expect(await screen.findByRole('heading', { name: 'Shared documents' })).toBeInTheDocument();
    expect(screen.getByText(/shared a collection of documents with you/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Divorce');
  });

  it("Settings → Sharing lists a collection's link beside a document's, and takes one back after asking", async () => {
    const state = at('/settings', {
      shares: [
        {
          id: 'sh-c',
          document_id: null,
          document_title: null,
          collection_id: BROKER.id,
          collection_name: 'For the broker',
          follow_collection: true,
          recipient_label: 'Jane Smith',
          created_by_name: 'Mansoor Seikh',
          created_at: '2026-09-27T10:00:00Z',
          expires_at: '2026-10-04T10:00:00Z',
          has_pin: false,
          open_count: 2,
          last_opened_at: null,
          state: 'active',
          flow: 'v2',
          permission: 'download',
          max_opens: null,
          max_downloads: null,
          downloads_used: 1,
          pages: null,
          summary:
            'Shared with Jane Smith, opened 2 times; 1 download. Stops working on 4 October at 11:00. Keeps up with the collection.',
        },
        {
          id: 'sh-d',
          document_id: PASSPORT.id,
          document_title: "Mansoor's passport",
          collection_id: null,
          collection_name: null,
          recipient_label: 'the embassy',
          created_by_name: 'Mansoor Seikh',
          created_at: '2026-09-26T10:00:00Z',
          expires_at: '2026-09-27T10:00:00Z',
          has_pin: false,
          open_count: 1,
          last_opened_at: null,
          state: 'expired',
          flow: 'v2',
          permission: 'download',
          summary: 'Shared with the embassy, opened once. Expired on 27 September at 11:00.',
        },
      ],
    });
    fireEvent.click(await screen.findByRole('link', { name: /^Sharing/ }));
    const live = await screen.findByRole('list', { name: 'Links that work now' });
    expect(within(live).getByText('The collection “For the broker”')).toBeInTheDocument();
    expect(within(live).getByText(/Keeps up with the collection\.$/)).toBeInTheDocument();
    const ended = screen.getByRole('list', { name: 'Links that no longer work' });
    expect(within(ended).getByText("“Mansoor's passport”")).toBeInTheDocument();
    // An ended link has nothing to take back.
    expect(within(ended).queryByRole('button')).toBeNull();
    await expectAccessible();

    const takeBack = within(live).getByRole('button', {
      name: 'Take back the link to the collection “For the broker”, shared with Jane Smith',
    });
    // Asked first; Cancel does nothing.
    fireEvent.click(takeBack);
    const asked = await screen.findByRole('alertdialog', { name: 'Take this link back?' });
    expect(asked).toHaveTextContent(
      'Whoever has it can no longer open the documents it gives from the collection “For the broker”',
    );
    fireEvent.click(within(asked).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(takeBack);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Take it back' }),
    );
    expect(
      await screen.findByText('The link to the collection “For the broker” is taken back.'),
    ).toHaveFocus();
    expect(state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      '/api/v1/shares/sh-c',
    ]);
    expect(screen.queryByText('The collection “For the broker”')).toBeNull();
  });

  it('Sharing is not in Settings for a teen', async () => {
    at('/settings', {}, 'teen');
    await screen.findByRole('link', { name: /How you hear about things/ });
    expect(screen.queryByRole('link', { name: /^Sharing/ })).toBeNull();
  });

  it('putting a document in a collection shared outside says so first', async () => {
    at(`/documents/${PASSPORT.id}`, {
      collections: [
        {
          ...BROKER,
          items: [STATEMENT.id],
          shared_outside: { with: ['Jane Smith'], following: true },
        },
        { ...BROKER, id: 'collection-q', name: 'Quiet', etag: '"q"', items: [] },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', {
      name: "Add “Mansoor's passport” to a collection",
    });
    const shared = (await within(sheet).findByText('For the broker')).closest('li') as HTMLElement;
    expect(shared).toHaveTextContent(
      'This collection is shared with Jane Smith. What you put in it goes to them too, if everybody the collection is for may see it.',
    );
    const quiet = within(sheet).getByText('Quiet').closest('li') as HTMLElement;
    expect(quiet).not.toHaveTextContent(/shared/);
  });
});
