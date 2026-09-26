import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, PASSPORT, signedIn, TYPES, type FakeState } from './test-api.js';

/**
 * The card asks for a type's details (5.10): the fixed fields in the type's
 * own words, then its own fields, each with the input its kind asks for.
 * Save waits for what is required and says what; Skip for now never waits.
 * The document's page shows the details, keeps what its type no longer asks
 * for under "Other details", and keeps a note's line breaks.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** The fixed fields as GET /document-types gives them (0.5.6): all shown, none required. */
function core(over: Record<string, { shown?: boolean; required?: boolean; label?: string }> = {}) {
  const out: Record<string, { shown: boolean; required: boolean; label: string | null }> = {};
  for (const key of [
    'identifier',
    'issued_by',
    'issued',
    'expires',
    'physical_location',
    'tags',
    'notes',
  ]) {
    out[key] = { shown: true, required: false, label: null, ...over[key] };
  }
  return out;
}

/** A passport as the vault ships it (0032): its number, by that name, and its expiry required. */
const PASSPORT_TYPE = {
  ...TYPES[0],
  builtin: true,
  hidden: false,
  core: core({
    identifier: { required: true, label: 'Passport number' },
    issued_by: { label: 'Issuing country' },
    expires: { required: true },
  }),
};

/** A car (0034): its plate required, by what people call it. */
const CAR_TYPE = {
  key: 'vehicle_registration',
  label: 'Vehicle title / registration',
  category: 'property',
  fields: [
    { key: 'vin', label: 'VIN', kind: 'text', required: false },
    { key: 'plate', label: 'Registration plate', kind: 'text', required: true },
    { key: 'mot_due', label: 'MOT due', kind: 'date', required: false },
  ],
  expiry_driver: 'expires_on',
  reminder_leads: [45, 7],
  usually_essential: false,
  default_visibility: 'household',
  issued_by_label: null,
  builtin: true,
  hidden: false,
  core: core(),
};

/** A household's own type, with a field of every other kind. */
const PET_TYPE = {
  key: 'h_petinsure2',
  label: 'Pet insurance',
  category: 'insurance',
  fields: [
    { key: 'h_species000', label: 'Species', kind: 'choice', required: true },
    { key: 'h_band000000', label: 'Band', kind: 'choice', choices: ['Basic', 'Lifetime'] },
    { key: 'h_direct0000', label: 'Paid by direct debit', kind: 'yes_no', required: false },
    { key: 'h_cover00000', label: 'Cover', kind: 'money', required: false },
    { key: 'h_claims0000', label: 'Claims made', kind: 'number', required: false },
    { key: 'h_first00000', label: 'First year', kind: 'year', required: false },
    { key: 'h_terms00000', label: 'Terms', kind: 'long_text', required: false },
  ],
  expiry_driver: null,
  reminder_leads: [],
  usually_essential: false,
  default_visibility: 'household',
  issued_by_label: 'Insurer',
  builtin: false,
  hidden: false,
  // Where the original is kept is not asked for this one.
  core: core({ expires: { shown: false }, physical_location: { shown: false } }),
};

/** The attribute library: a choice whose answers are its own, not the type's. */
const ATTRIBUTES = [
  {
    key: 'h_species000',
    label: 'Species',
    kind: 'choice',
    choices: ['Cat', 'Dog'],
    builtin: false,
  },
  { key: 'colour', label: 'Colour', kind: 'text', choices: null, builtin: true },
];

const DETAIL_TYPES = [PASSPORT_TYPE, ...TYPES.slice(1), CAR_TYPE, PET_TYPE];

/** A car already in the vault, with a detail its type no longer asks for. */
const CAR = {
  ...PASSPORT,
  id: 'doc-car',
  type_key: 'vehicle_registration',
  title: 'The Golf',
  category: 'property',
  identifier: null,
  is_essential: false,
  physical_location: null,
  tags: [],
  issued: null,
  expires: { date: '2027-06-30', precision: 'month' },
  extra: {
    vin: 'WVWZZZ1KZAW000001',
    plate: 'KX19 ZLT',
    mot_due: { date: '2027-03-31', precision: 'month' },
    colour: 'Blue',
  },
  latest_version_id: 'v-car',
  etag: '"car"',
};

