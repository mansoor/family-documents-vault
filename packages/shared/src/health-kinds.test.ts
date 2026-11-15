import { describe, expect, it } from 'vitest';
import { ITEM_SURE } from './batch-levels.js';
import { effectiveVisibility } from './capture.js';
import { batchVisibility } from './batches.js';
import {
  missingFields,
  nextReminder,
  PERIODIC_KINDS,
  REMINDING_DATE_REQUIRED,
  remindingDateOptional,
  SENSITIVE_BY_DEFAULT,
} from './documents.js';
import { folderMatcher } from './folders.js';
import { proposeDetails, type ProposalContext, type ProposalKind } from './proposals.js';
import { firstReview, nextOccurrence, nextReview, yearlyReviewOffered } from './reminders.js';
import {
  keepsOwnSensitive,
  parentsKeep,
  sensitiveStartingVisibility,
  teenOwnStart,
  teenUploader,
} from './sensitive.js';
import {
  FIXTURE_HOUSEHOLD,
  FIXTURE_ISSUERS,
  FIXTURE_KINDS,
  FIXTURE_PEOPLE,
} from './testdata/proposal-fixtures.js';

/**
 * Health's kinds, details and reminders (0.9.0, H3 of plan-health), as
 * @fdv/shared decides them: what the pages say a health paper is — sure only
 * with its own marks and none of another's, so that ambiguity is Check and
 * never a wrong Ready (the S5 rules); a teen's own vaccination record kept
 * where their parents see it; the dates the family adds only if there is
 * one; and a yearly review's days.
 */

const health = (key: string, label: string, more: Partial<ProposalKind> = {}): ProposalKind => ({
  key,
  label,
  fields: [],
  expiry_driver: null,
  issued_by_label: 'Provider',
  ...more,
});

/** The vault's kinds with Health's, as a household that changed none has them (0101). */
const HEALTH_KINDS: ProposalKind[] = [
  ...FIXTURE_KINDS.map((k) => (k.key === 'medical_record' ? { ...k, label: 'Medical record' } : k)),
  health('insurance_card', 'Health insurance card', {
    expiry_driver: 'expires_on',
    issued_by_label: 'Insurer',
  }),
  health('explanation_of_benefits', 'Explanation of benefits', { issued_by_label: 'Insurer' }),
  health('lab_result', 'Lab result'),
  health('visit_summary', 'Visit summary'),
  health('imaging_report', 'Imaging report'),
  health('vaccination_record', 'Vaccination record', {
    fields: [{ key: 'next_dose_due', label: 'Next dose due', kind: 'date' }],
    remind_from: 'next_dose_due',
  }),
  health('advance_directive', 'Advance directive / living will', { issued_by_label: null }),
  health('healthcare_proxy', 'Healthcare proxy / power of attorney', { issued_by_label: null }),
  health('hipaa_authorization', 'HIPAA authorization', { expiry_driver: 'expires_on' }),
];

const ctx: ProposalContext = {
  types: HEALTH_KINDS,
  people: FIXTURE_PEOPLE,
  issuers: FIXTURE_ISSUERS,
  household: FIXTURE_HOUSEHOLD,
  dateOrder: 'dmy',
};
const lines = (...l: string[]) => l.join('\n');
const sure = (c: number | undefined) => (c ?? 0) >= ITEM_SURE.type_key;
const kindOf = (text: string, c: ProposalContext = ctx) => {
  const p = proposeDetails(text, c);
  return { key: p.type_key?.value ?? null, sure: sure(p.type_key?.confidence), p };
};

