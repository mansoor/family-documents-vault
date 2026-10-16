import { describe, expect, it } from 'vitest';
import { ITEM_SURE } from './batch-levels.js';
import { PERSON_CHECK_CONFIDENCE, proposeDetails, type ProposalContext } from './proposals.js';
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

/**
 * The owner's decisions for 0.8.0 (S5, 16 Oct 2026): two kinds of their own,
 * joint papers and initials, and everyday cues — each offered unsure where
 * the page leaves room, never a wrong Ready.
 */
describe('the owner’s decisions for the Smart exit (S5)', () => {
  const card = (...extra: string[]) =>
    lines(
      'Lantern Card',
      'Your credit card statement',
      'Mrs Sara Khan',
      'Statement date 18 March 2026',
      'Card number ending 4417',
      'Previous balance £412.20',
      'New balance £203.18',
      'Minimum payment £25.00',
      'Payment due 12 April 2026',
      'Credit limit £4,500.00',
      ...extra,
    );

  it('a card’s statement is a kind of its own, due when its payment is, sure with its own marks alone', () => {
    const p = proposeDetails(card('Card expiry date 30 September 2029'), ctx);
    expect(p.type_key?.value).toBe('credit_card_statement');
    expect(p.type_key?.confidence).toBeGreaterThanOrEqual(ITEM_SURE.type_key);
    // Due when the payment is, never when the card runs out.
    expect(p.expires?.value.date).toBe('2026-04-12');
    expect(p.issued?.value.date).toBe('2026-03-18');
  });

  it('a card’s statement is never a bill: a bill has no credit limit', () => {
    const p = proposeDetails(
      lines(
        'Northern Glow Energy',
        'Your electricity account',
        'Billing period 1 to 31 August 2026',
        'Account number 8820 4417',
        'Amount due £84.21',
        'Payment due 1 October 2026',
        'Minimum payment £84.21',
        'Credit limit £500.00',
      ),
      ctx,
    );
    expect(p.type_key?.value).not.toBe('utility_bill');
  });

  it('a statement with a card’s marks and a bank’s, or neither, is offered unsure', () => {
    const both = proposeDetails(card('Sort code 30-91-57   Account number 41228706'), ctx);
    expect(both.type_key?.value).toBe('credit_card_statement');
    expect(both.type_key?.confidence).toBeLessThan(ITEM_SURE.type_key);
    const bank = lines(
      'Harbourline Bank',
      'Current Account Statement',
      'Mr Ahmed Khan',
      'Statement date 30 April 2026',
      'Account number 41228706   Sort code 30-91-57',
      'Opening balance £1,204.33   Closing balance £1,509.15',
      'Money in £2,915.00   Money out £2,610.18',
    );
    const sure = proposeDetails(bank, ctx);
    expect(sure.type_key?.value).toBe('bank_statement');
    expect(sure.type_key?.confidence).toBeGreaterThanOrEqual(ITEM_SURE.type_key);
    // A bank's statement with a card's minimum payment on it: unsure.
    const mixed = proposeDetails(`${bank}\nMinimum payment £25.00 due 3 May 2026`, ctx);
    expect(mixed.type_key?.confidence ?? 0).toBeLessThan(ITEM_SURE.type_key);
    // Neither's marks: "Your statement" alone is a bank's, unsure.
    const neither = proposeDetails(
      lines('Your statement', 'Money in £20.00', 'Money out £14.00'),
      ctx,
    );
    expect(neither.type_key?.value).toBe('bank_statement');
    expect(neither.type_key?.confidence).toBeLessThan(ITEM_SURE.type_key);
  });

  it('a school’s report on a pupil is a school report, not a diploma; a certificate is still a diploma', () => {
    const p = proposeDetails(
      lines(
        'Larchwood Primary School',
        'End of Year Report 2025/26',
        'Pupil: Zain Khan   Year 4',
        'Attendance: 97%',
        'English   Working at the expected standard',
        'Class teacher: Mrs J Ellery',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('school_report');
    expect(p.owner_member_id).toMatchObject({ value: 'm-zain', cue: 'name_labelled' });
    expect(p.expires).toBeUndefined();
    const gcse = proposeDetails(
      lines(
        'NORTHERN EXAMINATIONS BOARD',
        'General Certificate of Secondary Education',
        'This is to certify that ZAIN KHAN has been awarded the following grades',
      ),
      ctx,
    );
    expect(gcse.type_key?.value).toBe('diploma');
  });

  it('an initial and the family’s surname mean the one of the family they can only mean, unsurely', () => {
    const unsure = { confidence: PERSON_CHECK_CONFIDENCE, cue: 'name_on_page' };
    for (const text of [
      'Pet insurance\nPolicyholder   Mrs S Khan\nPolicy number PB12345678',
      'Dental recall\nMr A. Khan\n14 Elm Street',
      'Statement\nZ. Khan\n14 Elm Street',
    ]) {
      expect(proposeDetails(text, ctx).owner_member_id, text).toMatchObject(unsure);
    }
    expect(proposeDetails('Policyholder   Mrs S Khan', ctx).owner_member_id?.value).toBe('m-sara');
    // An initial with neither a title nor a full stop is not one.
    expect(proposeDetails('Statement\nS Khan\nAccount 1234', ctx).owner_member_id).toBeUndefined();
    // Two of the family it could mean: nobody.
    const twoS: ProposalContext = {
      ...ctx,
      people: [...FIXTURE_PEOPLE, { id: 'm-sam', name: 'Sam' }],
    };
    expect(proposeDetails('Policyholder   Mrs S Khan', twoS).owner_member_id).toBeUndefined();
    // Somebody else's surname, or a line about somebody else: nobody.
    expect(proposeDetails('Policyholder   Mrs S Patel', ctx).owner_member_id).toBeUndefined();
    expect(proposeDetails('Consultant: Mr A Khan', ctx).owner_member_id).toBeUndefined();
    // Never Ready on an initial alone.
    expect(PERSON_CHECK_CONFIDENCE).toBeLessThan(ITEM_SURE.owner_member_id);
  });

  it('two of the family named together: the first named, unsurely, initials too', () => {
    const p = proposeDetails('Mortgage statement\nMr A Khan & Mrs S Khan\n14 Elm Street', ctx);
    expect(p.owner_member_id).toEqual({
      value: 'm-ahmed',
      confidence: PERSON_CHECK_CONFIDENCE,
      cue: 'name_on_page',
    });
  });

  it('everyday papers: an ISA, a dental recall, hire purchase, a National Insurance letter', () => {
    const kind = (...l: string[]) => proposeDetails(lines(...l), ctx).type_key?.value;
    expect(
      kind(
        'Kestrel Savings',
        'Junior ISA: annual statement',
        'Account no. 7740 1182',
        'Interest paid £12.20 at 3.10% AER',
      ),
    ).toBe('bank_statement');
    expect(
      kind(
        'Riverside Dental Care',
        'Your check-up is due',
        'Our records show a dental check-up is now due.',
      ),
    ).toBe('medical_record');
    expect(
      kind(
        'Quayside Motor Finance',
        'Hire Purchase Agreement regulated by the Consumer Credit Act 1974',
        'APR 8.9%',
      ),
    ).toBe('loan');
    expect(kind('Quayside Motor Finance', 'Amount of credit £9,500.00', 'APR 8.9%')).toBe('loan');
    expect(
      kind(
        'HM Revenue & Customs',
        'Your National Insurance number',
        'Your National Insurance number is QQ 98 76 54 B.',
      ),
    ).toBe('national_id');
  });

  it('a National Insurance letter is issued by HMRC, and HM Revenue & Customs spelled out is the tax office', () => {
    const ni = proposeDetails(
      lines(
        'HM Revenue & Customs',
        'Zain Khan',
        'Your National Insurance number',
        'Your National Insurance number is QQ 98 76 54 B. Keep this letter safe.',
      ),
      ctx,
    );
    expect(ni.type_key?.value).toBe('national_id');
    expect(ni.issued_by).toMatchObject({ value: 'HMRC', cue: 'issuing_body' });
    const receipt = proposeDetails(
      lines(
        'HM Revenue & Customs',
        'Your Self Assessment tax return has been received',
        'Name: Sara Khan',
      ),
      ctx,
    );
    expect(receipt.type_key?.value).toBe('tax_return');
  });

  it('a licence summary from the Driver and Vehicle Licensing Agency is a driving licence', () => {
    const p = proposeDetails(
      lines(
        'View your driving licence information',
        'Driver and Vehicle Licensing Agency',
        'Name                         Mrs Sara Khan',
        'Licence valid to             9 May 2031',
        'Category B   Cars',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('drivers_licence');
    expect(p.expires?.value.date).toBe('2031-05-09');
  });

  it('a travel insurance summary is insurance, and its lead traveller whose it is', () => {
    const p = proposeDetails(
      lines(
        'Harbourside Mutual',
        'Annual Multi-Trip Travel Insurance',
        'Lead traveller: Sara Khan',
        'Other travellers: Ahmed Khan, Zain Khan',
        'Policy reference: HMT-562546',
        'Your cover runs from 5 July 2026 until 4 July 2027.',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('insurance_policy');
    expect(p.owner_member_id?.value).toBe('m-sara');
    expect(p.expires?.value.date).toBe('2027-07-04');
  });

  it('a registered contact is not the account holder', () => {
    const p = proposeDetails(
      lines(
        'Kestrel Savings',
        'Junior ISA: annual statement',
        'Account holder: Zain Khan',
        'Registered contact: Mrs Sara Khan',
        'Rate 3.10% AER',
      ),
      ctx,
    );
    expect(p.owner_member_id?.value).toBe('m-zain');
  });
});
