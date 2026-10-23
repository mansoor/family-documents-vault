import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_BY_TITLE_NOTE,
  CHECKLIST_ONLY_ME_NOTE,
  CHECKLIST_TITLE_LINES_MAX,
  checkChecklist,
  checkItem,
  checklistLooksByTitle,
  checklistMissing,
  CHECKLIST_KIND_WORDS,
  itemAgain,
  readChecklist,
  savedItem,
  type ChecklistContext,
  type ChecklistDoc,
  type ChecklistReadItem,
} from './checklist.js';
import { FOLDER_KIND_WORDS, foldKey, suggestFromFolder, US_IMMIGRATION_WORDS } from './folders.js';
import { FIXTURE_KINDS } from './testdata/index.js';

/**
 * The owner's report of 23 October (0.9.0): "mansoors passport / mansoors
 * ead" found the passport and not the EAD card. A checklist now reads
 * "mansoors" as Mansoor's, knows the papers of US immigration as a visa's,
 * and looks for a line by the words of its title when its kind is none or
 * finds nothing.
 */

const OWN = { key: 'h_workpaper', label: 'Work papers' };
const KINDS = [...FIXTURE_KINDS, OWN];
const ctx: ChecklistContext = {
  types: KINDS,
  people: [
    { id: 'm-mansoor', name: 'Mansoor' },
    { id: 'm-richa', name: 'Richa' },
    { id: 'm-chris', name: 'Chris' },
    { id: 'm-james', name: 'James Lee' },
    { id: 'm-bill', name: 'Bill' },
  ],
  me: 'm-mansoor',
  today: '2026-10-23',
};
const opts = { today: ctx.today, audience: 'everyone', people: ctx.people, types: KINDS };
const read = (text: string, c: ChecklistContext = ctx) => readChecklist(text, c).items;
const one = (text: string) => read(text)[0] as ChecklistReadItem;
const on = (date: string) => ({ date, precision: 'day' as const });
const doc = (o: Partial<ChecklistDoc> & { id: string }): ChecklistDoc => ({
  title: o.id,
  type_key: 'passport',
  owner_member_id: 'm-mansoor',
  visibility: 'household',
  issued: null,
  expires: null,
  created_at: '2026-10-01T00:00:00.000Z',
  tax_year: null,
  in_collection: false,
  ...o,
});

const OWNERS_LIST = 'mansoors passport\nmansoors ead';

describe("the owner's checklist (23 October)", () => {
  const passport = doc({ id: 'pp', title: 'Mansoor’s passport', issued: on('2020-03-01') });
  const richas = doc({
    id: 'richa-pp',
    title: 'Richa’s passport',
    owner_member_id: 'm-richa',
    issued: on('2024-03-01'),
  });

  it('finds both, as Mansoor’s, with the EAD card a visa', () => {
    const ead = doc({ id: 'ead', title: 'Mansoor’s EAD Card', type_key: 'visa' });
    const items = read(OWNERS_LIST);
    expect(items.map((i) => [i.type_key, i.member_id, i.understood])).toEqual([
      ['passport', 'm-mansoor', true],
      ['visa', 'm-mansoor', true],
    ]);
    const c = checkChecklist(items, [passport, richas, ead], opts);
    expect(c.map((i) => i.matches.map((m) => [m.document_id, m.ticked]))).toEqual([
      [['pp', true]],
      // No date on it: offered, to check, as any visa with none is.
      [['ead', false]],
    ]);
    expect(c[0]?.summary).toBe('The most recent passport, Mansoor’s');
    expect(c[1]?.summary).toBe('The most recent visa, Mansoor’s');
    // Richa's passport, though newer, is not Mansoor's.
    expect(c[0]?.matches.map((m) => m.document_id)).not.toContain('richa-pp');
  });

  it('finds both, the EAD card filed as a kind of the household’s own, by its title', () => {
    const ead = doc({ id: 'ead', title: 'Mansoor’s EAD Card', type_key: OWN.key });
    const c = checkChecklist(read(OWNERS_LIST), [passport, richas, ead], opts);
    expect(c[0]?.found).toBe(1);
    expect(c[0]?.by_title).toBeUndefined();
    expect(c[1]).toMatchObject({
      understood: true,
      problem: null,
      by_title: true,
      summary: 'Found by its title: Mansoor’s EAD Card',
      wanted: 1,
      found: 1,
      missing: [],
      member_id: 'm-mansoor',
    });
    expect(c[1]?.matches).toEqual([
      expect.objectContaining({
        document_id: 'ead',
        ticked: true,
        chosen: true,
        note: CHECKLIST_BY_TITLE_NOTE,
      }),
    ]);
    expect(checklistMissing(c)).toEqual([]);
    // Two by their titles: none ticked, and the visa still said to be missing.
    const two = checkChecklist(
      read(OWNERS_LIST),
      [ead, { ...ead, id: 'ead-old', title: 'Mansoor EAD card 2022' }],
      opts,
    );
    expect(two[1]).toMatchObject({ by_title: true, found: 0 });
    expect(two[1]?.matches.map((m) => [m.document_id, m.ticked])).toEqual([
      ['ead', false],
      ['ead-old', false],
    ]);
    expect(two[1]?.missing).toEqual(['the most recent visa, Mansoor’s']);
    // The test of the test: without its title, the line is a visa that is missing.
    const untitled = checkChecklist(read(OWNERS_LIST), [{ ...ead, title: 'Scan 0042' }], opts);
    expect(untitled[1]?.by_title).toBeUndefined();
    expect(untitled[1]?.found).toBe(0);
    expect(untitled[1]?.missing).toEqual(['the most recent visa, Mansoor’s']);
  });
});