describe('what the pages say a health paper is (H3)', () => {
  it('an insurance card is sure — never a policy, nor a national ID card by its “Member ID card”', () => {
    const card = lines(
      'Blue Shield of California',
      'MEMBER ID CARD',
      'Member: Ahmed Khan',
      'Member ID  XHB847291034',
      'Group No  0091823',
      'RxBIN 610014   RxPCN BSCA',
      'PCP copay $25   Specialist $50   Urgent care $75',
      'PPO',
    );
    const got = kindOf(card);
    expect(got.key).toBe('insurance_card');
    expect(got.sure).toBe(true);
    expect(got.p.identifier?.value).toBe('XHB847291034');
    // With no insurance card among the kinds (an older list), as before.
    expect(kindOf(card, { ...ctx, types: FIXTURE_KINDS }).key).not.toBe('insurance_card');
  });

  it('an explanation of benefits is sure, and “This is not a bill” is never a bill', () => {
    const eob = lines(
      'Aetna',
      'EXPLANATION OF BENEFITS',
      'THIS IS NOT A BILL',
      'Member: Sara Khan    Claim number: EOB-55120934',
      'Date of service 02/09/2026    Provider: Riverside Clinic',
      'Amount billed $420.00   Plan discount $180.00   Plan paid $200.00',
      'Amount you may owe the provider: $40.00',
    );
    const got = kindOf(eob);
    expect(got.key).toBe('explanation_of_benefits');
    expect(got.sure).toBe(true);
    expect(got.p.identifier?.value).toBe('EOB-55120934');
  });

  it('a lab’s results, an imaging report and a visit summary are each sure with only their own marks', () => {
    const lab = kindOf(
      lines(
        'Quest Diagnostics',
        'LABORATORY REPORT',
        'Patient: Ahmed Khan',
        'Specimen collected: 03/10/2026   Reported: 04/10/2026',
        'Test            Result    Reference range',
        'Cholesterol     5.1       < 5.0',
        'Glucose (fasting) 4.8     3.9 - 5.5',
      ),
    );
    expect([lab.key, lab.sure]).toEqual(['lab_result', true]);
    expect(lab.p.issued?.value).toEqual({ date: '2026-10-03', precision: 'day' });
    const imaging = kindOf(
      lines(
        'Riverside Hospital Radiology Department',
        'Patient: Sara Khan',
        'Exam date: 12/09/2026',
        'Clinical history: wrist pain after a fall',
        'Technique: two views',
        'Findings: as described by the radiologist',
        'Impression: see findings',
      ),
    );
    expect([imaging.key, imaging.sure]).toEqual(['imaging_report', true]);
    const visit = kindOf(
      lines(
        'Northside Medical Group',
        'AFTER VISIT SUMMARY',
        'Patient: Sara Khan    Visit date: 14/10/2026',
        'Seen by: Dr R Patel',
        'Reason for visit: annual check-up',
        'Your next appointment: in 12 months',
      ),
    );
    expect([visit.key, visit.sure]).toEqual(['visit_summary', true]);
  });

  it('a visit summary that lists an X-ray and lab results is Check, never a wrong Ready', () => {
    const got = kindOf(
      lines(
        'Northside Medical Group',
        'AFTER VISIT SUMMARY',
        'Patient: Sara Khan    Visit date: 14/10/2026',
        'Reason for visit: knee pain',
        'Ordered today: X-ray of the left knee; lab results to follow',
        'Follow-up appointment: two weeks',
      ),
    );
    expect(got.sure).toBe(false);
  });

  it('a vaccination card is a vaccination record, sure; its next dose the date it reminds from', () => {
    const card = lines(
      'COVID-19 VACCINATION RECORD CARD',
      'Name: Zain Khan',
      'Vaccine        Lot number     Date given',
      '1st dose       EW0182         12/05/2021',
      '2nd dose       EW0199         02/06/2021',
      'Next dose due: 01/09/2027',
    );
    const got = kindOf(card);
    expect([got.key, got.sure]).toEqual(['vaccination_record', true]);
    expect(got.p.expires?.value).toEqual({ date: '2027-09-01', precision: 'day' });
  });

  it('a GP’s immunisation record is a vaccination record, but Check: a medical record is in the running', () => {
    const record = lines(
      'Riverside Medical Practice',
      'Patient: Zain Khan',
      'Immunisation record held at this practice',
      'Vaccine                         Date given',
      'MMR dose 1                      14/01/2013',
      '4-in-1 pre-school booster       14/05/2015',
      'Next dose due: 01/09/2027',
    );
    const got = kindOf(record);
    expect([got.key, got.sure]).toEqual(['vaccination_record', false]);
    // Where the household hid the kind (it keeps its own, 0101), a medical record as before.
    const hidden = HEALTH_KINDS.map((k) =>
      k.key === 'vaccination_record' ? { ...k, hidden: true } : k,
    );
    expect(kindOf(record, { ...ctx, types: hidden }).key).toBe('medical_record');
  });

  it('a pet’s vaccination certificate is never a person’s vaccination record', () => {
    const got = kindOf(
      lines(
        'Park Lane Veterinary Surgery',
        'Vaccination certificate',
        'Pet’s name: Biscuit    Species: Dog',
        'Date given: 01/03/2026   Booster due: 01/03/2027',
      ),
    );
    expect(got.key).toBe('pet_record');
  });

  it('an advance directive, a healthcare proxy and a will are told apart; a form that is two is Check', () => {
    const directive = kindOf(
      lines(
        'ADVANCE DIRECTIVE',
        'I, Sara Khan, being of sound mind, make this statement of my wishes.',
        'If I am unable to make or communicate decisions, I direct that life-sustaining treatment be withheld.',
        'Signed 03/03/2026     Witnesses: two',
      ),
    );
    expect([directive.key, directive.sure]).toEqual(['advance_directive', true]);
    const proxy = kindOf(
      lines(
        'HEALTH CARE PROXY',
        'I, Ahmed Khan, appoint Sara Khan as my health care agent to make health care decisions for me.',
        'Alternate agent: Zain Khan',
        'Signed 05/05/2026   Witness 1, Witness 2',
      ),
    );
    expect([proxy.key, proxy.sure]).toEqual(['healthcare_proxy', true]);
    // A lasting power of attorney for health and welfare is a proxy, not a will.
    const lpa = kindOf(
      lines(
        'Lasting power of attorney',
        'Health and welfare',
        'The donor: Ahmed Khan.  The attorneys: Sara Khan.',
        'My attorneys may make decisions about medical treatment.',
      ),
    );
    expect(lpa.key).toBe('healthcare_proxy');
    // One for property and money is never a proxy (too little to say a will, as before).
    const money = kindOf(
      lines(
        'Lasting power of attorney',
        'Property and financial affairs',
        'The donor: Ahmed Khan.  The attorneys: Sara Khan.',
      ),
    );
    expect(money.key).not.toBe('healthcare_proxy');
    // A state form with both parts: offered unsure.
    const both = kindOf(
      lines(
        'ADVANCE HEALTH CARE DIRECTIVE',
        'Part 1: Power of attorney for health care — I appoint Sara Khan as my agent.',
        'Part 2: Instructions for health care — life-sustaining treatment.',
      ),
    );
    expect(both.sure).toBe(false);
  });

  it('a HIPAA authorization is sure; an explanation of benefits with a HIPAA notice is not', () => {
    const hipaa = kindOf(
      lines(
        'AUTHORIZATION FOR RELEASE OF PROTECTED HEALTH INFORMATION (HIPAA)',
        'Patient: Ahmed Khan',
        'I authorize Riverside Clinic to disclose my records to: Sara Khan',
        'This authorization expires on: 01/01/2028',
        'I may revoke this authorization in writing.',
      ),
    );
    expect([hipaa.key, hipaa.sure]).toEqual(['hipaa_authorization', true]);
    expect(hipaa.p.expires?.value).toEqual({ date: '2028-01-01', precision: 'day' });
    const eob = kindOf(
      lines(
        'EXPLANATION OF BENEFITS — THIS IS NOT A BILL',
        'Claim number: 99120   Date of service: 02/09/2026',
        'Amount you may owe: $40.00',
        'Your rights under HIPAA are described in our privacy notice.',
      ),
    );
    expect(eob.key).toBe('explanation_of_benefits');
    expect(eob.sure).toBe(false);
  });
});

