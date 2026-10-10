import { describe, expect, it } from 'vitest';
import { levelItem, storedLearnedClash, storedProposal, type LevelKind } from './batch-levels.js';
import type { BatchDefaults } from './batches.js';
import {
  applyLearned,
  bestRule,
  correctionsOf,
  learningOf,
  LEARNED_CONFIDENCE,
  LEARNED_RULES_MAX,
  LEARNED_SURE_CONFIDENCE,
  proposeLearned,
  ruleSure,
  ruleTrusted,
  teach,
  type KeptRule,
  type LearnedRule,
} from './learning.js';
import { proposeDetails, proposeWithTie, type DetailProposal } from './proposals.js';
import { FIXTURE_KINDS } from './testdata/proposal-fixtures.js';

/**
 * The vault learns from your corrections (Phase 6, I4): what an accept
 * teaches, how a rule is used on the next item, and what it never does.
 */

const SARA = 'm-sara';
const AHMED = 'm-ahmed';
const ZAIN = 'm-zain';
const people = [
  { id: SARA, name: 'Sara' },
  { id: AHMED, name: 'Ahmed' },
  { id: ZAIN, name: 'Zain' },
];
const types: LevelKind[] = [
  {
    key: 'medical_record',
    label: 'Medical record',
    default_visibility: 'household',
    expiry_driver: null,
    fields: [],
  },
  {
    key: 'tax_return',
    label: 'Tax return',
    default_visibility: 'adults',
    expiry_driver: null,
    fields: [],
  },
  {
    key: 'passport',
    label: 'Passport',
    default_visibility: 'household',
    expiry_driver: 'expires_on',
    fields: [],
  },
  { key: 'visa', label: 'Visa', default_visibility: 'household', expiry_driver: null, fields: [] },
];
const none: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: null,
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};
const dentist = { value: 'Northgate Dental', confidence: 0.9, cue: 'known_issuer' } as const;
const rule = (
  field: LearnedRule['field'],
  value: string,
  confirmed = 3,
  contradicted = 0,
  issuer_key = 'northgate dental',
): LearnedRule => ({ issuer_key, field, value, confirmed, contradicted });
const apply = (
  proposal: DetailProposal,
  rules: LearnedRule[],
  opts: { role?: 'adult' | 'teen' | 'owner'; tie?: string[] } = {},
) =>
  applyLearned({
    proposal,
    tie: opts.tie ?? [],
    learned: { rules, role: opts.role ?? 'adult', me: AHMED },
    types,
    people,
  });
const level = (
  proposal: DetailProposal,
  extra: { role?: 'adult' | 'teen'; defaults?: BatchDefaults; clash?: object } = {},
) =>
  levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal,
    learnedClash: extra.clash ?? null,
    duplicate: null,
    defaults: extra.defaults ?? none,
    types,
    people,
    role: extra.role ?? 'adult',
    me: extra.role === 'teen' ? ZAIN : AHMED,
  });

