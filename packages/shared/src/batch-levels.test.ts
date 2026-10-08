import { describe, expect, it } from 'vitest';
import {
  CLASH_CONFIDENCE,
  ITEM_SURE,
  levelItem,
  levelSummary,
  storedProposal,
  type LevelInput,
  type LevelKind,
} from './batch-levels.js';
import type { BatchDefaults } from './batches.js';
import type { DetailProposal } from './proposals.js';

/**
 * Levels and tags (Phase 6, I2): what the pages proposed, merged with the
 * batch's defaults and the kinds as they are now. Defaults fill only blanks
 * (Q4); a confident disagreement goes to Check with both values; who can
 * see it is never widened by a guess.
 */

const core = (
  over: Record<string, { shown?: boolean; required?: boolean; label?: string | null }> = {},
) => {
  const out: Record<string, { shown: boolean; required: boolean; label: string | null }> = {};
  for (const k of [
    'identifier',
    'issued_by',
    'issued',
    'expires',
    'physical_location',
    'tags',
    'notes',
  ]) {
    out[k] = { shown: true, required: false, label: null, ...over[k] };
  }
  return out as unknown as NonNullable<LevelKind['core']>;
};

const KINDS: LevelKind[] = [
  {
    key: 'passport',
    label: 'Passport',
    default_visibility: 'household',
    expiry_driver: 'expires_on',
    fields: [],
    core: core(),
  },
  {
    key: 'drivers_licence',
    label: "Driver's licence",
    default_visibility: 'household',
    expiry_driver: 'expires_on',
    fields: [],
    core: core(),
  },
  {
    key: 'medical_record',
    label: 'Medical record',
    default_visibility: 'adults',
    expiry_driver: null,
    fields: [],
    core: core(),
  },
  {
    key: 'vehicle',
    label: 'Car',
    default_visibility: 'household',
    expiry_driver: null,
    fields: [{ key: 'plate', label: 'Registration plate', kind: 'text', required: true }],
    core: core({ physical_location: { required: true, label: 'Where the logbook is' } }),
  },
];
const PEOPLE = [
  { id: 'm-sara', name: 'Sara' },
  { id: 'm-ahmed', name: 'Ahmed' },
  { id: 'm-zain', name: 'Zain' },
];
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
/** A proposal with one field left out. */
const without = (p: DetailProposal, field: keyof DetailProposal): DetailProposal => {
  const out = { ...p };
  delete out[field];
  return out;
};
/** A passport read well: kind, person, dates and number, all sure. */
const PASSPORT: DetailProposal = {
  type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
  owner_member_id: { value: 'm-sara', confidence: 0.9, cue: 'name_labelled' },
  issued: { value: day('2021-03-14'), confidence: 0.89, cue: 'issue_label' },
  expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
  identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
  issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
};

const level = (over: Partial<LevelInput> = {}) =>
  levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal: PASSPORT,
    duplicate: null,
    defaults: NO_DEFAULTS,
    types: KINDS,
    people: PEOPLE,
    role: 'adult',
    me: 'm-ahmed',
    ...over,
  });
const codes = (l: ReturnType<typeof levelItem>) => l.tags.map((t) => t.code);
const words = (l: ReturnType<typeof levelItem>) => l.tags.map((t) => t.words);

