import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_FORM_UNSAID_NOTE,
  CHECKLIST_LINES_MAX,
  CHECKLIST_NO_DATE_NOTE,
  CHECKLIST_ONLY_ME_NOTE,
  CHECKLIST_TEXT_MAX,
  CHECKLIST_WAS_BANK_NOTE,
  checkChecklist,
  checkItem,
  checklistMissing,
  checklistSummary,
  itemAgain,
  readChecklist,
  savedItem,
  type ChecklistContext,
  type ChecklistDoc,
  type ChecklistReadItem,
} from './checklist.js';
import { FIXTURE_KINDS } from './testdata/index.js';

/**
 * Reading a checklist (0.9.0, C1): the owner's own list for a refinance,
 * and the ways people write one — bullets, commas, "and", numbers in
 * words, years and ranges, two people, a first name two of them share, and
 * lines that say nothing it knows.
 */

const KINDS = FIXTURE_KINDS.map((k) =>
  // 0077: the bank's own kind is called what it is.
  k.key === 'bank_statement' ? { ...k, label: 'Bank statement' } : k,
);
const ctx: ChecklistContext = {
  types: KINDS,
  people: [
    { id: 'm-mansoor', name: 'Mansoor' },
    { id: 'm-richa', name: 'Richa' },
    { id: 'm-sam-j', name: 'Sam Jones' },
    { id: 'm-sam-s', name: 'Sam Smith' },
    { id: 'm-zara', name: 'Zara' },
  ],
  me: 'm-mansoor',
  today: '2026-10-18',
};

const brief = (i: ChecklistReadItem) => ({
  kind: i.type_key,
  who: i.member_id,
  count: i.count,
  months: i.months,
  years: i.years,
  current: i.current,
  problem: i.problem,
});
const read = (text: string, c: ChecklistContext = ctx) => readChecklist(text, c).items;
const said = (text: string, c: ChecklistContext = ctx) =>
  read(text, c).map((i) => checklistSummary(i, c));