describe('a rule used (I4)', () => {
  it('proposes the kind and the person where the pages proposed none, saying so', () => {
    const got = apply({ issued_by: dentist }, [
      rule('type_key', 'medical_record'),
      rule('owner_member_id', SARA),
    ]);
    expect(got.proposal).toEqual({
      issued_by: dentist,
      type_key: { value: 'medical_record', confidence: LEARNED_SURE_CONFIDENCE, cue: 'learned' },
      owner_member_id: { value: SARA, confidence: LEARNED_SURE_CONFIDENCE, cue: 'learned' },
    });
    expect(got.learnedKind).toBe('medical_record');
    const l = level(got.proposal);
    expect(l.proposals?.type_key?.from).toBe('learned');
    expect(l.proposals?.owner_member_id?.from).toBe('learned');
    expect(l.level).toBe('ready');
  });

  it('only with an issuer named, and only that issuer’s rules', () => {
    expect(apply({}, [rule('type_key', 'medical_record')]).proposal).toEqual({});
    const other = apply({ issued_by: dentist }, [
      rule('type_key', 'tax_return', 9, 0, 'hm revenue customs'),
    ]);
    expect(other.proposal.type_key).toBeUndefined();
  });

  it('is sure only once confirmed three times and never contradicted', () => {
    for (const [confirmed, contradicted, sure] of [
      [1, 0, false],
      [2, 0, false],
      [3, 0, true],
      [9, 0, true],
      [9, 1, false],
    ] as const) {
      expect(ruleSure({ confirmed, contradicted })).toBe(sure);
      const got = apply({ issued_by: dentist }, [
        rule('type_key', 'medical_record', confirmed, contradicted),
      ]);
      expect(got.proposal.type_key?.confidence).toBe(
        sure ? LEARNED_SURE_CONFIDENCE : LEARNED_CONFIDENCE,
      );
      // And so the item is Ready only when it is sure; else Check, "Kind unsure".
      const l = level({
        ...got.proposal,
        owner_member_id: { value: SARA, confidence: 0.95, cue: 'name_labelled' },
      });
      expect({ confirmed, contradicted, level: l.level }).toEqual({
        confirmed,
        contradicted,
        level: sure ? 'ready' : 'check',
      });
      if (!sure) expect(l.tags.map((t) => t.code)).toContain('kind_unsure');
    }
  });

  it('never overrides a confident page proposal that disagrees: the pages stand, and the item is Check with both', () => {
    const page: DetailProposal = {
      issued_by: dentist,
      type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
      owner_member_id: { value: SARA, confidence: 0.95, cue: 'name_labelled' },
    };
    const got = apply(page, [rule('type_key', 'visa', 9), rule('owner_member_id', AHMED, 9)]);
    expect(got.proposal).toEqual(page);
    expect(got.clash).toEqual({ type_key: 'visa', owner_member_id: AHMED });
    const l = level(got.proposal, { clash: got.clash });
    expect(l.level).toBe('check');
    expect(l.proposals?.type_key).toMatchObject({ value: 'passport', from: 'pages' });
    expect(l.tags.filter((t) => t.code === 'clash_learned').map((t) => t.words)).toEqual([
      'The pages say a passport, your earlier choices say a visa',
      'The pages say Sara, your earlier choices say Ahmed',
    ]);
    // A rule not sure yet that disagrees says nothing, and changes nothing.
    const quiet = apply(page, [rule('type_key', 'visa', 2)]);
    expect(quiet).toMatchObject({ proposal: page, clash: {} });
    // An unsure page proposal is not replaced either: it stays, unsure.
    const unsure = { ...page, type_key: { ...page.type_key, confidence: 0.76 } } as DetailProposal;
    expect(apply(unsure, [rule('type_key', 'visa', 9)]).proposal.type_key).toEqual(unsure.type_key);
  });

  it('makes surer a proposal it agrees with — only a sure rule makes it sure', () => {
    const page: DetailProposal = {
      issued_by: dentist,
      type_key: { value: 'medical_record', confidence: 0.8, cue: 'kind_words' },
    };
    expect(apply(page, [rule('type_key', 'medical_record', 3)]).proposal.type_key).toEqual({
      value: 'medical_record',
      confidence: LEARNED_SURE_CONFIDENCE,
      cue: 'kind_words',
      learned: true,
      page_confidence: 0.8,
    });
    expect(apply(page, [rule('type_key', 'medical_record', 1)]).proposal.type_key).toEqual({
      value: 'medical_record',
      confidence: 0.84,
      cue: 'kind_words',
      learned: true,
      page_confidence: 0.8,
    });
    // Already surer than the rule would make it: untouched.
    const sure = {
      ...page,
      type_key: { value: 'medical_record', confidence: 0.97, cue: 'kind_words' },
    } as DetailProposal;
    expect(apply(sure, [rule('type_key', 'medical_record', 9)]).proposal).toEqual(sure);
    // Made surer, it is "learned" on the card, and its page's cue kept.
    expect(
      level(apply(page, [rule('type_key', 'medical_record', 3)]).proposal).proposals?.type_key,
    ).toMatchObject({ from: 'learned', cue: 'kind_words' });
  });

  it('breaks a near-tie between kinds the pages could not choose between', () => {
    const tie = ['tax_return', 'medical_record'];
    expect(
      apply({ issued_by: dentist }, [rule('type_key', 'medical_record')], { tie }).proposal
        .type_key,
    ).toMatchObject({ value: 'medical_record', confidence: LEARNED_SURE_CONFIDENCE });
    // A rule for neither of them is never sure.
    expect(
      apply({ issued_by: dentist }, [rule('type_key', 'visa')], { tie }).proposal.type_key,
    ).toMatchObject({ value: 'visa', confidence: LEARNED_CONFIDENCE });
  });

  it('a near-tie is what proposeDetails could not choose, and nothing else changes', () => {
    // A page with a tax return's words and a medical record's, equally.
    const text = [
      'Northgate Dental',
      'Tax year 2025 to 2026: self assessment for HMRC',
      'Medical record from the clinic: patient notes',
    ].join('\n');
    const ctx = {
      types: FIXTURE_KINDS,
      people,
      issuers: [{ value: 'Northgate Dental', count: 2 }],
    };
    const { proposal, tie } = proposeWithTie(text, ctx);
    expect(proposal).toEqual(proposeDetails(text, ctx));
    expect(proposal.type_key).toBeUndefined();
    expect([...tie].sort()).toEqual(['medical_record', 'tax_return']);
    expect(proposal.issued_by).toMatchObject({ value: 'Northgate Dental' });
    // With no rules, exactly what the pages say.
    expect(proposeLearned(text, ctx, { rules: [], role: 'adult', me: AHMED })).toEqual({
      proposal,
      clash: {},
    });
    // A sure rule for one of them chooses it.
    const chosen = proposeLearned(text, ctx, {
      rules: [rule('type_key', 'medical_record')],
      role: 'adult',
      me: AHMED,
    });
    expect(chosen.proposal.type_key).toEqual({
      value: 'medical_record',
      confidence: LEARNED_SURE_CONFIDENCE,
      cue: 'learned',
    });
  });

  it('a kind only the rules proposed gets the dates and number the pages give for it', () => {
    const text = [
      'Northgate Dental',
      'Policy number: ND-55821',
      'Start date: 1 March 2026',
      'Renewal date: 1 March 2027',
    ].join('\n');
    const ctx = {
      types: FIXTURE_KINDS,
      people,
      issuers: [{ value: 'Northgate Dental', count: 2 }],
      dateOrder: 'dmy' as const,
    };
    const plain = proposeDetails(text, ctx);
    expect(plain.type_key).toBeUndefined();
    expect(plain.expires).toBeUndefined();
    const got = proposeLearned(text, ctx, {
      rules: [rule('type_key', 'insurance_policy')],
      role: 'adult',
      me: AHMED,
    });
    expect(got.proposal.type_key).toMatchObject({ value: 'insurance_policy', cue: 'learned' });
    expect(got.proposal.identifier).toMatchObject({ value: 'ND-55821' });
    expect(got.proposal.expires?.value.date).toBe('2027-03-01');
    expect(got.proposal.expires?.value.date).toBe(
      proposeDetails(text, { ...ctx, current: { type_key: 'insurance_policy' } }).expires?.value
        .date,
    );
  });

  it('a teen is proposed nobody by a rule — their documents are their own', () => {
    const got = apply({ issued_by: dentist }, [rule('owner_member_id', SARA, 9)], {
      role: 'teen',
    });
    expect(got.proposal.owner_member_id).toBeUndefined();
    expect(got.clash).toEqual({});
    // Nor, were one planted in what was sealed, does it say "the pages say".
    const l = level(
      {
        type_key: { value: 'medical_record', confidence: 0.97, cue: 'kind_words' },
        owner_member_id: { value: SARA, confidence: 0.9, cue: 'learned' },
      },
      { role: 'teen' },
    );
    expect(l.proposals?.owner_member_id?.value).toBe(ZAIN);
    expect(l.tags.map((t) => t.code)).not.toContain('not_theirs');
  });

  it('a kind hidden, or a person not of the family, is never proposed', () => {
    const got = applyLearned({
      proposal: { issued_by: dentist },
      tie: [],
      learned: {
        rules: [rule('type_key', 'visa'), rule('owner_member_id', 'm-guest')],
        role: 'adult',
        me: AHMED,
      },
      types: types.map((t) => ({ ...t, hidden: t.key === 'visa' })),
      people,
    });
    expect(got.proposal).toEqual({ issued_by: dentist });
  });

  it('two rules as good as each other say nothing', () => {
    const rules = [rule('owner_member_id', SARA, 3), rule('owner_member_id', AHMED, 3)];
    expect(bestRule(rules, 'northgate dental', 'owner_member_id', () => true)).toBeNull();
    expect(apply({ issued_by: dentist }, rules).proposal.owner_member_id).toBeUndefined();
  });

  it('never against the batch: a default stands, with no clash, and is not widened', () => {
    const got = apply({ issued_by: dentist }, [rule('type_key', 'medical_record', 9)]);
    const l = level(got.proposal, { defaults: { ...none, type_key: 'tax_return' } });
    expect(l.proposals?.type_key).toMatchObject({ value: 'tax_return', from: 'batch' });
    expect(l.clashes).toEqual([]);
    // The same as the batch's: the batch's.
    const same = level(got.proposal, { defaults: { ...none, type_key: 'medical_record' } });
    expect(same.proposals?.type_key).toMatchObject({ from: 'batch', confidence: null });
  });

  it('who can see it is never wider than without the rule', () => {
    const vis = { private: 0, adults: 1, household: 2 } as const;
    for (const chosen of [null, 'household', 'adults', 'private'] as const) {
      for (const kind of types.map((t) => t.key)) {
        const without = level(
          { issued_by: dentist },
          { defaults: { ...none, visibility: chosen } },
        );
        const withRule = level(
          apply({ issued_by: dentist }, [rule('type_key', kind), rule('owner_member_id', SARA)])
            .proposal,
          { defaults: { ...none, visibility: chosen } },
        );
        expect(
          vis[withRule.proposals?.visibility.value ?? 'household'] <=
            vis[without.proposals?.visibility.value ?? 'household'],
        ).toBe(true);
      }
    }
  });

  it('sealed and opened: the learned flag and the clash survive; anything else is dropped', () => {
    const raw = {
      v: 1,
      proposal: {
        type_key: { value: 'visa', confidence: 0.9, cue: 'learned', extra: 'x' },
        owner_member_id: { value: SARA, confidence: 0.84, cue: 'name_labelled', learned: true },
        issued_by: { value: 'Dentist', confidence: 0.9, cue: 'known_issuer', learned: 'yes' },
      },
      learned_clash: { type_key: 'passport', owner_member_id: 7, other: 'x' },
    };
    expect(storedProposal(raw)).toEqual({
      type_key: { value: 'visa', confidence: 0.9, cue: 'learned' },
      owner_member_id: { value: SARA, confidence: 0.84, cue: 'name_labelled', learned: true },
      issued_by: { value: 'Dentist', confidence: 0.9, cue: 'known_issuer' },
    });
    expect(storedLearnedClash(raw)).toEqual({ type_key: 'passport' });
    expect(storedLearnedClash({ v: 1, proposal: {} })).toEqual({});
  });
});

