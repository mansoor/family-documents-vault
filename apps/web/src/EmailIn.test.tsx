import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * Email in (0.8.0, S4), on the web: an owner's, the second part of
 * Settings → Server and reading → Email, in and out (0.9.0), which says how the worker has the mailbox, warns while senders are
 * not checked, says what went wrong and what was left alone, and turns it
 * on only while it is offered; the line on Add and Home telling whoever may
 * add documents where to send from where, with a code to confirm it — never
 * a viewer; and an email's notes in Needs attention.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

function at(
  path: string,
  over: Partial<FakeState>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const mailbox = (over: Record<string, unknown> = {}) => ({
  available: true,
  enabled: false,
  server: {
    state: 'ready',
    address: 'home@vault.test',
    folder: 'INBOX',
    after: 'move',
    sender_check: false,
    poll_seconds: 300,
    checked_at: new Date().toISOString(),
    words: 'The vault checks home@vault.test, in its INBOX folder.',
  },
  last_checked_at: null,
  last_error: null,
  last_added_at: null,
  unknown_senders: 0,
  unverified: 0,
  waiting: 0,
  counts: [],
  sender_warning:
    'Senders aren’t verified. Anyone who knows the mailbox’s address can send an email that looks as if it came from someone in the family. Set FDV_MAIL_IN_AUTHSERV_ID so the vault accepts only email your provider checked.',
  ...over,
});
const puts = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'PUT' && c.url === '/api/v1/mail-in');

