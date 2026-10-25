import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  levelItem,
  type BatchDefaults,
  type BatchItemView,
  type DetailProposal,
  type DocumentTypeView,
  type StoredLocalAi,
} from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * The local AI (0.9.0, R4), on the web: Settings → Server and reading →
 * Reading and the check says whether the server has one set up — its model and host, never set
 * here — and turns it on or off for the household, an owner's, off unless
 * turned on; Test asks the worker. And on a card, a detail it suggested is
 * marked "suggested by the local AI", unsure, with the card at Check.
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

const SET_UP = {
  state: 'reachable',
  model: 'qwen2.5:3b-instruct',
  host: 'ollama:11434',
  checked_at: '2026-10-23T10:00:00.000Z',
};

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

describe('Settings → Reading: the local AI (R4)', () => {
  it('not set up on this server: said so, how it is set up, and the switch can’t be turned on', async () => {
    at('/settings/reading', {
      localAi: { local_ai: false, local_ai_server: { state: 'not_set_up' } },
    });
    expect(await screen.findByText('Not set up on this server.')).toBeInTheDocument();
    expect(screen.getByText(/FDV_LOCAL_AI_URL and/)).toHaveTextContent(
      'It can’t be set from here.',
    );
    const box = screen.getByRole('checkbox', { name: /with the local AI too/ });
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull();
    // Nothing on the page takes an address or a model.
    expect(screen.queryByRole('textbox')).toBeNull();
    await expectAccessible();
  });

  it('set up and answering: its model and host; turned on, said so; Test says how long it took', async () => {
    const state = at('/settings/reading', {
      localAi: { local_ai: false, local_ai_server: SET_UP },
      localAiTestAnswer: {
        problem: null,
        model: 'qwen2.5:3b-instruct',
        host: 'ollama:11434',
        latency_ms: 2345,
        words: 'qwen2.5:3b-instruct answered in 2.3 seconds.',
      },
    });
    expect(
      await screen.findByText(
        'Set up: qwen2.5:3b-instruct at ollama:11434. It answered when last asked.',
      ),
    ).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: /with the local AI too/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(state.localAi?.local_ai).toBe(true));
    expect(state.localAiPuts).toEqual([{ local_ai: true }]);
    const said = await screen.findByText(
      'Turned on. Papers read from now on are read with the local AI too.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(
      await screen.findByText(
        'qwen2.5:3b-instruct answered in 2.3 seconds.',
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(state.checksAsked).toEqual([{ kind: 'local_ai', path: null }]);
    await expectAccessible();
  });

  it('set up, not answering: said so, papers read without it', async () => {
    at('/settings/reading', {
      localAi: { local_ai: true, local_ai_server: { ...SET_UP, state: 'unreachable' } },
    });
    expect(
      await screen.findByText(/didn’t answer when last asked, so papers are read without it/),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /with the local AI too/ })).toBeChecked();
    await expectAccessible();
  });

  it('an owner’s alone: an adult is told so', async () => {
    at('/settings/reading', { localAi: { local_ai: false, local_ai_server: SET_UP } }, 'adult');
    expect(
      await screen.findByText('Only an owner can change how the vault reads papers.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says exactly what is sent, where, and that it applies to everyone’s uploads (the R4 review, M1)', async () => {
    at('/settings/reading', { localAi: { local_ai: false, local_ai_server: SET_UP } });
    await screen.findByText(/on a machine on your network you control/);
    const card = (await screen.findByRole('heading', { name: 'The local AI' })).closest(
      'section',
    ) as HTMLElement;
    expect(card).toHaveTextContent('on a machine on your network you control');
    expect(card).toHaveTextContent('Only me papers included');
    expect(card).toHaveTextContent('the filed documents the owner running it can see');
    expect(card).toHaveTextContent('whole names where two share one');
    expect(card).toHaveTextContent('may keep what it is sent in its own logs');
    expect(card).toHaveTextContent('Best on this same server, or over https');
    expect(card).toHaveTextContent('it reads everyone’s uploads in the household');
    expect(card).not.toHaveTextContent(/nothing it reads leaves/i);
    await expectAccessible();
  });

  it('whoever adds papers is told, where they add them, when the local AI reads them', async () => {
    at('/add/many', { batches: [], localAi: { local_ai: true, local_ai_server: SET_UP } }, 'adult');
    expect(await screen.findByText(/Read by the household’s local AI, on/)).toHaveTextContent(
      'Read by the household’s local AI, on ollama:11434',
    );
    await expectAccessible();
    cleanup();
    // Off for the household: nothing said.
    at(
      '/add/many',
      { batches: [], localAi: { local_ai: false, local_ai_server: SET_UP } },
      'adult',
    );
    await screen.findByRole('heading', { level: 1 });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText(/Read by the household’s local AI/)).toBeNull();
  });

  it('Server and reading lists it', async () => {
    at('/settings', { localAi: { local_ai: false, local_ai_server: SET_UP } });
    const link = await screen.findByRole('link', { name: /^Reading and the check.*local AI/ });
    expect(link).toHaveAttribute('href', '/settings/reading');
  });
});

const DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: 'household',
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};

