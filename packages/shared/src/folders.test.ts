import { describe, expect, it } from 'vitest';
import { ITEM_SURE, levelItem, type LevelInput, type LevelKind } from './batch-levels.js';
import { untouchedAccept } from './batch-review.js';
import type { BatchDefaults } from './batches.js';
import type { DocumentTypeView } from './documents.js';
import {
  FOLDER_CHARS_MAX,
  FOLDER_CONFIDENCE,
  FOLDER_KIND_PARENTS,
  FOLDER_KIND_WORDS,
  FOLDER_NEW_TAGS_MAX,
  FOLDER_SEGMENTS_MAX,
  folderMatcher,
  foldKey,
  isGenericFolder,
  itemFolder,
  singular,
  suggestFromFolder,
  type FolderContext,
} from './folders.js';
import { correctionsOf, learningOf } from './learning.js';
import type { DetailProposal } from './proposals.js';

/**
 * Folder names → suggested details (0.8.0, S2): what a folder's segments say
 * of an item's kind, whose it is and its tags, and how that is weighed with
 * what the pages propose and the batch's defaults.
 */

const KINDS: LevelKind[] = [
  ['passport', 'Passport', 'household', 'expires_on', null],
  ['drivers_licence', "Driver's licence", 'household', 'expires_on', null],
  ['birth_certificate', 'Birth certificate', 'household', null, null],
  ['bank_statement', 'Bank / investment statement', 'adults', null, 'Bank statement'],
  ['insurance_policy', 'Insurance policy', 'household', 'expires_on', null],
  ['tax_return', 'Tax return', 'adults', null, null],
  ['tax_form', 'W-2 / 1099 / tax form', 'adults', null, null],
  ['medical_record', 'Medical record / immunisation', 'adults', null, null],
  ['prescription', 'Prescription', 'adults', 'expires_on', null],
  ['utility_bill', 'Utility / bill', 'household', 'expires_on', null],
  ['vehicle_registration', 'Vehicle title / registration', 'household', 'expires_on', null],
  ['employment_contract', 'Employment contract / offer', 'adults', 'expires_on', null],
  ['will', 'Will / trust / power of attorney', 'adults', 'review_on', null],
  ['marriage_certificate', 'Marriage / divorce certificate', 'adults', null, null],
  ['credit_card_statement', 'Credit card statement', 'adults', 'expires_on', null],
  ['school_report', 'School report', 'household', null, null],
  ['other', 'Something else', 'household', null, null],
].map(([key, label, vis, driver, short]) => ({
  key: key as string,
  label: label as string,
  default_visibility: vis as LevelKind['default_visibility'],
  expiry_driver: driver as LevelKind['expiry_driver'],
  fields: [],
  ...(short ? { short_label: short } : {}),
}));
const PEOPLE = [
  { id: 'm-sara', name: 'Sara' },
  { id: 'm-ahmed', name: 'Ahmed Khan' },
  { id: 'm-zain', name: 'Zain' },
];
const ctx = (over: Partial<FolderContext> = {}): FolderContext => ({
  types: KINDS,
  people: PEOPLE,
  tags: [
    { value: 'holiday', visibility: 'household' },
    { value: 'car', visibility: 'household' },
    { value: 'ivf', visibility: 'private' },
  ],
  ...over,
});
const NO_DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: null,
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};
const day = (date: string) => ({ date, precision: 'day' as const });
/** "Résumés/résumé.pdf" composed, its name decomposed (a Mac's), and the folder composed. */
const NFC_PATH = `R${String.fromCharCode(0xe9)}sum${String.fromCharCode(0xe9)}s/r${String.fromCharCode(0xe9)}sum${String.fromCharCode(0xe9)}.pdf`;
const NFD_NAME = (NFC_PATH.split('/')[1] ?? '').normalize('NFD');
const NFC_DIR = NFC_PATH.split('/')[0];

