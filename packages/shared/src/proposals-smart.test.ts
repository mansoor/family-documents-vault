import { describe, expect, it } from 'vitest';
import { proposeDetails, type ProposalContext } from './proposals.js';
import {
  FIXTURE_HOUSEHOLD,
  FIXTURE_ISSUERS,
  FIXTURE_KINDS,
  FIXTURE_PEOPLE,
} from './testdata/proposal-fixtures.js';

/**
 * What the Smart exit's measurement (0.8.0, S5) taught the rules, each on
 * wording of its own (the corpus's tuning set's kind of paper, never its
 * held-out one): a name OCR left a hyphen on, a sentence above a name that
 * is not its label, a bill paid by Direct Debit, a GP's letter, a register
 * of title and a GCSE certificate.
 */

const ctx: ProposalContext = {
  types: FIXTURE_KINDS,
  people: FIXTURE_PEOPLE,
  issuers: FIXTURE_ISSUERS,
  household: FIXTURE_HOUSEHOLD,
  dateOrder: 'dmy',
};
const lines = (...l: string[]) => l.join('\n');

describe('reading what the Smart exit found (S5)', () => {
  it('a name with a hyphen OCR left after it is still the whole name', () => {
    const p = proposeDetails(
      lines('Logbook', 'Mr Ahmed Khan-', '14 Elm Street', 'Ashby Vale'),
      ctx,
    );
    expect(p.owner_member_id).toMatchObject({ value: 'm-ahmed', confidence: 0.9 });
  });

  it('a sentence about the policyholder above a name is not its label; a label alone on its line is', () => {
    const certificate = lines(
      'Certificate of Motor Insurance',
      '2. Name of policyholder: Mrs Sara Khan',
      '5. Persons or classes of persons entitled to drive:',
      '  The policyholder.',
      '  Ahmed Khan.',
    );
    // Sara, labelled, over Ahmed, a driver: not two names as sure as each other.
    expect(proposeDetails(certificate, ctx).owner_member_id?.value).toBe('m-sara');
    // The registered keeper over a name alone on its line says it is theirs.
    const keeper = proposeDetails(lines('Registered keeper', 'Ahmed Khan', 'The house'), ctx);
    expect(keeper.owner_member_id).toMatchObject({ value: 'm-ahmed', cue: 'name_labelled' });
  });

  it('a bill paid by Direct Debit is due on the day it is collected', () => {
    const p = proposeDetails(
      lines(
        'Your electricity bill',
        'Account number 8820 4417 3391    Bill date 14 September 2026',
        'Mrs Sara Khan',
        'Total charges £84.21',
        "We'll collect £84.21 by Direct Debit on or just after 1 October 2026.",
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('utility_bill');
    expect(p.expires).toMatchObject({ value: { date: '2026-10-01' }, cue: 'due_label' });
  });

  it('a label above a row of more dates than labels claims none of them: never the wrong one', () => {
    // "Valid from" misread, "Valid until" read: which date is its is not said.
    const misread = proposeDetails(
      lines(
        'RESIDENCE PERMIT   UNITED KINGDOM',
        'Name: SARA KHAN',
        'Vaiid from Valid until',
        '30.11.2019 30.11.2029',
        'Type of permit: INDEFINITE LEAVE',
      ),
      ctx,
    );
    expect(misread.type_key?.value).toBe('visa');
    expect(misread.expires).toBeUndefined();
    // Both read: each date is its label's, as before.
    const read = proposeDetails(
      lines(
        'RESIDENCE PERMIT   UNITED KINGDOM',
        'Name: SARA KHAN',
        'Valid from Valid until',
        '30.11.2019 30.11.2029',
        'Type of permit: INDEFINITE LEAVE',
      ),
      ctx,
    );
    expect(read.expires?.value.date).toBe('2029-11-30');
    expect(read.issued?.value.date).toBe('2019-11-30');
  });

  it('a GP’s letter about a patient is a medical record', () => {
    const p = proposeDetails(
      lines(
        'NORTHGATE MEDICAL PRACTICE',
        'Date: 3 March 2026',
        'Mrs Sara Khan',
        'NHS number: 999 204 7731',
        'Dear Mrs Khan,',
        'Re: Your recent blood test',
        'Your results are within the normal range.',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('medical_record');
  });

  it('an official copy of a register of title is a deed', () => {
    const p = proposeDetails(
      lines(
        'HM Land Registry',
        'Official copy of register of title',
        'Title number AV412237',
        'B: Proprietorship Register',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('property_deed');
  });

  it('a General Certificate of Secondary Education is a diploma', () => {
    const p = proposeDetails(
      lines(
        'NORTHERN EXAMINATIONS BOARD',
        'General Certificate of Secondary Education',
        'This is to certify that AHMED KHAN has been awarded the following grades',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('diploma');
  });
});