describe('email in’s page (S4)', () => {
  it('is in Server and reading, says the mailbox is ready, warns that senders aren’t checked, and turns it on', async () => {
    const state = at('/settings', { mailIn: mailbox() });
    fireEvent.click(await screen.findByRole('link', { name: /^Email, in and out/ }));
    expect(
      await screen.findByRole('heading', { name: 'Email, in and out', level: 1 }),
    ).toBeInTheDocument();
    // Its second part, after where email comes from.
    expect(screen.getByRole('heading', { name: 'Email in', level: 2 })).toBeInTheDocument();
    expect(
      await screen.findByText('The vault checks home@vault.test, in its INBOX folder.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Senders aren’t verified.')).toBeInTheDocument();
    expect(screen.getByText(/Set FDV_MAIL_IN_AUTHSERV_ID/)).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: 'Add what the family emails in' });
    expect(box).toBeEnabled();
    await expectAccessible();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const said = await screen.findByText(
      'Saved. Email in is on: the vault checks the mailbox every few minutes.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(puts(state).map((c) => c.body)).toEqual([{ enabled: true }]);
  });

  it('says why it is off, and cannot be turned on, while the mailbox is not set up', async () => {
    at('/settings/email-in', {
      mailIn: mailbox({
        available: false,
        sender_warning: null,
        server: {
          state: 'not_configured',
          address: null,
          folder: null,
          after: 'move',
          sender_check: false,
          poll_seconds: 300,
          checked_at: new Date().toISOString(),
          words:
            'Email in isn’t set up on this server: FDV_MAIL_IN_HOST, FDV_MAIL_IN_USER and a password aren’t all set on the worker.',
        },
      }),
    });
    expect(await screen.findByText(/isn’t set up on this server/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Add what the family emails in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByText('Senders aren’t verified.')).toBeNull();
    await expectAccessible();
  });

  it('says when nobody can confirm an address, and when the server makes mail be filed otherwise (F1, F10)', async () => {
    at('/settings/email-in', {
      mailIn: mailbox({
        confirm: { send_from: false, emailed: false },
        confirm_warning:
          'Nobody can confirm their address yet: an owner needs to set FDV_MAIL_IN_AUTHSERV_ID or FDV_SMTP_URL.',
        server: {
          ...mailbox().server,
          filing: 'leave',
          filing_words:
            'Your mail server can’t move or delete one email safely, so the vault leaves each email it has added where it is, marked as read.',
        },
      }),
    });
    expect(await screen.findByText(/Nobody can confirm their address yet/)).toBeInTheDocument();
    expect(
      screen.getByText(/leaves each email it has added where it is, marked as read/),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('says what last went wrong, and what was left in the mailbox', async () => {
    at('/settings/email-in', {
      mailIn: mailbox({
        enabled: true,
        last_checked_at: new Date().toISOString(),
        last_error: {
          code: 'login_failed',
          words:
            'The mailbox refused the vault’s sign-in. Check FDV_MAIL_IN_USER and the app password.',
          at: new Date().toISOString(),
        },
        counts: [
          '3 emails from unknown senders were ignored. They are still in the mailbox, unread.',
        ],
      }),
    });
    expect(await screen.findByText(/refused the vault’s sign-in/)).toBeInTheDocument();
    expect(
      screen.getByText(
        '3 emails from unknown senders were ignored. They are still in the mailbox, unread.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Last checked/)).toBeInTheDocument();
    await expectAccessible();
  });

  it('is an owner’s page: anybody else is told it is not theirs', async () => {
    const state = at('/settings/email-in', { mailIn: mailbox() }, 'adult');
    expect(
      await screen.findByRole('heading', { name: 'Email, in and out', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Only an owner can change the vault’s email settings.'),
    ).toBeInTheDocument();
    // Nothing of the page drawn, nor asked of the vault.
    expect(screen.queryByRole('checkbox', { name: 'Add what the family emails in' })).toBeNull();
    expect(state.calls.some((c) => c.url === '/api/v1/mail-in')).toBe(false);
  });
});

describe('where to email documents, on Add and Home (S4)', () => {
  it('without the sender check, confirms by a code emailed TO the address, typed in (F1)', async () => {
    const state = at('/add', { mailIn: mailbox({ enabled: true }) }, 'teen');
    const line = await screen.findByRole('region', { name: 'Email documents in' });
    expect(line).toHaveTextContent('Email documents to home@vault.test from you@example.test.');
    expect(line).toHaveTextContent(/First, confirm that the address is yours/);
    // Sending a code from the address proves nothing without the check: not offered.
    expect(screen.queryByRole('button', { name: /Get a code to send/ })).toBeNull();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    const field = await screen.findByLabelText('Code from the email sent to y**@example.test');
    await waitFor(() => expect(field).toHaveFocus());
    await expectAccessible();
    fireEvent.change(field, { target: { value: 'nope-nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('That isn’t the code. Check it, and try again.'),
    ).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'k7qm-3xrp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText(
        'Your address is confirmed: emails from it now come into your Inbox.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Email documents in' })).toHaveTextContent(
        /Attachments go into your Inbox/,
      ),
    );
    expect(state.calls.filter((c) => c.url === '/api/v1/mail-in/me/email-code')).toHaveLength(1);
  });

  it('with the sender check, gives a code to send FROM the address, and a link to write that email (F1)', async () => {
    at(
      '/add',
      {
        mailIn: mailbox({
          enabled: true,
          sender_warning: null,
          server: { ...mailbox().server, sender_check: true },
        }),
      },
      'adult',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Get a code to send' }));
    const code = await screen.findByText('FDV-ABCD-EFGH-JKMN');
    await waitFor(() => expect(code.closest('p')).toHaveFocus());
    expect(screen.getByRole('link', { name: 'Write that email' })).toHaveAttribute(
      'href',
      'mailto:home%40vault.test?subject=FDV-ABCD-EFGH-JKMN',
    );
    await expectAccessible();
  });

  it('with no way to confirm, says why; and tells its person what of theirs waits in the mailbox (F1)', async () => {
    at(
      '/add',
      {
        mailIn: mailbox({ enabled: true }),
        mailInMine: {
          confirm: { send_from: false, emailed: false },
          confirm_words:
            'Nobody can confirm their address yet: an owner needs to set FDV_MAIL_IN_AUTHSERV_ID.',
          held: { unverified: 1, unconfirmed: 2, last_at: '2026-10-12T08:00:00Z' },
        },
      },
      'adult',
    );
    const line = await screen.findByRole('region', { name: 'Email documents in' });
    expect(line).toHaveTextContent('Nobody can confirm their address yet');
    expect(line).toHaveTextContent(
      '2 emails from your address are waiting in the mailbox until your address is confirmed.',
    );
    expect(line).toHaveTextContent(
      '1 email from your address didn’t pass the mailbox’s sender check',
    );
    expect(line).toHaveTextContent('The newest is from 12 Oct.');
    expect(screen.queryByRole('button', { name: /code/ })).toBeNull();
    await expectAccessible();
  });

  it('once confirmed, says where attachments go — and that they are marked while senders are not checked', async () => {
    at(
      '/',
      {
        mailIn: mailbox({ enabled: true }),
        mailInMine: {
          on: true,
          address: 'home@vault.test',
          email: 'you@example.test',
          confirmed: true,
          code_expires_at: null,
          sender_check: false,
        },
      },
      'adult',
    );
    const line = await screen.findByRole('region', { name: 'Email documents in' });
    expect(line).toHaveTextContent(
      'Attachments go into your Inbox to look over, each marked “sender not verified”.',
    );
    expect(screen.queryByRole('button', { name: /Get a/ })).toBeNull();
  });

  it('says nothing while email in is off, nor ever to a viewer', async () => {
    at('/add', { mailIn: mailbox({ enabled: false }) }, 'adult');
    expect(
      await screen.findByRole('button', { name: 'Take a photo or choose a file' }),
    ).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('region', { name: 'Email documents in' })).toBeNull();
    cleanup();
    const state = at('/', { mailIn: mailbox({ enabled: true }) }, 'viewer');
    await screen.findByRole('heading', { level: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('region', { name: 'Email documents in' })).toBeNull();
    expect(state.calls.some((c) => c.url.startsWith('/api/v1/mail-in'))).toBe(false);
  });

  it('an item from an email whose sender was not verified says so, in the queue and on its card', async () => {
    const emailed = {
      id: 'i-mail',
      batch_id: 'b-mail',
      name: 'statement.pdf',
      content_type: 'application/pdf',
      byte_size: 2048,
      sha256: 'a'.repeat(64),
      arrived_at: '2026-10-13T09:05:00Z',
      state: 'waiting' as const,
      reading: 'read' as const,
      read_failure: null,
      preview_state: 'ready' as const,
      preview_pages: 1,
      duplicate: null,
      document_id: null,
      level: 'unrecognised' as const,
      tags: [],
      proposals: null,
      clashes: [],
      sender_unverified: true,
    };
    const batch = {
      id: 'b-mail',
      name: 'Email, 13 Oct',
      created_at: '2026-10-13T09:00:00Z',
      ends_at: '2026-11-12T09:00:00Z',
      defaults: {
        owner_member_id: null,
        type_key: null,
        visibility: 'household' as const,
        physical_location: null,
        collection_id: null,
        tags: [],
        is_essential: false,
      },
      items: [emailed],
    };
    at('/inbox/batches/b-mail', { batches: [batch] }, 'adult');
    expect(await screen.findByText('Sender not verified')).toBeInTheDocument();
    cleanup();
    at('/inbox/batches/b-mail/items/i-mail', { batches: [batch] }, 'adult');
    const why = await screen.findByText(
      /couldn’t check that you sent it\. If you didn’t, remove it\./,
    );
    expect(why.closest('[role="note"]')).toHaveTextContent(/^Sender not verified/);
    await expectAccessible();
  });

  it('an email’s note is in Needs attention, with Dismiss', async () => {
    const state = at(
      '/',
      {
        watchNotices: [
          {
            id: 'n-mail',
            source: 'email',
            file_name: null,
            reason: 'nothing_to_add',
            left_in_place: false,
            title: 'An email had nothing we could add',
            words:
              'No PDF, photo, Word or Excel file was attached to an email you sent. The email was moved to the household mailbox’s Filed folder.',
            at: new Date().toISOString(),
          },
        ],
      },
      'adult',
    );
    expect(await screen.findByText(/An email had nothing we could add/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the note about an email' }));
    expect(await screen.findByText('Dismissed.')).toBeInTheDocument();
    expect(state.watchNotices).toEqual([]);
  });
});