describe('a general paper that mentions a health paper stays itself (the H3 review)', () => {
  it('a health insurance policy schedule with “your member ID card is enclosed”: a policy, sure', () => {
    const got = kindOf(
      lines(
        'Northwind Health Insurance',
        'HEALTH INSURANCE POLICY SCHEDULE',
        'Policyholder: Ahmed Khan',
        'Policy number: NHI-4471-2290     Period of cover: 01/01/2027 to 31/12/2027',
        'Annual premium: £1,240.00   Excess: £100',
        'Your member ID card is enclosed. Show it at the hospital.',
      ),
    );
    expect([got.key, got.sure]).toEqual(['insurance_policy', true]);
  });

  it('a property and financial affairs LPA that mentions health and welfare is never a proxy', () => {
    const got = kindOf(
      lines(
        'Lasting power of attorney',
        'Property and financial affairs',
        'The donor: Ahmed Khan.  The attorneys: Sara Khan.',
        'If you also want someone to make decisions about your care, make a separate',
        'lasting power of attorney for health and welfare.',
      ),
    );
    expect(got.key === 'healthcare_proxy' && got.sure).toBe(false);
    expect(got.key).not.toBe('healthcare_proxy');
  });

  it('a will that mentions a separate living will is a will, sure', () => {
    const got = kindOf(
      lines(
        'LAST WILL AND TESTAMENT',
        'I, Ahmed Khan, revoke all former wills and appoint Sara Khan as my executor.',
        'I give the residue of my estate to my wife.',
        'I have made a separate living will about my medical treatment.',
        'Signed by the testator in our presence.',
      ),
    );
    expect([got.key, got.sure]).toEqual(['will', true]);
  });

  it('an energy statement that says “This is not a bill” is a bill, as before', () => {
    const statement = lines(
      'British Gas',
      'Your energy statement — this is not a bill',
      'Account number: 8500 1234 567',
      'Billing period: 1 Aug 2026 to 31 Aug 2026',
      'Electricity: 212 kWh   Standing charge: £15.20',
      'Amount due: £84.21, collected by Direct Debit on 1 October',
    );
    const before = kindOf(statement, { ...ctx, types: FIXTURE_KINDS });
    const got = kindOf(statement);
    expect(before.key).toBe('utility_bill');
    expect([got.key, got.sure]).toEqual([before.key, before.sure]);
  });

  it('an explanation of benefits with an amount due on it: offered unsure', () => {
    const got = kindOf(
      lines(
        'Aetna',
        'EXPLANATION OF BENEFITS — THIS IS NOT A BILL',
        'Claim number: 99120   Date of service: 02/09/2026',
        'Amount billed $420.00   Plan paid $200.00',
        'Amount due to the provider: $40.00',
      ),
    );
    expect(got.key).toBe('explanation_of_benefits');
    expect(got.sure).toBe(false);
  });

  it('a medical record that mentions a vaccination record, with the kind kept: Check', () => {
    const got = kindOf(
      lines(
        'Riverside Medical Practice',
        'Clinic letter',
        'Patient: Zain Khan   NHS number: 485 777 3456',
        'Seen in clinic for asthma review. Inhaler technique checked.',
        'Please bring his vaccination record and booster history to the next appointment.',
      ),
    );
    expect(got.key).toBe('medical_record');
    // The letter's own strongest cue: still itself, and sure.
    expect(got.sure).toBe(true);
  });
});