describe('an item’s level', () => {
  it('Ready: the kind and the person sure, and everything the kind requires filled', () => {
    const l = level();
    expect(l.level).toBe('ready');
    expect(l.tags).toEqual([]);
    expect(l.clashes).toEqual([]);
    expect(l.proposals).toMatchObject({
      type_key: { value: 'passport', from: 'pages', confidence: 0.97, cue: 'kind_words' },
      owner_member_id: { value: 'm-sara', from: 'pages', confidence: 0.9 },
      expires: { value: day('2031-03-14'), from: 'pages', confidence: 0.94 },
      identifier: { value: '533401872', from: 'pages' },
      issued_by: { value: 'United Kingdom', from: 'pages' },
      visibility: { value: 'household', from: 'kind' },
    });
  });

  it('not read yet: no level, and the card starts from the defaults alone', () => {
    for (const reading of ['waiting', 'reading'] as const) {
      const l = level({ reading, defaults: { ...NO_DEFAULTS, owner_member_id: 'm-zain' } });
      expect(l.level).toBeNull();
      expect(l.tags).toEqual([]);
      expect(l.proposals?.type_key).toBeUndefined();
      expect(l.proposals?.owner_member_id).toEqual({
        value: 'm-zain',
        from: 'batch',
        confidence: null,
        cue: null,
      });
      // A kind chosen for the batch: nothing to check said before the pages are read
      // (W-I2-3) — but what is worth knowing is.
      const kinded = level({
        reading,
        defaults: { ...NO_DEFAULTS, type_key: 'medical_record', visibility: 'household' },
      });
      expect(kinded.level).toBeNull();
      expect(kinded.tags).toEqual([
        {
          code: 'narrowed',
          kind: 'info',
          words: 'Kept to adults: as a medical record usually is',
        },
      ]);
    }
  });

  it('accepted: nothing — it is a document now', () => {
    expect(level({ state: 'accepted' })).toEqual({
      level: null,
      tags: [],
      proposals: null,
      clashes: [],
    });
  });

  it('Check: a person, a kind or an expiry under the sure bar says which', () => {
    const unsure = (field: 'type_key' | 'owner_member_id' | 'expires', c: number) =>
      level({
        proposal: { ...PASSPORT, [field]: { ...PASSPORT[field], confidence: c } },
      });
    expect(unsure('owner_member_id', ITEM_SURE.owner_member_id).level).toBe('ready');
    const person = unsure('owner_member_id', ITEM_SURE.owner_member_id - 0.01);
    expect(person.level).toBe('check');
    expect(words(person)).toEqual(['Person unsure']);
    const kind = unsure('type_key', ITEM_SURE.type_key - 0.01);
    expect(kind.level).toBe('check');
    expect(words(kind)).toEqual(['Kind unsure']);
    const expiry = unsure('expires', ITEM_SURE.expires - 0.01);
    expect(expiry.level).toBe('check');
    expect(words(expiry)).toEqual(['Expiry unsure']);
  });

  it('Check: what the kind requires and nobody gave, by the kind’s own words', () => {
    const noExpiry = without(PASSPORT, 'expires');
    const l = level({ proposal: noExpiry });
    expect(l.level).toBe('check');
    expect(l.tags).toEqual([
      {
        code: 'missing',
        kind: 'check',
        field: 'expires',
        words: 'Missing: expiry (required for a passport)',
      },
    ]);
    // A kind with a required field of its own, and where its paper copy is.
    const car = level({
      proposal: {
        type_key: { value: 'vehicle', confidence: 0.95, cue: 'kind_words' },
        owner_member_id: PASSPORT.owner_member_id as NonNullable<DetailProposal['owner_member_id']>,
      },
    });
    expect(words(car)).toEqual([
      'Missing: where the logbook is (required for a car)',
      'Missing: registration plate (required for a car)',
    ]);
    // The batch says where the paper copies are: filled, for whoever sees it.
    const kept = level({
      proposal: { type_key: { value: 'vehicle', confidence: 0.95, cue: 'kind_words' } },
      defaults: { ...NO_DEFAULTS, owner_member_id: 'm-sara', physical_location: 'Study drawer' },
    });
    expect(words(kept)).toEqual(['Missing: registration plate (required for a car)']);
    // Somebody who does not see where originals are kept: the default is not theirs to fill with.
    const unseen = level({
      proposal: { type_key: { value: 'vehicle', confidence: 0.95, cue: 'kind_words' } },
      defaults: { ...NO_DEFAULTS, owner_member_id: 'm-sara', physical_location: 'Study drawer' },
      role: 'viewer',
    });
    expect(codes(unseen)).toContain('missing');
    expect(unseen.tags.find((t) => t.field === 'physical_location')).toBeDefined();
  });

  it('Check: whose it is missing, when neither the pages nor the batch say', () => {
    const nobody = without(PASSPORT, 'owner_member_id');
    const l = level({ proposal: nobody });
    expect(l.level).toBe('check');
    expect(words(l)).toEqual(['Missing: whose it is']);
  });

  it('Not recognised: no kind proposed and none chosen for the batch; a default kind levels it', () => {
    const l = level({ proposal: { owner_member_id: PASSPORT.owner_member_id } as DetailProposal });
    expect(l.level).toBe('unrecognised');
    const given = level({
      proposal: { owner_member_id: PASSPORT.owner_member_id } as DetailProposal,
      defaults: { ...NO_DEFAULTS, type_key: 'medical_record' },
    });
    expect(given.level).toBe('ready');
    expect(given.proposals?.type_key).toEqual({
      value: 'medical_record',
      from: 'batch',
      confidence: null,
      cue: null,
    });
  });

  it('a kind since deleted, or somebody no longer to be chosen, is nothing proposed', () => {
    const l = level({ types: KINDS.filter((k) => k.key !== 'passport') });
    expect(l.level).toBe('unrecognised');
    expect(l.proposals?.type_key).toBeUndefined();
    const gone = level({ people: PEOPLE.filter((p) => p.id !== 'm-sara') });
    expect(gone.proposals?.owner_member_id).toBeUndefined();
    expect(words(gone)).toEqual(['Missing: whose it is']);
    // A kind deleted since, with the batch's kind standing: what was read for
    // the deleted kind — its number and dates — is not the batch's kind's (W-I2-4).
    const other = level({
      types: KINDS.filter((k) => k.key !== 'passport'),
      defaults: { ...NO_DEFAULTS, type_key: 'drivers_licence' },
    });
    expect(other.proposals?.type_key).toMatchObject({ value: 'drivers_licence', from: 'batch' });
    expect(other.proposals?.expires).toBeUndefined();
    expect(other.proposals?.identifier).toBeUndefined();
    expect(other.proposals?.issued_by).toBeUndefined();
  });

  it('Problem: pages that could not be read, with why; a kind not read is not a problem', () => {
    const blank = level({ reading: 'failed', failure: 'blank', proposal: null });
    expect(blank.level).toBe('problem');
    expect(blank.tags).toEqual([
      expect.objectContaining({
        code: 'unread',
        kind: 'problem',
        words: 'Couldn’t read the pages',
      }),
    ]);
    expect(blank.tags[0]?.detail).toMatch(/blank/);
    expect(
      level({ reading: 'failed', failure: 'password', proposal: null }).tags[0]?.detail,
    ).toMatch(/password/);
    // A spreadsheet: not read, and levelled by the batch's defaults alone.
    const sheet = level({
      reading: 'failed',
      failure: 'not_read',
      proposal: null,
      defaults: { ...NO_DEFAULTS, type_key: 'medical_record', owner_member_id: 'm-zain' },
    });
    expect(sheet.level).toBe('ready');
    expect(sheet.tags).toEqual([expect.objectContaining({ code: 'not_read', kind: 'info' })]);
  });

  it('Problem: a duplicate, said as I1 says it, read or not', () => {
    const dup = {
      of: 'document' as const,
      document_id: 'd1',
      title: 'Sara’s passport',
    };
    for (const reading of ['waiting', 'read'] as const) {
      const l = level({ reading, duplicate: dup });
      expect(l.level).toBe('problem');
      expect(l.tags[0]).toEqual({
        code: 'duplicate_document',
        kind: 'problem',
        words: 'Already in the vault: Sara’s passport',
      });
    }
    const same = level({
      duplicate: {
        of: 'item',
        batch_id: 'b',
        batch_name: null,
        batch_created_at: '2026-10-01T00:00:00Z',
        item_id: 'i',
        same_batch: true,
      },
    });
    expect(same.tags[0]).toMatchObject({ code: 'duplicate_in_batch', words: 'Also in this batch' });
  });
});

