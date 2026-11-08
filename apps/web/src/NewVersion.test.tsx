import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DetailSuggestions } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeState,
} from './test-api.js';

/**
 * A new version's details, offered (0.9.0; the owner's report of 7 Nov 2026:
 * a renewed licence added from the phone kept its old dates, and nothing
 * offered the new ones). "The new version says:" each field its pages read
 * otherwise, as new (was old); Use these makes the ticked ones its own, as a
 * renewal, with a toast and Undo; Not now puts it away for this person and
 * this version. And an older version looked at: View in History, its pages
 * and its own details under a banner, Back to the current version.
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:page'), revokeObjectURL: vi.fn() });
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

function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      return {
        matches: Boolean(minWidth) && px >= Number(minWidth?.[1]),
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

/** Aisha's licence, renewed: version 2's pages read, its details still version 1's. */
const LICENCE = {
  ...PASSPORT,
  id: 'doc-l',
  title: 'Aisha’s licence',
  owner_member_id: 'm-0',
  is_essential: false,
  issued: { date: '2015-03-01', precision: 'day' },
  expires: { date: '2025-03-01', precision: 'day' },
  identifier: 'KHAN9-123',
  issued_by: 'DVLA',
  versions: 2,
  latest_version_id: 'v-2',
  details_unconfirmed: true,
  etag: '"l-1"',
};

const READ = (
  over: Partial<NonNullable<DetailSuggestions['renewal']>> = {},
): DetailSuggestions => ({
  state: 'ready',
  version_id: 'v-2',
  proposal: {},
  renewal: {
    issued: {
      value: { date: '2025-03-01', precision: 'day' },
      confidence: 0.9,
      cue: 'issue_label',
    },
    expires: {
      value: { date: '2033-03-01', precision: 'day' },
      confidence: 0.9,
      cue: 'expiry_label',
    },
    identifier: { value: 'KHAN9-456', confidence: 0.85, cue: 'number_label' },
    ...over,
  },
});

/** Version 1, as it was when version 2 replaced it. */
const OLDER = {
  id: 'v-1',
  document_id: 'doc-l',
  version_no: 1,
  filename: 'licence-2015.pdf',
  mime: 'application/pdf',
  byte_size: 2048,
  sha256: 'o',
  page_count: 1,
  ocr_status: 'done',
  uploaded_at: '2015-03-02T09:00:00Z',
  uploaded_by_name: 'Mansoor Seikh',
  preview_pages: 1,
  file_removed: false,
  details: {
    issued: { date: '2015-03-01', precision: 'day' },
    expires: { date: '2025-03-01', precision: 'day' },
    identifier: 'KHAN9-123',
    issued_by: 'DVLA',
    extra: {},
    kept_at: '2026-11-06T10:00:00Z',
  },
  details_kept: true,
  details_unconfirmed: false,
};

const withLicence = (over: Partial<FakeState> = {}, doc: Record<string, unknown> = {}) =>
  fresh({
    members: [ME, AISHA],
    documents: [{ ...LICENCE, ...doc }],
    detailSuggestions: { 'doc-l': READ() },
    olderVersions: { 'doc-l': [{ ...OLDER }] },
    ...over,
  });

