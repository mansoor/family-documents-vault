import {
  DOWNLOAD_KEEPS_DETAILS,
  kindStillSharedWords,
  SENSITIVE_FOLLOW_CONFIRM,
  SENSITIVE_ONLY_ME_NOTE,
  SENSITIVE_SHARE_CONFIRM,
  sensitiveCollectionShareConfirm,
  sensitiveStillSharedWords,
  SHOW_TITLE_COLLECTION_HINT,
  SHOW_TITLE_LABEL,
  stopSharingWords,
} from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  TYPES,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * What Sensitive protects, on the web (0.9.0, H1a): a sensitive document's
 * link asks first, in a plain dialog, and its page shows the title only if
 * the sharer chooses; a collection's link with one ticked asks the same; a
 * document its collection's link would send out asks before it goes in; a
 * teen's or a grown-up child's own sensitive paper starts as Only me on the
 * card, which says why; a search hit with no snippet shows none.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
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

/** Kinds as the vault gives them since AIR2: a passport sensitive, a lease not. */
const KINDS = [
  { ...TYPES[0], builtin: true, hidden: false, belongs_to: 'person', sensitive_default: true },
  {
    key: 'property_deed',
    label: 'Property deed / lease',
    category: 'property',
    fields: [],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: false,
    default_visibility: 'household',
    issued_by_label: null,
    builtin: true,
    hidden: false,
    belongs_to: 'household',
    sensitive_default: false,
  },
];

/** A passport, sensitive as its kind says. */
const SENSITIVE = { ...PASSPORT, sensitive: null, sensitive_effective: true };
/** A lease, not sensitive. */
const LEASE = {
  ...PASSPORT,
  id: 'doc-lease',
  type_key: 'property_deed',
  title: 'Flat lease',
  is_essential: false,
  latest_version_id: 'v-lease',
  sensitive: null,
  sensitive_effective: false,
  etag: '"lease"',
};

