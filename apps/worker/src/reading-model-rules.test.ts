import {
  applyReadingModel,
  FOLDER_AGREE_FLOOR,
  ITEM_SURE,
  kindVetoed,
  levelItem,
  proposeOnThread,
  proposeWithTie,
  READING_MODEL_ALONE_CONFIDENCE,
  READING_MODEL_DOUBT_CONFIDENCE,
  storedProposal,
  type DetailProposal,
  type FolderSuggestion,
  type KindChance,
  type LearnedContext,
  type ProposalContext,
} from '@fdv/shared';
import { FIXTURE_KINDS, FIXTURE_PEOPLE } from '@fdv/shared/testdata';
import { describe, expect, it } from 'vitest';
import { loadReadingModel } from './reading-model.js';

/**
 * What the reading model may say (0.9.0, R2): one more cue, never the
 * decider. Alone it never makes a card Ready; disagreeing, the card is
 * Check; it never proposes a hidden kind, a household's own, "Something
 * else" or a note; and the household's switch turns it off on the thread.
 */

const model = (() => {
  const got = loadReadingModel().model;
  if (!got) throw new Error('the reading model is not here');
  return got;
})();

const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({
  types: FIXTURE_KINDS,
  people: FIXTURE_PEOPLE,
  household: 'The Khan family',
  dateOrder: 'dmy',
  ...over,
});
const lines = (...l: string[]) => l.join('\n');
/** Chances a test chooses: this kind this sure, `none` the rest — every class the model has there. */
const sure = (kind: string, p = 0.97): KindChance[] => [
  { kind, p },
  ...model.classes.filter((c) => c !== kind).map((c) => ({ kind: c, p: c === 'none' ? 1 - p : 0 })),
];
/** The rules' reading of a page, and the model's say over it, from chances a test chooses. */
const withChances = (text: string, chances: KindChance[], c: ProposalContext = ctx()) => {
  const rules = proposeWithTie(text, c);
  return applyReadingModel({ text, ctx: c, proposal: rules.proposal, rules, chances });
};
/** The card as the batch shows it: no defaults, the household's kinds, a folder or none. */
const level = (proposal: DetailProposal, folder: FolderSuggestion | null = null) =>
  levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal,
    duplicate: null,
    folder,
    defaults: {
      type_key: null,
      owner_member_id: null,
      visibility: 'household',
      physical_location: null,
      collection_id: null,
      tags: [],
      is_essential: false,
    },
    types: FIXTURE_KINDS.map((k) => ({ ...k, default_visibility: 'household' as const })),
    people: FIXTURE_PEOPLE,
    role: 'owner',
    me: 'm-sara',
  });

/** A page the rules find no kind on: a vet's bill, in words the rules do not know. */
const VET_BILL = lines(
  'Larkfield Animal Clinic',
  'Mabel has been seen today',
  'Annual booster given today',
  'Booster due: 14/03/2027',
  'Owner: Sara Khan',
  'Consultation £68.00',
);

/** A page the rules read as a passport, surely. */
const PASSPORT = lines(
  'PASSPORT',
  'Surname: KHAN',
  'Given names: SARA',
  'Nationality: BRITISH CITIZEN',
  'Place of birth: LEEDS',
  'Date of issue: 02 JUN 2021',
  'Date of expiry: 02 JUN 2031',
);

