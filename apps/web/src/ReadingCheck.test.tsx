import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * The Reading check (0.9.0, R0), on the web: an owner's, the second part of
 * Settings → Server and reading → Reading and the check. It starts a check of the last N documents filed through
 * review, shows how far the worker has got and lets it be cancelled; a
 * finished check shows its numbers both ways, by kind, against the check
 * before it, and — to the owner who ran it alone — the documents that
 * needed typing.
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

const counts = (needs: number, wrong = 0, documents = 50) => ({
  documents,
  ready: documents - needs,
  check: needs,
  unrecognised: 0,
  problem: 0,
  not_read: 0,
  needs_typing: needs,
  wrong_ready: wrong,
  ready_detail_wrong: 0,
  expiry_not_on_paper: 0,
  kind_typed: needs,
  person_typed: 0,
  expiry_typed: 0,
});
const result = (needs: number, wrong = 0) => ({
  all: counts(needs, wrong),
  text: counts(needs, wrong, 30),
  scan: counts(0, 0, 20),
  by_kind: {
    passport: { documents: 4, kind_right: 4, no_typing: 3 },
    '(only_me)': { documents: 2, kind_right: 1, no_typing: 1 },
  },
});
const check = (over: Record<string, unknown> & { id: string }) => ({
  state: 'done',
  failure: null,
  n: 50,
  include_edited: true,
  requested_by: { member_id: 'me', name: 'Mansoor' },
  mine: true,
  created_at: '2026-10-17T10:00:00.000Z',
  started_at: '2026-10-17T10:00:00.000Z',
  finished_at: '2026-10-17T10:30:00.000Z',
  progress: { total: 50, done: 50 },
  reader: { server_version: '0.9.0-dev.3', rules: 'abcdef012345' },
  summary: {
    chosen: 50,
    read: 50,
    skipped: 1,
    edited: 2,
    without_rules: result(11),
    with_rules: result(6),
  },
  ...over,
});
const earlier = check({
  id: 'check-old',
  created_at: '2026-10-10T10:00:00.000Z',
  finished_at: '2026-10-10T10:30:00.000Z',
  reader: { server_version: '0.9.0-dev.2', rules: '012345abcdef' },
  summary: {
    chosen: 50,
    read: 50,
    skipped: 0,
    edited: 0,
    without_rules: result(18, 1),
    with_rules: result(9),
  },
});
const posts = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/reading-checks');