function start(path: string, over: Partial<FakeState> = {}): FakeState {
  const state = fresh({ types: DETAIL_TYPES, attributes: ATTRIBUTES, ...over });
  installFakeApi(state);
  signedIn();
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** To the Add card, with a file chosen and the type picked. */
async function addCard(typeKey: string) {
  const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
  await waitFor(() => expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled());
  fireEvent.change(input, {
    target: { files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' })] },
  });
  await screen.findByRole('heading', { name: 'Is this right?' });
  fireEvent.change(screen.getByLabelText('What it is'), { target: { value: typeKey } });
}

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the card asks for a type’s details (5.10)', () => {
  it('a passport card asks for Passport number, marked required', async () => {
    start('/add');
    await addCard('passport');

    // The type's own word for it, not the app's.
    const number = screen.getByLabelText(/^Passport number/);
    expect(screen.queryByLabelText('Number')).toBeNull();
    const label = document.querySelector('label[for="f-number"]') as HTMLElement;
    expect(label.textContent).toBe('Passport number * required');
    // Read out as a word, never the symbol alone.
    expect(number).toHaveAccessibleName('Passport number required');
    expect(number).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText(/^Expires/)).toHaveAttribute('aria-required', 'true');
    // What is not required is not marked.
    expect(screen.getByLabelText('Issued')).not.toHaveAttribute('aria-required');
    expect(screen.getByLabelText('Issuing country')).not.toHaveAttribute('aria-required');
    await expectAccessible();

    // A car asks for its own details after the fixed fields, the plate required.
    fireEvent.change(screen.getByLabelText('What it is'), {
      target: { value: 'vehicle_registration' },
    });
    expect(screen.getByLabelText(/^Number/)).not.toHaveAttribute('aria-required');
    const plate = screen.getByLabelText(/^Registration plate/);
    expect(plate).toHaveAccessibleName('Registration plate required');
    expect(screen.getByLabelText('VIN')).toBeInTheDocument();
    const order = [...document.querySelectorAll('form input, form select, form textarea')].map(
      (el) => el.id,
    );
    expect(order.indexOf('f-location')).toBeLessThan(order.indexOf('f-x-vin'));
    expect(order.indexOf('f-x-plate')).toBeLessThan(order.indexOf('f-notes'));
    await expectAccessible();
  });

  it('Save waits and names the missing fields; Skip does not wait', async () => {
    const state = start('/add');
    await addCard('passport');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));

    // In the card's order.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Still needed: Expires and Passport number. Fill them in, or skip for now.',
    );
    expect(state.captures ?? []).toHaveLength(0);
    // Each is marked, and the place is on the first.
    const expires = screen.getByLabelText(/^Expires/);
    const number = screen.getByLabelText(/^Passport number/);
    expect(expires).toHaveAttribute('aria-invalid', 'true');
    expect(number).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(expires);
    await expectAccessible();

    // Filled in, it is no longer marked, and Save names only what is left.
    type(/^Expires/, 'March 2031');
    expect(expires).not.toHaveAttribute('aria-invalid');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Still needed: Passport number. Fill it in, or skip for now.',
      ),
    );
    expect(document.activeElement).toBe(number);
    expect(state.captures ?? []).toHaveLength(0);

    // Skip for now never waits: the file goes, with no details.
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures).toEqual([{ fields: ['file'], metadata: null }]);
  });

  it('with every required field given, Save sends the details ahead of the file', async () => {
    const state = start('/add');
    await addCard('vehicle_registration');
    type(/^Registration plate/, ' KX19 ZLT ');
    type('VIN', 'WVWZZZ1KZAW000001');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures?.[0]?.metadata).toMatchObject({
      type_key: 'vehicle_registration',
      extra: { plate: 'KX19 ZLT', vin: 'WVWZZZ1KZAW000001' },
    });
    // Nothing typed is nothing sent.
    expect(state.captures?.[0]?.metadata?.extra).not.toHaveProperty('mot_due');
    expect(state.captures?.[0]?.metadata).not.toHaveProperty('notes');
  });

  it('"Mar 2031" is accepted', async () => {
    const state = start('/add');
    await addCard('vehicle_registration');
    type(/^Registration plate/, 'KX19 ZLT');
    type('MOT due', 'Mar 2031');
    type('Expires', 'Mar 2031');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures?.[0]?.metadata).toMatchObject({
      expires: { date: '2031-03-31', precision: 'month' },
      extra: { mot_due: { date: '2031-03-31', precision: 'month' } },
    });
  });

  it('a date the card cannot read is named, and nothing is sent', async () => {
    const state = start('/add');
    await addCard('vehicle_registration');
    type(/^Registration plate/, 'KX19 ZLT');
    type('MOT due', 'next week');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'MOT due: try 14 Mar 2031, March 2031, or just 2031.',
    );
    expect(document.activeElement).toBe(screen.getByLabelText('MOT due'));
    expect(state.captures ?? []).toHaveLength(0);
  });

  it('each kind has its own input: a pick-list, a yes/no switch, numbers and amounts', async () => {
    const state = start('/add');
    await addCard(PET_TYPE.key);
    // What this type does not show is not asked.
    expect(screen.queryByLabelText('Where the original is kept')).toBeNull();
    expect(screen.queryByLabelText('Expires')).toBeNull();

    // A choice with no answers of its own offers the library's.
    const species = await screen.findByRole('combobox', { name: /^Species/ });
    await waitFor(() =>
      expect([...(species as HTMLSelectElement).options].map((o) => o.text)).toEqual([
        'Not chosen',
        'Cat',
        'Dog',
      ]),
    );
    expect(
      [...screen.getByLabelText<HTMLSelectElement>('Band').options].map((o) => o.text),
    ).toEqual(['Not chosen', 'Basic', 'Lifetime']);
    const direct = screen.getByRole('switch', { name: 'Paid by direct debit' });
    expect(direct).not.toBeChecked();
    await expectAccessible();

    // Each read as the vault keeps it, or named when it cannot be.
    fireEvent.change(species, { target: { value: 'Dog' } });
    fireEvent.click(direct);
    expect(direct).toBeChecked();
    type('Cover', '£1,200.5');
    type('Claims made', '3');
    type('First year', '2019');
    type('Terms', 'Excess £99\nNo dental');
    type('Claims made', 'three');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Claims made: write a number, such as 3.',
    );
    type('Claims made', '3');
    type('Cover', '12.345');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Cover: write an amount, such as 12.50.'),
    );
    type('Cover', '£1,200.50');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures?.[0]?.metadata?.extra).toEqual({
      h_species000: 'Dog',
      h_direct0000: true,
      h_cover00000: 1200.5,
      h_claims0000: 3,
      h_first00000: 2019,
      h_terms00000: 'Excess £99\nNo dental',
    });
  });

  it('editing sends only the details that changed, and a cleared one is taken away', async () => {
    const state = start(`/documents/${CAR.id}/confirm`, { documents: [{ ...CAR }] });
    const plate = await screen.findByLabelText<HTMLInputElement>(/^Registration plate/);
    expect(plate.value).toBe('KX19 ZLT');
    // A date as a person writes it, to be typed over.
    expect(screen.getByLabelText<HTMLInputElement>('MOT due').value).toBe('March 2027');
    type('VIN', '');
    type('MOT due', 'April 2027');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${CAR.id}`));
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect((patch?.body as { extra: unknown }).extra).toEqual({
      vin: null,
      mot_due: { date: '2027-04-30', precision: 'month' },
    });
    // The detail the type no longer asks for is left as it is.
    expect(state.documents[0]?.extra).toEqual({
      plate: 'KX19 ZLT',
      mot_due: { date: '2027-04-30', precision: 'month' },
      colour: 'Blue',
    });
  });

  it('editing, Save waits too, and what was changed can be saved without them', async () => {
    const state = start(`/documents/${PASSPORT.id}/confirm`, {
      documents: [{ ...PASSPORT, identifier: null }],
    });
    await screen.findByLabelText('Where the original is kept');
    type('Where the original is kept', 'Hall drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Still needed: Passport number. Fill it in, or save without it.',
    );
    expect(state.calls.some((c) => c.method === 'PATCH')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save without it' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${PASSPORT.id}`));
    expect(state.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      physical_location: 'Hall drawer',
      identifier: null,
    });
  });

  it('an Only me document’s details and notes come from the document itself, never a list', async () => {
    const mine = { ...CAR, visibility: 'private', notes: 'Spare key\nin the blue tin' };
    const state = start(`/documents/${CAR.id}/confirm`, { documents: [mine] });
    const plate = await screen.findByLabelText<HTMLInputElement>(/^Registration plate/);
    expect(plate.value).toBe('KX19 ZLT');
    const notes = screen.getByLabelText<HTMLTextAreaElement>('Notes');
    expect(notes.value).toBe('Spare key\nin the blue tin');
    expect(screen.getByText('Sealed with the document, so only you can read them.')).toBeTruthy();
    // Read from GET /documents/{id}, not a list.
    expect(
      state.calls.some((c) => c.method === 'GET' && c.url === `/api/v1/documents/${CAR.id}`),
    ).toBe(true);
    // Nothing changed is nothing sent: no detail, no note is written again.
    type('Name', 'Our Golf');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${CAR.id}`));
    const body = state.calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Our Golf' });
    expect(body).not.toHaveProperty('extra');
    expect(body).not.toHaveProperty('notes');
  });
});

describe('the document page shows them (5.10)', () => {
  it('the facts list shows the type’s details in its own words', async () => {
    start(`/documents/${CAR.id}`, { documents: [{ ...CAR }] });
    await screen.findByRole('heading', { name: 'The Golf', level: 1 });
    const facts = document.querySelector('dl.facts') as HTMLElement;
    const pairs = [...facts.querySelectorAll('dt')].map(
      (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`,
    );
    expect(pairs).toEqual(
      expect.arrayContaining([
        'VIN: WVWZZZ1KZAW000001',
        'Registration plate: KX19 ZLT',
        'MOT due: March 2027',
      ]),
    );
    // A detail the type no longer asks for is not among its facts.
    expect(pairs.some((p) => p.startsWith('Colour'))).toBe(false);
  });

  it('Other details can be removed', async () => {
    const state = start(`/documents/${CAR.id}`, { documents: [{ ...CAR }] });
    const section = (await screen.findByRole('heading', { name: 'Other details' })).closest(
      'section',
    ) as HTMLElement;
    // Named as the library names it, once it has answered.
    await within(section).findByText('Colour');
    expect(within(section).getByText('Blue')).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(within(section).getByRole('button', { name: 'Remove Colour' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove this detail?' });
    expect(dialog).toHaveTextContent('“Colour: Blue” is taken off this document for good.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Other details' })).toBeNull(),
    );
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ extra: { colour: null } });
    expect(patch?.headers?.['if-match']).toBe('"car"');
    // Only that one: the car's own details stay.
    expect(state.documents[0]?.extra).toEqual({
      vin: 'WVWZZZ1KZAW000001',
      plate: 'KX19 ZLT',
      mot_due: { date: '2027-03-31', precision: 'month' },
    });
    expect(screen.getByText('KX19 ZLT')).toBeInTheDocument();
  });

  it('a viewer sees Other details, and is not offered Remove', async () => {
    const state = fresh({ types: DETAIL_TYPES, attributes: ATTRIBUTES, documents: [{ ...CAR }] });
    installFakeApi(state);
    signedIn('viewer');
    window.history.replaceState({}, '', `/documents/${CAR.id}`);
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Other details' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(section).getByText('Blue')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).toBeNull();
  });

  it('notes keep their line breaks', async () => {
    const state = start('/add');
    await addCard('birth_certificate');
    type('Notes', 'Certified copy\n\nOriginal with Mum');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures?.[0]?.metadata?.notes).toBe('Certified copy\n\nOriginal with Mum');

    // As written, on the document's page: its lines are its own.
    const heading = await screen.findByRole('heading', { name: 'Notes' });
    const text = heading.closest('section')?.querySelector('p') as HTMLElement;
    expect(text.textContent).toBe('Certified copy\n\nOriginal with Mum');
    expect(text).toHaveClass('keep-lines');
  });
});