function item(
  proposal: DetailProposal,
  localAi: StoredLocalAi,
  types: DocumentTypeView[],
): BatchItemView {
  const levelled = levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal,
    localAi,
    duplicate: null,
    defaults: DEFAULTS,
    types,
    people: [
      { id: 'me', name: 'Mansoor Seikh' },
      { id: 'm-0', name: 'Aisha' },
    ],
    role: 'owner',
    me: 'me',
  });
  return {
    id: 'item-1',
    batch_id: 'batch-1',
    name: 'item-1.pdf',
    content_type: 'application/pdf',
    byte_size: 2048,
    sha256: 'item-1'.padEnd(64, '0'),
    arrived_at: '2026-10-06T09:05:00Z',
    state: 'waiting',
    reading: 'read',
    read_failure: null,
    preview_state: 'ready',
    preview_pages: 1,
    duplicate: null,
    document_id: null,
    level: levelled.level,
    tags: levelled.tags,
    proposals: levelled.proposals,
    clashes: levelled.clashes,
  };
}

describe('a card the local AI read (R4)', () => {
  const card = (proposal: DetailProposal, localAi: StoredLocalAi) => {
    const state = fresh({ members: [{ ...ME, role: 'owner' }, AISHA], batches: [] });
    state.batches = [
      {
        id: 'batch-1',
        name: 'Scanned post',
        created_at: '2026-10-06T09:00:00Z',
        ends_at: '2026-11-05T09:00:00Z',
        defaults: DEFAULTS,
        items: [item(proposal, localAi, state.types as unknown as DocumentTypeView[])],
      },
    ];
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/inbox/batches/batch-1/items/item-1');
    render(<App />);
    return state;
  };

  it('what it suggested is marked so, unsure, and the card says why it waits', async () => {
    card(
      { owner_member_id: { value: 'm-0', confidence: 0.95, cue: 'name_labelled' } },
      { state: 'read', fields: { type_key: 'birth_certificate' } },
    );
    const kind = await screen.findByLabelText(/What it is/);
    expect(kind).toHaveValue('birth_certificate');
    const label = screen.getByText('What it is').closest('label') as HTMLElement;
    expect(label).toHaveTextContent('suggested by the local AI');
    expect(label).toHaveTextContent('unsure');
    expect(screen.getByText('Suggested by the local AI: kind')).toBeInTheDocument();
    await expectAccessible();
  });

  it('where it reads the paper otherwise, the card keeps the rules’ reading and says so', async () => {
    card(
      {
        type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
        owner_member_id: { value: 'm-0', confidence: 0.95, cue: 'name_labelled' },
        expires: {
          value: { date: '2031-03-14', precision: 'day' },
          confidence: 0.94,
          cue: 'expiry_label',
        },
      },
      { state: 'read', fields: { type_key: 'birth_certificate' } },
    );
    const kind = await screen.findByLabelText(/What it is/);
    expect(kind).toHaveValue('passport');
    expect(screen.getByText('The local AI reads it as a birth certificate')).toBeInTheDocument();
    const why = screen.getByText('The local AI reads it as a birth certificate').closest('ul');
    expect(within(why as HTMLElement).queryByText(/Ready/)).toBeNull();
    await expectAccessible();
  });
});