describe('defaults and the pages (Q4)', () => {
  it('a default fills a blank, and the pages saying the same confirm it', () => {
    const nobody = without(PASSPORT, 'owner_member_id');
    const filled = level({
      proposal: nobody,
      defaults: { ...NO_DEFAULTS, owner_member_id: 'm-sara' },
    });
    expect(filled.level).toBe('ready');
    expect(filled.proposals?.owner_member_id).toEqual({
      value: 'm-sara',
      from: 'batch',
      confidence: null,
      cue: null,
    });
    const both = level({ defaults: { ...NO_DEFAULTS, owner_member_id: 'm-sara' } });
    expect(both.proposals?.owner_member_id).toEqual({
      value: 'm-sara',
      from: 'both',
      confidence: 0.9,
      cue: 'name_labelled',
    });
    expect(both.level).toBe('ready');
  });

  it(`a confident disagreement (${CLASH_CONFIDENCE} or more) goes to Check with both; a weaker one keeps the default silently`, () => {
    const at = (c: number) =>
      level({
        proposal: {
          ...PASSPORT,
          owner_member_id: { value: 'm-sara', confidence: c, cue: 'name_labelled' },
        },
        defaults: { ...NO_DEFAULTS, owner_member_id: 'm-ahmed' },
      });
    const clash = at(CLASH_CONFIDENCE);
    expect(clash.level).toBe('check');
    expect(clash.clashes).toEqual([
      {
        field: 'owner_member_id',
        pages: { value: 'm-sara', confidence: CLASH_CONFIDENCE, cue: 'name_labelled' },
        batch: 'm-ahmed',
      },
    ]);
    expect(clash.tags).toEqual([
      { code: 'clash_person', kind: 'check', words: 'The pages say Sara, the batch says Ahmed' },
    ]);
    // The batch's stands on the card until somebody chooses.
    expect(clash.proposals?.owner_member_id).toMatchObject({ value: 'm-ahmed', from: 'batch' });
    const weak = at(CLASH_CONFIDENCE - 0.01);
    expect(weak.clashes).toEqual([]);
    expect(weak.tags).toEqual([]);
    expect(weak.level).toBe('ready');
    expect(weak.proposals?.owner_member_id).toMatchObject({ value: 'm-ahmed', from: 'batch' });
  });

  it('a kind the batch chose and the pages dispute: Check, and the dates read for the other kind are not offered', () => {
    const l = level({ defaults: { ...NO_DEFAULTS, type_key: 'drivers_licence' } });
    expect(l.level).toBe('check');
    expect(words(l)).toEqual([
      "The pages say a passport, the batch says a driver's licence",
      "Missing: expiry (required for a driver's licence)",
    ]);
    expect(l.proposals?.type_key).toMatchObject({ value: 'drivers_licence', from: 'batch' });
    expect(l.proposals?.expires).toBeUndefined();
    expect(l.proposals?.identifier).toBeUndefined();
  });

  it('a teen’s are their own: whose it is is them — and the pages confidently naming somebody else is a Check, with nobody else to choose (W-I2-1)', () => {
    const l = level({ role: 'teen', me: 'm-zain' });
    expect(l.proposals?.owner_member_id).toMatchObject({ value: 'm-zain', from: 'batch' });
    expect(l.clashes).toEqual([]);
    expect(l.level).toBe('check');
    expect(l.tags).toEqual([
      {
        code: 'not_theirs',
        kind: 'check',
        words: 'The pages say Sara: your documents are your own',
      },
    ]);
    // Less sure than the clash bar, or the teen themself: Ready.
    const weak = level({
      role: 'teen',
      me: 'm-zain',
      proposal: {
        ...PASSPORT,
        owner_member_id: {
          value: 'm-sara',
          confidence: CLASH_CONFIDENCE - 0.01,
          cue: 'name_labelled',
        },
      },
    });
    expect(weak.level).toBe('ready');
    const own = level({
      role: 'teen',
      me: 'm-zain',
      proposal: {
        ...PASSPORT,
        owner_member_id: { value: 'm-zain', confidence: 0.9, cue: 'name_labelled' },
      },
    });
    expect(own.level).toBe('ready');
  });
});

