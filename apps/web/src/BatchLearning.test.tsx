import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  levelItem,
  type BatchDefaults,
  type BatchItemView,
  type BatchLearning,
  type DetailProposal,
  type DocumentTypeView,
  type LearnedClash,
} from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * The vault learns from your corrections (Phase 6, I4), on the web: the
 * count under Your uploads, at every width; what it learned a press away,
 * with Forget all, asked first; and on a file's card, a suggestion the
 * rules made marked "learned from your earlier choices", with a sure rule
 * that disagrees with the pages said beside it.
 */

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

const DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: 'household',
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};

const LEARNED: BatchLearning = {
  counted: 50,
  unchanged: 31,
  window: 50,
  rules_max: 500,
  rules: [
    {
      id: 'r1',
      issuer: 'northgate dental',
      field: 'type_key',
      value: 'medical_record',
      label: 'Medical record',
      confirmed: 4,
      contradicted: 0,
      sure: true,
      last_used: '2026-10-09',
    },
    {
      id: 'r2',
      issuer: 'northgate dental',
      field: 'owner_member_id',
      value: 'm-0',
      label: 'Aisha',
      confirmed: 2,
      contradicted: 1,
      sure: false,
      last_used: '2026-10-08',
    },
  ],
};

/** An item as the vault answers it: levelled as the vault levels it, with what the rules said. */
function item(
  id: string,
  proposal: DetailProposal,
  types: DocumentTypeView[],
  clash: LearnedClash | null = null,
): BatchItemView {
  const levelled = levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal,
    learnedClash: clash,
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
    id,
    batch_id: 'batch-1',
    name: `${id}.pdf`,
    content_type: 'application/pdf',
    byte_size: 2048,
    sha256: id.padEnd(64, '0'),
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

const DENTIST = { value: 'Northgate Dental', confidence: 0.9, cue: 'known_issuer' } as const;

/** The app at `path`, an owner, with a batch of these items, and what was learned. */
function at(
  path: string,
  opts: {
    width?: number;
    learned?: BatchLearning;
    items?: (types: DocumentTypeView[]) => BatchItemView[];
    over?: Partial<FakeState>;
  } = {},
): FakeState {
  atWidth(opts.width ?? 1280);
  const state = fresh({
    members: [{ ...ME, role: 'owner' }, AISHA],
    batches: [],
    ...(opts.learned ? { learned: structuredClone(opts.learned) } : {}),
    ...opts.over,
  });
  state.batches = [
    {
      id: 'batch-1',
      name: 'Scanned post',
      created_at: '2026-10-06T09:00:00Z',
      ends_at: '2026-11-05T09:00:00Z',
      defaults: DEFAULTS,
      items: opts.items?.(state.types as unknown as DocumentTypeView[]) ?? [],
    },
  ];
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('learning from your corrections, on the web (I4)', () => {
  it('Your uploads says how well it is doing, from 768 px and on a phone', async () => {
    for (const width of [1280, 768, 375]) {
      at('/inbox', { width, learned: LEARNED });
      const box = await screen.findByRole('region', { name: 'What the vault learned from you' });
      expect(box).toHaveTextContent('Of your last 50 accepted, 31 needed no change.');
      expect(
        within(box).getByRole('button', { name: /What the vault has learned from you: 2 rules/ }),
      ).toHaveAttribute('aria-expanded', 'false');
      await expectAccessible();
      cleanup();
    }
  });

  it('what it learned, a press away; Forget all asks first, Cancel gives the focus back, and forgetting says so', async () => {
    const state = at('/inbox', { learned: LEARNED });
    const box = await screen.findByRole('region', { name: 'What the vault learned from you' });
    const toggle = within(box).getByRole('button', { name: /What the vault has learned/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rules = within(box).getByRole('list', { name: 'Rules learned from you' });
    expect(
      within(rules)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'From northgate dental — kind: Medical recordconfirmed 4 times · trusted',
      'From northgate dental — whose: Aishaconfirmed twice, not once',
    ]);
    expect(box).toHaveTextContent('Only you can see these');
    expect(box).toHaveTextContent('never chosen differently for that sender');
    expect(box).toHaveTextContent('What you’ve taught stays until you forget it');
    await expectAccessible();

    const forget = within(box).getByRole('button', { name: 'Forget all' });
    fireEvent.click(forget);
    const ask = await screen.findByRole('alertdialog', {
      name: 'Forget what the vault learned from you?',
    });
    expect(ask).toHaveTextContent('Its 2 rules and the count go.');
    expect(ask).toHaveTextContent('Your waiting files will be read again.');
    await expectAccessible();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(within(box).getByRole('button', { name: 'Forget all' })).toHaveFocus(),
    );
    expect(state.forgotten ?? 0).toBe(0);

    fireEvent.click(within(box).getByRole('button', { name: 'Forget all' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Forget all' }),
    );
    await waitFor(() => expect(state.forgotten).toBe(1));
    const said = await screen.findByText(
      'Forgotten. Your waiting files will be read again, and the vault starts learning again from your next accepts.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(screen.queryByRole('region', { name: 'What the vault learned from you' })).toBeNull();
  });

  it('nothing to say yet, nothing said; a vault that does not learn is never asked', async () => {
    at('/inbox', { learned: { ...LEARNED, counted: 0, unchanged: 0, rules: [] } });
    await screen.findByRole('heading', { level: 1, name: 'Inbox' });
    await waitFor(() => expect(screen.queryByText(/needed no change/)).toBeNull());
    expect(screen.queryByRole('region', { name: 'What the vault learned from you' })).toBeNull();
    cleanup();
    const old = at('/inbox');
    await screen.findByRole('heading', { level: 1, name: 'Inbox' });
    await waitFor(() => expect(old.calls.some((c) => c.url.includes('/batches'))).toBe(true));
    expect(old.calls.some((c) => c.url.includes('/batches/learned'))).toBe(false);
  });

  it('one accepted so far is said plainly', async () => {
    at('/inbox', { learned: { ...LEARNED, counted: 1, unchanged: 0, rules: [] } });
    expect(await screen.findByText('Your last accepted file needed a change.')).toBeInTheDocument();
  });

  it('a suggestion the rules made is marked "learned from your earlier choices", unsure until the rule is trusted', async () => {
    at('/inbox/batches/batch-1/items/item-1', {
      learned: LEARNED,
      items: (types) => [
        item(
          'item-1',
          {
            issued_by: DENTIST,
            type_key: { value: 'birth_certificate', confidence: 0.9, cue: 'learned' },
            owner_member_id: { value: 'm-0', confidence: 0.78, cue: 'learned' },
          },
          types,
        ),
      ],
    });
    const kind = await screen.findByLabelText(/What it is/);
    expect(kind).toHaveValue('birth_certificate');
    const kindLabel = screen.getByText('What it is').closest('label') as HTMLElement;
    expect(kindLabel).toHaveTextContent('suggested · learned from your earlier choices');
    expect(kindLabel).not.toHaveTextContent('unsure');
    // Whose it is: learned, and not trusted yet.
    const marks = screen.getAllByText('suggested · learned from your earlier choices');
    expect(marks).toHaveLength(2);
    expect(marks[1]?.parentElement).toHaveTextContent('unsure');
    expect(screen.getByText('Person unsure')).toBeInTheDocument();
    await expectAccessible();
  });

  it('a trusted rule that disagrees with the pages: the pages stand on the card, and both are said', async () => {
    at('/inbox/batches/batch-1/items/item-1', {
      learned: LEARNED,
      items: (types) => [
        item(
          'item-1',
          {
            issued_by: DENTIST,
            type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
            owner_member_id: { value: 'me', confidence: 0.95, cue: 'name_labelled' },
          },
          types,
          { type_key: 'birth_certificate' },
        ),
      ],
    });
    expect(await screen.findByLabelText(/What it is/)).toHaveValue('passport');
    expect(
      screen.getByText('The pages say a passport, your earlier choices say a birth certificate'),
    ).toBeInTheDocument();
    expect(screen.getByText('What it is').closest('label')).toHaveTextContent('suggested · 97%');
    await expectAccessible();
  });
});
