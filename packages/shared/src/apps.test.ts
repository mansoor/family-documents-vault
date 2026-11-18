import { describe, expect, it } from 'vitest';
import { describeEvent, describeEvents, type ActivityEvent } from './activity.js';
import {
  amountText,
  appBatchName,
  appMayDownloadSent,
  appMayRead,
  appSensitiveConfirmWords,
  hintDate,
  lookbackStart,
  lookbackWords,
  type AppReadCase,
  parseAppMetadata,
  sealedAppHints,
  storedAppHints,
  type AppHints,
} from './apps.js';
import { untouchedAccept } from './batch-review.js';
import {
  appFilesItself,
  appInboxOf,
  CLASH_CONFIDENCE,
  ITEM_SURE,
  levelItem,
  personByName,
  type LevelInput,
  type LevelKind,
} from './batch-levels.js';
import type { BatchDefaults } from './batches.js';
import type { DocumentTypeView } from './documents.js';
import type { DetailProposal, Proposed } from './proposals.js';

/**
 * Connected apps (0.9.0, APP1): what an app may say of what it sends, and
 * how it meets the vault's own reading: hints are claims — one more
 * source, below a sure reading.
 */

const core = () => {
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
    out[k] = { shown: true, required: false, label: null };
  }
  return out as unknown as NonNullable<LevelKind['core']>;
};

