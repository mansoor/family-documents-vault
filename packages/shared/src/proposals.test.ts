import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_CUES,
  PROPOSAL_FIELDS,
  PROPOSAL_THRESHOLDS,
  proposeDetails,
  type CurrentDetails,
  type DetailProposal,
  type ProposalContext,
  type ProposalKind,
} from './proposals.js';
import {
  FIXTURE_FIELDS,
  proposeFor,
  proposedValue,
  score,
  type FieldScore,
  type FixtureField,
} from './testdata/proposal-accuracy.js';
import {
  FIXTURE_HOUSEHOLD,
  FIXTURE_ISSUERS,
  FIXTURE_KINDS,
  FIXTURE_PEOPLE,
  HELD_OUT,
  TUNED,
  type ProposalFixture,
} from './testdata/proposal-fixtures.js';

const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({
  types: FIXTURE_KINDS,
  people: FIXTURE_PEOPLE,
  issuers: FIXTURE_ISSUERS,
  household: FIXTURE_HOUSEHOLD,
  dateOrder: 'dmy',
  ...over,
});
const lines = (...l: string[]) => l.join('\n');
const fixture = (name: string): ProposalFixture => {
  const f = [...TUNED, ...HELD_OUT].find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};
const ALL = [...TUNED, ...HELD_OUT];
const NOT_OURS = ALL.filter((f) => f.truth.type_key === null);

/** Every proposal in it, as [field, confidence, cue]. */
const each = (p: DetailProposal) =>
  PROPOSAL_FIELDS.flatMap((f) => {
    const x = p[f];
    return x ? [[f, x.confidence, x.cue] as const] : [];
  });