describe('alone, the reading model never makes a card Ready', () => {
  it('a kind the rules found none for is suggested, unsure, and the card is Check', () => {
    expect(proposeWithTie(VET_BILL, ctx()).proposal.type_key).toBeUndefined();
    const got = proposeOnThread(VET_BILL, ctx(), null, model).proposal;
    expect(got.type_key).toMatchObject({
      value: 'pet_record',
      confidence: READING_MODEL_ALONE_CONFIDENCE,
      model: 'alone',
    });
    // Its dates read for that kind.
    expect(got.expires?.value.date).toBe('2027-03-14');
    const card = level(got);
    expect(card.level).toBe('check');
    expect(card.proposals?.type_key).toMatchObject({ value: 'pet_record', model: true });
    expect(card.tags.map((t) => t.words)).toContain('Kind suggested by the vault’s reading model');
  });

  it('however sure it is, and with the folder agreeing, it stays under the bar', () => {
    expect(READING_MODEL_ALONE_CONFIDENCE).toBeLessThan(ITEM_SURE.type_key);
    expect(READING_MODEL_ALONE_CONFIDENCE).toBeLessThan(FOLDER_AGREE_FLOOR);
    const got = withChances(VET_BILL, sure('pet_record', 0.999999));
    expect(got.type_key?.confidence).toBe(READING_MODEL_ALONE_CONFIDENCE);
    const card = level(got, {
      path: 'Papers',
      type_key: 'pet_record',
      owner_member_id: null,
      tags: [],
    });
    expect(card.proposals?.type_key?.confidence).toBeLessThan(ITEM_SURE.type_key);
    expect(card.level).toBe('check');
  });

  it('never stands over the folder: the folder’s kind is shown, and both are said', () => {
    const got = withChances(VET_BILL, sure('pet_record'));
    const card = level(got, {
      path: 'Papers',
      type_key: 'insurance_policy',
      owner_member_id: null,
      tags: [],
    });
    expect(card.proposals?.type_key).toMatchObject({ value: 'insurance_policy', from: 'folder' });
    expect(card.level).toBe('check');
    expect(card.tags.map((t) => t.words).join('|')).toMatch(
      /The folder says Insurance[^;|]*; the vault’s reading model suggests a pet record/,
    );
  });

  it('says nothing under its bar, nor for a kind the rules rule out', () => {
    expect(withChances(VET_BILL, sure('pet_record', 0.6)).type_key).toBeUndefined();
    // A contract is no payslip, whatever the model reads (KIND_VETOES).
    const contract = lines('Our Co Ltd', 'Statement of main terms', 'Net pay  2,619.00');
    expect(proposeWithTie(contract, ctx()).proposal.type_key).toBeUndefined();
    expect(withChances(contract, sure('pay_statement')).type_key).toBeUndefined();
  });
});

describe('it never proposes a kind the household does not offer it', () => {
  it('not a hidden kind, a household’s own, "Something else" or a note', () => {
    const hidden = ctx({
      types: FIXTURE_KINDS.map((k) => (k.key === 'pet_record' ? { ...k, hidden: true } : k)),
    });
    expect(withChances(VET_BILL, sure('pet_record'), hidden).type_key).toBeUndefined();
    const own = ctx({
      types: FIXTURE_KINDS.map((k) => (k.key === 'pet_record' ? { ...k, builtin: false } : k)),
    });
    expect(withChances(VET_BILL, sure('pet_record'), own).type_key).toBeUndefined();
    const withNote = ctx({
      types: [
        ...FIXTURE_KINDS,
        { key: 'note', label: 'Note', fields: [], expiry_driver: null, builtin: true },
      ],
    });
    for (const kind of ['other', 'note', 'none']) {
      expect(withChances(VET_BILL, sure(kind), withNote).type_key, kind).toBeUndefined();
    }
    // A kind the household does not keep at all.
    const without = ctx({ types: FIXTURE_KINDS.filter((k) => k.key !== 'pet_record') });
    expect(withChances(VET_BILL, sure('pet_record'), without).type_key).toBeUndefined();
  });

  it('nor a kind the document already has', () => {
    const c = ctx({ current: { type_key: 'warranty' } });
    expect(withChances(VET_BILL, sure('pet_record'), c).type_key).toBeUndefined();
  });

  it('where the rules tie, only one of the kinds they tie between', () => {
    const page = lines('Passport', 'Visa', 'Valid until 01/02/2030', 'Nationality: Indian');
    const rules = proposeWithTie(page, ctx());
    expect(rules.tie.length).toBeGreaterThan(1);
    const [a] = rules.tie;
    expect(withChances(page, sure(a as string)).type_key).toMatchObject({
      value: a,
      model: 'alone',
    });
    expect(withChances(page, sure('pet_record')).type_key).toBeUndefined();
  });
});

