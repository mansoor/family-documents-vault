import { describe, expect, it } from 'vitest';
import { ITEM_SURE, levelItem, type LevelInput, type LevelKind } from './batch-levels.js';
import { untouchedAccept } from './batch-review.js';
import type { BatchDefaults } from './batches.js';
import type { DocumentTypeView } from './documents.js';
import {
  FOLDER_CHARS_MAX,
  FOLDER_CONFIDENCE,
  FOLDER_KIND_WORDS,
  FOLDER_NEW_TAGS_MAX,
  FOLDER_SEGMENTS_MAX,
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
  ['passport', 'Passport', 'household', 'expires_on'],
  ['drivers_licence', "Driver's licence", 'household', 'expires_on'],
  ['birth_certificate', 'Birth certificate', 'household', null],
  ['bank_statement', 'Bank / investment statement', 'adults', null],
  ['insurance_policy', 'Insurance policy', 'household', 'expires_on'],
  ['tax_return', 'Tax return', 'adults', null],
  ['medical_record', 'Medical record / immunisation', 'adults', null],
  ['utility_bill', 'Utility / bill', 'household', 'expires_on'],
  ['will', 'Will / trust / power of attorney', 'adults', 'review_on'],
  ['other', 'Something else', 'household', null],
].map(([key, label, vis, driver]) => ({
  key: key as string,
  label: label as string,
  default_visibility: vis as LevelKind['default_visibility'],
  expiry_driver: driver as LevelKind['expiry_driver'],
  fields: [],
}));
const PEOPLE = [
  { id: 'm-sara', name: 'Sara' },
  { id: 'm-ahmed', name: 'Ahmed Khan' },
  { id: 'm-zain', name: 'Zain' },
];
const ctx = (over: Partial<FolderContext> = {}): FolderContext => ({
  types: KINDS,
  people: PEOPLE,
  tags: ['holiday', 'car-insurance'],
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

describe('the folder an item came from, as it is kept (S2)', () => {
  it('keeps its folders without the file’s own name, tidied and bounded', () => {
    expect(itemFolder('Passports/Ahmed/scan 1.pdf', { fileName: 'scan 1.pdf' })).toBe(
      'Passports/Ahmed',
    );
    // The file's name is dropped only when it is the last segment.
    expect(itemFolder('Passports/Ahmed', { fileName: 'scan 1.pdf' })).toBe('Passports/Ahmed');
    expect(itemFolder('Passports\\Ahmed\\x.pdf', { withFileName: true })).toBe('Passports/Ahmed');
    expect(itemFolder('./a//../Bills/ ', {})).toBe('a/Bills');
    // Control characters (a bidi override among them) are never kept.
    expect(itemFolder('Pass‮ports/Ah\u0000med\n', {})).toBe('Passports/Ahmed');
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
  it('folds separators, case, accents, possessives and simple plurals', () => {
    expect(foldKey('Bank_Statements')).toBe('bank statement');
    expect(foldKey('bank-statements')).toBe('bank statement');
    expect(foldKey('Bank.Statements')).toBe('bank statement');
    expect(foldKey('Ahmed’s papers')).toBe('ahmed paper');
    expect(foldKey('Policies')).toBe('policy');
    expect(foldKey('Café')).toBe('cafe');
    expect(singular('passports')).toBe('passport');
    expect(singular('taxes')).toBe('tax');
    expect(singular('glasses')).toBe('glass');
    expect(singular('bus')).toBe('bus');
  });

  it('names a kind by its label, a part of it, its key or the families’ words', () => {
    const kindOf = (folder: string) => suggestFromFolder(folder, ctx())?.type_key ?? null;
    expect(kindOf('Passports')).toBe('passport');
    expect(kindOf('passport')).toBe('passport');
    expect(kindOf('Birth certificates')).toBe('birth_certificate');
    expect(kindOf('Bank statements')).toBe('bank_statement');
    expect(kindOf('Bank_Statements')).toBe('bank_statement');
    // A part of a label: "Bank / investment statement" is "Bank" too.
    expect(kindOf('Bank')).toBe('bank_statement');
    expect(kindOf('Insurance')).toBe('insurance_policy');
    expect(kindOf('Tax')).toBe('tax_return');
    expect(kindOf('Medical')).toBe('medical_record');
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

  it('keeps its synonyms to kinds that exist, each to one kind', () => {
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
  });

  it('two segments saying different kinds say none; the nearest saying one is enough', () => {
    expect(suggestFromFolder('Passports/Insurance', ctx())?.type_key).toBeNull();
    expect(suggestFromFolder('Family/Passports', ctx())?.type_key).toBe('passport');
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
    // Two segments naming two people name nobody.
    expect(who('Sara/Zain')).toBeNull();
  });

  it('never names somebody the uploader cannot see: a hidden name is any other word', () => {
    const seen = PEOPLE.filter((m) => m.id !== 'm-sara');
    const hidden = suggestFromFolder('Sara/Passports', ctx({ people: seen }));
    const nobody = suggestFromFolder('Qwerty/Passports', ctx({ people: seen }));
    expect(hidden?.owner_member_id).toBeNull();
    // Exactly as a name nobody has: a new tag, and nothing more.
    expect(hidden?.tags).toEqual([{ value: 'sara', existing: false }]);
    expect(nobody?.tags).toEqual([{ value: 'qwerty', existing: false }]);
    expect(hidden?.type_key).toBe(nobody?.type_key);
  });

  it('gives a teen themselves alone; another of the family is no person and no tag', () => {
    const teen = { choosable: (id: string) => id === 'm-zain' };
    expect(suggestFromFolder('Zain/Passports', ctx(teen))?.owner_member_id).toBe('m-zain');
    const other = suggestFromFolder('Sara/Passports', ctx(teen));
    expect(other?.owner_member_id).toBeNull();
    expect(other?.tags).toEqual([]);
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

  it('proposes tags: one already used, or a new one from the folder’s name', () => {
    const s = suggestFromFolder('Scans/Holidays/Car insurance/2024/Greece trip', ctx());
    expect(s?.tags).toEqual([
      { value: 'greece trip', existing: false },
      // "Car insurance" is the tag "car-insurance", already used: not the kind.
      { value: 'car-insurance', existing: true },
      { value: 'holiday', existing: true },
    ]);
    // Containers, years and dates are never tags.
    expect(suggestFromFolder('Documents/2024/March', ctx())?.tags).toEqual([]);
    // At most a few new ones.
    const many = suggestFromFolder('aa/bb/cc/dd/ee', ctx());
    expect(many?.tags.filter((t) => !t.existing)).toHaveLength(FOLDER_NEW_TAGS_MAX);
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
const pages = (over: DetailProposal): DetailProposal => over;
const passportSure: DetailProposal = {
  type_key: { value: 'passport', confidence: 0.95, cue: 'kind_words' },
  owner_member_id: { value: 'm-ahmed', confidence: 0.92, cue: 'name_labelled' },
  expires: { value: day('2031-03-14'), confidence: 0.9, cue: 'expiry_label' },
};

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

  it('agreeing with the pages makes them surer: Ready on the folder and the pages together', () => {
    const unsure = pages({
      type_key: { value: 'passport', confidence: 0.76, cue: 'kind_words' },
      owner_member_id: { value: 'm-ahmed', confidence: 0.78, cue: 'name_on_page' },
      expires: { value: day('2031-03-14'), confidence: 0.9, cue: 'expiry_label' },
    });
    expect(level({ proposal: unsure }).level).toBe('check');
    const out = level({ proposal: unsure, folder: folder('Ahmed/Passports') });
    expect(out.level).toBe('ready');
    expect(out.proposals?.type_key).toMatchObject({
      value: 'passport',
      from: 'pages',
      confidence: 0.86,
      cue: 'kind_words',
      folder: true,
    });
    expect(out.proposals?.owner_member_id).toMatchObject({ from: 'pages', folder: true });
  });

  it('disagreeing, the pages win and the item is Check, with both said', () => {
    const out = level({ proposal: passportSure, folder: folder('Sara/Driving licences') });
    expect(out.proposals?.type_key).toMatchObject({ value: 'passport', from: 'pages' });
    expect(out.proposals?.owner_member_id).toMatchObject({ value: 'm-ahmed', from: 'pages' });
    expect(out.level).toBe('check');
    expect(out.tags.filter((t) => t.code === 'clash_folder').map((t) => t.words)).toEqual([
      "The folder says Driver's licence; the pages look like a passport",
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
      { value: 'greece', from: 'folder', existing: false },
      { value: 'holiday', from: 'folder', existing: true },
    ]);
  });

  it('a teen’s folder never names somebody else; and the rules agree as the pages do', () => {
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
    // A rule's proposal and the folder agreeing: surer, as the pages are.
    const learned = level({
      proposal: { type_key: { value: 'passport', confidence: 0.78, cue: 'learned' } },
      folder: folder('Passports'),
    });
    expect(learned.proposals?.type_key).toMatchObject({
      from: 'learned',
      confidence: 0.88,
      folder: true,
    });
    const against = level({
      proposal: { type_key: { value: 'passport', confidence: 0.9, cue: 'learned' } },
      folder: folder('Bills'),
    });
    expect(against.tags.find((t) => t.code === 'clash_folder')?.words).toBe(
      'The folder says Utility / bill; your earlier choices say a passport',
    );
  });

  it('a person or kind the folder names that is no longer to be chosen is none', () => {
    const s = folder('Ahmed/Passports');
    const out = level({
      proposal: {},
      folder: s,
      people: PEOPLE.filter((m) => m.id !== 'm-ahmed'),
      types: KINDS.filter((k) => k.key !== 'passport'),
    });
    expect(out.proposals?.type_key).toBeUndefined();
    expect(out.proposals?.owner_member_id).toBeUndefined();
  });

  it('untouched, the card files the folder’s kind, person and used tags, never a new tag', () => {
    const out = level({
      proposal: passportSure,
      folder: folder('Ahmed/Passports/Holidays/Greece'),
    });
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
    expect(body.tags).toEqual(['holiday']);
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