async function openPage(
  state: FakeState,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
  path = '/documents/doc-l',
) {
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  await screen.findByRole('heading', { level: 1 });
}
const card = () => screen.findByRole('region', { name: 'The new version says:' });
/** The page has heard what the pages say, and drawn what it would of it. */
async function settled(state: FakeState) {
  await screen.findAllByText('Download');
  await waitFor(() =>
    expect(state.calls.some((c) => c.url.endsWith('/documents/doc-l/suggestions'))).toBe(true),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}
const renewals = (state: FakeState) => state.renewalCalls ?? [];

describe('the new version says (0.9.0)', () => {
  it('shows each field its pages read otherwise, as new (was old), ticked, for whoever may change it', async () => {
    const state = withLicence();
    await openPage(state);
    const region = await card();
    const boxes = within(region).getAllByRole('checkbox');
    expect(boxes.map((b) => b.closest('label')?.textContent)).toEqual([
      'Issued 1 Mar 2025 (was 1 Mar 2015)',
      'Expires 1 Mar 2033 (was 1 Mar 2025)',
      'Number KHAN9-456 (was KHAN9-123)',
    ]);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(renewals(state)).toEqual([]);
    await expectAccessible();
  });

  it('is not shown for a first version, once its details are confirmed, or when the pages say the same', async () => {
    const confirmed = withLicence({}, { details_unconfirmed: false });
    await openPage(confirmed);
    await settled(confirmed);
    expect(screen.queryByRole('region', { name: 'The new version says:' })).not.toBeInTheDocument();
    cleanup();
    const same = withLicence({
      detailSuggestions: {
        'doc-l': READ({
          issued: {
            value: { date: '2015-03-01', precision: 'day' },
            confidence: 0.9,
            cue: 'issue_label',
          },
          expires: {
            value: { date: '2025-03-01', precision: 'day' },
            confidence: 0.9,
            cue: 'expiry_label',
          },
          identifier: { value: 'KHAN9 123', confidence: 0.85, cue: 'number_label' },
        }),
      },
    });
    await openPage(same);
    await settled(same);
    expect(screen.queryByRole('region', { name: 'The new version says:' })).not.toBeInTheDocument();
  });

  it('Use these sends them all, on the document as it was loaded; the toast says so, and Undo puts them back', async () => {
    const state = withLicence();
    await openPage(state);
    fireEvent.click(within(await card()).getByRole('button', { name: 'Use these' }));
    await waitFor(() => expect(renewals(state)).toHaveLength(1));
    expect(renewals(state)[0]).toEqual({
      path: '/api/v1/documents/doc-l/renewal',
      etag: '"l-1"',
      body: {
        version_id: 'v-2',
        issued: { date: '2025-03-01', precision: 'day' },
        expires: { date: '2033-03-01', precision: 'day' },
        identifier: 'KHAN9-456',
      },
    });
    const toast = await screen.findByRole('region', { name: 'What was just done' });
    expect(toast).toHaveTextContent(
      'The new version’s details are saved. You can undo this for 5 minutes.',
    );
    await waitFor(() => expect(document.activeElement).toBe(toast));
    // Its details are the new version's now: the card has nothing to ask.
    expect(screen.queryByRole('region', { name: 'The new version says:' })).not.toBeInTheDocument();
    const facts = screen
      .getByRole('region', { name: 'Details of Aisha’s licence' })
      .querySelector('dl.facts') as HTMLElement;
    expect(within(facts).getByText('1 Mar 2033')).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(renewals(state)).toHaveLength(2));
    expect(renewals(state)[1]).toMatchObject({
      path: '/api/v1/documents/doc-l/renewal/undo',
      body: { version_id: 'v-2' },
    });
    await waitFor(() => expect(toast).toHaveTextContent('Undone: the details are as they were.'));
    const now = screen
      .getByRole('region', { name: 'Details of Aisha’s licence' })
      .querySelector('dl.facts') as HTMLElement;
    expect(within(now).getByText('1 Mar 2015')).toBeInTheDocument();
    expect(within(now).queryByText('1 Mar 2033')).not.toBeInTheDocument();
  });

  it('a field unticked is left as it was', async () => {
    const state = withLicence();
    await openPage(state);
    const region = await card();
    fireEvent.click(within(region).getByRole('checkbox', { name: /^Number/ }));
    fireEvent.click(within(region).getByRole('button', { name: 'Use these' }));
    await waitFor(() => expect(renewals(state)).toHaveLength(1));
    expect(renewals(state)[0]?.body).toEqual({
      version_id: 'v-2',
      issued: { date: '2025-03-01', precision: 'day' },
      expires: { date: '2033-03-01', precision: 'day' },
    });
    // Nothing ticked: nothing to use.
    cleanup();
    await openPage(withLicence());
    const again = await card();
    for (const box of within(again).getAllByRole('checkbox')) fireEvent.click(box);
    expect(within(again).getByRole('button', { name: 'Use these' })).toBeDisabled();
  });

  it('a weak reading is shown, marked "check this", and left unticked', async () => {
    const state = withLicence({
      detailSuggestions: {
        'doc-l': READ({
          issued: {
            value: { date: '2015-03-01', precision: 'day' },
            confidence: 0.9,
            cue: 'issue_label',
          },
          expires: {
            value: { date: '2033-03-01', precision: 'day' },
            confidence: 0.72,
            cue: 'expiry_label',
          },
          identifier: {
            value: 'KHAN9-456',
            confidence: 0.9,
            cue: 'number_label',
            corrected: true,
          },
        }),
      },
    });
    await openPage(state);
    const region = await card();
    const expires = within(region).getByRole('checkbox', { name: /^Expires/ });
    const number = within(region).getByRole('checkbox', { name: /^Number/ });
    expect(expires).not.toBeChecked();
    expect(number).not.toBeChecked();
    expect(within(region).getAllByText('check this')).toHaveLength(2);
    expect(within(region).getByRole('button', { name: 'Use these' })).toBeDisabled();
    fireEvent.click(expires);
    fireEvent.click(within(region).getByRole('button', { name: 'Use these' }));
    await waitFor(() => expect(renewals(state)).toHaveLength(1));
    expect(renewals(state)[0]?.body).toEqual({
      version_id: 'v-2',
      expires: { date: '2033-03-01', precision: 'day' },
    });
  });

  it('Not now puts it away for this person and this version, and the vault is not asked again', async () => {
    const state = withLicence();
    await openPage(state);
    fireEvent.click(within(await card()).getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'The new version says:' }),
      ).not.toBeInTheDocument(),
    );
    expect(Object.keys(localStorage)).toContain('fdv.new-version-not-now.hh.me.v-2');
    expect(renewals(state)).toEqual([]);
    cleanup();
    installFakeApi(state);
    window.history.replaceState({}, '', '/documents/doc-l');
    render(<App />);
    await screen.findAllByText('Download');
    expect(screen.queryByRole('region', { name: 'The new version says:' })).not.toBeInTheDocument();
  });

  it('changed elsewhere since the page was loaded: nothing is saved, and the page is loaded again', async () => {
    const state = withLicence();
    await openPage(state);
    const region = await card();
    const loads = () => state.calls.filter((c) => c.url.endsWith('/documents/doc-l')).length;
    const before = loads();
    Object.assign(state.documents[0] as Record<string, unknown>, { etag: '"elsewhere"' });
    fireEvent.click(within(region).getByRole('button', { name: 'Use these' }));
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('nothing was saved and it has been loaded again');
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    expect((state.documents[0] as { expires: unknown }).expires).toEqual({
      date: '2025-03-01',
      precision: 'day',
    });
    // Another version newest by then: the same.
    cleanup();
    const newer = withLicence({
      renewalRefusal: {
        status: 409,
        code: 'version_changed',
        message: 'This document has another newest version now.',
      },
    });
    await openPage(newer);
    fireEvent.click(within(await card()).getByRole('button', { name: 'Use these' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was saved');
  });

  it('a viewer, and a teen for somebody else’s document, see nothing of it', async () => {
    for (const role of ['viewer', 'teen'] as const) {
      const state = withLicence();
      await openPage(state, role);
      await screen.findAllByText('Download');
      expect(
        screen.queryByRole('region', { name: 'The new version says:' }),
      ).not.toBeInTheDocument();
      expect(state.calls.some((c) => c.url.endsWith('/suggestions'))).toBe(false);
      cleanup();
    }
  });

  it('a field still empty keeps its chip, under the card', async () => {
    const state = withLicence(
      {
        detailSuggestions: {
          'doc-l': {
            ...READ(),
            proposal: {
              issued_by: { value: 'DVLA Swansea', confidence: 0.85, cue: 'letterhead' },
            },
          },
        },
      },
      { issued_by: null },
    );
    await openPage(state);
    await card();
    const chips = await screen.findByRole('region', { name: 'We read the pages — is this right?' });
    // A chip taken fills its one field, and confirms nothing: the card still asks.
    fireEvent.click(within(chips).getByRole('button', { name: /: From DVLA Swansea\?/ }));
    await waitFor(() =>
      expect(state.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { issued_by: 'DVLA Swansea' },
      ]),
    );
    await waitFor(() =>
      expect(
        within(chips).queryByRole('button', { name: /: From DVLA Swansea\?/ }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('region', { name: 'The new version says:' })).toBeInTheDocument();
  });

  it('the Edit card, saved, confirms the details: the card has nothing more to ask', async () => {
    const state = withLicence();
    await openPage(state, 'owner', '/documents/doc-l/confirm');
    fireEvent.click(await screen.findByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(state.calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ confirm_details: true });
    expect((state.documents[0] as { details_unconfirmed: unknown }).details_unconfirmed).toBe(
      false,
    );
  });
});

describe('an older version, looked at (0.9.0)', () => {
  const openHistory = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /^History/ }));
    return screen.findByRole('heading', { name: 'History' });
  };

  it('View in History shows its pages and its own details under a banner; the address keeps it; Back returns', async () => {
    atWidth(1280);
    const state = withLicence({}, { details_unconfirmed: false });
    await openPage(state);
    await openHistory();
    fireEvent.click(screen.getByRole('button', { name: 'View version 1' }));
    const banner = await screen.findByRole('heading', {
      name: /^Version 1 of 2: replaced on 20 Sept? 2026 — not the current version$/,
    });
    expect(window.location.search).toBe('?version=v-1');
    await waitFor(() => expect(document.activeElement).toBe(banner));
    const details = screen.getByRole('region', { name: 'This version’s details' });
    expect(within(details).getByText('1 Mar 2025')).toBeInTheDocument();
    expect(within(details).getByText('KHAN9-123')).toBeInTheDocument();
    // Its pages, in the pages pane.
    const pages = screen.getByRole('region', { name: 'Pages of Aisha’s licence, version 1' });
    await within(pages).findByRole('img', { name: /^Page 1 of/ });
    expect(state.calls.some((c) => c.url.endsWith('/versions/v-1/pages/1'))).toBe(true);
    // Nothing that changes the document: no Edit, no Trash, no sharing; its Download stays.
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move to the Trash' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Share a link/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    await expectAccessible();

    // A reload keeps it.
    cleanup();
    installFakeApi(state);
    window.history.replaceState({}, '', '/documents/doc-l?version=v-1');
    render(<App />);
    expect(await screen.findByRole('heading', { name: /^Version 1 of 2/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the current version' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.queryByRole('heading', { name: /^Version 1 of 2/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
  });

  it('a version whose pages were never drawn says so and offers Download; one whose details were never kept says so', async () => {
    atWidth(1280);
    const state = withLicence(
      {
        olderVersions: {
          'doc-l': [{ ...OLDER, preview_pages: 0, details: null, details_kept: false }],
        },
      },
      { details_unconfirmed: false },
    );
    await openPage(state, 'owner', '/documents/doc-l?version=v-1');
    await screen.findByRole('heading', { name: /^Version 1 of 2/ });
    expect(
      await screen.findByText('Its pages could not be drawn. Download it to open it.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Details weren’t kept for versions replaced before 0\.9\.0\./),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(state.calls.some((c) => c.url.endsWith('/versions/v-1/content'))).toBe(true),
    );
  });

  it('an Essential’s older pages ask who is asking first', async () => {
    atWidth(1280);
    const state = withLicence(
      { stepUpNeeded: true },
      { is_essential: true, details_unconfirmed: false },
    );
    await openPage(state, 'owner', '/documents/doc-l?version=v-1');
    await screen.findByRole('heading', { name: /^Version 1 of 2/ });
    expect(await screen.findByText('Confirm it’s you to see its pages.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm it’s you' })).toBeInTheDocument();
    // Its own pages were asked for — the older version's — and not shown unasked.
    expect(state.calls.some((c) => c.url.endsWith('/versions/v-1/pages/1'))).toBe(true);
    expect(screen.queryByRole('img', { name: /^Page 1 of/ })).not.toBeInTheDocument();
  });

  it('a viewer looks at it too, with nothing to change', async () => {
    atWidth(1280);
    const state = withLicence({}, { details_unconfirmed: false });
    await openPage(state, 'viewer', '/documents/doc-l?version=v-1');
    await screen.findByRole('heading', { name: /^Version 1 of 2/ });
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'The new version says:' })).not.toBeInTheDocument();
  });

  it('on a phone: one column, the banner, its pages in the viewer, then its details', async () => {
    atWidth(390);
    const state = withLicence({}, { details_unconfirmed: false });
    await openPage(state, 'owner', '/documents/doc-l?version=v-1');
    const banner = await screen.findByRole('heading', { name: /^Version 1 of 2/ });
    const pages = screen.getByRole('region', { name: 'Pages of Aisha’s licence, version 1' });
    const details = screen.getByRole('region', { name: 'This version’s details' });
    expect(banner.closest('main')).not.toHaveClass('doc-panes');
    expect(banner.compareDocumentPosition(pages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pages.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await within(pages).findByRole('img', { name: /^Page 1 of/ });
    await expectAccessible();
  });
});
