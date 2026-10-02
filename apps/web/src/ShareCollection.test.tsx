import { SHARE_CODE_TRUTH, SHARE_CODE_UNAVAILABLE } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** The web's stylesheet, read from disk: under Vitest an import of it is empty. */
const CSS = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();

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
      // What it offered and was left unticked, which never follows (the
      // 5.19 review's second round) — the diary, and the deeds with no file.
      left_out_ids: [DIARY.id, PAPER.id],
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

  it('a collection’s link is protected as a document’s is, with operator mail and without (W520-8)', async () => {
    const openSheet = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Share this collection' }));
      const sheet = await screen.findByRole('dialog', { name: 'Share “For the broker”' });
      await within(sheet).findByRole('checkbox', { name: /Mansoor's passport/ });
      return { sheet, protect: within(sheet).getByRole('group', { name: 'Protect it' }) };
    };
    const posted = (state: FakeState) =>
      state.calls
        .filter((c) => c.method === 'POST' && c.url === `/api/v1/collections/${BROKER.id}/shares`)
        .at(-1)?.body as Record<string, unknown> | undefined;

    // With operator mail: a password made up, a code by email, one browser.
    const state = at(`/collections/${BROKER.id}`, { operatorMail: true });
    const { sheet, protect } = await openSheet();
    fireEvent.click(within(protect).getByLabelText(/ask for a password/));
    fireEvent.click(within(protect).getByLabelText(/email them a code/));
    fireEvent.change(within(sheet).getByLabelText('Their email address'), {
      target: { value: 'jane.smith@example.com' },
    });
    fireEvent.click(within(protect).getByLabelText('This browser only'));
    expect(within(sheet).getByText(SHARE_CODE_TRUTH)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make the link' }));
    expect(await within(sheet).findByTestId('share-password')).toHaveTextContent('k7mq-p2xa-9htw');
    expect(posted(state)).toMatchObject({
      document_ids: [PASSPORT.id],
      with_pin: false,
      with_password: true,
      code_email: 'jane.smith@example.com',
      this_device_only: true,
    });
    expect(within(sheet).getByText(/a code is emailed to j•••@e•••\.com/)).toBeInTheDocument();
    cleanup();

    // Without: no code is offered, and the reason is said; the rest is there.
    const without = at(`/collections/${BROKER.id}`, { operatorMail: false });
    const other = await openSheet();
    expect(within(other.protect).queryByLabelText(/email them a code/)).not.toBeInTheDocument();
    expect(within(other.sheet).getByTestId('share-code-unavailable')).toHaveTextContent(
      SHARE_CODE_UNAVAILABLE,
    );
    fireEvent.click(within(other.protect).getByLabelText(/ask for a password/));
    fireEvent.click(within(other.sheet).getByRole('button', { name: 'I’ll type one' }));
    fireEvent.change(within(other.sheet).getByLabelText('The password'), {
      target: { value: 'river otter lantern' },
    });
    await expectAccessible();
    fireEvent.click(within(other.sheet).getByRole('button', { name: 'Make the link' }));
    await within(other.sheet).findByText(/\/s#share-secret-0123456789abcdef$/);
    const body = posted(without);
    expect(body).toMatchObject({ password: 'river otter lantern', with_pin: false });
    expect(body).not.toHaveProperty('code_email');
    expect(body).not.toHaveProperty('this_device_only');
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
    // Heard with the Add button itself, not only read around it (W519-3).
    expect(
      within(sheet).getByRole('button', { name: 'Add to “For the broker”' }),
    ).toHaveAccessibleDescription(
      'This collection is shared with Jane Smith. What you put in it goes to them too, if everybody the collection is for may see it.',
    );
    expect(
      within(sheet).getByRole('button', { name: 'Add to “Quiet”' }),
    ).not.toHaveAccessibleDescription();
  });

  it('a teen is told what they put in a shared collection stays in the family (C519-02)', async () => {
    at(
      `/documents/${PASSPORT.id}`,
      {
        collections: [
          {
            ...BROKER,
            audience: 'everyone',
            items: [],
            shared_outside: { with: [], following: true },
          },
        ],
      },
      'teen',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', {
      name: "Add “Mansoor's passport” to a collection",
    });
    const said =
      'This collection is shared outside the family. What you put in it stays in the family: only what an owner or an adult puts in goes to them.';
    expect(await within(sheet).findByText(said)).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: 'Add to “For the broker”' }),
    ).toHaveAccessibleDescription(said);
  });

  it('Keep it up to date is named once, and explained once (W519-5)', async () => {
    at(`/collections/${BROKER.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Share this collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share “For the broker”' });
    const follow = await within(sheet).findByRole('checkbox', { name: 'Keep it up to date' });
    expect(follow).toHaveAccessibleName('Keep it up to date');
    expect(follow).toHaveAccessibleDescription(
      /^What an owner or an adult puts in the collection later goes too/,
    );
  });

  it('every box in the share sheets sits beside the start of its label, as the app’s other boxes do', async () => {
    // The app's box: `.check`, the box and then its label, side by side and
    // never wrapped onto a line of its own (5.18's PIN row on a phone).
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /(?:^|\})\s*\.check\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).not.toMatch(/flex-wrap:\s*wrap/);
    // And the box keeps its size beside a long label that wraps (the PIN's).
    const box = /(?:^|\})\s*\.check input\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(box).toMatch(/flex:\s*none|flex-shrink:\s*0/);
    const boxesBesideLabels = (root: HTMLElement) => {
      const boxes = within(root).getAllByRole('checkbox');
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) {
        const row = box.parentElement as HTMLElement;
        expect(row.className, box.id).toMatch(/\bcheck\b/);
        const label = box.nextElementSibling as HTMLElement | null;
        expect(label?.tagName, box.id).toBe('LABEL');
        expect(label?.getAttribute('for'), box.id).toBe(box.id);
      }
    };
    // A collection's sheet: the documents, Keep it up to date and the PIN.
    at(`/collections/${BROKER.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Share this collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share “For the broker”' });
    await within(sheet).findByRole('checkbox', { name: /Keep it up to date/ });
    boxesBesideLabels(sheet);
    cleanup();
    // A document's: the PIN.
    at(`/documents/${PASSPORT.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    const pin = await screen.findByRole('checkbox', { name: /Also ask for a four-digit PIN/ });
    boxesBesideLabels(pin.closest('section') as HTMLElement);
  });

  it('why a document is not ticked, and what Keep it up to date means, sit just under the label (second review)', async () => {
    // In the label's own column, the next line down: not under the row's
    // tap height, 22px below a title of one line.
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /(?:^|\})\s*\.check\.check-noted\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(/align-content:\s*start/);
    expect(Number(/row-gap:\s*(\d+)px/.exec(rule)?.[1] ?? 99)).toBeLessThanOrEqual(4);
    // Nothing sets them in by hand any more: the column does.
    for (const said of ['.share-item-why', '.share-follow-note']) {
      const own = new RegExp(`(?:^|\\})\\s*${said.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
      expect(own?.[1] ?? '', said).not.toMatch(/padding-left/);
    }
    at(`/collections/${BROKER.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Share this collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share “For the broker”' });
    const follow = await within(sheet).findByRole('checkbox', { name: 'Keep it up to date' });
    const notes = [
      ...[...sheet.querySelectorAll<HTMLElement>('[id$="-why"]')],
      sheet.querySelector<HTMLElement>('#share-follow-note') as HTMLElement,
    ];
    expect(notes.length).toBeGreaterThan(2);
    for (const note of notes) {
      const row = note.parentElement as HTMLElement;
      expect(row.className, note.id).toMatch(/\bcheck-noted\b/);
      expect(note.previousElementSibling?.tagName, note.id).toBe('LABEL');
    }
    expect(follow.parentElement?.contains(sheet.querySelector('#share-follow-note'))).toBe(true);
  });
});