describe('proposeDetails: no cue, no answer', () => {
  it('a page that says nothing of what it is, or whose, gets nothing', () => {
    expect(proposeDetails('', ctx())).toEqual({});
    expect(proposeDetails('   \n\n  ', ctx())).toEqual({});
    // Dates, numbers and the family's names, none of them labelled as anything.
    const prose = lines(
      'We met Sara and Ahmed for lunch on 14 March 2031 and talked about the garden.',
      'Zain brought 4471 2290 conkers. Granny Ruth said the weather would turn by 2 April 2031.',
    );
    expect(proposeDetails(prose, ctx())).toEqual({});
  });

  it('a document that is none of the kinds gets no kind, no date and no number', () => {
    expect(NOT_OURS.length).toBeGreaterThanOrEqual(2);
    for (const f of NOT_OURS) {
      const p = proposeFor(f, 'dmy');
      expect(p.type_key, f.name).toBeUndefined();
      expect(p.issued, f.name).toBeUndefined();
      expect(p.expires, f.name).toBeUndefined();
      expect(p.identifier, f.name).toBeUndefined();
    }
  });

  it('a kind is proposed only at the spike’s bar: a score of 5, and 2 ahead of the next', () => {
    // "Passport" alone scores 3: a letter that mentions one is not one.
    const letter = lines(
      'Dear Mr Khan,',
      'Please bring your passport and a utility bill to your appointment.',
    );
    expect(proposeDetails(letter, ctx()).type_key).toBeUndefined();
    // 4, and nothing else near it: still short of the bar, however clear the lead.
    const four = lines('PASSPORT', 'Surname KHAN');
    expect(proposeDetails(four, ctx()).type_key).toBeUndefined();
    // With its nationality and place of birth, it is: 7.
    const page = lines('PASSPORT', 'Nationality', 'BRITISH CITIZEN', 'Place of birth', 'LEEDS');
    expect(proposeDetails(page, ctx()).type_key).toMatchObject({
      value: 'passport',
      cue: 'kind_words',
    });
  });

  it('every proposal says how sure it is, at or above its bar, and its cue is a reason, never the text', () => {
    let seen = 0;
    for (const f of ALL) {
      for (const [field, confidence, cue] of each(proposeFor(f, 'dmy'))) {
        seen += 1;
        expect(confidence, `${f.name} ${field}`).toBeGreaterThanOrEqual(PROPOSAL_THRESHOLDS[field]);
        expect(confidence, `${f.name} ${field}`).toBeLessThanOrEqual(1);
        expect(PROPOSAL_CUES, `${f.name} ${field}`).toContain(cue);
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  it('a date of birth is never an issue or an expiry date, however near a stronger label', () => {
    const page = lines(
      'PASSPORT',
      'Nationality BRITISH CITIZEN',
      'Place of birth LEEDS',
      'Date of expiry',
      'Date of birth 03 MAR 1985',
    );
    const p = proposeDetails(page, ctx());
    expect(p.type_key?.value).toBe('passport');
    expect(p.expires).toBeUndefined();
    expect(p.issued).toBeUndefined();
  });

  it('a date in numbers whose order cannot be told is read only when something says which', () => {
    const page = (d: string) =>
      lines(
        'PASSPORT',
        'Nationality BRITISH CITIZEN',
        'Place of birth LEEDS',
        `Date of expiry ${d}`,
      );
    // Nothing says: 03/04/2031 is not read.
    expect(
      proposeDetails(page('03/04/2031'), ctx({ dateOrder: undefined })).expires,
    ).toBeUndefined();
    // The household writes the day first.
    expect(proposeDetails(page('03/04/2031'), ctx({ dateOrder: 'dmy' })).expires?.value).toEqual({
      date: '2031-04-03',
      precision: 'day',
    });
    // The document's own dates say so, whatever the household writes.
    const own = `${page('03/04/2031')}\nDate of birth 19/07/1982`;
    expect(proposeDetails(own, ctx({ dateOrder: 'mdy' })).expires?.value.date).toBe('2031-04-03');
  });

  it('the machine-readable lines are believed only with their check digits right', () => {
    const base = fixture('uk-passport-sara').text;
    const p = proposeDetails(base, ctx());
    expect(p.type_key?.cue).toBe('machine_lines');
    expect(p.identifier).toMatchObject({ value: '533401872', cue: 'machine_lines' });
    expect(p.expires).toMatchObject({ value: { date: '2031-03-14' }, cue: 'machine_lines' });
    // One digit of the number misread: neither the number nor the lines are believed.
    const misread = base.replace('5334018725GBR', '5334018795GBR').replace('3103142<', '3103143<');
    const q = proposeDetails(misread, ctx());
    expect(q.type_key?.cue).toBe('kind_words');
    expect(q.identifier?.cue).not.toBe('machine_lines');
    expect(q.expires?.cue).not.toBe('machine_lines');
  });

  it('two of the family named together is a document of theirs together: nobody is proposed', () => {
    const p = proposeFor(fixture('uk-home-schedule-joint'), 'dmy');
    expect(p.type_key?.value).toBe('insurance_policy');
    expect(p.owner_member_id).toBeUndefined();
    // Named alone, as the holder, it is theirs.
    const alone = fixture('uk-home-schedule-joint').text.replace(
      'Mr Ahmed Khan and Mrs Sara Khan',
      'Mrs Sara Khan',
    );
    expect(proposeDetails(alone, ctx()).owner_member_id).toMatchObject({
      value: 'm-sara',
      cue: 'name_labelled',
    });
    // Named together where only the first is labelled: still theirs together.
    const tenancy = proposeFor(fixture('uk-tenancy-joint'), 'dmy');
    expect(tenancy.type_key?.value).toBe('property_deed');
    expect(tenancy.owner_member_id).toBeUndefined();
    expect(
      proposeDetails('Tenant: Sara Khan & Ahmed Khan\nRent: £1,150', ctx()).owner_member_id,
    ).toBeUndefined();
  });

  it('a parent, a witness or a doctor named on the page is not whose it is', () => {
    const p = proposeFor(fixture('uk-birth-certificate-zain'), 'dmy');
    expect(p.owner_member_id?.value).toBe('m-zain');
    // Each named where a page names someone: the child's, not the parent's.
    const letter = lines('Patient name: Zain Khan', "Parent's name: Sara Khan", 'Clinic letter');
    expect(proposeDetails(letter, ctx()).owner_member_id).toMatchObject({ value: 'm-zain' });
  });

  it('a name in the family that is also a word counts only as a name, with its capital', () => {
    const will = proposeDetails(
      lines(
        'LAST WILL AND TESTAMENT',
        'I appoint my executor',
        'Dear will, see the residue of my estate',
      ),
      ctx({ people: [{ id: 'm-will', name: 'Will' }] }),
    );
    expect(will.owner_member_id).toBeUndefined();
  });

  it('a hidden kind is never proposed', () => {
    const hidden = FIXTURE_KINDS.map((k) => (k.key === 'passport' ? { ...k, hidden: true } : k));
    const p = proposeDetails(fixture('us-passport-ahmed').text, ctx({ types: hidden }));
    expect(p.type_key).toBeUndefined();
    // And so nothing is read for it: no dates, no number.
    expect(p.expires).toBeUndefined();
    expect(p.identifier).toBeUndefined();
  });

  it("a kind of the household's own is proposed by its name and two of its fields", () => {
    const gym: ProposalKind = {
      key: 'h_gym',
      label: 'Gym membership',
      fields: [
        { key: 'club', label: 'Club', kind: 'text' },
        { key: 'membership_level', label: 'Membership level', kind: 'text' },
        { key: 'locker', label: 'Locker number', kind: 'text' },
      ],
      expiry_driver: 'expires_on',
      core: {
        identifier: { shown: true, required: false, label: 'Member number' },
        issued_by: { shown: true, required: false, label: null },
        issued: { shown: true, required: false, label: 'Joined' },
        expires: { shown: true, required: false, label: 'Renews' },
        physical_location: { shown: true, required: false, label: null },
        tags: { shown: true, required: false, label: null },
        notes: { shown: true, required: false, label: null },
      },
    };
    const card = lines(
      'Gym membership',
      'Club: Riverside Leisure',
      'Membership level: Gold',
      'Member number: GM-448812',
      'Joined: 4 January 2026',
      'Renews: 3 January 2027',
    );
    const p = proposeDetails(card, ctx({ types: [...FIXTURE_KINDS, gym] }));
    expect(p.type_key?.value).toBe('h_gym');
    // Its own words for its dates and its number are its labels.
    expect(p.issued?.value.date).toBe('2026-01-04');
    expect(p.expires?.value.date).toBe('2027-01-03');
    expect(p.identifier?.value).toBe('GM-448812');
    // Its name alone is not enough.
    expect(proposeDetails('Gym membership', ctx({ types: [...FIXTURE_KINDS, gym] }))).toEqual({});
  });
});

describe('proposeDetails: no date without a confident type', () => {
  it('a page with labelled dates but no kind confidently its own proposes no date and no number', () => {
    // A passport's dates and number, with nothing that says it is a passport.
    const bare = lines(
      'Date of issue 14 MAR 2021',
      'Date of expiry 14 MAR 2031',
      'Document no. 533401872',
    );
    const p = proposeDetails(bare, ctx());
    expect(p).toEqual({});
    // "Passport" alone does not reach the bar either.
    expect(proposeDetails(`PASSPORT\n${bare}`, ctx())).toEqual({});
    // Its kind given — the document already has it — the same page's dates are read.
    const kind = proposeDetails(bare, ctx({ current: { type_key: 'passport' } }));
    expect(kind.issued?.value.date).toBe('2021-03-14');
    expect(kind.expires?.value.date).toBe('2031-03-14');
    expect(kind.identifier?.value).toBe('533401872');
  });

  it('documents that are none of the kinds have dates on them, and none is proposed', () => {
    for (const f of NOT_OURS) {
      expect(f.text, f.name).toMatch(/\d{4}/);
      const p = proposeFor(f, 'dmy');
      expect([p.issued, p.expires], f.name).toEqual([undefined, undefined]);
    }
  });

  it('only the dates its kind keeps: a bank statement has no expiry', () => {
    const p = proposeFor(fixture('uk-bank-statement-ahmed'), 'dmy');
    expect(p.type_key?.value).toBe('bank_statement');
    expect(p.expires).toBeUndefined();
    // A kind that shows no issue date is offered none.
    const noIssue = FIXTURE_KINDS.map((k) =>
      k.key === 'bank_statement'
        ? { ...k, core: { issued: { shown: false, required: false, label: null } } as never }
        : k,
    );
    expect(
      proposeDetails(fixture('uk-bank-statement-ahmed').text, ctx({ types: noIssue })).issued,
    ).toBeUndefined();
  });

  it('a document that would run out before it was issued says neither', () => {
    const page = lines(
      'PASSPORT',
      'Nationality BRITISH CITIZEN',
      'Place of birth LEEDS',
      'Date of issue 14 MAR 2031',
      'Date of expiry 14 MAR 2021',
    );
    const p = proposeDetails(page, ctx());
    expect(p.type_key?.value).toBe('passport');
    expect(p.issued).toBeUndefined();
    expect(p.expires).toBeUndefined();
  });
});

describe('proposeDetails: a filled field is never offered', () => {
  /** The fixture's truth, as the document would hold it. */
  const held = (f: ProposalFixture, only?: FixtureField): CurrentDetails => {
    const t = f.truth;
    const day = (d: string | null) => (d ? { date: d, precision: 'day' as const } : null);
    const all: CurrentDetails = {
      type_key: t.type_key,
      owner_member_id: t.owner,
      issued: day(t.issued),
      expires: day(t.expires),
      identifier: t.identifier,
      issued_by: t.issued_by,
    };
    if (!only) return all;
    const key = only === 'owner' ? 'owner_member_id' : only;
    return { [key]: all[key] };
  };

  it('a field the document has a value for is left out, whatever the page says', () => {
    let checked = 0;
    for (const f of ALL) {
      const open = proposeFor(f, 'dmy');
      for (const field of FIXTURE_FIELDS) {
        if (f.truth[field] === null) continue;
        const key = field === 'owner' ? 'owner_member_id' : field;
        const p = proposeDetails(f.text, ctx({ current: held(f, field) }));
        expect(p[key], `${f.name} ${field}`).toBeUndefined();
        if (open[key]) checked += 1;
      }
    }
    // The pages proposed many of these when the fields were empty.
    expect(checked).toBeGreaterThan(40);
  });

  it('a document with every field filled is offered nothing', () => {
    for (const f of TUNED.filter((x) => x.truth.type_key !== null)) {
      const current = held(f);
      // A field the document has no value for may still be proposed; fill them all.
      const p = proposeDetails(
        f.text,
        ctx({
          current: {
            ...current,
            owner_member_id: current.owner_member_id ?? 'm-someone',
            issued: current.issued ?? { date: '2000-01-01', precision: 'day' },
            expires: current.expires ?? { date: '2099-01-01', precision: 'day' },
            identifier: current.identifier ?? 'X',
            issued_by: current.issued_by ?? 'Somebody',
          },
        }),
      );
      expect(p, f.name).toEqual({});
    }
  });

  it('blank is not a value: a field of spaces is still offered', () => {
    const f = fixture('uk-energy-bill-ahmed');
    const p = proposeDetails(f.text, ctx({ current: { identifier: '   ', issued_by: '' } }));
    expect(p.identifier?.value).toBe('8500 1234 567');
    expect(p.issued_by?.value).toBe('British Gas');
  });
});

/** The review's families (5.37): names that are words, and a surname for everybody. */
const THOMPSONS = ctx({
  people: [
    { id: 'p-sarah', name: 'Sarah Thompson' },
    { id: 'p-david', name: 'David Thompson' },
    { id: 'p-will', name: 'Will Thompson' },
    { id: 'p-may', name: 'May Thompson' },
  ],
  household: 'The Thompsons',
  issuers: [],
});
const CARTERS = ctx({
  people: [
    { id: 'p-bill', name: 'Bill Carter' },
    { id: 'p-jen', name: 'Jennifer Carter' },
    { id: 'p-grace', name: 'Grace Carter' },
  ],
  household: 'Carter Family',
  issuers: [],
  dateOrder: 'mdy',
});

describe('proposeDetails: whose it is, and nobody else (the 5.37 review)', () => {
  it('a first name that is also a word is never matched alone (C537-01)', () => {
    for (const [text, family] of [
      [
        'Columbus Plumbing LLC\nINVOICE\nBill To:\nJ CARTER\n742 Maple Ave\nColumbus OH 43215',
        CARTERS,
      ],
      [
        'AEP Ohio\nJ CARTER\nBill Date Sep 5, 2025\nService Address 742 MAPLE AVE COLUMBUS OH 43215',
        CARTERS,
      ],
      ['Bill Payment Confirmation\n742 Maple Ave\nColumbus OH 43215', CARTERS],
      ['May 2025 Statement\nMrs S Thompson\n12 Elm Road\nLeeds LS6 2AB', THOMPSONS],
      [
        'Brown & Co\nMr D Thompson\n12 Elm Road\nLeeds LS6 2AB\nRe: Will and Lasting Power of Attorney',
        THOMPSONS,
      ],
      ['Home insurance\nName of insured: Mr D Thompson\nWill-writing cover included', THOMPSONS],
      ['Dear Will,\nThanks for the lovely evening.', THOMPSONS],
    ] as const) {
      expect(proposeDetails(text, family).owner_member_id, text).toBeUndefined();
    }
    // With the surname beside it, Will is Will.
    expect(
      proposeDetails('St James’s Hospital\nPatient: Will Thompson\nDischarge summary', THOMPSONS)
        .owner_member_id?.value,
    ).toBe('p-will');
  });

  it('a first name alone could be anybody: a doctor, a solicitor, another passport holder (C537-02)', () => {
    // A grandmother's passport: SARAH, but PATEL, in print and in its lines.
    const patel = fixture('uk-passport-sara')
      .text.replace(
        'P<GBRKHAN<<SARA<AMINA<<<<<<<<<<<<<<<<<<<<<<<',
        'P<GBRPATEL<<SARAH<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
      )
      .replace(/KHAN/g, 'PATEL')
      .replace('SARA AMINA', 'SARAH');
    expect(patel).toContain('P<GBRPATEL<<SARAH<');
    expect(proposeDetails(patel, THOMPSONS).owner_member_id).toBeUndefined();
    for (const text of [
      'Hyde Park Surgery\nRe: Mr D Thompson\nDear Mr Thompson,\nYour results are normal.\nYours sincerely,\nDr Sarah Jones',
      'Clinic letter\nPatient: Mr D Thompson\nConsultant: Dr Will Hughes',
      'Brown & Co Solicitors\nMrs S Thompson\n12 Elm Road\nYour matter is handled by Mr David Brown, partner.',
      'Dear Sarah,\nThank you for your letter.',
    ]) {
      expect(proposeDetails(text, THOMPSONS).owner_member_id, text).toBeUndefined();
    }
    // A passport with the family's surname in its lines is theirs.
    const own = fixture('uk-passport-sara')
      .text.replace(/KHAN/g, 'THOMPSON')
      .replace(/SARA\b/g, 'SARAH');
    expect(proposeDetails(own, THOMPSONS).owner_member_id?.value).toBe('p-sarah');
  });

  it("a family member's name on a transaction line is a payee, not whose it is (C537-03)", () => {
    const uk = lines(
      'Barclays Bank UK PLC',
      'Mr D M Thompson',
      '12 Elm Road',
      'Leeds LS6 2AB',
      'Your statement',
      '8 Aug Transfer to Sarah Thompson Ref: Holiday 200.00 954.80',
    );
    expect(proposeDetails(uk, THOMPSONS).owner_member_id).toBeUndefined();
    const us = lines(
      'Chase',
      'ACCOUNT HOLDER: J CARTER',
      '08/15 Zelle Payment To Grace Carter -50.00',
    );
    expect(proposeDetails(us, CARTERS).owner_member_id).toBeUndefined();
    // Laid out in columns, the payee alone in one: the row still starts with its date.
    const columns = lines(
      'Barclays Bank UK PLC',
      'Mr D M Thompson',
      '08 Aug 2025      SARAH THOMPSON      FASTER PAYMENT      200.00',
    );
    expect(proposeDetails(columns, THOMPSONS).owner_member_id).toBeUndefined();
  });

  it("a first name only takes the household's surname, never another member's (N537P-03)", () => {
    const family = ctx({
      people: [
        { id: 'p-sarah', name: 'Sarah Thompson' },
        { id: 'p-david', name: 'David Thompson' },
        { id: 'p-will', name: 'Will' },
        { id: 'p-amelia', name: 'Amelia' },
        { id: 'p-ruth', name: 'Ruth Miller' },
      ],
      household: 'The Thompsons',
      issuers: [],
    });
    // Granny's late husband's papers, and a cousin's report.
    for (const text of [
      'Pension Wise\nMr Will Miller\n4 Mill Lane\nYork YO1 7AA',
      'Certified copy of an entry of death\nName and surname: Will Miller',
      'Hillside Primary School\nEnd of year report\nStudent name: Amelia Miller',
    ]) {
      expect(proposeDetails(text, family).owner_member_id, text).toBeUndefined();
    }
    // With the household's surname, they are theirs.
    expect(
      proposeDetails('End of year report\nStudent name: Amelia Thompson', family).owner_member_id
        ?.value,
    ).toBe('p-amelia');
    // A household whose name is no surname: the one most of the family share, and only that.
    const ours = ctx({ ...family, household: 'Our family' });
    expect(
      proposeDetails('End of year report\nStudent name: Amelia Thompson', ours).owner_member_id
        ?.value,
    ).toBe('p-amelia');
    expect(proposeDetails('Student name: Amelia Miller', ours).owner_member_id).toBeUndefined();
    // One member's surname is nobody's "most".
    const granny = ctx({
      people: [
        { id: 'p-ruth', name: 'Ruth Miller' },
        { id: 'p-amelia', name: 'Amelia' },
      ],
      household: 'Our family',
      issuers: [],
    });
    expect(proposeDetails('Student name: Amelia Miller', granny).owner_member_id).toBeUndefined();
  });

  it("a comma ends a name: the next one's surname is not hers (the second check's probe)", () => {
    for (const text of [
      'Class list\nNames: Sarah Ahmed, Lucy Thompson, Jo Hill',
      'Sports day results\nRelay team: Sarah Ahmed, Lucy Thompson, Jo Hill',
    ]) {
      expect(proposeDetails(text, THOMPSONS).owner_member_id, text).toBeUndefined();
    }
    // Her own name, written either way round, is still hers.
    for (const text of ['Names: Sarah Thompson, Jo Hill', 'Name: THOMPSON, SARAH']) {
      expect(proposeDetails(text, THOMPSONS).owner_member_id?.value, text).toBe('p-sarah');
    }
  });

  it('a limit gives fewer answers, never another one (N537P-04)', () => {
    const wording = Array.from(
      { length: 41 },
      (_, i) => `${i + 1}. We will pay for loss or damage, and you will tell us of any change.`,
    );
    const schedule = 'Policy schedule\nPolicyholders: Mr Will Thompson and Mrs Sarah Thompson';
    // 82 "will"s in the wording are not 82 Wills: the two of them, so nobody…
    expect(proposeDetails(lines(...wording, schedule), THOMPSONS).owner_member_id).toBeUndefined();
    // …and Will alone, after them, is still found.
    const his = 'Policy schedule\nPolicyholder: Mr Will Thompson\nNamed driver: Mrs Sarah Thompson';
    expect(proposeDetails(lines(...wording, his), THOMPSONS).owner_member_id?.value).toBe('p-will');
    // 41 Wills that are words, with their capital: Will is not looked for to
    // the end, so nobody is proposed — never Sarah alone.
    const asked = Array.from({ length: 41 }, (_, i) => `${i + 1}. Will you tell us of any change?`);
    expect(proposeDetails(lines(...asked, schedule), THOMPSONS).owner_member_id).toBeUndefined();
    // Nor where the family is too many to look for each.
    const many = ctx({
      people: [
        { id: 'p-sarah', name: 'Sarah Thompson' },
        ...Array.from({ length: 50 }, (_, i) => ({ id: `p-${i}`, name: `Cousin${i} Thompson` })),
      ],
      household: 'The Thompsons',
      issuers: [],
    });
    const hers = 'Hyde Park Surgery\nPatient: Mrs Sarah Thompson';
    expect(proposeDetails(hers, THOMPSONS).owner_member_id?.value).toBe('p-sarah');
    expect(proposeDetails(hers, many).owner_member_id).toBeUndefined();
  });

  it("what is right of a name is another column: a letter's reference beside its address (N537P-08)", () => {
    const pad = (left: string, right: string) => `${left.padEnd(52)}${right}`;
    for (const right of [
      'Our ref: DT/4471',
      'Amount due £84.20',
      'GP: Dr A Patel',
      'Card ending 4471',
    ]) {
      const letter = lines(
        'Brown & Co Solicitors',
        '',
        pad('Mrs Sarah Thompson', right),
        pad('12 Elm Road', 'Date: 22 July 2025'),
        'Leeds LS6 2AB',
      );
      const got = proposeDetails(letter, THOMPSONS).owner_member_id;
      expect(got?.value, right).toBe('p-sarah');
      expect(got?.confidence, right).toBe(0.9);
    }
    // What is left of it is its label: a father's name is not whose it is.
    const birth = lines(
      'Birth certificate',
      pad('Name and surname of child', 'Will Thompson'),
      pad("Father's name", 'David Thompson'),
    );
    expect(proposeDetails(birth, THOMPSONS).owner_member_id?.value).toBe('p-will');
  });
});

describe('proposeDetails: the review round (5.37)', () => {
  it('a pet’s vaccination certificate is a pet record, never a person’s medical record (C537-04)', () => {
    for (const text of [
      'RABIES VACCINATION CERTIFICATE\nClintonville Animal Hospital\nAnimal: Cat\nVeterinarian: Dr L Moreno',
      'Vaccination certificate\nPark Lane Veterinary Surgery\nPet’s name: Biscuit\nSpecies: Dog',
      'Banfield Pet Hospital\nVaccination history\nPet: Mittens (Cat)\nMicrochip 826098765432109',
    ]) {
      expect(proposeDetails(text, ctx()).type_key?.value, text).toBe('pet_record');
      // With no pet kind, nothing: never the person's kind.
      const noPets = FIXTURE_KINDS.filter((k) => k.key !== 'pet_record');
      expect(proposeDetails(text, ctx({ types: noPets })).type_key, text).toBeUndefined();
    }
  });

  it('"issued" in a sentence is not a label: the letter’s "Date:" is its issue date (C537-05)', () => {
    const letter = lines(
      'Hyde Park Surgery',
      'Date: 22/07/2025',
      'We have issued a new prescription for her inhaler.',
      'Next review due 22/07/2026.',
    );
    const p = proposeDetails(letter, ctx({ current: { type_key: 'medical_record' } }));
    expect(p.issued?.value.date).toBe('2025-07-22');
    const bill = lines(
      'British Gas',
      'Bill date: 3 May 2025',
      'We have issued a refund of £20.00, which will reach your account by 14 June 2025.',
    );
    expect(
      proposeDetails(bill, ctx({ current: { type_key: 'utility_bill' } })).issued?.value.date,
    ).toBe('2025-05-03');
  });

  it('"issued" wrapped to the end of a line, or before a number, is still in a sentence (N537P-02)', () => {
    const asIs = (text: string, kind: string) =>
      proposeDetails(text, ctx({ current: { type_key: kind } })).issued?.value.date;
    // Wrapped as pdftotext -layout wraps a letter: "issued" ends the line.
    const bill = lines(
      'Octopus Energy',
      'Bill date: 3 May 2025',
      'Account number: A-1B2C3D4E',
      'We have issued',
      'a refund of £20.00, which will reach your account by 14 June 2025.',
    );
    expect(asIs(bill, 'utility_bill')).toBe('2025-05-03');
    const surgery = lines(
      'Hyde Park Surgery',
      '22 July 2025',
      'Re: May Thompson',
      'We have issued',
      'a repeat prescription; next review due 22/07/2026.',
    );
    expect(asIs(surgery, 'medical_record')).toBeUndefined();
    // A digit after it is not a date after it.
    const inhalers = lines(
      'Hyde Park Surgery',
      'We issued 2 inhalers; next review due 22/07/2026.',
    );
    expect(asIs(inhalers, 'medical_record')).toBeUndefined();
    // A label alone on its line, numbered or not, still has its date below it…
    for (const label of ['Issued', 'Issued:', '4a. Issued', 'Date issued']) {
      expect(asIs(lines('PASSPORT', label, '14 March 2025'), 'passport'), label).toBe('2025-03-14');
    }
    // …and one in a label's form, the date right after it.
    expect(asIs('PASSPORT\nIssued: on 14 March 2025', 'passport')).toBe('2025-03-14');
  });

  it('a passport’s machine-readable expiry is read in the century that fits its issue (C537-06)', () => {
    const exp = '990314';
    const line2 = (() => {
      const v = (c: string) =>
        /\d/.test(c) ? Number(c) : /[A-Z]/.test(c) ? c.charCodeAt(0) - 55 : 0;
      const cd = (t: string) =>
        [...t].reduce((sum, c, i) => sum + v(c) * ([7, 3, 1][i % 3] as number), 0) % 10;
      return `533401872${cd('533401872')}GBR850303${cd('850303')}F${exp}${cd(exp)}<<<<<<<<<<<<<<00`;
    })();
    const old = lines(
      'PASSPORT',
      'Nationality BRITISH CITIZEN',
      'Place of birth LEEDS',
      'Date of issue 14 MAR 89',
      'Date of expiry 14 MAR 99',
      'P<GBRKHAN<<SARA<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
      line2,
    );
    const p = proposeDetails(old, ctx());
    expect(p.expires).toMatchObject({ value: { date: '1999-03-14' }, cue: 'machine_lines' });
    expect(p.issued?.value.date).toBe('1989-03-14');
  });

  it('a number is read whole, and a phone number or a postcode is never one (C537-09)', () => {
    const policy = ctx({ current: { type_key: 'insurance_policy' } });
    expect(
      proposeDetails('Policy Number 123 4567-B12-35\nEffective 03/15/2025', policy).identifier
        ?.value,
    ).toBe('123 4567-B12-35');
    expect(proposeDetails('Policy number: HB 2219 4487 01', policy).identifier?.value).toBe(
      'HB 2219 4487 01',
    );
    const bill = ctx({ current: { type_key: 'utility_bill' } });
    for (const text of [
      'Account number\n0808 164 1088 (call us)',
      'Account number: 0345 030 7058',
      'Account number: (800) 555-0199',
      'Account number: +44 113 496 0000',
    ]) {
      expect(proposeDetails(text, bill).identifier, text).toBeUndefined();
    }
    expect(proposeDetails('Policy no.\nLS6 2AB 12 Elm Road', policy).identifier).toBeUndefined();
  });

  it('a motor insurance certificate with its vehicle’s registration mark is insurance (decision 15)', () => {
    const p = proposeFor(fixture('uk-car-insurance-ahmed'), 'dmy');
    expect(p.type_key?.value).toBe('insurance_policy');
    expect(p.issued?.value.date).toBe('2025-11-12');
    expect(p.expires?.value.date).toBe('2026-11-11');
  });

  it('a passport’s issuer is a country, never the office that printed it (W537-3)', () => {
    expect(proposeFor(fixture('uk-passport-sara'), 'dmy').issued_by).toMatchObject({
      value: 'United Kingdom',
      cue: 'machine_lines',
    });
    expect(proposeFor(fixture('us-passport-ahmed'), 'dmy').issued_by).toMatchObject({
      value: 'United States',
      cue: 'issuing_country',
    });
    // An Irish passport is Ireland's; the United Kingdom's names Northern Ireland.
    expect(proposeFor(fixture('uk-passport-ahmed'), 'dmy').issued_by?.value).toBe('United Kingdom');
    for (const f of ALL) {
      expect(proposeFor(f, 'dmy').issued_by?.value ?? '', f.name).not.toMatch(
        /passport office|department of state/i,
      );
    }
  });
});

describe('proposeDetails: how it does on the fixtures', () => {
  const total = (s: Record<FixtureField, FieldScore>) =>
    FIXTURE_FIELDS.reduce(
      (a, f) => ({
        right: a.right + s[f].right,
        said: a.said + s[f].said,
        wrong: a.wrong + s[f].wrong,
      }),
      { right: 0, said: 0, wrong: 0 },
    );

  it('on the documents it was tuned on', () => {
    const s = score(TUNED, 'dmy');
    expect(s.type_key).toMatchObject({ said: 20, right: 20, wrong: 0 });
    expect(s.owner.right).toBeGreaterThanOrEqual(16);
    expect(s.issued).toMatchObject({ right: 15, wrong: 0 });
    expect(s.expires).toMatchObject({ right: 14, wrong: 0 });
    expect(s.identifier).toMatchObject({ right: 15, wrong: 0 });
    expect(s.issued_by).toMatchObject({ right: 15, wrong: 0 });
    expect(total(s).wrong).toBe(0);
  });

  it('on the held-out documents, written by someone who never saw the rules', () => {
    const s = score(HELD_OUT, 'dmy');
    expect(HELD_OUT).toHaveLength(14);
    // Run once with the rules frozen (11/12 kinds, 10, 10, 8, 9, 8). The
    // review round then fixed one of its misses — the motor certificate's
    // "vehicle registration mark" — and the passport issuers became
    // countries, so this set is no longer unseen. Its misses now: a GP
    // letter's date on a line of its own; Granny Ruth, whose surname the
    // family's names do not give; the issuers no letterhead rule offers
    // (State Farm, PG&E, the GP practice, California's DMV); and a school's
    // name offered as the issuer of a letter that is none of the kinds.
    expect(s.type_key).toMatchObject({ said: 12, right: 12, wrong: 0, quiet: 2 });
    expect(s.owner).toMatchObject({ right: 10, wrong: 0 });
    expect(s.issued).toMatchObject({ right: 11, wrong: 0 });
    expect(s.expires).toMatchObject({ right: 9, wrong: 0 });
    expect(s.identifier).toMatchObject({ right: 10, wrong: 0 });
    expect(s.issued_by.right).toBeGreaterThanOrEqual(8);
    expect(total(s).wrong).toBeLessThanOrEqual(1);
  });

  it('a page made to be slow is not: each of these is proposed for in well under 250 ms', () => {
    const fill = (piece: string) => piece.repeat(Math.ceil(60_000 / piece.length)).slice(0, 60_000);
    const crafted = [
      fill('Sara '),
      fill('Sara Khan, '),
      `PASSPORT\nNationality\nPlace of birth\n${fill('exp ')}`,
      fill('Sara Ahmed Zain Ruth Khan '),
      fill('Dear Sara Khan, '),
      fill('01/09/2026 Card payment to TESCO 12.50 Sara Khan '),
      fill('Date of issue 14 MAR 2021 Date of expiry 14 MAR 2031 '),
      fill('Mr Sara Khan\n12 Acacia Avenue\n'),
    ];
    // A label, then a run of white space with no date after it: 25 s a
    // page before (N537P-01), as a Word file's tabs give it.
    for (const word of ['Issued', 'Expiry']) {
      for (const space of [' ', '\t']) {
        const run = `${word}${space.repeat(59_990)}x`;
        crafted.push(run, `Passport nationality place of birth surname\n${run}`);
      }
    }
    for (const text of crafted) {
      for (const over of [
        {},
        { current: { type_key: 'passport' } },
        { current: { type_key: 'utility_bill' } },
      ]) {
        const started = Date.now();
        const p = proposeDetails(text, ctx(over));
        expect(Date.now() - started, text.slice(0, 30)).toBeLessThan(250);
        // Bounded by what it counts, never by time: the same page, the same answer.
        expect(proposeDetails(text, ctx(over))).toEqual(p);
      }
    }
  });

  it('the text is read with no run of white space over 40 and no line over 2,000 characters', () => {
    // pdftotext -layout sets a label and its value far apart on a wide form.
    const wide = lines('PASSPORT', `Issued:${' '.repeat(100)}14 March 2025`);
    expect(
      proposeDetails(wide, ctx({ current: { type_key: 'passport' } })).issued?.value.date,
    ).toBe('2025-03-14');
    // What is past a line's first 2,000 characters is not read.
    const long = `Date of issue 14 March 2025 ${'x'.repeat(2_000)} Date of expiry 14 March 2035`;
    const p = proposeDetails(long, ctx({ current: { type_key: 'passport' } }));
    expect(p.issued?.value.date).toBe('2025-03-14');
    expect(p.expires).toBeUndefined();
  });

  it('a long statement is read quickly: the dates and labels of 60,000 characters', () => {
    const row = (i: number) =>
      `${String((i % 28) + 1).padStart(2, '0')}/09/2026  Card payment ${i}  Paid out  12.${i % 100}`;
    const text = lines(
      'Your statement',
      'Statement date: 30 September 2026',
      'Account number 43219876',
      ...Array.from({ length: 1500 }, (_, i) => row(i)),
    );
    const started = Date.now();
    const p = proposeDetails(text, ctx());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(p.issued?.value.date).toBe('2026-09-30');
  });

  it('a document always gets the same answer', () => {
    for (const f of ALL) {
      expect(proposeFor(f, 'dmy'), f.name).toEqual(proposeFor(f, 'dmy'));
      for (const field of FIXTURE_FIELDS) proposedValue(proposeFor(f, 'dmy'), field);
    }
  });
});