describe('agreeing and disagreeing with the rules', () => {
  it('where the model disagrees strongly, the rules’ kind stands but the card is Check', () => {
    const rules = proposeWithTie(PASSPORT, ctx()).proposal;
    expect(rules.type_key?.value).toBe('passport');
    expect(level(rules).level).toBe('ready');
    const got = withChances(PASSPORT, sure('utility_bill'));
    expect(got.type_key).toMatchObject({
      value: 'passport',
      confidence: READING_MODEL_DOUBT_CONFIDENCE,
      model: 'doubts',
      model_kind: 'utility_bill',
    });
    const card = level(got);
    expect(card.level).toBe('check');
    expect(card.proposals?.type_key?.value).toBe('passport');
    expect(card.tags.map((t) => t.words)).toContain(
      'Kind unsure: the vault’s reading model reads it as a bill',
    );
    // As sure of no kind at all: the same.
    const none = level(withChances(PASSPORT, sure('none')));
    expect(none.level).toBe('check');
    expect(none.tags.map((t) => t.words)).toContain(
      'Kind unsure: the vault’s reading model reads it as none of its kinds',
    );
    // And a folder that agrees with the rules does not make it sure again.
    const folder = level(got, {
      path: 'Papers',
      type_key: 'passport',
      owner_member_id: null,
      tags: [],
    });
    expect(folder.level).toBe('check');
  });

  it('a passport’s machine-readable lines are not doubted', () => {
    const mrz = lines(
      'P<GBRKHAN<<SARA<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
      '9876543210GBR8601014F3106023<<<<<<<<<<<<<<04',
    );
    const rules = proposeWithTie(mrz, ctx()).proposal;
    if (rules.type_key?.cue === 'machine_lines') {
      expect(withChances(mrz, sure('utility_bill')).type_key?.model).toBeUndefined();
    }
  });

  it('agreeing, it never makes the rules’ own unsure kind sure (the R2 review: two papers in one file)', () => {
    // A page the rules read as a passport, but not surely: another kind's
    // cues close behind — as a second paper in the same file gives them.
    const page = lines('Passport', 'Visa', 'Nationality: Indian');
    const rules = proposeWithTie(page, ctx()).proposal;
    expect(rules.type_key?.value).toBe('passport');
    expect(rules.type_key?.confidence).toBeLessThan(ITEM_SURE.type_key);
    const got = withChances(page, sure('passport', 0.9999));
    expect(got.type_key).toEqual(rules.type_key);
    expect(level(got).level).not.toBe('ready');
  });

  it('doubts a kind it reads the page as, even one the rules rule out for it (the R2 review)', () => {
    // A contract: the rules rule out a payslip for it, and read it as a contract.
    const contract = lines(
      'Statement of main terms of employment',
      'Employee: Sara Khan',
      'Job title: Analyst',
      'Start date: 01/04/2026',
      'Notice period: one month',
      'Holiday entitlement: 25 days',
    );
    const rules = proposeWithTie(contract, ctx()).proposal;
    expect(rules.type_key?.value).toBe('employment_contract');
    const got = withChances(contract, sure('pay_statement', 0.97));
    expect(got.type_key).toMatchObject({
      value: 'employment_contract',
      model: 'doubts',
      model_kind: 'pay_statement',
    });
    expect(level(got).level).toBe('check');
  });

  it('a household’s own kind is neither doubted nor suggested by the model, which does not know it (the R2 review)', () => {
    const gym = {
      key: 'gym_membership',
      label: 'Gym membership',
      fields: [
        { key: 'member_no', label: 'Membership number', kind: 'text', required: false },
        { key: 'club', label: 'Club', kind: 'text', required: false },
      ],
      expiry_driver: null,
      builtin: false,
    } as unknown as ProposalContext['types'][number];
    const c = ctx({ types: [...FIXTURE_KINDS, gym] });
    const page = lines(
      'Larkfield Leisure',
      'Your gym membership',
      'Membership number: 0012345',
      'Club: Larkfield Pool and Gym',
      'Owner: Sara Khan',
    );
    const rules = proposeWithTie(page, c).proposal;
    expect(rules.type_key?.value).toBe('gym_membership');
    // The real model reads it as no kind it knows; its say changes nothing.
    const real = proposeOnThread(page, c, null, model).proposal;
    expect(real.type_key).toEqual(rules.type_key);
    expect(withChances(page, sure('none', 0.999), c).type_key).toEqual(rules.type_key);
  });

  it('never replaces an issuer the uploader’s rules or a sender’s layout gave, and holds its own to the kind (the R2 review)', () => {
    // A passport's page the rules cannot name; the model suggests a passport,
    // and a passport's issuer is its country, read again for the kind.
    const page = lines(
      'United Kingdom of Great Britain and Northern Ireland',
      'Surname: KHAN',
      'Given names: SARA',
      'Date of expiry: 02 JUN 2031',
    );
    expect(proposeWithTie(page, ctx()).proposal.type_key).toBeUndefined();
    const plain = proposeWithTie(page, ctx({ current: { type_key: 'passport' } })).proposal
      .issued_by;
    expect(plain).toBeDefined();
    // With none of its own: the country, held to the kind's confidence.
    const own = applyReadingModel({
      text: page,
      ctx: ctx(),
      proposal: {},
      rules: { tie: [] },
      chances: sure('passport'),
    });
    expect(own.type_key?.model).toBe('alone');
    expect(own.issued_by?.value).toBe(plain?.value);
    expect(own.issued_by?.confidence).toBeLessThan(plain?.confidence as number);
    // One the uploader's layout gave stands.
    const learnedIssuer: DetailProposal = {
      issued_by: { value: 'HM Passport Office', confidence: 0.9, cue: 'learned', shape: true },
    };
    const kept = applyReadingModel({
      text: page,
      ctx: ctx(),
      proposal: learnedIssuer,
      rules: { tie: [] },
      chances: sure('passport'),
    });
    expect(kept.type_key?.model).toBe('alone');
    expect(kept.issued_by).toEqual(learnedIssuer.issued_by);
  });

  it('against the uploader’s own rules (I4), only another kind makes it Check; it is never replaced', () => {
    const learned: DetailProposal = {
      type_key: { value: 'warranty', confidence: 0.9, cue: 'learned' },
    };
    const rules = { tie: [] };
    const run = (chances: KindChance[]) =>
      applyReadingModel({ text: VET_BILL, ctx: ctx(), proposal: learned, rules, chances });
    expect(run(sure('pet_record')).type_key).toMatchObject({
      value: 'warranty',
      model: 'doubts',
      model_kind: 'pet_record',
    });
    expect(run(sure('none')).type_key).toEqual(learned.type_key);
    expect(run(sure('warranty')).type_key).toEqual(learned.type_key);
  });
});