describe('a line found by its title', () => {
  const gym = (id: string, title: string, o: Partial<ChecklistDoc> = {}) =>
    doc({ id, title, type_key: OWN.key, ...o });

  it('one found is ticked and said back; several are offered unticked; none is Not understood', () => {
    const item = one('Gym card');
    expect(item).toMatchObject({ type_key: null, problem: 'kind', title_words: ['gym', 'card'] });
    const single = checkItem(item, [gym('g1', 'City GYM Card')], opts);
    expect(single).toMatchObject({
      understood: true,
      by_title: true,
      summary: 'Found by its title: City GYM Card',
      found: 1,
    });
    expect(single.matches[0]).toMatchObject({ ticked: true, chosen: true });
    const several = checkItem(
      item,
      [gym('g1', 'City gym card', { issued: on('2025-01-01') }), gym('g2', 'Gym cards 2024')],
      opts,
    );
    expect(several).toMatchObject({
      understood: true,
      by_title: true,
      summary: 'Found by its title: 2 to choose from',
      found: 0,
      found_not_added: 0,
      missing: [],
    });
    expect(several.matches.map((m) => [m.document_id, m.ticked, m.note])).toEqual([
      ['g1', false, CHECKLIST_BY_TITLE_NOTE],
      ['g2', false, CHECKLIST_BY_TITLE_NOTE],
    ]);
    const none = checkItem(item, [gym('g3', 'Gym membership letter')], opts);
    expect(none).toMatchObject({ understood: false, problem: 'kind', matches: [], found: 0 });
    expect(none.by_title).toBeUndefined();
    // One found for a line that asks for two: offered, not chosen.
    const two = checkItem(one('Last 2 gym cards'), [gym('g1', 'City gym card')], opts);
    expect(two).toMatchObject({ by_title: true, wanted: 2, found: 0, found_not_added: 0 });
    expect(two.matches.map((m) => [m.document_id, m.ticked, m.chosen])).toEqual([
      ['g1', false, false],
    ]);
  });

  it('matches whole words, whatever their case, accents or number', () => {
    const docs = [
      gym('cafe', 'CAFÉ loyalty CARDS'),
      gym('cardigan', 'Café loyalty cardigan receipt'),
      gym('other', 'Loyalty scheme letter'),
    ];
    const c = checkItem(one('cafe loyalty card'), docs, opts);
    expect(c.matches.map((m) => m.document_id)).toEqual(['cafe']);
    expect(c.matches[0]?.ticked).toBe(true);
  });

  it('keeps to the line’s person and years', () => {
    const docs = [
      gym('m-2024', 'Gym card 2024', { owner_member_id: 'm-mansoor' }),
      gym('r-2024', 'Gym card', { owner_member_id: 'm-richa', issued: on('2024-02-01') }),
      gym('r-2023', 'Gym card', { owner_member_id: 'm-richa', issued: on('2023-02-01') }),
    ];
    const richas = checkItem(one('Richas gym card'), docs, opts);
    expect(richas.member_id).toBe('m-richa');
    expect(richas.matches.map((m) => m.document_id)).toEqual(['r-2024', 'r-2023']);
    const of2024 = checkItem(one('Richa’s gym card for 2024'), docs, opts);
    expect(of2024.matches.map((m) => [m.document_id, m.ticked])).toEqual([['r-2024', true]]);
    // A year its title names counts as its year.
    const his = checkItem(one('Gym card 2024 (Mansoor)'), docs, opts);
    expect(his.matches.map((m) => m.document_id)).toEqual(['m-2024']);
    // "Current": one that has not run out.
    const cards = [
      gym('expired', 'Gym card', { expires: on('2026-01-01') }),
      gym('valid', 'Gym card', {
        expires: on('2027-01-01'),
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    ];
    expect(
      checkItem(one('Current gym card'), cards, opts).matches.map((m) => m.document_id),
    ).toEqual(['valid']);
    // Nobody's of that year: not understood.
    expect(checkItem(one('Gym card 2019'), docs, opts).understood).toBe(false);
  });

  it('an Only me one is found and not ticked for a collection others see', () => {
    const docs = [gym('mine', 'Gym card', { visibility: 'private' })];
    const shared = checkItem(one('gym card'), docs, opts);
    expect(shared.matches[0]).toMatchObject({ ticked: false, note: CHECKLIST_ONLY_ME_NOTE });
    expect(shared).toMatchObject({ found: 0, found_not_added: 1 });
    const alone = checkItem(one('gym card'), docs, { ...opts, audience: 'only_me' });
    expect(alone.matches[0]).toMatchObject({ ticked: true });
  });

  it('a line whose person is still to choose, or with nothing left to look for, is not looked for', () => {
    const docs = [gym('g1', 'Grandma gym card'), gym('g2', 'Please bring originals')];
    expect(checkItem(one('Grandma’s gym card'), docs, opts).matches).toEqual([]);
    expect(one('Please bring the originals').title_words).toBeUndefined();
    expect(one('and so on....').title_words).toBeUndefined();
    // More than six words is a sentence, not a title.
    expect(
      one('the gym card from the leisure centre on main street near the old library').title_words,
    ).toBeUndefined();
  });

  it('is looked for again as the page opens', () => {
    const kept = savedItem(one('mansoors gym card'));
    expect(kept.title_words).toEqual(['gym', 'card']);
    const again = itemAgain(JSON.parse(JSON.stringify(kept)) as typeof kept, ctx);
    expect(again).toMatchObject({ problem: 'kind', member_id: 'm-mansoor' });
    const c = checkItem(again, [gym('g1', 'Mansoor gym card')], opts);
    expect(c).toMatchObject({
      by_title: true,
      found: 1,
      summary: 'Found by its title: Mansoor gym card',
    });
    // A line with no words to look for keeps none.
    expect(savedItem(one('W2 for 2025')).title_words).toBeUndefined();
  });

  it(`is bounded: ${CHECKLIST_TITLE_LINES_MAX} lines of a checklist at most are looked for`, () => {
    const lines = Array.from(
      { length: CHECKLIST_TITLE_LINES_MAX + 5 },
      (_, i) => `gym card ${2000 + i}`,
    );
    const docs = lines.map((l, i) => gym(`g${i}`, l));
    const c = checkChecklist(read(lines.join('\n')), docs, opts);
    expect(c.filter((i) => i.by_title).length).toBe(CHECKLIST_TITLE_LINES_MAX);
    expect(c.slice(CHECKLIST_TITLE_LINES_MAX).every((i) => !i.understood)).toBe(true);
    // Whether the API is to load the titled documents.
    expect(checklistLooksByTitle(c)).toBe(true);
    expect(checklistLooksByTitle(checkChecklist(read('Passport'), [doc({ id: 'p' })], opts))).toBe(
      false,
    );
    // A line no title has is looked for still: the API loads them.
    expect(checklistLooksByTitle(checkChecklist(read('gym card'), [], opts))).toBe(true);
  });

  it('a kind that finds something is never looked for by its title', () => {
    const docs = [
      doc({ id: 'pp', title: 'Old passport', issued: on('2015-01-01') }),
      gym('photo', 'Passport photo'),
    ];
    const c = checkItem(one('Passport'), docs, opts);
    expect(c.by_title).toBeUndefined();
    expect(c.matches.map((m) => m.document_id)).toEqual(['pp']);
  });
});

describe('the papers of US immigration (a visa’s)', () => {
  it('each is read as a visa, in a checklist and in a folder’s name', () => {
    for (const w of US_IMMIGRATION_WORDS) {
      const item = one(`${w.toUpperCase()} for Mansoor`);
      expect([w, item.type_key, item.problem]).toEqual([w, 'visa', null]);
      expect([w, suggestFromFolder(`Mansoor/${w}`, { types: KINDS, people: ctx.people })]).toEqual([
        w,
        expect.objectContaining({ type_key: 'visa', owner_member_id: 'm-mansoor' }),
      ]);
    }
    for (const folder of ['EAD', 'I-94', 'I-797 2024', 'Immigration/I-94', 'PR Card']) {
      expect([folder, suggestFromFolder(folder, { types: KINDS, people: [] })?.type_key]).toEqual([
        folder,
        'visa',
      ]);
    }
    // "Employment" alone is still an employment contract's.
    expect(one('Employment contract').type_key).toBe('employment_contract');
    expect(one('Employment authorization document').type_key).toBe('visa');
  });

  it('none is another kind’s word, and the ambiguous are left out', () => {
    const mine = new Set(US_IMMIGRATION_WORDS.map(foldKey));
    for (const [kind, words] of [
      ...Object.entries(FOLDER_KIND_WORDS),
      ...Object.entries(CHECKLIST_KIND_WORDS),
    ]) {
      if (kind === 'visa') continue;
      for (const w of words) expect([kind, w, mine.has(foldKey(w))]).toEqual([kind, w, false]);
    }
    // "Approval notice" and "travel document" say other kinds as often: not a visa's.
    expect(one('Mortgage approval notice').type_key).toBe('loan');
    expect(one('Travel documents').type_key).toBeNull();
    expect(one('Passport and travel documents').type_key).toBe('passport');
  });
});

describe('whose, without an apostrophe', () => {
  it('"mansoors" is Mansoor’s; a word that is nobody stays as it was', () => {
    expect(one('mansoors passport').member_id).toBe('m-mansoor');
    expect(one('Mansoors EAD').member_id).toBe('m-mansoor');
    expect(one('Richas bank statements').member_id).toBe('m-richa');
    expect(one('James Lees passport').member_id).toBe('m-james');
    expect(one('passports').member_id).toBeNull();
    expect(one('zaras passport')).toMatchObject({ member_id: null, problem: null });
    // As a heading too.
    expect(
      read('Mansoors documents\nPassport').map((i) => [i.heading, i.type_key, i.member_id]),
    ).toEqual([['Mansoors documents', 'passport', 'm-mansoor']]);
  });

  it('never takes the "s" from a name that ends in one', () => {
    // "Chriss" is not Chris's: nobody is "Chriss", and "Chris" keeps its s.
    expect(one('chriss passport')).toMatchObject({ member_id: null, type_key: 'passport' });
    expect(one('Chris’s passport').member_id).toBe('m-chris');
  });

  it('a name as it is says whose when the rest says the kind', () => {
    // "James passport" keeps James as he is (never "Jame"), and is his.
    expect(one('James passport').member_id).toBe('m-james');
    expect(one('james passport').member_id).toBe('m-james');
    expect(one('mansoor passport').member_id).toBe('m-mansoor');
    // A name that takes the line's kind with it says nothing: "bills" are a bill's.
    expect(one('bills for 2024')).toMatchObject({ type_key: 'utility_bill', member_id: null });
    expect(one('Bill statement').member_id).toBeNull();
    // With no kind after it, a name as it is is a word to look for, not whose.
    expect(one('james gym card')).toMatchObject({
      member_id: null,
      title_words: ['james', 'gym', 'card'],
    });
  });
});