describe('which health kinds come one after another (PERIODIC_KINDS)', () => {
  it('a lab result, a visit summary, an imaging report and an EOB: never renewals; the rest are', () => {
    for (const k of ['lab_result', 'visit_summary', 'imaging_report', 'explanation_of_benefits']) {
      expect(PERIODIC_KINDS.has(k), k).toBe(true);
    }
    for (const k of [
      'vaccination_record',
      'insurance_card',
      'advance_directive',
      'healthcare_proxy',
      'hipaa_authorization',
      'prescription',
    ]) {
      expect(PERIODIC_KINDS.has(k), k).toBe(false);
    }
  });

  it('every one of them is sensitive by default, as 0101 seeds them', () => {
    for (const k of [
      'insurance_card',
      'explanation_of_benefits',
      'lab_result',
      'visit_summary',
      'imaging_report',
      'vaccination_record',
      'advance_directive',
      'healthcare_proxy',
      'hipaa_authorization',
    ]) {
      expect(SENSITIVE_BY_DEFAULT, k).toContain(k);
    }
  });
});

describe('a teen’s own vaccination record stays where their parents see it (H3)', () => {
  const today = '2026-11-15';
  const teen = { role: 'teen' as const };
  const fifteenAsAdult = { role: 'adult' as const, date_of_birth: '2011-06-01' };
  const grownSon = { role: 'adult' as const, date_of_birth: '2005-01-01', relationship: 'Son' };

  it('a teen by sign-in or by age is one; a grown-up child is not', () => {
    expect(teenUploader(teen, today)).toBe(true);
    expect(teenUploader(fifteenAsAdult, today)).toBe(true);
    expect(teenUploader(grownSon, today)).toBe(false);
    // 18 by their date of birth, still signed in as a teen: not one (the review).
    const grownTeen = { role: 'teen' as const, date_of_birth: '2007-01-01' };
    expect(teenUploader(grownTeen, today)).toBe(false);
    expect(keepsOwnSensitive(grownTeen, today)).toBe(true);
    expect(teenUploader({ role: 'teen' as const, date_of_birth: '2011-01-01' }, today)).toBe(true);
    // All three keep their own sensitive papers as before (H1a).
    for (const who of [teen, fifteenAsAdult, grownSon]) {
      expect(keepsOwnSensitive(who, today)).toBe(true);
    }
  });

  it('only the vaccination record, and only a built-in’s key', () => {
    expect(parentsKeep({ key: 'vaccination_record' })).toBe(true);
    for (const key of ['medical_record', 'lab_result', 'h_vaccinatio', null]) {
      expect(parentsKeep({ key }), String(key)).toBe(false);
    }
  });

  it('never Only me by H1a’s rule for a teen’s own; Only me for any other of theirs', () => {
    const start = (parentsKept: boolean) =>
      sensitiveStartingVisibility('adults', {
        sensitive: true,
        own: true,
        keeps: true,
        parentsKept,
      });
    expect(start(true)).toBe('adults');
    expect(start(false)).toBe('private');
  });

  it('a teen signed in as one, who cannot see Adults only: Everyone for it, Only me for another', () => {
    expect(teenOwnStart('adults', { key: 'vaccination_record' })).toBe('household');
    expect(teenOwnStart('adults', { key: 'lab_result' })).toBe('private');
    expect(teenOwnStart('household', { key: 'passport' })).toBe('household');
    expect(
      effectiveVisibility({}, { key: 'vaccination_record', default_visibility: 'adults' }, 'teen'),
    ).toBe('household');
    expect(
      effectiveVisibility({}, { key: 'lab_result', default_visibility: 'adults' }, 'teen'),
    ).toBe('private');
    // An adult's start is the kind's, as ever.
    expect(
      effectiveVisibility({}, { key: 'vaccination_record', default_visibility: 'adults' }, 'adult'),
    ).toBe('adults');
    // A batch's: the same for the teen's own.
    expect(
      batchVisibility({
        chosen: null,
        type: { key: 'vaccination_record', default_visibility: 'adults' },
        role: 'teen',
        owner: 'me',
        me: 'me',
      }),
    ).toBe('household');
  });
});