describe('the Reading check’s page (R0)', () => {
  it('is in Server and reading, says how many can be read, and starts a check of the last N', async () => {
    const state = at('/settings', { readingChecks: [], readingFiled: 37 });
    fireEvent.click(await screen.findByRole('link', { name: /^Reading and the check/ }));
    expect(
      await screen.findByRole('heading', { name: 'Reading and the check', level: 1 }),
    ).toBeInTheDocument();
    // Its second part, after the reading model.
    expect(screen.getByRole('heading', { name: 'Reading check', level: 2 })).toBeInTheDocument();
    expect(
      await screen.findByText('You can see 37 documents filed through review.'),
    ).toBeInTheDocument();
    const n = screen.getByLabelText('Read again the last');
    expect(n).toHaveValue(50);
    await expectAccessible();
    // Out of bounds: not started.
    fireEvent.change(n, { target: { value: '5' } });
    expect(screen.getByRole('button', { name: 'Start the check' })).toBeDisabled();
    fireEvent.change(n, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /changed by hand/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start the check' }));
    await waitFor(() => expect(posts(state)).toHaveLength(1));
    expect(posts(state)[0]?.body).toEqual({ n: 120, include_edited: false });
    // Waiting for the worker: said, with how far it has got, and Cancel.
    const now = await screen.findByRole('region', { name: 'Reading now' });
    expect(within(now).getByText(/Waiting for the vault to start reading/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Documents read' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start the check' })).toBeNull();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the check' }));
    expect(await screen.findByText('Cancelled. Nothing it read was kept.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start the check' })).toBeEnabled(),
    );
    expect(state.readingChecks?.[0]?.state).toBe('cancelled');
  });

  it('nothing filed through review: says where it comes from, and starts nothing', async () => {
    at('/settings/reading-check', { readingChecks: [], readingFiled: 0 });
    expect(
      await screen.findByText(/No documents have been filed through review yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Many documents' })).toHaveAttribute(
      'href',
      '/add/many',
    );
    expect(screen.getByRole('button', { name: 'Start the check' })).toBeDisabled();
    await expectAccessible();
  });

  it('one status region, said only as the check’s state changes: never as each poll moves the count on', async () => {
    const state = at('/settings/reading-check', {
      readingChecks: [
        check({
          id: 'check-2',
          state: 'running',
          finished_at: null,
          progress: { total: 50, done: 12 },
          summary: null,
        }),
      ],
      readingFiled: 50,
    });
    const now = await screen.findByRole('region', { name: 'Reading now' });
    expect(within(now).getByText('Reading 12 of 50…')).toBeInTheDocument();
    // Its count is no live region: only the one status line is.
    expect(within(now).queryAllByRole('status')).toEqual([]);
    // One in the check's part (the reading model's part has its own, above).
    const part = screen.getByRole('region', { name: 'Reading check' });
    expect(within(part).getAllByRole('status')).toHaveLength(1);
    const said = () => within(part).getByRole('status').textContent ?? '';
    // The next poll: further on, and nothing said.
    const row = state.readingChecks?.[0] as Record<string, unknown>;
    row.progress = { total: 50, done: 30 };
    await waitFor(() => expect(within(now).getByText('Reading 30 of 50…')).toBeInTheDocument(), {
      timeout: 6000,
    });
    expect(said()).toBe('');
    // Finished: said, once.
    Object.assign(row, check({ id: 'check-2' }));
    await waitFor(() => expect(said()).toBe('The check has finished: 11 of 50 needed typing.'), {
      timeout: 6000,
    });
  }, 20_000);

  it('her running check shows its progress, and she may cancel it', async () => {
    at('/settings/reading-check', {
      readingChecks: [
        check({
          id: 'check-2',
          state: 'running',
          finished_at: null,
          progress: { total: 50, done: 12 },
          summary: null,
        }),
      ],
      readingFiled: 50,
    });
    const now = await screen.findByRole('region', { name: 'Reading now' });
    expect(within(now).getByText('Reading 12 of 50…')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Documents read' });
    expect(bar).toHaveAttribute('value', '12');
    expect(bar).toHaveAttribute('max', '50');
    expect(screen.getByRole('button', { name: 'Cancel the check' })).toBeEnabled();
    await expectAccessible();
  });

  it('another owner’s check running: said, with whose, and none can start; never cancelled from here', async () => {
    const state = at('/settings/reading-check', {
      readingChecks: [
        check({
          id: 'check-o',
          state: 'running',
          finished_at: null,
          progress: { total: 50, done: 12 },
          summary: null,
          mine: false,
          requested_by: { member_id: 'm-o', name: 'Olivia' },
        }),
      ],
      readingFiled: 50,
    });
    const now = await screen.findByRole('region', { name: 'Reading now' });
    expect(
      within(now).getByText(
        'Olivia’s check is running. One check runs at a time: you can start yours once it has finished.',
      ),
    ).toBeInTheDocument();
    // Nothing of how far it has got, and no way to stop it.
    expect(within(now).queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/12 of 50/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel the check' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start the check' })).toBeNull();
    expect(screen.getByText('Running · only they see what it found')).toBeInTheDocument();
    expect(state.calls.some((c) => c.url === '/api/v1/reading-checks/check-o')).toBe(false);
    await expectAccessible();
  });

  it('says when a check ran on the family’s clock, its zone named when this browser’s differs (the TZ review)', async () => {
    const was = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      at('/settings/reading-check', {
        readingChecks: [check({ id: 'check-new' })],
        readingFiled: 50,
        timezone: 'Europe/London',
      });
      // 10:30 UTC on 17 October: 11:30 in London, never 03:30 in Los Angeles.
      expect(
        await screen.findByRole('heading', { name: /^Checked 17 Oct, 11:30 BST/ }),
      ).toBeInTheDocument();
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  });

  it('a finished check: its numbers both ways, by kind, against the one before, and its misses for its owner', async () => {
    at('/settings/reading-check', {
      readingChecks: [check({ id: 'check-new' }), earlier],
      readingFiled: 50,
      readingMisses: {
        'check-new': [
          {
            document_id: 'd-passport',
            title: 'Sara passport',
            type_key: 'passport',
            fields: ['kind', 'person'],
            level: 'check',
            wrong_ready: false,
          },
        ],
      },
    });
    expect(await screen.findByRole('heading', { name: /^Checked / })).toBeInTheDocument();
    expect(
      screen.getByText('Since 0.9.0-dev.2: needs typing 18 → 11; wrong Ready 1 → 0.'),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'How the vault read them' });
    const needs = within(table).getByRole('row', { name: /Needed typing/ });
    expect(
      within(needs)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['11', '6']);
    expect(within(table).getByRole('columnheader', { name: 'With your learning' })).toBeTruthy();
    expect(
      screen.getByText(
        /the rules the vault learned from your corrections, on the documents you filed/,
      ),
    ).toBeInTheDocument();
    const byKind = screen.getByRole('table', { name: 'By kind, without learned rules' });
    expect(within(byKind).getByRole('rowheader', { name: 'Your Only me documents' })).toBeTruthy();
    expect(screen.getByText(/1 left out/)).toBeInTheDocument();
    // Hers alone: which documents needed typing, each a link.
    const miss = await screen.findByRole('link', { name: /Sara passport/ });
    expect(miss).toHaveAttribute('href', '/documents/d-passport');
    expect(miss).toHaveTextContent('Needed the kind and whose it is');
    expect(screen.getByText(/Only you see this list/)).toBeInTheDocument();
    await expectAccessible();
    // The earlier one, shown: compared with nothing older.
    fireEvent.click(screen.getByRole('button', { name: /Show the check of/ }));
    await waitFor(() =>
      expect(screen.queryByText(/^Since 0\.9\.0-dev\.2/)).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('table', { name: 'How the vault read them' })).getByRole('row', {
        name: /Needed typing/,
      }),
    ).toHaveTextContent('18');
  });

  it('another owner’s finished check: that it is there, and whose; never its numbers or misses', async () => {
    const state = at('/settings/reading-check', {
      readingChecks: [
        check({ id: 'check-o', mine: false, requested_by: { member_id: 'm-o', name: 'Olivia' } }),
      ],
      readingFiled: 50,
      readingMisses: { 'check-o': [{ document_id: 'd-x', title: 'Olivia private letter' }] },
    });
    expect(await screen.findByText('Finished · only they see what it found')).toBeInTheDocument();
    // Hers to start: none of Olivia's is running.
    expect(screen.getByRole('button', { name: 'Start the check' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: /^Checked / })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Olivia private letter')).toBeNull();
    // Not even asked for.
    expect(state.calls.some((c) => c.url === '/api/v1/reading-checks/check-o')).toBe(false);
    await expectAccessible();
  });

  it('removes a check, after asking', async () => {
    const state = at('/settings/reading-check', {
      readingChecks: [check({ id: 'check-new' })],
      readingFiled: 50,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove this check' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove this check?' });
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Removed.')).toBeInTheDocument();
    expect(state.readingChecks).toEqual([]);
  });

  it('is an owner’s: not offered to an adult, and refused if they go there', async () => {
    at('/settings', { readingChecks: [], readingFiled: 3 }, 'adult');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(screen.queryByRole('link', { name: /^Reading and the check/ })).toBeNull();
    cleanup();
    const state = at('/settings/reading-check', { readingChecks: [], readingFiled: 3 }, 'adult');
    expect(await screen.findByText('This isn’t something you can open.')).toBeInTheDocument();
    expect(
      screen.getByText('Only an owner can change how the vault reads papers.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start the check' })).toBeNull();
    expect(state.calls.some((c) => c.url.startsWith('/api/v1/reading-checks'))).toBe(false);
  });
});
