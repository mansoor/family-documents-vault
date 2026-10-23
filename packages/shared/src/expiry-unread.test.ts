import { describe, expect, it } from 'vitest';
import {
  levelItem,
  storedExpiryLabels,
  storedProposal,
  type LevelInput,
  type LevelKind,
} from './batch-levels.js';
import type { BatchDefaults } from './batches.js';
import {
  expiryLabelKinds,
  MAX_EXPIRY_LABEL_KINDS,
  proposeDetails,
  type DetailProposal,
  type ProposalContext,
} from './proposals.js';

/**
 * An end date on the page, not on the card (0.9.0, R3). A kind whose expiry
 * is the family's to add — an employment contract, a will, a logbook, a
 * deed — is complete without one, so a scan whose "End date" OCR misread
 * could be Ready with it missing: the scan set's photographed fixed-term
 * contract was, before R3. The page saying the date is there, the card
 * waits. Since the re-check every such kind's labels are asked, and the
 * card's kind decides — the batch's, the uploader's, or one changed after.
 */

const core = () =>
  Object.fromEntries(
    ['identifier', 'issued_by', 'issued', 'expires', 'physical_location', 'tags', 'notes'].map(
      (k) => [k, { shown: true, required: false, label: null }],
    ),
  ) as unknown as NonNullable<LevelKind['core']>;

const CONTRACT: LevelKind = {
  key: 'employment_contract',
  label: 'Employment contract',
  default_visibility: 'adults',
  expiry_driver: 'end_date',
  fields: [],
  core: core(),
};
const DEED: LevelKind = {
  key: 'property_deed',
  label: 'Property deed',
  default_visibility: 'adults',
  expiry_driver: 'end_date',
  fields: [],
  core: core(),
};
const BILL: LevelKind = {
  key: 'utility_bill',
  label: 'Utility bill',
  default_visibility: 'household',
  expiry_driver: 'due_date',
  fields: [],
  core: core(),
};
const RECORD: LevelKind = {
  key: 'medical_record',
  label: 'Medical record',
  default_visibility: 'adults',
  expiry_driver: null,
  fields: [],
  core: core(),
};
const ctx: ProposalContext = {
  types: [CONTRACT, DEED, BILL],
  people: [{ id: 'm-ahmed', name: 'Ahmed Khan' }],
  dateOrder: 'dmy',
};
const contract = (end: string) =>
  [
    'Corvid Logistics Ltd',
    'Statement of Main Terms of Employment',
    'Employee: Ahmed Khan',
    'Job title: Operations Analyst',
    'Start date: 6 January 2025',
    `This is a fixed-term contract. End date: ${end}.`,
    'Salary: £41,328.65 per annum',
    'Notice period: one month',
  ].join('\n');
const NO_DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: null,
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};
const ahmed = { value: 'm-ahmed', confidence: 0.95, cue: 'name_labelled' as const };
/** A card as the API levels it: the pages' proposal and labels as the worker sealed them. */
const card = (
  proposal: DetailProposal,
  labels: readonly string[],
  kind: string | null,
): LevelInput => ({
  state: 'waiting',
  reading: 'read',
  failure: null,
  proposal: storedProposal(JSON.parse(JSON.stringify({ v: 1, proposal }))),
  expiryLabels: storedExpiryLabels(
    JSON.parse(JSON.stringify({ v: 1, proposal, expiry_labels: labels })),
  ),
  duplicate: null,
  defaults: { ...NO_DEFAULTS, type_key: kind },
  types: [CONTRACT, DEED, BILL, RECORD],
  people: ctx.people,
  role: 'owner',
  me: 'm-ahmed',
});
const words = (l: ReturnType<typeof levelItem>) => l.tags.map((t) => t.words);