describe('the I4 review', () => {
  /** Each letter filed as it truly is, in turn, the pages proposing neither kind nor person. */
  const history = (filed: Array<{ kind?: string; person?: string }>) => {
    let rules: KeptRule[] = [];
    let n = 0;
    for (const f of filed) {
      rules = teach(
        rules,
        learningOf({
          proposals: level({ issued_by: { ...dentist, value: 'Riverside Surgery' } }).proposals,
          filed: {
            type_key: f.kind ?? null,
            owner_member_id: f.person ?? null,
            issued_by: 'Riverside Surgery',
          },
          role: 'adult',
        }),
        { newId: () => `r${n++}`, today: '2026-10-10' },
      ).rules;
    }
    return rules;
  };
  const surgery = { value: 'Riverside Surgery', confidence: 0.9, cue: 'letterhead' } as const;

  it('a shared surgery: four letters for Sara, then four for Ahmed — neither is trusted, and the next is Check (I4-1)', () => {
    const rules = history([
      ...Array.from({ length: 4 }, () => ({ kind: 'medical_record', person: SARA })),
      ...Array.from({ length: 4 }, () => ({ kind: 'medical_record', person: AHMED })),
    ]);
    const people_ = rules.filter((r) => r.field === 'owner_member_id');
    expect(people_.map((r) => [r.value, r.confirmed, r.contradicted])).toEqual([
      [SARA, 4, 4],
      [AHMED, 4, 0],
    ]);
    const ahmed = people_.find((r) => r.value === AHMED) as KeptRule;
    expect(ruleSure(ahmed)).toBe(true);
    expect(ruleTrusted(ahmed, rules)).toBe(false);
    const got = apply(
      {
        issued_by: surgery,
        type_key: { value: 'medical_record', confidence: 0.97, cue: 'kind_words' },
      },
      rules,
    );
    expect(got.proposal.owner_member_id).toEqual({
      value: AHMED,
      confidence: LEARNED_CONFIDENCE,
      cue: 'learned',
    });
    const l = level(got.proposal);
    expect(l.level).toBe('check');
    expect(l.tags.map((t) => t.code)).toContain('person_unsure');
    // The kind, always the same: trusted.
    expect(got.proposal.type_key?.confidence).toBe(0.97);
  });

  it('a sender of several kinds: four tax returns, then four medical records — the kind is never trusted (I4-1)', () => {
    const rules = history([
      ...Array.from({ length: 4 }, () => ({ kind: 'tax_return' })),
      ...Array.from({ length: 4 }, () => ({ kind: 'medical_record' })),
    ]);
    const got = apply({ issued_by: surgery }, rules);
    expect(got.proposal.type_key).toEqual({
      value: 'medical_record',
      confidence: LEARNED_CONFIDENCE,
      cue: 'learned',
    });
    // Nor, against the pages, is it said as a clash.
    const pages = apply(
      { issued_by: surgery, type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' } },
      rules,
    );
    expect(pages.clash).toEqual({});
  });

  it('a rule raising the pages never makes a clash with the batch, nor speaks for the pages (I4-4)', () => {
    const page: DetailProposal = {
      issued_by: { ...surgery },
      type_key: { value: 'tax_return', confidence: 0.77, cue: 'kind_words' },
    };
    const raised = apply(page, [rule('type_key', 'tax_return', 1, 0, 'riverside surgery')]);
    expect(raised.proposal.type_key).toMatchObject({ confidence: 0.82, page_confidence: 0.77 });
    const defaults = { ...none, type_key: 'medical_record' };
    expect(level(page, { defaults }).clashes).toEqual([]);
    expect(level(raised.proposal, { defaults }).clashes).toEqual([]);
    // Sure on the pages alone: the clash says the pages' own confidence.
    const strong: DetailProposal = {
      issued_by: { ...surgery },
      type_key: { value: 'tax_return', confidence: 0.85, cue: 'kind_words' },
    };
    const both = apply(strong, [rule('type_key', 'tax_return', 3, 0, 'riverside surgery')]);
    expect(level(both.proposal, { defaults }).clashes).toEqual([
      {
        field: 'type_key',
        pages: { value: 'tax_return', confidence: 0.85, cue: 'kind_words' },
        batch: 'medical_record',
      },
    ]);
    // Agreeing with the batch: "both", at the pages' own confidence.
    expect(
      level(both.proposal, { defaults: { ...none, type_key: 'tax_return' } }).proposals?.type_key,
    ).toMatchObject({ from: 'both', confidence: 0.85 });
  });

  it('what an accept removed is answered as it was, for an Undo (I4-3)', () => {
    const rules: KeptRule[] = [
      {
        id: 'x',
        issuer_key: 'riverside surgery',
        field: 'owner_member_id',
        value: SARA,
        confirmed: 1,
        contradicted: 1,
        last_used: '2026-10-01',
      },
    ];
    const r = teach(
      rules,
      {
        issuer: 'riverside surgery',
        steps: [{ field: 'owner_member_id', value: AHMED, corrected: true }],
      },
      { newId: () => 'y', today: '2026-10-10' },
    );
    expect(r.rules.map((x) => x.id)).toEqual(['y']);
    expect(r.removed).toEqual([{ ...rules[0], contradicted: 2 }]);
  });
});

describe('what an accept teaches (I4)', () => {
  const proposals = level({
    issued_by: dentist,
    type_key: { value: 'tax_return', confidence: 0.9, cue: 'kind_words' },
  }).proposals;

  it('a correction is a field changed, or filled where nothing was proposed', () => {
    const kind = { core: {}, expiry_driver: null };
    expect(
      correctionsOf({
        proposals,
        filed: { type_key: 'tax_return', issued_by: 'Northgate Dental' },
        kind,
      }),
    ).toEqual([]);
    expect(
      correctionsOf({
        proposals,
        filed: {
          type_key: 'medical_record',
          owner_member_id: SARA,
          issued_by: 'Northgate Dental',
          identifier: 'N-1',
          issued: { date: '2026-03-02', precision: 'day' },
          expires: { date: '2027-03-02', precision: 'day' },
        },
        kind,
      }),
    ).toEqual(['type_key', 'owner_member_id', 'issued', 'identifier']);
    // A field the kind does not keep is not filed, so not corrected.
    expect(
      correctionsOf({
        proposals,
        filed: { type_key: 'tax_return' },
        kind: { core: { issued_by: { shown: false } }, expiry_driver: null },
      }),
    ).toEqual([]);
    // Cleared on the card: a correction.
    expect(
      correctionsOf({ proposals, filed: { type_key: 'tax_return', issued_by: null }, kind }),
    ).toEqual(['issued_by']);
  });

  it('teaches the issuer filed, and only that; a teen no person (I4-8)', () => {
    expect(
      learningOf({
        proposals,
        filed: {
          type_key: 'medical_record',
          owner_member_id: SARA,
          issued_by: 'NORTHGATE DENTAL LTD',
        },
        role: 'adult',
      }),
    ).toEqual({
      issuer: 'northgate dental',
      steps: [
        { field: 'type_key', value: 'medical_record', corrected: true },
        { field: 'owner_member_id', value: SARA, corrected: true },
      ],
    });
    // The pages named the dentist, but the card filed no issuer: nothing.
    expect(learningOf({ proposals, filed: { type_key: 'tax_return' }, role: 'adult' })).toEqual({
      issuer: '',
      steps: [],
    });
    expect(
      learningOf({
        proposals,
        filed: { type_key: 'tax_return', issued_by: 'Northgate Dental' },
        role: 'adult',
      }),
    ).toEqual({
      issuer: 'northgate dental',
      steps: [{ field: 'type_key', value: 'tax_return', corrected: false }],
    });
    expect(
      learningOf({ proposals, filed: { type_key: 'tax_return', issued_by: null }, role: 'adult' }),
    ).toEqual({ issuer: '', steps: [] });
    expect(
      learningOf({
        proposals,
        filed: { type_key: 'medical_record', owner_member_id: ZAIN, issued_by: 'Northgate Dental' },
        role: 'teen',
      }).steps.map((s) => s.field),
    ).toEqual(['type_key']);
  });

  it('a correction makes a rule; an unchanged accept confirms it; a contradiction counts against it, and drops it', () => {
    let n = 0;
    const opts = { newId: () => `r${++n}`, today: '2026-10-09' };
    const lesson = (value: string, corrected: boolean) => ({
      issuer: 'northgate dental',
      steps: [{ field: 'type_key' as const, value, corrected }],
    });
    // Unchanged with no rule: nothing made.
    expect(teach([], lesson('tax_return', false), opts).rules).toEqual([]);
    let r = teach([], lesson('medical_record', true), opts);
    expect(r.rules).toEqual([
      {
        id: 'r1',
        issuer_key: 'northgate dental',
        field: 'type_key',
        value: 'medical_record',
        confirmed: 1,
        contradicted: 0,
        last_used: '2026-10-09',
      },
    ]);
    r = teach(r.rules, lesson('medical_record', false), opts);
    expect(r.rules[0]).toMatchObject({ confirmed: 2, contradicted: 0 });
    expect(r.confirmed).toEqual(['r1']);
    r = teach(r.rules, lesson('tax_return', true), opts);
    expect(r.rules.map((x) => [x.value, x.confirmed, x.contradicted])).toEqual([
      ['medical_record', 2, 1],
      ['tax_return', 1, 0],
    ]);
    expect(r.contradicted).toEqual(['r1']);
    r = teach(r.rules, lesson('tax_return', false), opts);
    r = teach(r.rules, lesson('tax_return', false), opts);
    // Contradicted three times, confirmed twice: gone.
    expect(r.rules.map((x) => [x.value, x.confirmed, x.contradicted])).toEqual([
      ['tax_return', 3, 0],
    ]);
  });

  it('keeps at most LEARNED_RULES_MAX a person: the least used go, never the one just made', () => {
    const full: KeptRule[] = Array.from({ length: LEARNED_RULES_MAX }, (_, i) => ({
      id: `old${String(i).padStart(3, '0')}`,
      issuer_key: `issuer ${i}`,
      field: 'type_key',
      value: 'tax_return',
      confirmed: i === 0 ? 9 : 1,
      contradicted: 0,
      last_used: i < 2 ? '2026-01-01' : '2026-10-01',
    }));
    const r = teach(
      full,
      {
        issuer: 'northgate dental',
        steps: [{ field: 'type_key', value: 'medical_record', corrected: true }],
      },
      { newId: () => 'new', today: '2026-10-09' },
    );
    expect(r.rules).toHaveLength(LEARNED_RULES_MAX);
    expect(r.rules.some((x) => x.id === 'new')).toBe(true);
    // The longest unused and least confirmed went.
    expect(r.rules.some((x) => x.id === 'old001')).toBe(false);
    expect(r.rules.some((x) => x.id === 'old000')).toBe(true);
  });
});