function start(
  path: string,
  over: Partial<FakeState> = {},
  role: 'owner' | 'adult' | 'teen' = 'owner',
): FakeState {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const state = fresh({
    types: clone(KINDS),
    members: [ME],
    documents: [{ ...SENSITIVE }, { ...LEASE }],
    sensitive: true,
    sensitiveProtects: true,
    timezone: 'Europe/London',
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('a sensitive document’s link asks first (0.9.0, H1a)', () => {
  it('asks in a plain dialog before anything is sent; Cancel makes nothing; Share it anyway makes it, its title not shown', async () => {
    const state = start(`/documents/${SENSITIVE.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    // Its title on the link's page: off, and said why.
    const show = await screen.findByRole('checkbox', { name: SHOW_TITLE_LABEL });
    expect(show).not.toBeChecked();
    expect(show).toHaveAccessibleDescription(
      'It’s sensitive, so the page says “A document” unless you show its title.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Share a sensitive document?' });
    expect(within(dialog).getByText(SENSITIVE_SHARE_CONFIRM)).toBeInTheDocument();
    await expectAccessible();
    // Asked before anything was sent.
    expect(state.shareBodies ?? []).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.shares).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Share it anyway',
      }),
    );
    await screen.findByRole('button', { name: 'Copy the link' });
    expect(state.shares).toHaveLength(1);
    // Asked: said so. Its title left to the vault: no show_title sent.
    expect(state.shareBodies).toHaveLength(1);
    expect(state.shareBodies?.[0]).toMatchObject({ confirm_sensitive: true });
    expect('show_title' in (state.shareBodies?.[0] ?? {})).toBe(false);
  });

  it('its title shown, when chosen: show_title sent', async () => {
    const state = start(`/documents/${SENSITIVE.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: SHOW_TITLE_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Share it anyway',
      }),
    );
    await screen.findByRole('button', { name: 'Copy the link' });
    expect(state.shareBodies?.[0]).toMatchObject({ confirm_sensitive: true, show_title: true });
  });

  it('a document that is not sensitive: nothing asked, its title shown unless unticked', async () => {
    const state = start(`/documents/${LEASE.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    const show = await screen.findByRole('checkbox', { name: SHOW_TITLE_LABEL });
    expect(show).toBeChecked();
    fireEvent.click(show);
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByRole('button', { name: 'Copy the link' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(state.shareBodies).toEqual([expect.objectContaining({ show_title: false })]);
    expect('confirm_sensitive' in (state.shareBodies?.[0] ?? {})).toBe(false);
  });

  it('the vault says so of one the page did not know was sensitive: the same question, then sent', async () => {
    // Known as not sensitive on the page; the vault knows better.
    const state = start(`/documents/${LEASE.id}`, {
      documents: [{ ...LEASE, sensitive_effective: false }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    await screen.findByRole('checkbox', { name: SHOW_TITLE_LABEL });
    const doc = state.documents[0] as Record<string, unknown>;
    doc.sensitive_effective = true;
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(SENSITIVE_SHARE_CONFIRM)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share it anyway' }));
    await screen.findByRole('button', { name: 'Copy the link' });
    expect(state.shareBodies?.map((b) => b.confirm_sensitive === true)).toEqual([false, true]);
  });

  it('a vault without it: no choice of title, nothing asked', async () => {
    const state = start(`/documents/${SENSITIVE.id}`, { sensitiveProtects: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    await screen.findByRole('button', { name: 'Make the link' });
    expect(screen.queryByRole('checkbox', { name: SHOW_TITLE_LABEL })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByRole('button', { name: 'Copy the link' });
    expect(state.shares).toHaveLength(1);
  });
});

/** The signed-in member's collection for everyone: the passport and the lease. */
const BROKER: FakeCollection = {
  id: 'collection-b',
  name: 'For the broker',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"broker.1"',
  items: [SENSITIVE.id, LEASE.id],
};

describe('a collection’s link with a sensitive one ticked asks first (0.9.0, H1a)', () => {
  it('says which is sensitive, asks before anything is sent, and offers to show their titles', async () => {
    const state = start(`/collections/${BROKER.id}`, { collections: [{ ...BROKER }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Share this collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share “For the broker”' });
    const passport = await within(sheet).findByRole('checkbox', { name: /Mansoor's passport/ });
    expect(passport).toBeChecked();
    expect(passport).toHaveAccessibleName(expect.stringContaining('Sensitive'));
    expect(within(sheet).getByRole('checkbox', { name: /Flat lease/ })).not.toHaveAccessibleName(
      expect.stringContaining('Sensitive'),
    );
    const show = within(sheet).getByRole('checkbox', { name: SHOW_TITLE_LABEL });
    expect(show).not.toBeChecked();
    fireEvent.change(within(sheet).getByLabelText('Who is it for?'), {
      target: { value: 'the broker' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make the link' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Share sensitive documents?' });
    expect(within(dialog).getByText(sensitiveCollectionShareConfirm(1))).toBeInTheDocument();
    expect(state.shareBodies ?? []).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share anyway' }));
    await within(sheet).findByRole('button', { name: 'Copy the link' });
    expect(state.shareBodies?.[0]).toMatchObject({ confirm_sensitive: true });
    expect('show_title' in (state.shareBodies?.[0] ?? {})).toBe(false);
  });

  it('nothing sensitive ticked: nothing asked, and no choice of title', async () => {
    const state = start(`/collections/${BROKER.id}`, { collections: [{ ...BROKER }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Share this collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share “For the broker”' });
    fireEvent.click(await within(sheet).findByRole('checkbox', { name: /Mansoor's passport/ }));
    expect(within(sheet).queryByRole('checkbox', { name: SHOW_TITLE_LABEL })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make the link' }));
    await within(sheet).findByRole('button', { name: 'Copy the link' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect('confirm_sensitive' in (state.shareBodies?.[0] ?? {})).toBe(false);
  });
});

describe('put in a collection whose link keeps up with it (0.9.0, H1a)', () => {
  it('asks first; Cancel puts nothing in; Put it in anyway sends confirm_sensitive', async () => {
    const state = start(`/documents/${SENSITIVE.id}`, {
      collections: [{ ...BROKER, items: [LEASE.id] }],
      followingSensitive: [SENSITIVE.id],
    });
    // The document's own Collections, from its action row.
    fireEvent.click(await screen.findByRole('button', { name: /^Collections/ }));
    const collections = await screen.findByRole('region', { name: 'Collections' });
    fireEvent.click(within(collections).getByRole('button', { name: 'Add to a collection' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to “For the broker”' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Put a sensitive document in?' });
    expect(within(dialog).getByText(SENSITIVE_FOLLOW_CONFIRM)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.collections?.[0]?.items).toEqual([LEASE.id]);

    fireEvent.click(screen.getByRole('button', { name: 'Add to “For the broker”' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Put it in anyway',
      }),
    );
    await screen.findByText(/is in “For the broker” now/);
    expect(state.collections?.[0]?.items).toEqual([LEASE.id, SENSITIVE.id]);
    expect(state.collectionAdds?.map((b) => b.confirm_sensitive === true)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

/** Twenty years old today, on any day the test runs. */
const twentyYearsAgo = () => {
  const d = new Date();
  return `${d.getUTCFullYear() - 20}-01-01`;
};

/** Add, with a file chosen, and the card's kind set. */
async function addWith(kind: string) {
  const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
  await waitFor(() => expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled());
  fireEvent.change(input, {
    target: { files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' })] },
  });
  await screen.findByRole('heading', { name: 'Is this right?' });
  fireEvent.change(screen.getByLabelText('What it is'), { target: { value: kind } });
  // A passport asks when it expires.
  const expires = screen.queryByLabelText(/^Expires/);
  if (expires) fireEvent.change(expires, { target: { value: 'March 2031' } });
}

const pressed = () =>
  within(screen.getByRole('group', { name: 'Who can see it' }))
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent);

describe('a teen’s or a grown-up child’s own sensitive paper starts as Only me (0.9.0, H1a)', () => {
  it('a grown-up son: Only me, with a plain note why; not sensitive, and the note goes', async () => {
    const state = start(
      '/add',
      {
        members: [{ ...ME, role: 'adult', relationship: 'Son', date_of_birth: twentyYearsAgo() }],
      },
      'adult',
    );
    await addWith('passport');
    await waitFor(() => expect(pressed()).toEqual(['Only me']));
    expect(screen.getByText(SENSITIVE_ONLY_ME_NOTE)).toBeInTheDocument();
    await expectAccessible();
    // Said not sensitive on the card: as its kind says, and no note.
    fireEvent.change(screen.getByLabelText('Sensitive'), { target: { value: 'no' } });
    await waitFor(() => expect(pressed()).toEqual(['Everyone']));
    expect(screen.queryByText(SENSITIVE_ONLY_ME_NOTE)).toBeNull();
    // Back to sensitive, then changed by hand: theirs to choose, and saved so.
    fireEvent.change(screen.getByLabelText('Sensitive'), { target: { value: 'yes' } });
    await waitFor(() => expect(pressed()).toEqual(['Only me']));
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(screen.queryByText(SENSITIVE_ONLY_ME_NOTE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures?.[0]?.metadata).toMatchObject({ visibility: 'household' });
  });

  it('a lease is not sensitive: as its kind says, and no note', async () => {
    start(
      '/add',
      {
        members: [
          { ...ME, role: 'adult', relationship: 'daughter', date_of_birth: twentyYearsAgo() },
        ],
      },
      'adult',
    );
    await addWith('property_deed');
    await screen.findByLabelText('Sensitive');
    expect(pressed()).not.toEqual(['Only me']);
    expect(screen.queryByText(SENSITIVE_ONLY_ME_NOTE)).toBeNull();
  });

  it('a teen: Only me, said why, and saved so', async () => {
    const state = start('/add', { members: [{ ...ME, role: 'teen' }] }, 'teen');
    await addWith('passport');
    await waitFor(() => expect(pressed()).toEqual(['Only me']));
    expect(screen.getByText(SENSITIVE_ONLY_ME_NOTE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures?.[0]?.metadata).toMatchObject({ visibility: 'private' });
  });

  it('a parent: as before, and no note', async () => {
    start('/add', { members: [{ ...ME, relationship: 'Dad', date_of_birth: '1980-05-05' }] });
    await addWith('passport');
    await screen.findByLabelText('Sensitive');
    expect(pressed()).toEqual(['Everyone']);
    expect(screen.queryByText(SENSITIVE_ONLY_ME_NOTE)).toBeNull();
  });

  it('a vault without it: as before, for a grown-up son too', async () => {
    start(
      '/add',
      {
        members: [{ ...ME, role: 'adult', relationship: 'son', date_of_birth: twentyYearsAgo() }],
        sensitiveProtects: false,
      },
      'adult',
    );
    await addWith('passport');
    await screen.findByLabelText('Sensitive');
    expect(pressed()).toEqual(['Everyone']);
    expect(screen.queryByText(SENSITIVE_ONLY_ME_NOTE)).toBeNull();
  });
});

describe('a search hit with no snippet (0.9.0, H1a)', () => {
  it('shows its title, and no snippet at all', async () => {
    // The vault answers a sensitive one's hit with an empty snippet.
    start('/search?q=passport');
    expect(await screen.findAllByText("Mansoor's passport")).not.toHaveLength(0);
    expect(document.querySelector('.snippet')).toBeNull();
  });
});

describe('made sensitive while still shared (the H1a review, S2)', () => {
  const edit = async (state: FakeState) => {
    await screen.findByRole('heading', { name: 'Is this right?' });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Sensitive').value).toBe(''),
    );
    fireEvent.change(screen.getByLabelText('Sensitive'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    return state;
  };

  it('saved, then asked: End them now ends them, and says what it did', async () => {
    const said = { ended: 1, left_out: 1, kept: 0 };
    const state = await edit(
      start(`/documents/${LEASE.id}/confirm`, {
        liveLinks: { [LEASE.id]: 2 },
        stopSharing: said,
      }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Still shared outside the family',
    });
    expect(within(dialog).getByText(sensitiveStillSharedWords(2))).toBeInTheDocument();
    // The edit is saved already: nothing waits on the answer.
    expect(state.calls.some((c) => c.method === 'PATCH')).toBe(true);
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'End them now' }));
    const done = await screen.findByRole('alertdialog', { name: 'Sharing ended' });
    expect(within(done).getByText(stopSharingWords(said))).toBeInTheDocument();
    expect(state.calls.filter((c) => c.url.endsWith('/stop-sharing'))).toHaveLength(1);
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${LEASE.id}`));
  });

  it('Keep them: nothing ended, and on to the document', async () => {
    const state = await edit(
      start(`/documents/${LEASE.id}/confirm`, { liveLinks: { [LEASE.id]: 1 } }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Still shared outside the family',
    });
    expect(within(dialog).getByText(sensitiveStillSharedWords(1))).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep them' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${LEASE.id}`));
    expect(state.calls.some((c) => c.url.endsWith('/stop-sharing'))).toBe(false);
  });

  it('not shared: nothing asked', async () => {
    await edit(start(`/documents/${LEASE.id}/confirm`));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${LEASE.id}`));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a kind made sensitive by default: how many are still shared, and the way to Sharing', async () => {
    start('/settings/kinds/property_deed', { kindStillShared: 3 });
    await screen.findByRole('heading', { name: 'Property deed / lease', level: 1 });
    fireEvent.click(screen.getByRole('checkbox', { name: /Sensitive by default/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(kindStillSharedWords(3), { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sharing' })).toHaveAttribute('href', '/sharing');
  });
});

describe('a paused link turned back on (the H1a review, M1)', () => {
  const paused = {
    id: 'sh-paused',
    document_id: SENSITIVE.id,
    document_title: 'Mansoor’s passport',
    recipient_label: 'the embassy',
    created_by_name: 'Mansoor Seikh',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 864e5).toISOString(),
    has_pin: true,
    open_count: 1,
    last_opened_at: null,
    state: 'paused',
    flow: 'v2',
    paused_at: new Date().toISOString(),
    paused_reason: 'restored',
    summary: 'Shared with the embassy, opened once. Paused after a restore.',
  };

  it('one that gives a sensitive document asks first, and is turned on only when told', async () => {
    const state = start('/after-restore', {
      shares: [{ ...paused }],
      resumeSensitive: [paused.id],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn back on' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Turn on a link to sensitive documents?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.shares[0]?.state).toBe('paused');
    fireEvent.click(screen.getByRole('button', { name: 'Turn back on' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Turn it back on',
      }),
    );
    await screen.findByText('The link to “Mansoor’s passport” works again.');
    expect(
      state.calls
        .filter((c) => c.url.endsWith('/resume'))
        .map((c) => (c.body as { confirm_sensitive?: boolean } | undefined)?.confirm_sensitive),
    ).toEqual([undefined, undefined, true]);
  });
});

describe('the share sheets say what a title left off covers (the H1a review, M4, M5)', () => {
  it('a document’s: the page, not the file', async () => {
    start(`/documents/${SENSITIVE.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    expect(await screen.findByText(DOWNLOAD_KEEPS_DETAILS)).toBeInTheDocument();
  });

  it('a collection’s: those put in later too', async () => {
    start(`/collections/${BROKER.id}`, { collections: [{ ...BROKER }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Share this collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Share “For the broker”' });
    const show = await within(sheet).findByRole('checkbox', { name: SHOW_TITLE_LABEL });
    expect(show).toHaveAccessibleDescription(SHOW_TITLE_COLLECTION_HINT);
    expect(within(sheet).getByText(DOWNLOAD_KEEPS_DETAILS)).toBeInTheDocument();
  });
});