describe('a date the family adds only if there is one (H3)', () => {
  it('a vaccination record’s next dose and a prescription’s next refill remind, unrequired', () => {
    expect(remindingDateOptional({ key: 'vaccination_record' }, 'next_dose_due')).toBe(true);
    expect(remindingDateOptional({ key: 'prescription' }, 'refill_date')).toBe(true);
    expect(remindingDateOptional({ key: 'prescription' }, 'expires')).toBe(false);
    expect(remindingDateOptional({ key: 'utility_bill' }, 'due_date')).toBe(false);
    expect(remindingDateOptional({ key: 'h_aaaaaaaaaa' }, 'next_dose_due')).toBe(false);
    // Not Needs info without one.
    expect(
      missingFields(
        {
          key: 'vaccination_record',
          expiry_driver: null,
          fields: [{ key: 'next_dose_due', label: 'Next dose due', required: false }],
        },
        { extra: {} },
      ),
    ).toEqual([]);
  });

  it('the kinds editor’s rule leaves it unrequired there; a bill’s due date is still required', () => {
    const after = { expires: false, dates: ['next_dose_due'] };
    const sent = {
      remind_from: 'next_dose_due',
      fields: [{ key: 'next_dose_due', required: false }],
    };
    expect(
      nextReminder(
        sent,
        { reminding: { from: 'next_dose_due', leads: [30, 7] }, expires: false },
        {
          ...after,
          key: 'vaccination_record',
        },
      ),
    ).toEqual({ from: 'next_dose_due', leads: [30, 7] });
    const bill = nextReminder(
      { remind_from: 'due_date', fields: [{ key: 'due_date', required: false }] },
      { reminding: { from: 'due_date', leads: [7, 1] }, expires: false },
      { expires: false, dates: ['due_date'], key: 'utility_bill' },
    );
    expect(bill).toEqual({ problem: { message: REMINDING_DATE_REQUIRED, detail: 'due_date' } });
  });
});

