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
 * What the pages propose, on the web (5.37, A44): after Save, the
 * document's page asks "We read the pages — is this right?" with a chip
 * for each empty field the pages propose; the Edit card shows the same
 * chips under its fields. A chip fills only an empty field, never what was
 * typed, and only when tapped; each says how sure, lightly: "suggested · 92%".
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** A scan just saved with nothing filled in: what the pages are for. */
const SCAN = {
  ...PASSPORT,
  id: 'doc-3',
  type_key: null,
  title: null,
  owner_member_id: null,
  category: null,
  issued: null,
  expires: null,
  identifier: null,
  issued_by: null,
  physical_location: null,
  is_essential: false,
  tags: [],
  latest_version_id: 'v-3',
  etag: '"scan-1"',
};

const READ: DetailSuggestions = {
  state: 'ready',
  version_id: 'v-3',
  proposal: {
    type_key: { value: 'passport', confidence: 0.92, cue: 'kind_words' },
    owner_member_id: { value: 'm-0', confidence: 0.85, cue: 'name_labelled' },
    issued: {
      value: { date: '2021-03-14', precision: 'day' },
      confidence: 0.82,
      cue: 'issue_label',
    },
    expires: {
      value: { date: '2031-03-14', precision: 'day' },
      confidence: 0.82,
      cue: 'expiry_label',
    },
    identifier: { value: '533401872', confidence: 0.85, cue: 'number_label' },
    issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
  },
};

const withScan = (over: Partial<FakeState> = {}, doc: Record<string, unknown> = {}) =>
  fresh({
    members: [ME, AISHA],
    documents: [{ ...SCAN, ...doc }],
    detailSuggestions: { 'doc-3': READ },
    ...over,
  });

async function openPage(state: FakeState, role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner') {
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', '/documents/doc-3');
  render(<App />);
  await screen.findByRole('heading', { level: 1 });
}
const card = () => screen.findByRole('region', { name: 'We read the pages — is this right?' });
const asked = (state: FakeState) =>
  state.calls.filter((c) => c.url.endsWith('/documents/doc-3/suggestions')).length;
const patches = (state: FakeState) => state.calls.filter((c) => c.method === 'PATCH');