describe('a payslip that names a P60 (the R2 review)', () => {
  it('is never Ready as a tax form, nor sure as a payslip: Check at most, with the model or without', () => {
    const payslip = lines(
      'Northwind Logistics Ltd',
      'Payslip',
      'Employee: Sara Khan        Pay date: 28/02/2026',
      'Tax code: 1257L            NI number: QQ 12 34 56 C',
      'Basic pay                  2,950.00',
      'Tax deducted                 380.00',
      'National Insurance           160.00',
      'Net pay                    2,410.00',
      'Keep your P60 safe: you will need it to show what you earned this tax year.',
    );
    for (const m of [null, model]) {
      const got = proposeOnThread(payslip, ctx(), null, m).proposal;
      expect(got.type_key?.value).not.toBe('tax_form');
      expect(got.type_key?.confidence ?? 0).toBeLessThan(ITEM_SURE.type_key);
      expect(level(got).level).not.toBe('ready');
    }
    // A payslip with few of its own words, and a P60's: never Ready as a tax form.
    const thin = lines(
      'Northwind Logistics Ltd',
      'Tax code: 1257L',
      'Tax deducted  380.00',
      'Net pay  2,410.00',
      'Your P60 for the year will follow in May.',
    );
    for (const m of [null, model]) {
      const got = proposeOnThread(thin, ctx(), null, m).proposal;
      expect(got.type_key?.confidence ?? 0).toBeLessThan(ITEM_SURE.type_key);
      expect(level(got).level).not.toBe('ready');
    }
    // A P60 itself is still read as one, surely.
    const p60 = lines(
      'P60 End of Year Certificate',
      'Tax year to 5 April 2026',
      'Employee: Sara Khan',
      'Pay in this employment  £38,120.00',
      'Tax deducted  £5,120.00',
      'Final tax code 1257L',
      "Employer's PAYE reference 123/AB45678",
    );
    const read = proposeWithTie(p60, ctx()).proposal.type_key;
    expect(read?.value).toBe('tax_form');
    expect(read?.confidence).toBeGreaterThanOrEqual(ITEM_SURE.type_key);
  });

  it('nor one that names a form by its title (the R2 re-check): Check at most, with the model or without', () => {
    const w2 = lines(
      'Northwind Logistics Inc.',
      'Earnings for the period ending 02/28/2026',
      'Employee: Sara Khan',
      'Gross Pay $4,200.00',
      'Federal income tax withheld $512.40',
      'Net Pay $3,358.70',
      'Your Form W-2 for 2025 will be available in January.',
    );
    const p60 = lines(
      'Northwind Logistics Ltd',
      'Employee: Sara Khan',
      'Tax deducted £410.00',
      'Net pay £2,840.00',
      'Your P60 End of Year Certificate will be issued in April.',
    );
    for (const page of [w2, p60]) {
      for (const m of [null, model]) {
        const got = proposeOnThread(page, ctx(), null, m).proposal;
        // The form it names does not rule the payslip out.
        expect(kindVetoed('pay_statement', page), page.slice(0, 30)).toBe(false);
        expect(got.type_key?.confidence ?? 0, page.slice(0, 30)).toBeLessThan(ITEM_SURE.type_key);
        expect(level(got).level, page.slice(0, 30)).not.toBe('ready');
      }
    }
    // A certificate's title on a page with a payslip's pay for its period:
    // may be either, so the tax form is not sure either, by its title or not.
    const both = lines(
      'P60 End of Year Certificate',
      'Tax year to 5 April 2026',
      'Employee: Sara Khan',
      'Pay in this employment  £38,120.00',
      'Tax deducted  £5,120.00',
      'Net pay £2,840.00',
      'Final tax code 1257L',
      "Employer's PAYE reference 123/AB45678",
    );
    for (const m of [null, model]) {
      const got = proposeOnThread(both, ctx(), null, m).proposal;
      expect(got.type_key?.confidence ?? 0).toBeLessThan(ITEM_SURE.type_key);
      expect(level(got).level).not.toBe('ready');
    }
  });

  it('a real P60 and a real W-2 are still Ready, with the model or without', () => {
    const p60 = lines(
      'P60 End of Year Certificate',
      'Tax year to 5 April 2026',
      'Employee: Sara Khan',
      'Pay in this employment  £38,120.00',
      'Tax deducted  £5,120.00',
      'Final tax code 1257L',
      "Employer's PAYE reference 123/AB45678",
    );
    const w2 = lines(
      'Form W-2 Wage and Tax Statement 2025',
      "Employee's name: Sara Khan",
      'Wages, tips, other compensation  64,000.00',
      'Federal income tax withheld  7,100.00',
      'Employer identification number (EIN) 12-3456789',
    );
    for (const page of [p60, w2]) {
      for (const m of [null, model]) {
        const got = proposeOnThread(page, ctx(), null, m).proposal;
        expect(got.type_key?.value, page.slice(0, 20)).toBe('tax_form');
        expect(level(got).level, page.slice(0, 20)).toBe('ready');
      }
    }
  });
});