const KINDS: Array<LevelKind & Pick<DocumentTypeView, 'category'>> = [
  {
    key: 'bank_statement',
    label: 'Bank / investment statement',
    short_label: 'Bank statement',
    category: 'financial',
    default_visibility: 'adults',
    expiry_driver: null,
    fields: [
      { key: 'account_last4', label: 'Account (last 4)', kind: 'text' },
      { key: 'period', label: 'Period', kind: 'text' },
    ],
    core: core(),
    belongs_to: 'person',
  },
  {
    key: 'utility_bill',
    label: 'Utility / bill',
    short_label: 'Bill',
    category: 'bills',
    default_visibility: 'household',
    expiry_driver: null,
    remind_from: 'due_date',
    fields: [
      { key: 'amount', label: 'Bill amount', kind: 'text' },
      { key: 'due_date', label: 'Due date', kind: 'date', required: true },
    ],
    core: core(),
    belongs_to: 'household',
  },
  {
    key: 'warranty',
    label: 'Warranty / receipt',
    category: 'other',
    default_visibility: 'household',
    expiry_driver: 'expires_on',
    fields: [],
    core: core(),
  },
  {
    key: 'passport',
    label: 'Passport',
    category: 'identity',
    default_visibility: 'household',
    expiry_driver: 'expires_on',
    fields: [],
    core: core(),
  },
];
const PEOPLE = [
  { id: 'm-sara', name: 'Sara Khan' },
  { id: 'm-ahmed', name: 'Ahmed Khan' },
  { id: 'm-ahmad', name: 'Ahmad Ali' },
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
const APP = { name: 'Acme Money', allowed_kinds: ['bank_statement', 'utility_bill'] };

const input = (over: Partial<LevelInput> & { hints?: AppHints }): LevelInput => {
  const { hints, ...rest } = over;
  return {
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal: {},
    duplicate: null,
    defaults: NO_DEFAULTS,
    types: KINDS,
    people: PEOPLE,
    role: 'adult',
    me: 'm-ahmed',
    app: { ...APP, hints: hints ?? {} },
    ...rest,
  };
};
const kindP = (value: string, confidence: number): DetailProposal => ({
  type_key: { value, confidence, cue: 'kind_words' },
});
const codes = (l: ReturnType<typeof levelItem>) => l.tags.map((t) => t.code);

describe('an intake’s metadata (0.9.0, APP1)', () => {
  it('takes an external id and the hints the contract lists, each as it says', () => {
    const ok = parseAppMetadata({
      external_id: 'mt:tenant-7f3a:doc-01HZX3K9Q2',
      hints: {
        person: { name: '  Ahmed\u0000 Khan ' },
        kind: 'bank_statement',
        title: 'Northgate\u0007 current account',
        issued: '2026-10',
        expires: '2027',
        due_date: '2026-11-20',
        amount: { value: '-2450.1', currency: 'USD' },
        tax_year: 2025,
        account_last4: '1234',
        period: 'October 2026',
        tags: ['Acme Money', 'Acme Money', 'Bank'],
      },
    });
    expect(ok).toEqual({
      ok: true,
      value: {
        external_id: 'mt:tenant-7f3a:doc-01HZX3K9Q2',
        hints: {
          person: { name: 'Ahmed Khan' },
          kind: 'bank_statement',
          title: 'Northgate current account',
          issued: { date: '2026-10-31', precision: 'month' },
          expires: { date: '2027-12-31', precision: 'year' },
          due_date: { date: '2026-11-20', precision: 'day' },
          amount: { value: '-2450.1', currency: 'USD' },
          tax_year: 2025,
          account_last4: '1234',
          period: 'October 2026',
          tags: ['Acme Money', 'Bank'],
        },
      },
    });
  });

  it('refuses what the contract does not take, naming the field', () => {
    const detail = (raw: unknown) => {
      const r = parseAppMetadata(raw);
      return r.ok ? null : r.problem.detail;
    };
    expect(detail({})).toBe('external_id');
    expect(detail({ external_id: 'has space' })).toBe('external_id');
    expect(detail({ external_id: 'x'.repeat(129) })).toBe('external_id');
    expect(detail({ external_id: 'a', reference_url: 'https://x' })).toBe('reference_url');
    expect(detail({ external_id: 'a', hints: { sensitive: true } })).toBe('hints.sensitive');
    expect(detail({ external_id: 'a', hints: { visibility: 'household' } })).toBe(
      'hints.visibility',
    );
    expect(detail({ external_id: 'a', hints: { person: { member_id: 'nope' } } })).toBe(
      'hints.person',
    );
    expect(detail({ external_id: 'a', hints: { person: { household: false } } })).toBe(
      'hints.person',
    );
    expect(detail({ external_id: 'a', hints: { issued: '2026-02-30' } })).toBe('hints.issued');
    expect(
      detail({ external_id: 'a', hints: { amount: { value: '1.23456', currency: 'USD' } } }),
    ).toBe('hints.amount');
    expect(detail({ external_id: 'a', hints: { amount: { value: '1', currency: 'usd' } } })).toBe(
      'hints.amount',
    );
    expect(detail({ external_id: 'a', hints: { tax_year: 1899 } })).toBe('hints.tax_year');
    expect(detail({ external_id: 'a', hints: { tags: Array(11).fill('t') } })).toBe('hints.tags');
    expect(detail({ external_id: 'a', hints: { title: '' } })).toBe('hints.title');
  });

  it('dates, amounts, a batch’s name, and hints sealed and opened again', () => {
    expect(hintDate('2024-02')).toEqual({ date: '2024-02-29', precision: 'month' });
    expect(hintDate('2026-13')).toBeNull();
    expect(amountText({ value: '2450.10', currency: 'USD' })).toBe('2,450.10 USD');
    expect(amountText({ value: '-1234567', currency: 'EUR' })).toBe('-1,234,567 EUR');
    expect(appBatchName('Acme Money', '2026-11-16')).toBe('From Acme Money, 16 November 2026');
    expect(appBatchName('Acme Money', '2026-11-16', 2)).toBe(
      'From Acme Money, 16 November 2026 (2)',
    );
    const hints: AppHints = {
      kind: 'utility_bill',
      issued: { date: '2026-10-31', precision: 'month' },
      due_date: { date: '2026-11-20', precision: 'day' },
    };
    expect(storedAppHints(JSON.parse(sealedAppHints(hints)))).toEqual(hints);
    expect(storedAppHints({ v: 2, hints })).toEqual({});
    expect(storedAppHints({ v: 1, hints: { colour: 'red' } })).toEqual({});
  });

  it('whose Inbox a send goes to: the person it names, when they may have it (APP5)', () => {
    const family = [
      { id: 'm-sara', name: 'Sara Khan' },
      { id: 'm-sara-p', name: 'Sara Patel' },
      { id: 'm-ahmed', name: 'Ahmed Khan' },
      { id: 'm-teen', name: 'Tariq Khan' },
    ];
    const adults = new Set(['m-sara', 'm-sara-p', 'm-ahmed']);
    const of = (hints: AppHints, kind: { belongs_to?: 'person' | 'household' } | null = null) =>
      appInboxOf({ hints, kind, people: family, receives: (id) => adults.has(id) });
    expect(of({ person: { member_id: 'm-ahmed' } })).toBe('m-ahmed');
    expect(of({ person: { name: 'sara  KHAN' } })).toBe('m-sara');
    expect(of({ person: { name: 'Ahmed' } })).toBe('m-ahmed');
    // Two Saras, nobody, a teen, somebody not of the family, the household, nobody said.
    expect(of({ person: { name: 'Sara' } })).toBeNull();
    expect(of({ person: { name: 'J Smith' } })).toBeNull();
    expect(of({ person: { member_id: 'm-teen' } })).toBeNull();
    expect(of({ person: { name: 'Tariq' } })).toBeNull();
    expect(of({ person: { member_id: 'm-guest' } })).toBeNull();
    expect(of({ person: { household: true } })).toBeNull();
    expect(of({ kind: 'bank_statement' })).toBeNull();
    // A kind that usually belongs to the household, whoever it names.
    expect(of({ person: { member_id: 'm-ahmed' } }, { belongs_to: 'household' })).toBeNull();
    expect(of({ person: { member_id: 'm-ahmed' } }, { belongs_to: 'person' })).toBe('m-ahmed');
  });

  it('the file a send became, again: kept, out of the Trash, never Only me nor a never-category (APP5)', () => {
    const ok = {
      deleted: false,
      visibility: 'household',
      file_removed: false,
      category: 'financial',
      kind_category: 'financial',
    };
    expect(appMayDownloadSent(ok)).toBe(true);
    expect(appMayDownloadSent({ ...ok, visibility: 'adults' })).toBe(true);
    expect(appMayDownloadSent({ ...ok, visibility: 'private' })).toBe(false);
    expect(appMayDownloadSent({ ...ok, visibility: 'something new' })).toBe(false);
    expect(appMayDownloadSent({ ...ok, deleted: true })).toBe(false);
    expect(appMayDownloadSent({ ...ok, file_removed: true })).toBe(false);
    expect(appMayDownloadSent({ ...ok, category: 'identity', kind_category: 'identity' })).toBe(
      false,
    );
    expect(appMayDownloadSent({ ...ok, kind_category: null })).toBe(false);
  });

  it('a name is a person by the whole name, else a first name only one person has', () => {
    expect(personByName('sara  KHAN', PEOPLE)).toBe('m-sara');
    expect(personByName('Sara', PEOPLE)).toBe('m-sara');
    expect(personByName('Ahmed', PEOPLE)).toBe('m-ahmed');
    expect(personByName('Khan', PEOPLE)).toBeNull();
    expect(personByName('J Smith', PEOPLE)).toBeNull();
    expect(
      personByName('Sam', [
        { id: 'a', name: 'Sam One' },
        { id: 'b', name: 'Sam Two' },
      ]),
    ).toBeNull();
  });
});

describe('hints meet the reading (0.9.0, APP1)', () => {
  it('the pages say nothing: the hint fills it, as a default would, and it may be Ready', () => {
    const l = levelItem(
      input({ hints: { kind: 'bank_statement', person: { name: 'Ahmed Khan' } } }),
    );
    expect(l.proposals?.type_key).toEqual({
      value: 'bank_statement',
      from: 'app',
      confidence: null,
      cue: null,
    });
    expect(l.proposals?.owner_member_id).toMatchObject({ value: 'm-ahmed', from: 'app' });
    expect(l.proposals?.app_name).toBe('Acme Money');
    expect(l.level).toBe('ready');
  });

  it('the pages agree: surer for it, and sure where the pages were nearly so', () => {
    const near = levelItem(
      input({ proposal: kindP('bank_statement', 0.8), hints: { kind: 'bank_statement' } }),
    );
    expect(near.proposals?.type_key).toMatchObject({
      value: 'bank_statement',
      from: 'pages',
      app: true,
    });
    expect(near.proposals?.type_key?.confidence ?? 0).toBeGreaterThanOrEqual(ITEM_SURE.type_key);
    expect(codes(near)).not.toContain('kind_unsure');
    const weak = levelItem(
      input({ proposal: kindP('bank_statement', 0.5), hints: { kind: 'bank_statement' } }),
    );
    expect(weak.proposals?.type_key?.confidence ?? 1).toBeLessThan(ITEM_SURE.type_key);
    expect(codes(weak)).toContain('kind_unsure');
  });

  it('a confident reading that disagrees stands, and both are said: Check', () => {
    const l = levelItem(
      input({
        proposal: kindP('utility_bill', CLASH_CONFIDENCE),
        hints: { kind: 'bank_statement' },
      }),
    );
    expect(l.proposals?.type_key).toMatchObject({ value: 'utility_bill', from: 'pages' });
    expect(l.level).toBe('check');
    expect(l.tags).toContainEqual(
      expect.objectContaining({
        code: 'clash_app',
        words: 'The pages say Bill; Acme Money says Bank statement',
      }),
    );
  });

  it('an unsure reading that disagrees gives way to the hint, and is still Check', () => {
    const l = levelItem(
      input({ proposal: kindP('utility_bill', 0.6), hints: { kind: 'bank_statement' } }),
    );
    expect(l.proposals?.type_key).toMatchObject({ value: 'bank_statement', from: 'app' });
    expect(l.level).toBe('check');
    expect(codes(l)).toContain('clash_app');
  });

  it('the dates and the issuer follow the same table; fields never read are filled; one the kind lacks is said', () => {
    const l = levelItem(
      input({
        proposal: {
          ...kindP('utility_bill', 0.95),
          issued: {
            value: { date: '2026-10-01', precision: 'day' },
            confidence: 0.9,
            cue: 'issue_label',
          },
        },
        hints: {
          issued: { date: '2026-10-02', precision: 'day' },
          due_date: { date: '2026-11-20', precision: 'day' },
          amount: { value: '84.20', currency: 'GBP' },
          tax_year: 2025,
          title: 'Northgate Water, October',
          person: { household: true },
        },
      }),
    );
    // The pages' confident issue date stands, and the difference is said.
    expect(l.proposals?.issued).toMatchObject({ value: { date: '2026-10-01' }, from: 'pages' });
    expect(l.tags).toContainEqual(
      expect.objectContaining({
        code: 'clash_app',
        words: 'The pages and Acme Money give different issue dates',
      }),
    );
    // A bill's due date is its reminding date, the card's end date.
    expect(l.proposals?.expires).toMatchObject({ value: { date: '2026-11-20' }, from: 'app' });
    expect(l.proposals?.extra).toEqual({
      amount: { value: '84.20 GBP', from: 'app', confidence: null, cue: null },
    });
    expect(l.proposals?.title?.value).toBe('Northgate Water, October');
    expect(l.proposals?.household).toBe(true);
    expect(l.tags).toContainEqual(
      expect.objectContaining({ code: 'app_said', words: 'Acme Money said: tax year 2025' }),
    );
    // What Accept all Ready would file: the app's title, amount and due date, the household's.
    const body = untouchedAccept({
      proposals: l.proposals as NonNullable<typeof l.proposals>,
      defaults: NO_DEFAULTS,
      types: KINDS as unknown as DocumentTypeView[],
      people: PEOPLE.map((p) => ({ id: p.id, display_name: p.name })),
      role: 'adult',
      me: 'm-ahmed',
    });
    expect(body).toMatchObject({
      type_key: 'utility_bill',
      title: 'Northgate Water, October',
      owner_member_id: null,
      household_owned: true,
      extra: { amount: '84.20 GBP', due_date: { date: '2026-11-20', precision: 'day' } },
    });
  });

  it('a name it gave that matches nobody is no hint, and is said; the app is never told', () => {
    const l = levelItem(input({ hints: { kind: 'bank_statement', person: { name: 'J Smith' } } }));
    expect(l.proposals?.owner_member_id).toBeUndefined();
    expect(l.tags).toContainEqual(
      expect.objectContaining({
        code: 'app_said',
        words: 'Acme Money said “J Smith”: nobody in the family by that name',
      }),
    );
    expect(codes(l)).toContain('person_missing');
  });

  it('a kind the app may not send, or never sends, is held for a look', () => {
    const receipt = levelItem(input({ proposal: kindP('warranty', 0.95) }));
    expect(receipt.level).toBe('check');
    expect(receipt.tags).toContainEqual(
      expect.objectContaining({
        code: 'app_kind_not_allowed',
        words: 'Acme Money may not send a warranty',
      }),
    );
    const passport = levelItem(
      input({
        proposal: kindP('passport', 0.95),
        app: { ...APP, allowed_kinds: ['passport'], hints: {} },
      }),
    );
    expect(passport.tags).toContainEqual(
      expect.objectContaining({
        code: 'app_kind_not_allowed',
        words: 'Not a kind Acme Money sends',
      }),
    );
  });

  it('its tags are offered, never ticked; and without an app nothing changes', () => {
    const l = levelItem(input({ hints: { kind: 'bank_statement', tags: ['Acme Money'] } }));
    expect(l.proposals?.tags).toEqual([
      { value: 'Acme Money', from: 'app', existing: false, ticked: false },
    ]);
    const plain = levelItem(input({ app: null, proposal: kindP('warranty', 0.95) }));
    expect(codes(plain)).not.toContain('app_kind_not_allowed');
    expect(plain.proposals?.app_name).toBeUndefined();
  });
});

describe('what an app did, in the activity log (0.9.0, APP1)', () => {
  const event = (
    action: string,
    detail: Record<string, unknown>,
    over: Partial<ActivityEvent> = {},
  ) =>
    describeEvent({
      id: 1,
      at: '2026-11-16T12:00:00Z',
      action,
      actor: 'Ahmed',
      actor_member_id: 'm-ahmed',
      actor_label: null,
      object_type: 'member',
      object_id: 'm-ahmed',
      object_title: 'Ahmed',
      detail: { app_id: 'a', app: 'Acme Money', ...detail },
      ...over,
    });

  it('says the person via the app, and never what it sent', () => {
    expect(event('app.sent', {})?.text).toBe('Ahmed via Acme Money sent a file to their Inbox');
    expect(event('app.sent', {})?.kind).toBe('added');
    expect(event('app.checked', {})?.text).toBe('Ahmed via Acme Money checked on files it sent');
    expect(event('app.key_added', {}, { actor: 'Olivia' })).toMatchObject({
      text: 'Olivia generated an API key for Acme Money',
      notable: true,
      kind: 'people',
    });
    expect(event('app.key_added', { approval: 'asked_again' }, { actor: 'Olivia' })?.text).toBe(
      'Olivia generated an API key for Acme Money, so Ahmed must turn it on again',
    );
    expect(event('app.key_retired', {}, { actor: 'Olivia' })?.text).toBe(
      'Olivia revoked an API key of Acme Money',
    );
    // The vault's own notices: nobody did them, and they name nobody.
    expect(
      event('app.key_expiring', { expires_at: '2026-12-01T09:00:00.000Z' }, { actor: null }),
    ).toMatchObject({
      text: 'An API key of Acme Money expires on 1 December 2026 at 09:00',
      notable: true,
      actor_member_id: null,
    });
    expect(event('app.key_expired', {}, { actor: null })).toMatchObject({
      text: 'An API key of Acme Money has expired',
      notable: true,
      actor_member_id: null,
    });
    expect(event('app.connected', {}, { actor: 'Olivia', actor_member_id: 'm-olivia' })?.text).toBe(
      'Olivia connected Acme Money, acting as Ahmed',
    );
    expect(event('app.revoked', { reason: 'owner' }, { actor: 'Olivia' })?.text).toBe(
      'Olivia removed Acme Money',
    );
    const refused = event('app.refused_today', { code: 'app_key_expired' }, { actor: null });
    expect(refused).toMatchObject({
      text: 'Requests from Acme Money were refused today (API key expired)',
      notable: true,
      actor_member_id: null,
    });
  });
});

describe('what an app may read (0.9.0, APP2)', () => {
  const base: AppReadCase = {
    document: {
      visibility: 'household',
      is_essential: false,
      sensitive: null,
      deleted: false,
      type_key: 'utility_bill',
      category: 'bills',
      paper_date: '2026-10-01',
    },
    kind: { category: 'bills', sensitive_default: false, usually_essential: false },
    role: 'adult',
    own: false,
    grants: [{ kind_key: null, category: 'bills', lookback_months: 12, sensitive_kinds: [] }],
    today: '2026-11-16',
  };
  const may = (over: Partial<AppReadCase>, doc: Partial<AppReadCase['document']> = {}) =>
    appMayRead({ ...base, ...over, document: { ...base.document, ...doc } });

  it('a lookback is counted back by months, as the database counts it', () => {
    expect(lookbackStart('2026-11-16', 12)).toBe('2025-11-16');
    expect(lookbackStart('2026-03-31', 1)).toBe('2026-02-28');
    expect(lookbackStart('2024-03-31', 1)).toBe('2024-02-29');
    expect(lookbackStart('2026-01-31', 36)).toBe('2023-01-31');
    expect(lookbackStart('2026-01-15', 1)).toBe('2025-12-15');
    expect(may({}, { paper_date: '2025-11-16' })).toBe(true);
    expect(may({}, { paper_date: '2025-11-15' })).toBe(false);
    expect(lookbackWords(1)).toBe('the last month');
    expect(lookbackWords(12)).toBe('the last 12 months');
  });

  it('never what its person cannot see, Only me, Essential, the Trash, a note or a marked paper', () => {
    expect(may({})).toBe(true);
    expect(may({}, { visibility: 'private' })).toBe(false);
    expect(may({ own: true }, { visibility: 'private' })).toBe(false);
    expect(may({}, { visibility: 'adults' })).toBe(true);
    expect(may({ role: 'teen' })).toBe(false);
    expect(may({}, { is_essential: true })).toBe(false);
    expect(may({}, { deleted: true })).toBe(false);
    expect(may({}, { sensitive: true })).toBe(false);
    expect(may({ own: true }, { sensitive: true })).toBe(false);
    expect(may({}, { type_key: 'note' })).toBe(false);
    expect(may({ kind: null })).toBe(false);
    expect(may({}, { visibility: 'somebody_new' })).toBe(false);
  });

  it('only the categories an app may ever be given, its own included', () => {
    const passport = { type_key: 'passport', category: 'identity' };
    const identity = { category: 'identity', sensitive_default: true, usually_essential: false };
    const grants = [
      { kind_key: 'passport', category: null, lookback_months: 36, sensitive_kinds: ['passport'] },
    ];
    expect(may({ grants, kind: identity }, passport)).toBe(false);
    expect(may({ own: true, kind: identity }, passport)).toBe(false);
    expect(
      may({ kind: { category: 'medical', sensitive_default: true, usually_essential: false } }),
    ).toBe(false);
    // A kind kept as an Essential is never read through a grant; its own still is.
    const kept = { category: 'bills', sensitive_default: false, usually_essential: true };
    expect(may({ kind: kept })).toBe(false);
    expect(may({ kind: kept, own: true })).toBe(true);
    expect(may({}, { category: 'legal' })).toBe(false);
    expect(
      may({
        kind: {
          category: 'a_category_added_later',
          sensitive_default: false,
          usually_essential: false,
        },
      }),
    ).toBe(false);
  });

  it('a kind Sensitive by default needs its grant confirmed; its own need none', () => {
    const statement = { type_key: 'bank_statement', category: 'financial' };
    const kind = { category: 'financial', sensitive_default: true, usually_essential: false };
    const grant = (confirmed: boolean) => [
      {
        kind_key: 'bank_statement',
        category: null,
        lookback_months: 12,
        sensitive_kinds: confirmed ? ['bank_statement'] : [],
      },
    ];
    expect(may({ kind, grants: grant(false) }, statement)).toBe(false);
    expect(may({ kind, grants: grant(true) }, statement)).toBe(true);
    expect(may({ kind, grants: grant(false) }, { ...statement, sensitive: false })).toBe(true);
    expect(may({ kind, grants: [], own: true }, statement)).toBe(true);
    // Confirmed for another kind is not confirmed for this one.
    expect(
      may(
        {
          kind,
          grants: [
            {
              kind_key: null,
              category: 'financial',
              lookback_months: 12,
              sensitive_kinds: ['loan'],
            },
          ],
        },
        statement,
      ),
    ).toBe(false);
    // A kind whose default is not said is taken as Sensitive.
    expect(
      may(
        {
          kind: { category: 'financial', sensitive_default: null, usually_essential: false },
          grants: grant(false),
        },
        statement,
      ),
    ).toBe(false);
    expect(
      appSensitiveConfirmWords('Acme Money', ['Bank statement', 'Pay statement / payslip']),
    ).toBe(
      'Bank statement and Pay statement / payslip are sensitive. Acme Money will be able to read them. Allow anyway?',
    );
  });
});

describe('an app’s lines in the activity log (0.9.0, APP2)', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 16, 12, 0) - min * 60_000).toISOString();
  let id = 1000;
  const ev = (action: string, min: number, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
    id: id--,
    at: at(min),
    action,
    actor: 'Ahmed',
    actor_id: 'acc-ahmed',
    actor_member_id: 'm-ahmed',
    actor_label: null,
    object_type: 'member',
    object_id: 'm-ahmed',
    object_title: null,
    detail: { app_id: 'app-1', app: 'Acme Money' },
    ...over,
  });

  it('files sent to the Inbox of the person they are about name it, and fold per Inbox (APP5)', () => {
    const sara = { object_id: 'm-sara', object_title: 'Sara Khan' };
    const lines = describeEvents([
      ev('app.sent', 0, sara),
      ev('app.sent', 2, sara),
      ev('app.sent', 4),
      ev('app.withdrawn', 6, sara),
    ]).map((l) => l.text);
    expect(lines).toEqual([
      'Ahmed via Acme Money sent 2 files to Sara Khan’s Inbox',
      'Ahmed via Acme Money sent a file to their Inbox',
      'Ahmed via Acme Money took back a file it sent to Sara Khan’s Inbox',
    ]);
  });

  it('files sent close together are one line: "sent 12 files"', () => {
    const sent = Array.from({ length: 12 }, (_, i) => ev('app.sent', i * 3));
    expect(describeEvents(sent).map((l) => l.text)).toEqual([
      'Ahmed via Acme Money sent 12 files to their Inbox',
    ]);
    // More than an hour between: two lines; another app, its own.
    const apart = describeEvents([
      ev('app.sent', 0),
      ev('app.sent', 5),
      ev('app.sent', 90),
      ev('app.sent', 91, { detail: { app_id: 'app-2', app: 'Ledger' } }),
    ]);
    expect(apart.map((l) => l.text)).toEqual([
      'Ahmed via Acme Money sent 2 files to their Inbox',
      'Ahmed via Acme Money sent a file to their Inbox',
      'Ahmed via Ledger sent a file to their Inbox',
    ]);
  });

  it('a download and a read, as the person via the app; a sensitive one never named', () => {
    const doc = { object_type: 'document', object_id: 'd-1', object_title: 'Northgate, October' };
    const lines = describeEvents([
      ev('document.downloaded', 0, doc),
      ev('document.downloaded', 2, doc),
      ev('app.read', 3, doc),
      ev('app.looked_up', 4),
      ev('document.downloaded', 5, { ...doc, object_sensitive: true }),
    ]);
    expect(lines.map((l) => [l.text, l.kind])).toEqual([
      ['Ahmed via Acme Money downloaded “Northgate, October”', 'opened'],
      ['Ahmed via Acme Money read the details of “Northgate, October”', 'opened'],
      ['Ahmed via Acme Money looked up documents', 'opened'],
      ['Ahmed via Acme Money downloaded a sensitive document', 'opened'],
    ]);
    // A family download is said as it always was, and never folded with an app's.
    expect(
      describeEvents([ev('document.downloaded', 0, { ...doc, detail: {} })]).map((l) => l.text),
    ).toEqual(['Ahmed downloaded “Northgate, October”']);
  });
});