describe('what the pages propose, on the document page (5.37)', () => {
  it('after Save, asks "We read the pages — is this right?", a chip for each empty field, with how sure', async () => {
    const state = withScan();
    await openPage(state);
    const region = await card();
    const chips = within(region)
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('suggested'))
      .map((b) => b.getAttribute('aria-label'));
    expect(chips).toEqual([
      'What it is: Passport? suggested · 92%',
      'Whose it is: Aisha? suggested · 85%',
      'Issued: 14 Mar 2021? suggested · 82%',
      'Expires: 14 Mar 2031? suggested · 82%',
      'Number: 533401872? suggested · 85%',
      'Issued by: From United Kingdom? suggested · 90%',
    ]);
    // Lightly: the mark says how sure, and in words what it read.
    const mark = within(region).getAllByText('suggested · 92%')[0] as HTMLElement;
    expect(mark).toHaveAttribute(
      'title',
      'Read from the pages: the words this kind of document carries',
    );
    // Nothing is filled in until a chip is tapped.
    expect(patches(state)).toEqual([]);
    await expectAccessible();
  });

  it('a tap fills that one field, as the document was loaded, and the place moves to the next chip (W537-6)', async () => {
    const state = withScan();
    await openPage(state);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: /^Expires: 14 Mar 2031\?/ }));
    await waitFor(() => expect(patches(state)).toHaveLength(1));
    const [patch] = patches(state);
    expect(patch?.body).toEqual({ expires: { date: '2031-03-14', precision: 'day' } });
    expect(patch?.headers?.['if-match']).toBe('"scan-1"');
    // That field has its value now: its chip has gone, and the place is on
    // the one after it, not back at the first.
    await waitFor(() =>
      expect(within(region).queryByRole('button', { name: /^Expires:/ })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(region).getByRole('button', { name: /^Number: 533401872\?/ }),
      ),
    );
    // The kind, on a document with no name: the name the card would give it,
    // as the document now is.
    const now = (state.documents[0] as { etag: string }).etag;
    fireEvent.click(within(region).getByRole('button', { name: /^What it is: Passport\?/ }));
    await waitFor(() => expect(patches(state)).toHaveLength(2));
    expect(patches(state)[1]?.body).toEqual({
      type_key: 'passport',
      category: 'identity',
      title: 'Passport',
    });
    expect(patches(state)[1]?.headers?.['if-match']).toBe(now);
    expect(now).not.toBe('"scan-1"');
  });

  it('a name nobody typed follows the chips: the kind, then the person (W537-4)', async () => {
    const state = withScan();
    await openPage(state);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: /^What it is: Passport\?/ }));
    await waitFor(() => expect(patches(state)).toHaveLength(1));
    expect(patches(state)[0]?.body).toMatchObject({ title: 'Passport' });
    await waitFor(() =>
      expect(
        within(region).queryByRole('button', { name: /^What it is:/ }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(within(region).getByRole('button', { name: /^Whose it is: Aisha\?/ }));
    await waitFor(() => expect(patches(state)).toHaveLength(2));
    expect(patches(state)[1]?.body).toEqual({ owner_member_id: 'm-0', title: "Aisha's passport" });
    // A name somebody typed is theirs: a chip never renames it.
    cleanup();
    const typed = withScan({}, { title: 'Old passport, the blue one' });
    await openPage(typed);
    const again = await card();
    fireEvent.click(within(again).getByRole('button', { name: /^What it is: Passport\?/ }));
    await waitFor(() => expect(patches(typed)).toHaveLength(1));
    expect(patches(typed)[0]?.body).not.toHaveProperty('title');
  });

  it('after the last chip the place goes to the card’s status; after a failed one, to the error (W537-6)', async () => {
    const one: DetailSuggestions = {
      ...READ,
      proposal: {
        identifier: READ.proposal.identifier as NonNullable<
          DetailSuggestions['proposal']['identifier']
        >,
      },
    };
    const state = withScan({ detailSuggestions: { 'doc-3': one } });
    await openPage(state);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: /^Number:/ }));
    const status = await within(region).findByRole('status');
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(status).toHaveTextContent('That is everything the pages said.');

    cleanup();
    const failing = withScan();
    await openPage(failing);
    const card2 = await card();
    Object.assign(failing.documents[0] as Record<string, unknown>, { etag: '"elsewhere"' });
    fireEvent.click(within(card2).getByRole('button', { name: /^Issued:/ }));
    const error = await within(card2).findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(error));
  });

  it('a new version: the last one’s chips go, and nothing of its pages is saved (W537-1)', async () => {
    const state = withScan();
    // The new version arrives: the vault is reading its pages now.
    state.hold = (method, path) => {
      if (method === 'POST' && path.endsWith('/versions')) {
        Object.assign(state.documents[0] as Record<string, unknown>, {
          latest_version_id: 'v-new',
          etag: '"v2"',
        });
        state.detailSuggestions = { 'doc-3': { state: 'pending', version_id: null, proposal: {} } };
      }
      return undefined;
    };
    await openPage(state);
    const region = await card();
    expect(within(region).getByRole('button', { name: /^Expires:/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add a new version'), {
      target: { files: [new File(['%PDF-1.4'], 'renewed.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /We read the pages/ })).not.toBeInTheDocument(),
    );
    expect(patches(state)).toEqual([]);
    // And an answer for the old version, late, is not offered for the new one.
    state.detailSuggestions = { 'doc-3': READ };
    expect(screen.queryByRole('button', { name: /^Expires:/ })).not.toBeInTheDocument();
  });

  it('"Not now" is remembered for this person and this document; the Edit card still offers (decision 16)', async () => {
    const state = withScan();
    await openPage(state);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /We read the pages/ })).not.toBeInTheDocument(),
    );
    // Back on the page another time: it does not come back, and the vault
    // is not even asked.
    cleanup();
    // As a reload shows it: the same vault, the session this browser keeps.
    installFakeApi(state);
    window.history.replaceState({}, '', '/documents/doc-3');
    render(<App />);
    await screen.findByText('Download');
    expect(screen.queryByRole('region', { name: /We read the pages/ })).not.toBeInTheDocument();
    expect(asked(state)).toBe(1);
    expect(Object.keys(localStorage).some((k) => k.endsWith('.hh.me.doc-3'))).toBe(true);
    // The Edit card still offers what the pages say.
    cleanup();
    window.history.replaceState({}, '', '/documents/doc-3/confirm');
    installFakeApi(state);
    render(<App />);
    expect(
      await screen.findByRole('group', { name: 'What the pages say: what it is' }),
    ).toBeInTheDocument();
  });

  it('a chip goes the moment its field is filled, before the vault is asked again', async () => {
    const state = withScan();
    // The vault's next answer is held: what it said before is all the page has.
    let answered = 0;
    state.hold = (_method, path) =>
      path.endsWith('/suggestions') && ++answered > 1
        ? new Promise<void>(() => undefined)
        : undefined;
    await openPage(state);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: /^Number: 533401872\?/ }));
    await waitFor(() => expect(patches(state)).toHaveLength(1));
    await waitFor(() =>
      expect(within(region).queryByRole('button', { name: /^Number:/ })).not.toBeInTheDocument(),
    );
    expect(within(region).getByRole('button', { name: /^Expires:/ })).toBeInTheDocument();
  });

  it('a field the document has a value for is never offered', async () => {
    const state = withScan(
      {},
      { expires: { date: '2030-01-01', precision: 'day' }, identifier: 'X1' },
    );
    await openPage(state);
    const region = await card();
    expect(within(region).queryByRole('button', { name: /^Expires:/ })).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /^Number:/ })).not.toBeInTheDocument();
    expect(
      within(region).getByRole('button', { name: /^Issued: 14 Mar 2021\?/ }),
    ).toBeInTheDocument();
  });

  it('changed somewhere else since it was loaded: nothing is saved, and the page loads it again', async () => {
    const state = withScan();
    await openPage(state);
    const region = await card();
    // Somebody else filled in the number meanwhile.
    Object.assign(state.documents[0] as Record<string, unknown>, {
      identifier: '999',
      etag: '"elsewhere"',
    });
    fireEvent.click(within(region).getByRole('button', { name: /^Number: 533401872\?/ }));
    expect(
      await within(region).findByText(/changed somewhere else, so it has been loaded again/),
    ).toBeInTheDocument();
    // Theirs stands, and the chip for it has gone.
    expect((state.documents[0] as Record<string, unknown>).identifier).toBe('999');
    await waitFor(() =>
      expect(within(region).queryByRole('button', { name: /^Number:/ })).not.toBeInTheDocument(),
    );
  });

  it('Not now puts the card away, and the place goes to the details', async () => {
    const state = withScan();
    await openPage(state);
    const region = await card();
    fireEvent.click(within(region).getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /We read the pages/ })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(document.activeElement?.tagName).toBe('DL'));
    expect(patches(state)).toEqual([]);
  });

  it('while the pages are read it asks again, then offers what they say', async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const state = withScan({
      detailSuggestions: { 'doc-3': { state: 'pending', version_id: null, proposal: {} } },
    });
    await openPage(state);
    await waitFor(() => expect(asked(state)).toBe(1));
    expect(screen.queryByRole('region', { name: /We read the pages/ })).not.toBeInTheDocument();
    state.detailSuggestions = { 'doc-3': READ };
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await card();
    expect(asked(state)).toBe(2);
  });

  it('a viewer is never offered suggestions, and the vault is not asked', async () => {
    const state = withScan();
    await openPage(state, 'viewer');
    await screen.findByText('Download');
    expect(screen.queryByRole('region', { name: /We read the pages/ })).not.toBeInTheDocument();
    expect(asked(state)).toBe(0);
  });

  it('a vault that does not propose is not asked', async () => {
    const state = withScan();
    delete state.detailSuggestions;
    await openPage(state);
    await screen.findByText('Download');
    expect(asked(state)).toBe(0);
  });
});