describe('the folder an item came from, as it is kept (S2)', () => {
  it('keeps its folders without the file’s own name, tidied and bounded', () => {
    expect(itemFolder('Passports/Ahmed/scan 1.pdf', { fileName: 'scan 1.pdf' })).toBe(
      'Passports/Ahmed',
    );
    // The file's name is dropped only when it is the last segment.
    expect(itemFolder('Passports/Ahmed', { fileName: 'scan 1.pdf' })).toBe('Passports/Ahmed');
    // Compared in NFC: a name decomposed (a Mac's) is the same name.
    expect(itemFolder(NFC_PATH, { fileName: NFD_NAME })).toBe(NFC_DIR);
    expect(itemFolder(NFC_PATH.normalize('NFD'), { fileName: NFD_NAME.normalize('NFC') })).toBe(
      NFC_DIR,
    );
    expect(itemFolder('Passports\\Ahmed\\x.pdf', { withFileName: true })).toBe('Passports/Ahmed');
    expect(itemFolder('./a//../Bills/ ', {})).toBe('a/Bills');
    // Control characters (a bidi override among them) are never kept.
    expect(itemFolder('Pass‮ports/Ah\u0000med\n', {})).toBe('Passports/Ahmed');
    // Letters that draw nothing go, and a segment with nothing visible left.
    expect(itemFolder('ㅤㅤ/Pass⠀ports/ᅟᅠﾠ/x.pdf', { withFileName: true })).toBe('Passports');
    expect(itemFolder('', {})).toBeNull();
    expect(itemFolder('scan.pdf', { fileName: 'scan.pdf' })).toBeNull();
    const deep = Array.from({ length: 15 }, (_, i) => `level${i}`).join('/');
    const kept = itemFolder(deep) as string;
    expect(kept.split('/')).toHaveLength(FOLDER_SEGMENTS_MAX);
    // The deepest are kept: they are nearest the file.
    expect(kept.endsWith('level14')).toBe(true);
    const long = Array.from({ length: 10 }, () => 'x'.repeat(100)).join('/');
    expect((itemFolder(long) as string).length).toBeLessThanOrEqual(FOLDER_CHARS_MAX);
  });

  it('drops the top folder’s name only when it is a container', () => {
    expect(itemFolder('Scans/Passports/a.pdf', { withFileName: true, dropGenericTop: true })).toBe(
      'Passports',
    );
    expect(
      itemFolder('My Documents/Bills/a.pdf', { withFileName: true, dropGenericTop: true }),
    ).toBe('Bills');
    // "Ahmed" as a top folder says whose: kept.
    expect(itemFolder('Ahmed/Passport/a.pdf', { withFileName: true, dropGenericTop: true })).toBe(
      'Ahmed/Passport',
    );
    for (const g of ['Scans', 'Documents', 'Downloads', 'Desktop', 'my_documents', '2024']) {
      expect(isGenericFolder(g)).toBe(true);
    }
    expect(isGenericFolder('Ahmed')).toBe(false);
  });
});

