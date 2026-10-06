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
    // What it scored the one time it was run, with the rules frozen: a
    // floor, so a change that reads them worse fails here. Its misses: a
    // motor certificate whose vehicle's registration mark scores it nearly
    // as a vehicle registration (so no kind, and nothing read for it); a
    // GP letter's date on a line of its own; the issuers no letterhead rule
    // offers (State Farm, PG&E, the GP practice, California's DMV); and a
    // school's name offered as the issuer of a letter that is none of the
    // kinds, which this set says has none.
    expect(s.type_key).toMatchObject({ said: 12, right: 11, wrong: 0, quiet: 2 });
    expect(s.owner).toMatchObject({ right: 10, wrong: 0 });
    expect(s.issued).toMatchObject({ right: 10, wrong: 0 });
    expect(s.expires).toMatchObject({ right: 8, wrong: 0 });
    expect(s.identifier).toMatchObject({ right: 9, wrong: 0 });
    expect(s.issued_by.right).toBeGreaterThanOrEqual(8);
    expect(total(s).wrong).toBeLessThanOrEqual(1);
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