describe('who can see it: never widened by a guess', () => {
  it('a kind usually Adults only narrows the batch’s Everyone, and says so', () => {
    const letter: DetailProposal = {
      type_key: { value: 'medical_record', confidence: 0.97, cue: 'kind_words' },
      owner_member_id: { value: 'm-zain', confidence: 0.9, cue: 'name_labelled' },
    };
    const l = level({ proposal: letter, defaults: { ...NO_DEFAULTS, visibility: 'household' } });
    expect(l.proposals?.visibility).toEqual({ value: 'adults', from: 'narrowed' });
    expect(l.tags).toEqual([
      { code: 'narrowed', kind: 'info', words: 'Kept to adults: it looks like a medical record' },
    ]);
    // Narrowed is said, not a reason to check.
    expect(l.level).toBe('ready');
    // The batch's own choice stands where the kind is no narrower.
    expect(
      level({ defaults: { ...NO_DEFAULTS, visibility: 'adults' } }).proposals?.visibility,
    ).toEqual({
      value: 'adults',
      from: 'batch',
    });
    // A batch made Only me stays Only me.
    expect(
      level({ defaults: { ...NO_DEFAULTS, visibility: 'private', owner_member_id: 'm-ahmed' } })
        .proposals?.visibility,
    ).toEqual({ value: 'private', from: 'batch' });
  });

  it('for a teen, a kind kept for adults is their Only me, never Adults only', () => {
    const letter: DetailProposal = {
      type_key: { value: 'medical_record', confidence: 0.97, cue: 'kind_words' },
    };
    const l = level({
      proposal: letter,
      role: 'teen',
      me: 'm-zain',
      defaults: { ...NO_DEFAULTS, visibility: 'household' },
    });
    expect(l.proposals?.visibility).toEqual({ value: 'private', from: 'narrowed' });
    expect(words(l)).toContain('Kept to Only me: it looks like a medical record');
  });
});