describe('filing automatically: only when everything is sure and complete (0.9.0, APP4)', () => {
  const KIND: Proposed<string> = { value: 'bank_statement', confidence: 0.95, cue: 'kind_words' };
  const AHMED: Proposed<string> = { value: 'm-ahmed', confidence: 0.95, cue: 'name_on_page' };
  const PAGES: DetailProposal = { type_key: KIND, owner_member_id: AHMED };
  const sure = (over: Partial<LevelInput> & { hints?: AppHints } = {}) => {
    const i = input({
      proposal: PAGES,
      hints: { kind: 'bank_statement', person: { member_id: 'm-ahmed' } },
      ...over,
    });
    const l = levelItem(i);
    return { level: l.level, files: appFilesItself(i, l) };
  };
  const BILL: DetailProposal = {
    type_key: { value: 'utility_bill', confidence: 0.95, cue: 'kind_words' },
  };
  const DUE = { date: '2026-11-20', precision: 'day' } as const;

  it('files when the pages and the app agree on a kind it may send, and whose it is', () => {
    expect(sure()).toEqual({ level: 'ready', files: true });
    // The pages alone, sure, with the app saying nothing: the reading is enough.
    expect(sure({ hints: {} })).toEqual({ level: 'ready', files: true });
    // A household's bill: nobody named by the pages, the app says the household's.
    expect(sure({ proposal: BILL, hints: { person: { household: true }, due_date: DUE } })).toEqual(
      { level: 'ready', files: true },
    );
  });

  it('a hint alone is never enough: the kind, or the person, must be the pages’ own', () => {
    // Ready by the app's hints alone, as a default would make it: it waits.
    expect(
      sure({ proposal: {}, hints: { kind: 'bank_statement', person: { name: 'Ahmed Khan' } } }),
    ).toEqual({ level: 'ready', files: false });
    expect(sure({ proposal: { type_key: KIND } })).toEqual({
      level: 'ready',
      files: false,
    });
  });

  it('unsure, or sure only by a rule or the reading model: it waits', () => {
    const at = (type_key: Proposed<string>) =>
      sure({ proposal: { ...PAGES, type_key }, hints: {} });
    expect(at({ value: 'bank_statement', confidence: 0.6, cue: 'kind_words' }).files).toBe(false);
    expect(at({ value: 'bank_statement', confidence: 0.95, cue: 'learned' }).files).toBe(false);
    expect(
      at({ value: 'bank_statement', confidence: 0.95, cue: 'kind_words', model: 'alone' }).files,
    ).toBe(false);
  });

  it('any clash waits: the pages and the app disagree', () => {
    expect(sure({ hints: { kind: 'bank_statement', person: { member_id: 'm-sara' } } })).toEqual({
      level: 'check',
      files: false,
    });
    const dates = sure({
      proposal: {
        ...PAGES,
        issued: {
          value: { date: '2026-10-01', precision: 'day' },
          confidence: 0.9,
          cue: 'issue_label',
        },
      },
      hints: { issued: { date: '2026-10-09', precision: 'day' } },
    });
    expect(dates).toEqual({ level: 'check', files: false });
  });

  it('a near match, or a duplicate, waits', () => {
    expect(sure({ renewal: { title: 'Northgate, September' } }).files).toBe(false);
    expect(
      sure({ duplicate: { of: 'document', document_id: 'd-1', title: 'Northgate, October' } })
        .files,
    ).toBe(false);
  });

  it('the app named somebody the card does not have, or the household’s for a person’s paper: it waits', () => {
    // A name nobody in the family has is only said; the pages' person stands.
    expect(sure({ hints: { kind: 'bank_statement', person: { name: 'J Smith' } } })).toEqual({
      level: 'ready',
      files: false,
    });
    expect(sure({ hints: { person: { household: true } } }).files).toBe(false);
    // A bill the pages put a person on, which the app says is the household's.
    expect(
      sure({
        proposal: { ...BILL, owner_member_id: AHMED },
        hints: { person: { household: true }, due_date: DUE },
      }).files,
    ).toBe(false);
  });

  it('nobody on a paper that is a person’s: it waits', () => {
    expect(sure({ proposal: { type_key: KIND }, hints: {} })).toEqual({
      level: 'check',
      files: false,
    });
  });

  it('a required field missing waits', () => {
    // A bill with no due date: its Due date is required.
    expect(sure({ proposal: BILL, hints: { person: { household: true } } })).toEqual({
      level: 'check',
      files: false,
    });
  });

  it('a kind the app may not send, or never sends, waits', () => {
    expect(
      sure({
        proposal: {
          ...PAGES,
          type_key: { value: 'warranty', confidence: 0.95, cue: 'kind_words' },
        },
        hints: {},
      }).files,
    ).toBe(false);
    expect(
      sure({
        proposal: {
          ...PAGES,
          type_key: { value: 'passport', confidence: 0.95, cue: 'kind_words' },
        },
        app: { ...APP, allowed_kinds: ['passport'], hints: {} },
      }).files,
    ).toBe(false);
  });

  it('a kind the household keeps as an Essential, even one marked so after the app was allowed it, waits', () => {
    const types = KINDS.map((k) =>
      k.key === 'bank_statement' ? { ...k, usually_essential: true } : k,
    );
    const i = input({
      proposal: PAGES,
      hints: { kind: 'bank_statement', person: { member_id: 'm-ahmed' } },
      types,
    });
    const l = levelItem(i);
    expect(l.level).toBe('check');
    expect(l.tags).toContainEqual(
      expect.objectContaining({
        code: 'app_kind_not_allowed',
        words: 'Not a kind Acme Money sends',
      }),
    );
    expect(appFilesItself(i, l)).toBe(false);
  });

  it('the local AI reading it otherwise waits', () => {
    expect(
      sure({ localAi: { state: 'read', fields: { type_key: 'utility_bill' } } }),
    ).toMatchObject({ files: false });
  });

  it('not read yet, read failed, decided, or not from an app: never', () => {
    expect(sure({ reading: 'waiting' }).files).toBe(false);
    expect(sure({ reading: 'failed', failure: 'unreadable' }).files).toBe(false);
    expect(sure({ state: 'accepted' }).files).toBe(false);
    expect(sure({ app: null }).files).toBe(false);
  });

  it('is said in the activity log as filed from the app, by nobody; a sensitive one never named', () => {
    const line = (over: Partial<ActivityEvent> = {}) =>
      describeEvent({
        id: 1,
        at: '2026-11-17T12:00:00Z',
        action: 'document.created',
        actor: 'Ahmed',
        actor_member_id: 'm-ahmed',
        actor_label: null,
        object_type: 'document',
        object_id: 'd-1',
        object_title: 'Northgate, October',
        detail: { title: 'Northgate, October', app_id: 'a', app: 'Acme Money', auto: true },
        ...over,
      });
    expect(line()).toMatchObject({
      text: 'Filed automatically from Acme Money: “Northgate, October”',
      kind: 'added',
      actor_member_id: null,
      document_id: 'd-1',
    });
    expect(line({ object_sensitive: true })?.text).toBe(
      'Filed automatically from Acme Money: a sensitive document',
    );
    // A person's own add is said as it always was.
    expect(line({ detail: { title: 'Northgate, October' } })?.text).toBe(
      'Ahmed added “Northgate, October”',
    );
    // Its first file is not said again as an upload: nobody uploaded it.
    expect(line({ action: 'document.version_added' })).toBeNull();
    expect(line({ action: 'document.version_added', detail: { version_no: 1 } })?.text).toBe(
      'Ahmed uploaded a new copy of “Northgate, October”',
    );
  });
});