describe('reading a checklist', () => {
  it("reads the owner's example", () => {
    const items = read(`Documents for Mansoor
W2 for 2025 and 2024
Last 3 pay statements
Last 2 bank statements
Last 2 investment statements

Documents for Richa
and so on....`);
    expect(items.map(brief)).toEqual([
      {
        kind: 'tax_form',
        who: 'm-mansoor',
        count: null,
        months: null,
        years: [2025, 2024],
        current: false,
        problem: null,
      },
      {
        kind: 'pay_statement',
        who: 'm-mansoor',
        count: 3,
        months: null,
        years: [],
        current: false,
        problem: null,
      },
      {
        kind: 'bank_statement',
        who: 'm-mansoor',
        count: 2,
        months: null,
        years: [],
        current: false,
        problem: null,
      },
      {
        kind: 'investment_statement',
        who: 'm-mansoor',
        count: 2,
        months: null,
        years: [],
        current: false,
        problem: null,
      },
      {
        kind: null,
        who: 'm-richa',
        count: null,
        months: null,
        years: [],
        current: false,
        problem: 'kind',
      },
    ]);
    expect(items.map((i) => i.line)).toEqual([
      'W2 for 2025 and 2024',
      'Last 3 pay statements',
      'Last 2 bank statements',
      'Last 2 investment statements',
      'and so on',
    ]);
    expect(items[0]?.form).toBe('W-2');
    expect(items[0]?.heading).toBe('Documents for Mansoor');
    expect(items.map((i) => checklistSummary(i, ctx))).toEqual([
      'W-2s for 2025 and 2024, Mansoor’s',
      '3 most recent pay statements, Mansoor’s',
      '2 most recent bank statements, Mansoor’s',
      '2 most recent investment statements, Mansoor’s',
      'Not understood',
    ]);
  });

  it('reads each kind of heading, and a line before any as anyone’s', () => {
    expect(
      read(`Passport
Mansoor's documents
Passport
For Richa:
Passport
Zara:
Passport
Richa
Passport
Documents for me
Passport
Documents for both of us
Passport`).map((i) => i.member_id),
    ).toEqual([null, 'm-mansoor', 'm-richa', 'm-zara', 'm-richa', 'm-mansoor', null]);
    // "<name>: item" is a heading and an item on one line.
    expect(read('Richa: last 2 pay stubs').map(brief)).toEqual([
      {
        kind: 'pay_statement',
        who: 'm-richa',
        count: 2,
        months: null,
        years: [],
        current: false,
        problem: null,
      },
    ]);
  });

  it('a name two people share is asked about, never guessed', () => {
    const items = read('Documents for Sam\nPassport');
    expect(items[0]).toMatchObject({
      member_id: null,
      problem: 'person_shared',
      person_choices: ['m-sam-j', 'm-sam-s'],
      understood: false,
    });
    expect(checklistSummary(items[0] as ChecklistReadItem, ctx)).toBe(
      'The most recent passport: whose?',
    );
    // The whole name is one of them.
    expect(read('Documents for Sam Smith\nPassport')[0]?.member_id).toBe('m-sam-s');
  });

  it('a name that is nobody the reader may choose says so, and says nothing more', () => {
    const items = read('Documents for Priya\nPassport');
    expect(items[0]).toMatchObject({ member_id: null, problem: 'person_unknown' });
    // A heading that names a purpose ends the part before it: anyone's.
    expect(
      read('Documents for Mansoor\nPassport\nDocuments for the refinance\nPassport').map((i) => [
        i.member_id,
        i.problem,
      ]),
    ).toEqual([
      ['m-mansoor', null],
      [null, null],
    ]);
    // Two people at once are either of them, asked which.
    expect(read('Documents for Mansoor and Richa\nPassport')[0]).toMatchObject({
      problem: 'person_shared',
      person_choices: ['m-mansoor', 'm-richa'],
    });
    expect(read('Mansoor and Richa:\nPassport')[0]).toMatchObject({
      problem: 'person_shared',
      person_choices: ['m-mansoor', 'm-richa'],
    });
  });

  it('a line that reads as a heading ends the part before it (the C1 review)', () => {
    const whose = (text: string) => read(text).map((i) => [i.line, i.member_id, i.problem]);
    // "Joint", "Both of us", "Family": anyone's from there on.
    for (const h of ['Joint', 'Joint:', 'Both of us', 'Family']) {
      expect(whose(`Documents for Mansoor\nPassport\n${h}\nBank statement`), h).toEqual([
        ['Passport', 'm-mansoor', null],
        ['Bank statement', null, null],
      ]);
    }
    // Somebody by who they are, or a name nobody may be chosen for: whose?
    for (const h of [
      'My wife',
      'My wife:',
      'the children',
      'documents for grandma',
      'Grandma:',
      'Priya:',
    ]) {
      expect(whose(`Documents for Mansoor\nPassport\n${h}\nBank statement`), h).toEqual([
        ['Passport', 'm-mansoor', null],
        ['Bank statement', null, 'person_unknown'],
      ]);
    }
    expect(checklistSummary(read('My wife\nPassport')[0] as ChecklistReadItem, ctx)).toBe(
      'The most recent passport: whose?',
    );
    // Nor is "Note:" or "Passport:" a heading.
    expect(whose('Documents for Mansoor\nNote: bring originals\nPassport:')).toEqual([
      ['Note: bring originals', 'm-mansoor', 'kind'],
      ['Passport', 'm-mansoor', null],
    ]);
  });

  it('a name of the line’s own that is nobody the reader may choose is whose? (the C1 review)', () => {
    const one = (text: string, c = ctx) => read(text, c)[0] as ChecklistReadItem;
    expect(one('Grandma: passport')).toMatchObject({
      type_key: 'passport',
      problem: 'person_unknown',
    });
    expect(one("Dad's passport")).toMatchObject({
      type_key: 'passport',
      problem: 'person_unknown',
    });
    expect(one('Passport for my wife')).toMatchObject({ problem: 'person_unknown' });
    const teen: ChecklistContext = {
      ...ctx,
      people: [{ id: 'm-zara', name: 'Zara' }],
      me: 'm-zara',
    };
    expect(one("Mansoor's passport", teen)).toMatchObject({
      type_key: 'passport',
      member_id: null,
      problem: 'person_unknown',
    });
    // "Last year's W2" names nobody.
    expect(one("Last year's W2")).toMatchObject({ type_key: 'tax_form', problem: null });
  });

  it('a family member’s name before ’s or : wins over a kind’s word (Bill, May)', () => {
    const named: ChecklistContext = {
      ...ctx,
      people: [...ctx.people, { id: 'm-bill', name: 'Bill' }, { id: 'm-may', name: 'May' }],
    };
    expect(read("Bill's passport", named)[0]).toMatchObject({
      type_key: 'passport',
      member_id: 'm-bill',
    });
    expect(read("Bill's documents\nPassport", named)[0]?.member_id).toBe('m-bill');
    expect(read('May: last 2 pay stubs', named)[0]).toMatchObject({
      type_key: 'pay_statement',
      member_id: 'm-may',
      count: 2,
      in_months: [],
    });
    // A bill is still a bill, and May still a month, where nobody is named so.
    expect(read('Last bill')[0]?.type_key).toBe('utility_bill');
    expect(read('Bank statements for May')[0]?.in_months).toEqual(['2026-05']);
  });

  it('a teen is matched to themselves alone', () => {
    const teen: ChecklistContext = {
      ...ctx,
      people: [{ id: 'm-zara', name: 'Zara' }],
      me: 'm-zara',
    };
    const items = read('Documents for Mansoor\nPassport\nDocuments for me\nPassport', teen);
    expect(items.map((i) => [i.member_id, i.problem])).toEqual([
      [null, 'person_unknown'],
      ['m-zara', null],
    ]);
    // A saved item naming somebody else is nobody to them.
    const again = itemAgain(
      { ...savedItem(items[1] as ChecklistReadItem), member_id: 'm-mansoor' },
      teen,
    );
    expect(again).toMatchObject({ member_id: null, problem: 'person_unknown', understood: false });
  });

  it('bullets, numbers, boxes, commas, semicolons and "and"', () => {
    expect(
      read(`- Passport
* Birth certificate
• Driving licence
1. Last 2 bank statements
2) W-2 for 2024
[ ] Pay stubs
[x] Marriage certificate`).map((i) => i.type_key),
    ).toEqual([
      'passport',
      'birth_certificate',
      'drivers_licence',
      'bank_statement',
      'tax_form',
      'pay_statement',
      'marriage_certificate',
    ]);
    // Two kinds on a line are two items; years said once are for both.
    expect(
      read('Passport and driving licence, birth certificate; marriage certificate').map(
        (i) => i.type_key,
      ),
    ).toEqual(['passport', 'drivers_licence', 'birth_certificate', 'marriage_certificate']);
    expect(read('Bank and investment statements for 2024').map(brief)).toEqual([
      {
        kind: 'bank_statement',
        who: null,
        count: null,
        months: null,
        years: [2024],
        current: false,
        problem: null,
      },
      {
        kind: 'investment_statement',
        who: null,
        count: null,
        months: null,
        years: [2024],
        current: false,
        problem: null,
      },
    ]);
    // How many is for the parts after it; a phrase with "and" in it is one kind.
    expect(read('Last 2 bank statements and investment statements').map((i) => i.count)).toEqual([
      2, 2,
    ]);
    expect(read('Passport and last 3 pay stubs').map((i) => i.count)).toEqual([null, 3]);
    expect(read('Stocks and shares statements').map((i) => i.type_key)).toEqual([
      'investment_statement',
    ]);
  });

  it('how many, in numbers and in words, and how recent', () => {
    const counts = read(`Last 3 pay statements
The last two bank statements
Most recent 2 investment statements
3 most recent pay stubs
Latest passport
2 bank statements
Last twelve payslips
A couple of bank statements`).map((i) => i.count);
    expect(counts).toEqual([3, 2, 2, 3, null, 2, 12, 2]);
    expect(read('3 months of bank statements')[0]).toMatchObject({ months: 3, count: null });
    expect(read('Last 6 months of pay stubs')[0]).toMatchObject({ months: 6, count: null });
    expect(read('Current passport\nValid driving licence').map((i) => i.current)).toEqual([
      true,
      true,
    ]);
    // The last two years: the two before this one.
    expect(read('Last 2 years of tax returns')[0]?.years).toEqual([2025, 2024]);
    expect(said('3 months of bank statements')).toEqual([
      'Bank statements from each of the last 3 months, anyone’s',
    ]);
    expect(said('Current passport')).toEqual(['A current passport, anyone’s']);
  });

  it('years, ranges and tax years', () => {
    expect(read('Tax returns 2023-2025')[0]?.years).toEqual([2023, 2024, 2025]);
    expect(read('Tax returns 2023–2025')[0]?.years).toEqual([2023, 2024, 2025]);
    expect(read('Tax returns 2025 to 2023')[0]?.years).toEqual([2025, 2024, 2023]);
    expect(read('Tax return for tax year 2024')[0]).toMatchObject({
      type_key: 'tax_return',
      years: [2024],
    });
    expect(read('P60 tax year 2024-25')[0]).toMatchObject({
      type_key: 'tax_form',
      years: [2025],
      form: 'P60',
    });
    expect(read('1099 for 2025')[0]).toMatchObject({
      type_key: 'tax_form',
      years: [2025],
      form: '1099',
    });
    // A form's number is not a count, nor a year.
    expect(read('1099 for 2025')[0]?.count).toBeNull();
    expect(read('401k statement')[0]).toMatchObject({
      type_key: 'investment_statement',
      count: null,
      years: [],
    });
    // "2024/25" and "2024-25" are the same tax year.
    expect(read('P60 2024/25')[0]?.years).toEqual([2025]);
    expect(read('P60 2024-25')[0]?.years).toEqual([2025]);
    // A run of ten years or more is not read, and says why.
    const long = read('Tax returns 2010-2025')[0] as ChecklistReadItem;
    expect(long).toMatchObject({ understood: false, problem: 'years', years: [] });
    expect(long.note).toMatch(/too many to look for/);
  });

  it('forms by their plurals, and "two years of" them (the C1 review)', () => {
    for (const [text, form] of [
      ['W-2s for 2025', 'W-2'],
      ['W2s for 2025', 'W-2'],
      ['1099s for 2025', '1099'],
      ['P60s for 2025', 'P60'],
    ] as const) {
      expect(read(text)[0], text).toMatchObject({ type_key: 'tax_form', form, years: [2025] });
    }
    expect(read('Two years of W-2s')[0]).toMatchObject({
      type_key: 'tax_form',
      form: 'W-2',
      years: [2025, 2024],
    });
  });

  it('months by name, "dated within", and counts past the most a line asks for', () => {
    expect(read('Bank statements for May and June')[0]).toMatchObject({
      type_key: 'bank_statement',
      in_months: ['2026-05', '2026-06'],
      years: [],
    });
    expect(read('Pay stubs Jan–Mar 2026')[0]?.in_months).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(read('Pay stubs Nov-Jan')[0]?.in_months).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(read('Pay stub for June 2025')[0]?.in_months).toEqual(['2025-06']);
    expect(said('Bank statements for May and June')).toEqual([
      'Bank statements for May and June 2026, anyone’s',
    ]);
    // One dated within the last three months.
    expect(read('Bank statement dated within 3 months')[0]).toMatchObject({
      within: 3,
      count: null,
      months: null,
    });
    expect(said('Bank statement dated within 3 months')).toEqual([
      'A bank statement dated within the last 3 months, anyone’s',
    ]);
    // More than the most a line asks for is read as that, and said so.
    const many = read('Last 30 pay stubs')[0] as ChecklistReadItem;
    expect(many.count).toBe(24);
    expect(many.note).toBe('Read as 24 documents: the most one line asks for.');
  });

  it('a line about one person names them: possessive, "for", or in brackets', () => {
    expect(
      read(`Mansoor's W2 for 2025
Passport for Richa
Payslips (Zara)
Last year's W2`).map((i) => i.member_id),
    ).toEqual(['m-mansoor', 'm-richa', 'm-zara', null]);
  });

  it('a line it cannot read is Not understood', () => {
    const items = read('Refinance application\nPlease bring originals\nSomething for the lender');
    expect(items.map((i) => [i.understood, i.problem])).toEqual([
      [false, 'kind'],
      [false, 'kind'],
      [false, 'kind'],
    ]);
    // A household's own kind by its name.
    const own: ChecklistContext = {
      ...ctx,
      types: [...KINDS, { key: 'h_abcdefghij', label: 'Gym membership' }],
    };
    expect(read('Gym membership', own)[0]?.type_key).toBe('h_abcdefghij');
    // A hidden kind is never read.
    const hidden: ChecklistContext = {
      ...ctx,
      types: KINDS.map((k) => (k.key === 'passport' ? { ...k, hidden: true } : k)),
    };
    expect(read('Passport', hidden)[0]?.type_key).toBeNull();
  });

  it('is bounded: so many lines, so long', () => {
    const many = Array.from({ length: CHECKLIST_LINES_MAX + 20 }, () => 'Passport').join('\n');
    const r = readChecklist(many, ctx);
    expect(r.items).toHaveLength(CHECKLIST_LINES_MAX);
    expect(r.left_out).toBe(20);
    // The worst a list of the most it takes can be is quick.
    const worst = Array.from({ length: CHECKLIST_LINES_MAX }, () =>
      'Documents for '.concat('a'.repeat(20), ' and last 2 ', '2024-2025 '.repeat(8)),
    )
      .join('\n')
      .slice(0, CHECKLIST_TEXT_MAX);
    const started = Date.now();
    readChecklist(worst, ctx);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// ----------------------------------------------------------------- matching

const doc = (o: Partial<ChecklistDoc> & { id: string }): ChecklistDoc => ({
  title: o.id,
  type_key: 'pay_statement',
  owner_member_id: 'm-mansoor',
  visibility: 'adults',
  issued: null,
  expires: null,
  created_at: '2026-10-01T00:00:00.000Z',
  tax_year: null,
  in_collection: false,
  ...o,
});
const on = (date: string) => ({ date, precision: 'day' as const });
const opts = { today: '2026-10-18', audience: 'everyone', people: ctx.people, types: KINDS };
const one = (text: string) => read(text)[0] as ChecklistReadItem;

describe('matching a checklist', () => {
  it('last N: the N most recent by issue date, then by the date added', () => {
    const docs = [
      doc({ id: 'jul', issued: on('2026-07-31') }),
      doc({ id: 'sep', issued: on('2026-09-30') }),
      doc({ id: 'undated', created_at: '2026-08-15T00:00:00.000Z' }),
      doc({ id: 'aug', issued: on('2026-08-31') }),
      doc({ id: 'richas', owner_member_id: 'm-richa', issued: on('2026-10-01') }),
      doc({ id: 'bill', type_key: 'utility_bill', issued: on('2026-10-02') }),
    ];
    const c = checkItem(one('Documents for Mansoor\nLast 3 pay statements'), docs, opts);
    // A document with no date is never one of the most recent: offered after, to check.
    expect(c.matches.filter((m) => m.ticked).map((m) => m.document_id)).toEqual([
      'sep',
      'aug',
      'jul',
    ]);
    expect(c.matches.filter((m) => !m.chosen).map((m) => [m.document_id, m.note])).toEqual([
      ['undated', CHECKLIST_NO_DATE_NOTE],
    ]);
    expect(c).toMatchObject({ wanted: 3, found: 3, missing: [] });
    const months = checkItem(one('Documents for Mansoor\n3 months of pay statements'), docs, opts);
    expect(months.matches.find((m) => m.document_id === 'undated')?.ticked).toBe(false);
    // Anyone's: Richa's too.
    expect(checkItem(one('Last pay statement'), docs, opts).matches[0]?.document_id).toBe('richas');
  });

  it('years: a tax form by the tax year it keeps, otherwise its issue date', () => {
    const docs = [
      doc({
        id: 'w25',
        type_key: 'tax_form',
        title: 'W-2 2025',
        issued: on('2026-01-28'),
        tax_year: '2025',
      }),
      doc({
        id: 'w24',
        type_key: 'tax_form',
        title: 'W-2 2024',
        issued: on('2025-01-30'),
        tax_year: '2024',
      }),
      doc({ id: 'p60', type_key: 'tax_form', title: 'P60', tax_year: '2024/25' }),
      doc({ id: 'int', type_key: 'tax_form', title: '1099-INT 2025', tax_year: '2025' }),
      // No tax year, but its title says it: 2023.
      doc({ id: 'old', type_key: 'tax_form', title: 'W-2 2023', issued: on('2024-02-01') }),
      // No tax year, and nothing in its title: never ticked, whatever its issue date.
      doc({ id: 'nodate', type_key: 'tax_form', title: 'W-2 scan', issued: on('2025-02-01') }),
      // A tax form whose title names no form at all.
      doc({ id: 'plain', type_key: 'tax_form', title: 'Employer tax form', tax_year: '2025' }),
    ];
    const c = checkItem(one('Documents for Mansoor\nW2 for 2025 and 2024'), docs, opts);
    // The 1099 is not a W-2, nor is the P60; one naming no form is offered, to check.
    expect(c.matches.filter((m) => m.chosen).map((m) => m.document_id)).toEqual(['w25', 'w24']);
    expect(c).toMatchObject({ wanted: 2, found: 2, missing: [] });
    expect(c.matches.find((m) => m.document_id === 'plain')).toMatchObject({
      ticked: false,
      note: CHECKLIST_FORM_UNSAID_NOTE,
    });
    expect(c.matches.map((m) => m.document_id)).not.toContain('int');
    // One with no year to tell is offered unticked, to check.
    const nodate = c.matches.find((m) => m.document_id === 'nodate');
    expect(nodate).toMatchObject({ ticked: false, chosen: false, note: CHECKLIST_NO_DATE_NOTE });
    // A year with none is missing, said in words; its title's year counts.
    const missing = checkItem(one('Documents for Mansoor\nW2 for 2022 and 2023'), docs, opts);
    expect(missing).toMatchObject({ found: 1, missing: ['W-2 for 2022, Mansoor’s'] });
    expect(missing.matches[0]?.document_id).toBe('old');
    // A UK tax year, 2024/25, is the year it ends in too.
    const p60 = checkItem(one('P60 for 2025'), docs, opts);
    expect(p60.matches.filter((m) => m.chosen).map((m) => m.document_id)).toEqual(['p60']);
  });

  it('a kind changed away from a tax form loses its form', () => {
    const w2 = one('W2 for 2025');
    expect(w2.form).toBe('W-2');
    expect(itemAgain({ ...w2, type_key: 'bank_statement' }, ctx).form).toBeNull();
    expect(savedItem({ ...w2, type_key: 'passport' }).form).toBeNull();
  });

  it('months named, "dated within", and a date of a month counted in its month', () => {
    const docs = [
      doc({
        id: 'oct-m',
        type_key: 'bank_statement',
        issued: { date: '2026-10-31', precision: 'month' },
      }),
      doc({ id: 'jun', type_key: 'bank_statement', issued: on('2026-06-15') }),
      doc({ id: 'may', type_key: 'bank_statement', issued: on('2026-05-20') }),
    ];
    // Its month is this one, though its date is the month's last day.
    const last = checkItem(one('1 month of bank statements'), docs, opts);
    expect(last.matches.filter((m) => m.ticked).map((m) => m.document_id)).toEqual(['oct-m']);
    const named = checkItem(one('Bank statements for May and June'), docs, opts);
    expect(named.matches.filter((m) => m.ticked).map((m) => m.document_id)).toEqual(['jun', 'may']);
    expect(named).toMatchObject({ wanted: 2, found: 2, missing: [] });
    const april = checkItem(one('Bank statements for April and May'), docs, opts);
    expect(april).toMatchObject({ found: 1, missing: ['bank statement for April 2026'] });
    const within = checkItem(one('Bank statement dated within 3 months'), docs, opts);
    expect(within.matches.filter((m) => m.ticked).map((m) => m.document_id)).toEqual(['oct-m']);
    const tooOld = checkItem(
      one('Bank statement dated within 3 months'),
      docs.filter((d) => d.id !== 'oct-m'),
      opts,
    );
    expect(tooOld).toMatchObject({
      found: 0,
      missing: ['a bank statement dated within the last 3 months'],
    });
  });

  it('an investment line offers the person’s bank statements, unticked (0077)', () => {
    const docs = [
      doc({ id: 'inv', type_key: 'investment_statement', issued: on('2026-09-30') }),
      doc({ id: 'bank', type_key: 'bank_statement', issued: on('2026-08-31'), title: 'Vanguard' }),
      doc({
        id: 'richas',
        type_key: 'bank_statement',
        owner_member_id: 'm-richa',
        issued: on('2026-08-31'),
      }),
    ];
    const c = checkItem(one('Documents for Mansoor\nLast 2 investment statements'), docs, opts);
    expect(c.matches.map((m) => [m.document_id, m.ticked, m.note])).toEqual([
      ['inv', true, null],
      ['bank', false, CHECKLIST_WAS_BANK_NOTE],
    ]);
  });

  it('is quick: 100 lines against 5,000 documents in well under half a second', () => {
    const kinds = [
      'pay_statement',
      'bank_statement',
      'tax_form',
      'investment_statement',
      'passport',
    ];
    const docs = Array.from({ length: 5000 }, (_, i) =>
      doc({
        id: `d${i}`,
        type_key: kinds[i % kinds.length] as string,
        title: i % 3 === 0 ? `W-2 ${2020 + (i % 6)}` : `Paper ${i}`,
        owner_member_id: i % 2 ? 'm-mansoor' : 'm-richa',
        issued: i % 7 ? on(`20${20 + (i % 6)}-0${1 + (i % 9)}-1${i % 9}`) : null,
        tax_year: i % 5 ? String(2020 + (i % 6)) : null,
        visibility: i % 11 ? 'adults' : 'private',
      }),
    );
    const lines = Array.from(
      { length: 100 },
      (_, i) =>
        [
          "Mansoor's last 3 pay statements",
          'W2 for 2025 and 2024',
          '3 months of bank statements',
          'Last 2 investment statements',
          'Current passport',
        ][i % 5],
    ).join('\n');
    const items = readChecklist(lines, ctx).items;
    const started = Date.now();
    const checked = checkChecklist(items, docs, opts);
    const took = Date.now() - started;
    expect(checked).toHaveLength(100);
    (globalThis as { console?: { info: (s: string) => void } }).console?.info(
      `checkChecklist: ${items.length} items against 5,000 documents in ${took} ms`,
    );
    expect(took).toBeLessThan(250);
  });

  it('months: each of the last N months', () => {
    const docs = [
      doc({ id: 'oct', type_key: 'bank_statement', issued: on('2026-10-01') }),
      doc({ id: 'sep', type_key: 'bank_statement', issued: on('2026-09-30') }),
      doc({ id: 'jun', type_key: 'bank_statement', issued: on('2026-06-30') }),
    ];
    const c = checkItem(one('3 months of bank statements'), docs, opts);
    expect(c.matches.filter((m) => m.chosen).map((m) => m.document_id)).toEqual(['oct', 'sep']);
    expect(c).toMatchObject({ wanted: 3, found: 2, missing: ['bank statement for 1 more month'] });
  });

  it('current: one that has not run out', () => {
    const docs = [
      doc({
        id: 'expired',
        type_key: 'passport',
        issued: on('2025-01-01'),
        expires: on('2026-01-01'),
      }),
      doc({
        id: 'valid',
        type_key: 'passport',
        issued: on('2018-01-01'),
        expires: on('2028-01-01'),
      }),
    ];
    expect(checkItem(one('Current passport'), docs, opts).matches[0]?.document_id).toBe('valid');
    expect(checkItem(one('Latest passport'), docs, opts).matches[0]?.document_id).toBe('expired');
  });

  it('an Only me document is found, and not ticked for a collection others see', () => {
    const docs = [doc({ id: 'mine', visibility: 'private', issued: on('2026-09-30') })];
    const shared = checkItem(one('Last pay statement'), docs, opts);
    expect(shared.matches[0]).toMatchObject({
      ticked: false,
      chosen: true,
      note: CHECKLIST_ONLY_ME_NOTE,
    });
    // Found, but not added: not counted as found, nor asked for as missing.
    expect(shared).toMatchObject({ found: 0, found_not_added: 1, missing: [] });
    // In an Only me collection it is ticked.
    const alone = checkItem(one('Last pay statement'), docs, { ...opts, audience: 'only_me' });
    expect(alone.matches[0]).toMatchObject({ ticked: true, note: null });
  });

  it('one in the collection already is found, not ticked; fewer than asked are missing', () => {
    const docs = [doc({ id: 'in', in_collection: true, issued: on('2026-09-30') })];
    const c = checkItem(one('Documents for Mansoor\nLast 3 pay statements'), docs, opts);
    expect(c.matches[0]).toMatchObject({ ticked: false, in_collection: true });
    expect(c).toMatchObject({ found: 1, missing: ['2 more pay statements, Mansoor’s'] });
    expect(checklistMissing([c])).toEqual(['2 more pay statements, Mansoor’s']);
  });

  it('a skipped item, or one not understood, matches nothing and is not missing', () => {
    const docs = [doc({ id: 'x', issued: on('2026-09-30') })];
    const skipped = checkItem({ ...one('Last pay statement'), skipped: true }, docs, opts);
    expect(skipped).toMatchObject({ matches: [], found: 0, missing: [] });
    const whose = checkItem(one('Documents for Sam\nLast pay statement'), docs, opts);
    expect(whose).toMatchObject({ matches: [], missing: [] });
    expect(checklistMissing([skipped, whose])).toEqual([]);
  });
});