describe('what the pages propose, on the Edit card (5.37)', () => {
  async function openCard(state: FakeState) {
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/documents/doc-3/confirm');
    render(<App />);
    await screen.findByLabelText('What it is');
  }

  it('a chip under each empty field; it fills only an empty field, never what was typed', async () => {
    const state = withScan();
    await openCard(state);
    const kind = await screen.findByRole('group', { name: 'What the pages say: what it is' });
    // Not filled in: chosen with a tap.
    expect(screen.getByLabelText<HTMLSelectElement>('What it is').value).toBe('');
    fireEvent.click(within(kind).getByRole('button', { name: /Passport\? suggested · 92%/ }));
    expect(screen.getByLabelText<HTMLSelectElement>('What it is').value).toBe('passport');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('What it is')));
    expect(
      screen.queryByRole('group', { name: 'What the pages say: what it is' }),
    ).not.toBeInTheDocument();

    // A passport expires: its field, and the pages' date under it.
    const expires = await screen.findByRole('group', { name: 'What the pages say: expires' });
    // A number typed in: the pages' number is not offered over it.
    fireEvent.change(screen.getByLabelText('Number'), { target: { value: 'TYPED-1' } });
    expect(
      screen.queryByRole('group', { name: 'What the pages say: number' }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(expires).getByRole('button'));
    expect(screen.getByLabelText<HTMLInputElement>(/^Expires/).value).toBe('14 Mar 2031');

    // Whose: the card guesses the reader for a document that says nobody,
    // and the pages' person is offered over that guess (decision 17).
    expect(screen.getByLabelText<HTMLSelectElement>('Whose it is').value).toBe('me');
    const whose = screen.getByRole('group', { name: 'What the pages say: whose it is' });
    fireEvent.click(within(whose).getByRole('button', { name: /Aisha\?/ }));
    expect(screen.getByLabelText<HTMLSelectElement>('Whose it is').value).toBe('m-0');

    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(patches(state)).toHaveLength(1));
    expect(patches(state)[0]?.body).toMatchObject({
      type_key: 'passport',
      owner_member_id: 'm-0',
      identifier: 'TYPED-1',
      expires: { date: '2031-03-14', precision: 'day' },
      title: "Aisha's passport",
    });
  });

  it('once somebody chooses whose it is, the pages’ person is not offered over them (decision 17)', async () => {
    const state = withScan();
    await openCard(state);
    await screen.findByRole('group', { name: 'What the pages say: whose it is' });
    fireEvent.change(screen.getByLabelText('Whose it is'), { target: { value: 'me' } });
    expect(
      screen.queryByRole('group', { name: 'What the pages say: whose it is' }),
    ).not.toBeInTheDocument();
    // A document that says whose it is offers no other person.
    cleanup();
    const owned = withScan({}, { owner_member_id: 'me' });
    await openCard(owned);
    await screen.findByRole('group', { name: 'What the pages say: what it is' });
    expect(
      screen.queryByRole('group', { name: 'What the pages say: whose it is' }),
    ).not.toBeInTheDocument();
  });

  it('another kind chosen: the dates, number and issuer read for the proposed one are not offered (W537-5)', async () => {
    const state = withScan();
    await openCard(state);
    await screen.findByRole('group', { name: 'What the pages say: issued' });
    expect(screen.getByRole('group', { name: 'What the pages say: number' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What it is'), {
      target: { value: 'birth_certificate' },
    });
    expect(
      screen.queryByRole('group', { name: 'What the pages say: issued' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'What the pages say: number' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/From United Kingdom\?/)).not.toBeInTheDocument();
    // The proposed kind again: they are offered again.
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'passport' } });
    expect(
      await screen.findByRole('group', { name: 'What the pages say: issued' }),
    ).toBeInTheDocument();
  });

  it("who issued it: the pages' answer is the first chip, with its mark, and the older question is not asked", async () => {
    const state = withScan();
    await openCard(state);
    fireEvent.click(
      within(
        await screen.findByRole('group', { name: 'What the pages say: what it is' }),
      ).getByRole('button'),
    );
    const from = await screen.findByRole('group', { name: 'Who it might be from' });
    const first = within(from).getAllByRole('button')[0] as HTMLElement;
    expect(first).toHaveTextContent('From United Kingdom? suggested · 90%');
    expect(state.calls.some((c) => c.url.endsWith('/issuer-suggestions'))).toBe(false);
    fireEvent.click(first);
    expect(screen.getByLabelText<HTMLInputElement>('Issuing country').value).toBe('United Kingdom');
  });

  it('a typed date is never written over by a chip tapped after it', async () => {
    const state = withScan({}, { type_key: 'passport' });
    await openCard(state);
    const issued = await screen.findByRole('group', { name: 'What the pages say: issued' });
    const chip = within(issued).getByRole('button');
    // Typed, then the chip tapped in the same moment, before it went.
    fireEvent.change(screen.getByLabelText('Issued'), { target: { value: '1 Jan 2020' } });
    fireEvent.click(chip);
    expect(screen.getByLabelText<HTMLInputElement>('Issued').value).toBe('1 Jan 2020');
  });
});