describe('what a folder’s segments say (S2)', () => {
  it('folds separators, case, accents, possessives and simple plurals — and not what only looks plural', () => {
    expect(foldKey('Bank_Statements')).toBe('bank statement');
    expect(foldKey('bank-statements')).toBe('bank statement');
    expect(foldKey('Bank.Statements')).toBe('bank statement');
    expect(foldKey('Ahmed’s papers')).toBe('ahmed paper');
    expect(foldKey('Policies')).toBe('policy');
    expect(foldKey('Café')).toBe('cafe');
    expect(singular('passports')).toBe('passport');
    expect(singular('taxes')).toBe('tax');
    expect(singular('glasses')).toBe('glass');
    for (const w of ['news', 'series', 'status', 'bus', 'gas']) expect(singular(w)).toBe(w);
    expect(singular('ids')).toBe('id');
    expect(singular('gps')).toBe('gp');
  });

  it('names a kind by its name, a long part of it, its short name or the families’ own words', () => {
    const kindOf = (folder: string) => suggestFromFolder(folder, ctx())?.type_key ?? null;
    expect(kindOf('Passports')).toBe('passport');
    expect(kindOf('passport')).toBe('passport');
    expect(kindOf('Birth certificates')).toBe('birth_certificate');
    expect(kindOf('Bank statements')).toBe('bank_statement');
    expect(kindOf('Bank_Statements')).toBe('bank_statement');
    expect(kindOf('Bank')).toBe('bank_statement');
    // Its short name, and a part of its name of more than one word.
    expect(kindOf('Investment statements')).toBe('bank_statement');
    expect(kindOf('Power of attorney')).toBe('will');
    expect(kindOf('Insurance')).toBe('insurance_policy');
    expect(kindOf('Tax')).toBe('tax_return');
    expect(kindOf('Medical')).toBe('medical_record');
    expect(kindOf('GPs')).toBe('medical_record');
    expect(kindOf('Bills')).toBe('utility_bill');
    expect(kindOf('driving-licence')).toBe('drivers_licence');
    expect(kindOf('drivers_licence')).toBe('drivers_licence');
    // Years, dates and numbering are ignored.
    expect(kindOf('2024/Tax 2023-24')).toBe('tax_return');
    expect(kindOf('01 Passports')).toBe('passport');
    expect(kindOf('Bills/March 2024')).toBe('utility_bill');
    // "Something else" is no kind.
    expect(kindOf('Something else')).toBeNull();
    // A kind the uploader is not given is never suggested.
    expect(
      suggestFromFolder('Passports', ctx({ types: KINDS.filter((k) => k.key !== 'passport') }))
        ?.type_key ?? null,
    ).toBeNull();
  });

  it('never a word that could as well hold another kind’s papers, nor a one-word part of a name', () => {
    const kindOf = (folder: string) => suggestFromFolder(folder, ctx())?.type_key ?? null;
    for (const w of [
      'Statements',
      'Receipts',
      'Trust',
      'Property',
      'School',
      'Gas',
      'Licences',
      'License',
      'Wedding',
      'Divorce',
      'Birth',
      // One word of a kind's name: "Employment contract / offer", "Vehicle title / registration".
      'Offers',
      'Registration',
    ]) {
      expect(kindOf(w), w).toBeNull();
    }
    // Their longer forms still say the kind.
    expect(kindOf('Gas bills')).toBe('utility_bill');
    expect(kindOf('Divorce certificate')).toBe('marriage_certificate');
  });

  it('keeps its synonyms to one kind each, and its parents to kinds of the vault', () => {
    const seen = new Map<string, string>();
    for (const [kind, words] of Object.entries(FOLDER_KIND_WORDS)) {
      for (const w of words) {
        const key = foldKey(w);
        expect(key, w).not.toBe('');
        const was = seen.get(key);
        expect(was === undefined || was === kind, `${w}: ${was} and ${kind}`).toBe(true);
        seen.set(key, kind);
      }
    }
    for (const [child, parent] of Object.entries(FOLDER_KIND_PARENTS)) {
      expect(FOLDER_KIND_WORDS[child]).toBeDefined();
      expect(FOLDER_KIND_WORDS[parent]).toBeDefined();
    }
  });

  it('a kind beside other words is still the kind, the rest a tag; the specific under the general', () => {
    const car = suggestFromFolder('Car insurance', ctx());
    expect(car?.type_key).toBe('insurance_policy');
    expect(car?.tags).toEqual([{ value: 'car', existing: true, visibility: 'household' }]);
    const home = suggestFromFolder('Home contents insurance', ctx());
    expect(home?.type_key).toBe('insurance_policy');
    expect(home?.tags).toEqual([{ value: 'Home contents', existing: false, visibility: null }]);
    expect(suggestFromFolder('Tax/P60', ctx())?.type_key).toBe('tax_form');
    expect(suggestFromFolder('Medical/Prescriptions', ctx())?.type_key).toBe('prescription');
    // Two kinds neither under the other say none.
    expect(suggestFromFolder('Passports/Insurance', ctx())?.type_key).toBeNull();
    expect(suggestFromFolder('Family/Passports', ctx())?.type_key).toBe('passport');
  });

  it('a card’s statements and school reports have folder words of their own (S5)', () => {
    const kind = (folder: string) => suggestFromFolder(folder, ctx())?.type_key ?? null;
    expect(kind('Credit cards')).toBe('credit_card_statement');
    expect(kind('Credit card statements/2026')).toBe('credit_card_statement');
    // The specific under the general: a card's statements kept under Bank.
    expect(kind('Bank/Credit card')).toBe('credit_card_statement');
    expect(kind('Bank statements')).toBe('bank_statement');
    expect(kind('School reports')).toBe('school_report');
    expect(suggestFromFolder('School reports/Zain', ctx())).toMatchObject({
      type_key: 'school_report',
      owner_member_id: 'm-zain',
    });
    // "School" alone keeps a school's letters too: no kind.
    expect(kind('School/Zain')).toBeNull();
    // Two kinds neither under the other still say none.
    expect(kind('Credit cards/Passports')).toBeNull();
    expect(kind('School reports/Insurance')).toBeNull();
  });

  it('names somebody the uploader can see, by their name or its first word', () => {
    const who = (folder: string, over: Partial<FolderContext> = {}) =>
      suggestFromFolder(folder, ctx(over))?.owner_member_id ?? null;
    expect(who('Ahmed')).toBe('m-ahmed');
    expect(who('Ahmed Khan')).toBe('m-ahmed');
    expect(who('ahmed_khan')).toBe('m-ahmed');
    expect(who('Ahmed’s documents')).toBe('m-ahmed');
    expect(who('Passports/Sara')).toBe('m-sara');
    // A kind and a person in one segment, either way round.
    const both = suggestFromFolder('Sara passport', ctx());
    expect([both?.type_key, both?.owner_member_id]).toEqual(['passport', 'm-sara']);
    const turned = suggestFromFolder('Passports - Zain', ctx());
    expect([turned?.type_key, turned?.owner_member_id]).toEqual(['passport', 'm-zain']);
    // A name ending in s is never made singular.
    expect(who('James', { people: [...PEOPLE, { id: 'm-james', name: 'James' }] })).toBe('m-james');
    // Two segments naming two people name nobody.
    expect(who('Sara/Zain')).toBeNull();
  });

  it('never names somebody the uploader cannot see: a hidden name is any other word', () => {
    const seen = PEOPLE.filter((m) => m.id !== 'm-sara');
    const hidden = suggestFromFolder('Sara/Passports', ctx({ people: seen }));
    const nobody = suggestFromFolder('Qwerty/Passports', ctx({ people: seen }));
    expect(hidden?.owner_member_id).toBeNull();
    // Exactly as a name nobody has: a new tag, as written, and nothing more.
    expect(hidden?.tags).toEqual([{ value: 'Sara', existing: false, visibility: null }]);
    expect(nobody?.tags).toEqual([{ value: 'Qwerty', existing: false, visibility: null }]);
    expect(hidden?.type_key).toBe(nobody?.type_key);
  });

  it('gives a teen themselves alone: a segment with somebody else’s name gives no person and no tag, but its kind', () => {
    const teen = { choosable: (id: string) => id === 'm-zain' };
    expect(suggestFromFolder('Zain/Passports', ctx(teen))?.owner_member_id).toBe('m-zain');
    const other = suggestFromFolder('Sara/Passports', ctx(teen));
    expect(other?.owner_member_id).toBeNull();
    expect(other?.tags).toEqual([]);
    const inOne = suggestFromFolder('Sara passport trip', ctx(teen));
    expect(inOne?.type_key).toBe('passport');
    expect(inOne?.owner_member_id).toBeNull();
    expect(inOne?.tags).toEqual([]);
  });

  it('a name two of them share suggests nobody, and no tag', () => {
    const two = [...PEOPLE, { id: 'm-sara-2', name: 'Sara Ali' }];
    const s = suggestFromFolder('Sara/Passports', ctx({ people: two }));
    expect(s?.owner_member_id).toBeNull();
    expect(s?.tags).toEqual([]);
    // Her full name still says her.
    expect(suggestFromFolder('Sara Ali', ctx({ people: two }))?.owner_member_id).toBe('m-sara-2');
  });

  it('a name that is both a kind and a person says neither', () => {
    const will = [...PEOPLE, { id: 'm-will', name: 'Will' }];
    const s = suggestFromFolder('Will', ctx({ people: will }));
    expect([s?.type_key, s?.owner_member_id, s?.tags]).toEqual([null, null, []]);
  });

  it('the household’s own name is a container, with "The" and "family" or without', () => {
    for (const name of ['The Khan family', 'Khan family', 'Khan', 'Khan Family Documents']) {
      expect(
        suggestFromFolder(`${name}/Passports`, ctx({ household: 'The Khan family' }))?.tags,
        name,
      ).toEqual([]);
    }
    // Words of its own beside it are a tag.
    expect(
      suggestFromFolder('Khan holiday house', ctx({ household: 'The Khan family' }))?.tags,
    ).toEqual([{ value: 'Khan holiday house', existing: false, visibility: null }]);
  });

  it('proposes tags: one already used, with how widely; or a new one, as written, dates gone', () => {
    const s = suggestFromFolder('Scans/Holidays/2024/Greece Trip 2024', ctx());
    expect(s?.tags).toEqual([
      { value: 'Greece Trip', existing: false, visibility: null },
      { value: 'holiday', existing: true, visibility: 'household' },
    ]);
    expect(suggestFromFolder('IVF', ctx())?.tags).toEqual([
      { value: 'ivf', existing: true, visibility: 'private' },
    ]);
    // Containers, years and dates are never tags.
    expect(suggestFromFolder('Documents/2024/March', ctx())?.tags).toEqual([]);
    // At most a few new ones.
    const many = suggestFromFolder('aa/bb/cc/dd/ee', ctx());
    expect(many?.tags.filter((t) => !t.existing)).toHaveLength(FOLDER_NEW_TAGS_MAX);
  });

  it('is built once for a context: 200 folders against 5,000 tags in well under a second', () => {
    const tags = Array.from({ length: 5000 }, (_, i) => ({
      value: `tag ${i} word`,
      visibility: 'household' as const,
    }));
    const people = Array.from({ length: 40 }, (_, i) => ({
      id: `m-${i}`,
      name: `Person${i} Khan`,
    }));
    const started = Date.now();
    const match = folderMatcher(ctx({ tags, people }));
    const built = Date.now() - started;
    for (let i = 0; i < 200; i += 1) {
      match(`Scans/Person${i % 40}/Passports/Holiday ${i}/tag ${i} word/Greece`);
    }
    const all = Date.now() - started;
    (globalThis as { console?: { info: (s: string) => void } }).console?.info(
      `folderMatcher: built in ${built} ms; 200 folders against 5,000 tags in ${all} ms`,
    );
    expect(all).toBeLessThan(1000);
  });
});

