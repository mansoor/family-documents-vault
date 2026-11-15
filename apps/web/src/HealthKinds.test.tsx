import { PARENTS_KEEP_NOTE, REVIEW_LABEL, REVIEW_NOTE, SENSITIVE_ONLY_ME_NOTE } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Health's kinds on the web (0.9.0, H3): a teen's own vaccination record
 * starts where their parents can see it, and the card says why, where any
 * other health paper of theirs starts as Only me; and a yearly review is a
 * switch on an advance directive's page — off until somebody turns it on,
 * then a reminder like any other, with its next day said beside it.
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

const medical = (key: string, label: string, more: Record<string, unknown> = {}) => ({
  key,
  label,
  category: 'medical',
  fields: [],
  expiry_driver: null,
  reminder_leads: [],
  usually_essential: false,
  default_visibility: 'adults',
  issued_by_label: 'Provider',
  builtin: true,
  hidden: false,
  belongs_to: 'person',
  sensitive_default: true,
  ...more,
});

/** Three of Health's kinds, as the vault gives them since 0101. */
const KINDS = [
  medical('vaccination_record', 'Vaccination record', {
    fields: [
      { key: 'vaccines', label: 'Vaccines', kind: 'text', required: false },
      { key: 'next_dose_due', label: 'Next dose due', kind: 'date', required: false },
    ],
    remind_from: 'next_dose_due',
    remind_leads: [30, 7],
  }),
  medical('lab_result', 'Lab result'),
  medical('advance_directive', 'Advance directive / living will', {
    issued_by_label: null,
    core: {
      identifier: { shown: true, required: false, label: null },
      issued_by: { shown: false, required: false, label: null },
      issued: { shown: true, required: false, label: 'Signed' },
      expires: { shown: false, required: false, label: null },
      physical_location: { shown: true, required: false, label: null },
      tags: { shown: true, required: false, label: null },
      notes: { shown: true, required: false, label: null },
    },
  }),
];

const DIRECTIVE = {
  ...PASSPORT,
  id: 'doc-directive',
  type_key: 'advance_directive',
  category: 'medical',
  title: 'Mum’s living will',
  identifier: null,
  expires: null,
  issued: { date: '2024-03-10', precision: 'day' },
  visibility: 'adults',
  sensitive: null,
  sensitive_effective: true,
  etag: '"directive"',
};
const BLOODS = {
  ...DIRECTIVE,
  id: 'doc-bloods',
  type_key: 'lab_result',
  title: 'Bloods, October',
  etag: '"bloods"',
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
    documents: [clone(DIRECTIVE), clone(BLOODS)],
    sensitive: true,
    sensitiveProtects: true,
    healthKinds: true,
    reminders: [],
    timezone: 'Europe/London',
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** Add, with a file chosen, and the card's kind set. */
async function addWith(kind: string) {
  const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
  await waitFor(() => expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled());
  fireEvent.change(input, {
    target: { files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' })] },
  });
  await screen.findByRole('heading', { name: 'Is this right?' });
  fireEvent.change(screen.getByLabelText('What it is'), { target: { value: kind } });
}

const pressed = () =>
  within(screen.getByRole('group', { name: 'Who can see it' }))
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent);

describe('a teen’s own vaccination record starts where their parents see it (H3)', () => {
  it('Everyone, with a plain note why, and saved so', async () => {
    const state = start('/add', { members: [{ ...ME, role: 'teen' }] }, 'teen');
    await addWith('vaccination_record');
    await waitFor(() => expect(pressed()).toEqual(['Everyone']));
    expect(screen.getByText(PARENTS_KEEP_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(SENSITIVE_ONLY_ME_NOTE)).toBeNull();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures?.[0]?.metadata).toMatchObject({ visibility: 'household' });
  });

  it('any other health paper of theirs: Only me, as H1a has it', async () => {
    start('/add', { members: [{ ...ME, role: 'teen' }] }, 'teen');
    await addWith('lab_result');
    await waitFor(() => expect(pressed()).toEqual(['Only me']));
    expect(screen.getByText(SENSITIVE_ONLY_ME_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(PARENTS_KEEP_NOTE)).toBeNull();
  });

  it('a parent adding one: Adults only, as the kind says, and no note', async () => {
    start('/add', { members: [{ ...ME, relationship: 'Mum', date_of_birth: '1980-05-05' }] });
    await addWith('vaccination_record');
    await waitFor(() => expect(pressed()).toEqual(['Adults only']));
    expect(screen.queryByText(PARENTS_KEEP_NOTE)).toBeNull();
  });
});

describe('a yearly review on an advance directive (H3)', () => {
  it('off until turned on; on, a reminder with its next day; off again, gone', async () => {
    const state = start(`/documents/${DIRECTIVE.id}`);
    const box = await screen.findByRole('checkbox', { name: REVIEW_LABEL });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    await expectAccessible();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(state.reminders).toHaveLength(1);
    expect(state.reminders?.[0]).toMatchObject({
      document_id: DIRECTIVE.id,
      review: true,
      recurrence: 'annual',
      note: REVIEW_NOTE,
    });
    // On the anniversary of its signing.
    expect(String(state.reminders?.[0]?.fire_at)).toMatch(/-03-10$/);
    expect(await screen.findByText(/^Next review: /)).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(/^Next review: /);
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(state.reminders).toEqual([]);
    expect(screen.queryByText(/^Next review: /)).toBeNull();
  });

  it('is not offered on a lab result, nor by a vault without it', async () => {
    start(`/documents/${BLOODS.id}`);
    await screen.findByRole('heading', { name: BLOODS.title, level: 1 });
    expect(screen.queryByRole('checkbox', { name: REVIEW_LABEL })).toBeNull();
    cleanup();
    start(`/documents/${DIRECTIVE.id}`, { healthKinds: false });
    await screen.findByRole('heading', { name: DIRECTIVE.title, level: 1 });
    expect(screen.queryByRole('checkbox', { name: REVIEW_LABEL })).toBeNull();
  });

  it('is shown wherever one is on, so it can be turned off: a paper moved to another kind', async () => {
    const state = start(`/documents/${BLOODS.id}`, {
      reminders: [
        {
          id: 'rem-old',
          document_id: BLOODS.id,
          document_title: BLOODS.title,
          kind: 'manual',
          fire_at: '2027-03-10',
          lead_days: null,
          note: REVIEW_NOTE,
          recurrence: 'annual',
          review: true,
          status: 'scheduled',
          snoozed_until: null,
          label: 'In a while',
          source: null,
          about: null,
        },
      ],
    });
    const box = await screen.findByRole('checkbox', { name: REVIEW_LABEL });
    await waitFor(() => expect(box).toBeChecked());
    fireEvent.click(box);
    await waitFor(() => expect(state.reminders).toEqual([]));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: REVIEW_LABEL })).toBeNull());
  });
});