describe('the household’s switch, on the thread', () => {
  it('off, the rules read alone; with no model, the same', () => {
    const on = proposeOnThread(VET_BILL, ctx(), null, model).proposal;
    expect(on.type_key?.model).toBe('alone');
    const off = proposeOnThread(VET_BILL, ctx({ readingModel: false }), null, model).proposal;
    expect(off).toEqual(proposeOnThread(VET_BILL, ctx(), null, null).proposal);
    expect(off.type_key).toBeUndefined();
    // With the uploader's rules and layouts too.
    const learned: LearnedContext = { rules: [], role: 'owner' } as unknown as LearnedContext;
    expect(proposeOnThread(VET_BILL, ctx(), learned, model).proposal.type_key?.model).toBe('alone');
    expect(
      proposeOnThread(VET_BILL, ctx({ readingModel: false }), learned, model).proposal.type_key,
    ).toBeUndefined();
  });
});

describe('what is sealed keeps what the model said, and nothing else', () => {
  it('model and model_kind survive the seal; anything else of them is dropped', () => {
    const got = storedProposal({
      v: 1,
      proposal: {
        type_key: {
          value: 'passport',
          confidence: 0.84,
          cue: 'kind_words',
          model: 'doubts',
          model_kind: 'utility_bill',
        },
      },
    });
    expect(got.type_key).toMatchObject({ model: 'doubts', model_kind: 'utility_bill' });
    const junk = storedProposal({
      v: 1,
      proposal: {
        type_key: {
          value: 'passport',
          confidence: 0.84,
          cue: 'kind_words',
          model: 'surely',
          model_kind: '<script>',
        },
      },
    });
    expect(junk.type_key).not.toHaveProperty('model');
    expect(junk.type_key).not.toHaveProperty('model_kind');
  });
});