describe('the summary, and what was sealed', () => {
  it('says the levels there are, in order', () => {
    expect(levelSummary({ ready: 12, check: 5, unrecognised: 2, problem: 1 })).toBe(
      '12 Ready, 5 Check, 2 Not recognised, 1 Problem',
    );
    expect(levelSummary({ check: 1, problem: 3 })).toBe('1 Check, 3 Problems');
    expect(levelSummary({})).toBe('');
  });

  it('keeps only well-formed proposals of what the worker sealed', () => {
    expect(storedProposal({ v: 1, proposal: PASSPORT })).toEqual(PASSPORT);
    expect(storedProposal(null)).toEqual({});
    expect(storedProposal({ v: 2, proposal: PASSPORT })).toEqual({});
    expect(
      storedProposal({
        v: 1,
        proposal: {
          type_key: { value: 'passport', confidence: 2, cue: 'kind_words' },
          owner_member_id: { value: 'm-sara', confidence: 0.9, cue: 'made_up' },
          expires: {
            value: { date: 'soon', precision: 'day' },
            confidence: 0.9,
            cue: 'expiry_label',
          },
          identifier: { value: 42, confidence: 0.9, cue: 'number_label' },
          issued_by: PASSPORT.issued_by,
        },
      }),
    ).toEqual({ issued_by: PASSPORT.issued_by });
  });
});