describe('an expiry on the page, not on the card (R3)', () => {
  it('names each kind complete without an expiry whose own expiry label is on the page, whatever was read', () => {
    const misread = contract('S Janvary 2027');
    const read = contract('5 January 2027');
    // "End date" is a contract's word for its expiry, and a deed's.
    expect(expiryLabelKinds(misread, ctx)).toEqual(['employment_contract', 'property_deed']);
    // Read or not, it is asked (the re-check): the card's kind may not be the one read for.
    expect(proposeDetails(read, ctx).expires?.value.date).toBe('2027-01-05');
    expect(expiryLabelKinds(read, ctx)).toEqual(['employment_contract', 'property_deed']);
    // "The term ends" is a deed's alone.
    expect(expiryLabelKinds('The term ends on 3l Marhc 2O3O', ctx)).toEqual(['property_deed']);
    // A permanent contract that labels no end date: none.
    const permanent = contract('').replace(/This is a fixed-term contract\. End date: \./, '');
    expect(expiryLabelKinds(permanent, ctx)).toEqual([]);
    // A kind that needs its expiry is never named: it says it is missing itself.
    expect(expiryLabelKinds('Payment due by', ctx)).toEqual([]);
  });

  it('makes a card of such a kind with no expiry Check, never Ready; read back only as it was sealed', () => {
    const p = proposeDetails(contract('S Janvary 2027'), ctx);
    expect(p.type_key?.value).toBe('employment_contract');
    expect(p.expires).toBeUndefined();
    expect(levelItem(card(p, [], null)).level).toBe('ready');
    const l = levelItem(card(p, ['employment_contract', 'property_deed'], null));
    expect(l.level).toBe('check');
    expect(words(l)).toContain('Expiry on the page, not read');
    // Its expiry read: nothing to say.
    const q = proposeDetails(contract('5 January 2027'), ctx);
    expect(q.expires?.value.date).toBe('2027-01-05');
    const r = levelItem(card(q, ['employment_contract', 'property_deed'], null));
    expect(r.proposals?.expires?.value.date).toBe('2027-01-05');
    expect(words(r).filter((w) => w.startsWith('Expiry on the page'))).toEqual([]);
    expect(storedExpiryLabels({ v: 1, expiry_labels: ['property_deed'] })).toEqual([
      'property_deed',
    ]);
    expect(storedExpiryLabels({ v: 1, expiry_labels: 'property_deed' })).toEqual([]);
    expect(storedExpiryLabels({ v: 1, expiry_labels: [7, '', 'x'.repeat(65), 'will'] })).toEqual([
      'will',
    ]);
    expect(
      storedExpiryLabels({ v: 1, expiry_labels: Array.from({ length: 99 }, () => 'will') }),
    ).toHaveLength(MAX_EXPIRY_LABEL_KINDS);
    expect(storedExpiryLabels({ v: 2, expiry_labels: ['will'] })).toEqual([]);
    expect(storedExpiryLabels(null)).toEqual([]);
  });

  it('a page proposing a contract unsurely, in a batch of deeds, whose "term ends" date was misread: Check (the re-check, a)', () => {
    const text = 'The term ends on 3l Marhc 2O3O';
    const pages: DetailProposal = {
      type_key: { value: 'employment_contract', confidence: 0.78, cue: 'kind_words' },
      owner_member_id: ahmed,
    };
    const l = levelItem(card(pages, expiryLabelKinds(text, ctx), 'property_deed'));
    expect(l.proposals?.type_key?.value).toBe('property_deed');
    expect(l.level).toBe('check');
    expect(words(l)).toContain('Expiry on the page, not read');
  });

  it('an expiry the pages read for the kind they proposed, not offered for the card’s: Check (the re-check, b)', () => {
    const pages: DetailProposal = {
      type_key: { value: 'employment_contract', confidence: 0.9, cue: 'kind_words' },
      owner_member_id: ahmed,
      expires: {
        value: { date: '2027-01-05', precision: 'day' },
        confidence: 0.9,
        cue: 'expiry_label',
      },
    };
    // The batch says a deed: the contract's end date is not offered for it.
    const l = levelItem(card(pages, [], 'property_deed'));
    expect(l.proposals?.type_key?.value).toBe('property_deed');
    expect(l.proposals?.expires).toBeUndefined();
    expect(l.level).toBe('check');
    expect(words(l)).toContain('Expiry on the page, read for another kind');
    // As a contract it is offered: Ready.
    const asContract = levelItem(card(pages, [], 'employment_contract'));
    expect(asContract.proposals?.expires?.value).toEqual({ date: '2027-01-05', precision: 'day' });
    expect(asContract.level).toBe('ready');
  });

  it('is said by the kind the card has now: changed to one whose expiry the page labels, told; to another, not (the re-check)', () => {
    const text = 'The term ends on 3l Marhc 2O3O';
    const pages: DetailProposal = { owner_member_id: ahmed };
    const labels = expiryLabelKinds(text, ctx);
    // The kind changed to a deed: its own label is on the page.
    const deed = levelItem(card(pages, labels, 'property_deed'));
    expect(deed.level).toBe('check');
    expect(words(deed)).toContain('Expiry on the page, not read');
    // To a contract, whose words for its expiry are not on the page: Ready.
    const asContract = levelItem(card(pages, labels, 'employment_contract'));
    expect(words(asContract)).not.toContain('Expiry on the page, not read');
    expect(asContract.level).toBe('ready');
    // A medical record keeps no expiry: not told.
    const record = levelItem(card(pages, labels, 'medical_record'));
    expect(words(record)).not.toContain('Expiry on the page, not read');
    expect(record.level).toBe('ready');
  });
});

describe('a date read only once OCR’s confusions were put right is never Ready on its own (the R3 review)', () => {
  const letter = (date: string) =>
    [
      'Corvid Logistics Ltd',
      'Statement of Main Terms of Employment',
      'Employee: Ahmed Khan',
      'Job title: Operations Analyst',
      `Start date: ${date}`,
      'Salary: £41,328.65 per annum',
      'Notice period: one month',
    ].join('\n');
  const level = (proposal: ReturnType<typeof proposeDetails>) =>
    levelItem({
      state: 'waiting',
      reading: 'read',
      failure: null,
      // As the worker seals it, and the API opens it.
      proposal: storedProposal(JSON.parse(JSON.stringify({ v: 1, proposal }))),
      duplicate: null,
      defaults: NO_DEFAULTS,
      types: [CONTRACT, BILL],
      people: ctx.people,
      role: 'owner',
      me: 'm-ahmed',
    });

  it('an issue date put right is Check, said so; the same date read as written is Ready', () => {
    const fixed = proposeDetails(letter('6 January 2O25'), ctx);
    expect(fixed.issued).toMatchObject({ value: { date: '2025-01-06' }, corrected: true });
    const l = level(fixed);
    expect(l.level).toBe('check');
    expect(l.tags.map((t) => t.code)).toContain('date_corrected');
    expect(l.proposals?.issued).toMatchObject({ corrected: true });
    const read = proposeDetails(letter('6 January 2025'), ctx);
    expect(read.issued?.corrected).toBeUndefined();
    expect(level(read).level).toBe('ready');
  });
});