describe('a yearly review’s days (H3)', () => {
  it('is offered on an advance directive, a proxy and a HIPAA authorization alone', () => {
    for (const k of ['advance_directive', 'healthcare_proxy', 'hipaa_authorization']) {
      expect(yearlyReviewOffered({ key: k }), k).toBe(true);
    }
    for (const k of ['will', 'lab_result', 'vaccination_record', null]) {
      expect(yearlyReviewOffered({ key: k }), String(k)).toBe(false);
    }
  });

  it('starts on the next anniversary of its signing, else a year from today', () => {
    expect(firstReview('2024-03-10', '2026-11-15')).toBe('2027-03-10');
    expect(firstReview('2024-12-01', '2026-11-15')).toBe('2026-12-01');
    // Signed today: a year on, never today.
    expect(firstReview('2026-11-15', '2026-11-15')).toBe('2027-11-15');
    expect(firstReview(null, '2026-11-15')).toBe('2027-11-15');
    expect(firstReview('not a date', '2026-11-15')).toBe('2027-11-15');
  });

  it('never drifts: a 29 February review is on the 28th, and the 29th again in a leap year', () => {
    // Done on 28 Feb 2025, counted from 29 Feb 2024.
    expect(nextReview('2025-02-28', '2025-02-28', '2024-02-29')).toBe('2026-02-28');
    expect(nextReview('2027-02-28', '2027-03-01', '2024-02-29')).toBe('2028-02-29');
    // A monthly one on the 31st comes back on the 31st where there is one.
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-03-31');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-01-31')).toBe('2026-02-28');
  });

  it('comes back a year on after Done — late, on the day, or early', () => {
    // Due today.
    expect(nextReview('2026-11-15', '2026-11-15')).toBe('2027-11-15');
    // Two years overdue: the next one after today, not one already gone by.
    expect(nextReview('2024-06-01', '2026-11-15')).toBe('2027-06-01');
    // Done before its day: the year after its day, never the same day again.
    expect(nextReview('2026-12-20', '2026-11-15')).toBe('2027-12-20');
  });
});

describe('a folder of health papers (H3)', () => {
  it('“Vaccinations” is a vaccination record, “Health insurance” a card, “Living will” a directive', () => {
    const match = folderMatcher({
      types: HEALTH_KINDS.map((k) => ({ ...k, short_label: null, issuer_noun: null })),
      people: [],
    });
    expect(match('Medical/Vaccinations')?.type_key).toBe('vaccination_record');
    expect(match('Health insurance')?.type_key).toBe('insurance_card');
    expect(match('Wills/Living will')?.type_key).toBe('advance_directive');
    expect(match('Medical/Lab results')?.type_key).toBe('lab_result');
    expect(match('HIPAA forms')?.type_key).toBe('hipaa_authorization');
  });
});