// ------------------------------------------------------- weighed with the pages

const level = (over: Partial<LevelInput>) =>
  levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal: null,
    duplicate: null,
    defaults: NO_DEFAULTS,
    types: KINDS,
    people: PEOPLE,
    role: 'adult',
    me: 'm-sara',
    ...over,
  });
const folder = (path: string, over: Partial<FolderContext> = {}) =>
  suggestFromFolder(path, ctx(over));
const passportSure: DetailProposal = {
  type_key: { value: 'passport', confidence: 0.95, cue: 'kind_words' },
  owner_member_id: { value: 'm-ahmed', confidence: 0.92, cue: 'name_labelled' },
  expires: { value: day('2031-03-14'), confidence: 0.9, cue: 'expiry_label' },
};
const passportAt = (c: number): DetailProposal => ({
  type_key: { value: 'passport', confidence: c, cue: 'kind_words' },
  owner_member_id: { value: 'm-ahmed', confidence: c, cue: 'name_on_page' },
  expires: { value: day('2031-03-14'), confidence: 0.9, cue: 'expiry_label' },
});

describe('a folder weighed with the pages and the batch (S2)', () => {
  it('fills a blank, from the folder, unsure: never Ready on the folder alone', () => {
    const out = level({ proposal: {}, folder: folder('Ahmed/Passports') });
    expect(out.proposals?.type_key).toEqual({
      value: 'passport',
      from: 'folder',
      confidence: FOLDER_CONFIDENCE,
      cue: null,
    });
    expect(out.proposals?.owner_member_id?.from).toBe('folder');
    expect(FOLDER_CONFIDENCE).toBeLessThan(ITEM_SURE.type_key);
    expect(out.level).toBe('check');
    expect(out.tags.map((t) => t.words)).toContain('Kind from the folder name');
    expect(out.tags.map((t) => t.words)).toContain('Whose it is: from the folder name');
  });

  it('agreeing with the pages: Ready where the pages alone were nearly sure, else just under', () => {
    expect(level({ proposal: passportAt(0.8) }).level).toBe('check');
    const out = level({ proposal: passportAt(0.8), folder: folder('Ahmed/Passports') });
    expect(out.level).toBe('ready');
    expect(out.proposals?.type_key).toMatchObject({
      value: 'passport',
      from: 'pages',
      confidence: 0.9,
      cue: 'kind_words',
      folder: true,
    });
    expect(out.proposals?.owner_member_id).toMatchObject({ from: 'pages', folder: true });
    // Under the floor: surer, still Check.
    const under = level({ proposal: passportAt(0.76), folder: folder('Ahmed/Passports') });
    expect(under.level).toBe('check');
    expect(under.proposals?.type_key).toMatchObject({ confidence: 0.84, folder: true });
  });

  it('never makes an unsure rule of the uploader’s Ready (I4)', () => {
    // A rule alone, not sure yet (0.78), with the folder agreeing: still Check.
    const ruleOnly = level({
      proposal: {
        ...passportSure,
        type_key: { value: 'passport', confidence: 0.78, cue: 'learned' },
      },
      folder: folder('Passports'),
    });
    expect(ruleOnly.proposals?.type_key).toMatchObject({ from: 'learned', confidence: 0.84 });
    expect(ruleOnly.level).toBe('check');
    // The pages at 0.70 made 0.84 by a rule, with the folder agreeing: from 0.70, still Check.
    const raisedByRule = level({
      proposal: {
        ...passportSure,
        type_key: {
          value: 'passport',
          confidence: 0.84,
          cue: 'kind_words',
          learned: true,
          page_confidence: 0.7,
        },
      },
      folder: folder('Passports'),
    });
    expect(raisedByRule.proposals?.type_key).toMatchObject({ confidence: 0.84, folder: true });
    expect(raisedByRule.level).toBe('check');
    // A sure rule stays sure.
    const sureRule = level({
      proposal: {
        ...passportSure,
        type_key: { value: 'passport', confidence: 0.9, cue: 'learned' },
      },
      folder: folder('Passports'),
    });
    expect(sureRule.level).toBe('ready');
  });

  it('disagreeing, the pages win and the item is Check, with both said by their short names', () => {
    const out = level({ proposal: passportSure, folder: folder('Sara/Bank statements') });
    expect(out.proposals?.type_key).toMatchObject({ value: 'passport', from: 'pages' });
    expect(out.proposals?.owner_member_id).toMatchObject({ value: 'm-ahmed', from: 'pages' });
    expect(out.level).toBe('check');
    expect(out.tags.filter((t) => t.code === 'clash_folder').map((t) => t.words)).toEqual([
      'The folder says Bank statement; the pages look like a passport',
      'The folder says Sara; the pages say Ahmed Khan',
    ]);
    // Without the folder, the same pages are Ready.
    expect(level({ proposal: passportSure }).level).toBe('ready');
  });

  it('the batch’s defaults win over the folder, which fills only what they leave blank', () => {
    const defaults = { ...NO_DEFAULTS, type_key: 'insurance_policy' };
    const out = level({ proposal: {}, defaults, folder: folder('Ahmed/Passports') });
    expect(out.proposals?.type_key).toEqual({
      value: 'insurance_policy',
      from: 'batch',
      confidence: null,
      cue: null,
    });
    // No clash with a default: the folder is silent there.
    expect(out.tags.some((t) => t.code === 'clash_folder')).toBe(false);
    // Whose: left blank by the batch, so the folder's.
    expect(out.proposals?.owner_member_id?.from).toBe('folder');
    // And tags: the batch's, when it chose any.
    const tagged = level({
      proposal: {},
      defaults: { ...NO_DEFAULTS, tags: ['scanned'] },
      folder: folder('Holidays/Greece'),
    });
    expect(tagged.proposals?.tags).toBeUndefined();
    const untagged = level({ proposal: {}, folder: folder('Holidays/Greece') });
    expect(untagged.proposals?.tags).toEqual([
      { value: 'Greece', from: 'folder', existing: false, ticked: false },
      { value: 'holiday', from: 'folder', existing: true, ticked: true },
    ]);
  });

  it('ticks a used tag only where it is seen at least as widely as the item would be (IVF)', () => {
    // A tag of her Only me papers, and a file going to everybody: offered, not ticked.
    const everybody = level({
      proposal: passportSure,
      defaults: { ...NO_DEFAULTS, visibility: 'household' },
      folder: folder('IVF'),
    });
    expect(everybody.proposals?.visibility.value).toBe('household');
    expect(everybody.proposals?.tags).toEqual([
      { value: 'ivf', from: 'folder', existing: true, ticked: false },
    ]);
    // The same file kept Only me: ticked.
    const onlyMe = level({
      proposal: {
        ...passportSure,
        owner_member_id: { value: 'm-sara', confidence: 0.92, cue: 'name_labelled' },
      },
      defaults: { ...NO_DEFAULTS, visibility: 'private' },
      folder: folder('IVF'),
    });
    expect(onlyMe.proposals?.tags).toEqual([
      { value: 'ivf', from: 'folder', existing: true, ticked: true },
    ]);
  });

  it('a teen’s folder never names somebody else; a person or kind no longer to be chosen is none', () => {
    const teen = level({
      role: 'teen',
      me: 'm-zain',
      proposal: {},
      folder: folder('Sara/Passports', { choosable: (id) => id === 'm-zain' }),
    });
    expect(teen.proposals?.owner_member_id).toEqual({
      value: 'm-zain',
      from: 'batch',
      confidence: null,
      cue: null,
    });
    const gone = level({
      proposal: {},
      folder: folder('Ahmed/Passports'),
      people: PEOPLE.filter((m) => m.id !== 'm-ahmed'),
      types: KINDS.filter((k) => k.key !== 'passport'),
    });
    expect(gone.proposals?.type_key).toBeUndefined();
    expect(gone.proposals?.owner_member_id).toBeUndefined();
  });

  it('untouched — as Accept all Ready files it — never a folder’s tag, ticked or not', () => {
    const out = level({
      proposal: passportSure,
      folder: folder('Ahmed/Passports/Holidays/Greece'),
    });
    expect(out.proposals?.tags?.some((t) => t.ticked)).toBe(true);
    const body = untouchedAccept({
      proposals: out.proposals as NonNullable<typeof out.proposals>,
      defaults: NO_DEFAULTS,
      types: KINDS as unknown as DocumentTypeView[],
      people: PEOPLE.map((m) => ({ id: m.id, display_name: m.name })),
      role: 'adult',
      me: 'm-sara',
    });
    expect(body.type_key).toBe('passport');
    expect(body.owner_member_id).toBe('m-ahmed');
    expect(body.tags).toEqual([]);
  });

  it('accepting what the folder suggested is a confirmation, as accepting the pages’ is', () => {
    const out = level({
      proposal: { issued_by: { value: 'Northern Power', confidence: 0.9, cue: 'letterhead' } },
      folder: folder('Ahmed/Bills'),
    });
    const p = out.proposals as NonNullable<typeof out.proposals>;
    const filed = {
      type_key: 'utility_bill',
      owner_member_id: 'm-ahmed',
      issued: null,
      expires: null,
      identifier: null,
      issued_by: 'Northern Power',
    };
    expect(correctionsOf({ proposals: p, filed, kind: { expiry_driver: null } })).toEqual([]);
    expect(learningOf({ proposals: p, filed, role: 'adult' }).steps).toEqual([
      { field: 'type_key', value: 'utility_bill', corrected: false },
      { field: 'owner_member_id', value: 'm-ahmed', corrected: false },
    ]);
  });
});
