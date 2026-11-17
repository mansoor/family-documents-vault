import { describe, expect, it } from 'vitest';
import { describeEvent, type ActivityEvent } from './activity.js';
import {
  amountText,
  appBatchName,
  hintDate,
  parseAppMetadata,
  sealedAppHints,
  storedAppHints,
  type AppHints,
} from './apps.js';
import { untouchedAccept } from './batch-review.js';
import {
  CLASH_CONFIDENCE,
  ITEM_SURE,
  levelItem,
  personByName,
  type LevelInput,
  type LevelKind,
} from './batch-levels.js';
import type { BatchDefaults } from './batches.js';
import type { DocumentTypeView } from './documents.js';
import type { DetailProposal } from './proposals.js';

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
const APP = { name: 'MonTra', allowed_kinds: ['bank_statement', 'utility_bill'] };

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
        tags: ['MonTra', 'MonTra', 'Bank'],
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
          tags: ['MonTra', 'Bank'],
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
    expect(appBatchName('MonTra', '2026-11-16')).toBe('From MonTra, 16 November 2026');
    expect(appBatchName('MonTra', '2026-11-16', 2)).toBe('From MonTra, 16 November 2026 (2)');
    const hints: AppHints = {
      kind: 'utility_bill',
      issued: { date: '2026-10-31', precision: 'month' },
      due_date: { date: '2026-11-20', precision: 'day' },
    };
    expect(storedAppHints(JSON.parse(sealedAppHints(hints)))).toEqual(hints);
    expect(storedAppHints({ v: 2, hints })).toEqual({});
    expect(storedAppHints({ v: 1, hints: { colour: 'red' } })).toEqual({});
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
    expect(l.proposals?.app_name).toBe('MonTra');
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
        words: 'The pages say Bill; MonTra says Bank statement',
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
        words: 'The pages and MonTra give different issue dates',
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
      expect.objectContaining({ code: 'app_said', words: 'MonTra said: tax year 2025' }),
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
        words: 'MonTra said “J Smith”: nobody in the family by that name',
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
        words: 'MonTra may not send a warranty',
      }),
    );
    const passport = levelItem(
      input({
        proposal: kindP('passport', 0.95),
        app: { ...APP, allowed_kinds: ['passport'], hints: {} },
      }),
    );
    expect(passport.tags).toContainEqual(
      expect.objectContaining({ code: 'app_kind_not_allowed', words: 'Not a kind MonTra sends' }),
    );
  });

  it('its tags are offered, never ticked; and without an app nothing changes', () => {
    const l = levelItem(input({ hints: { kind: 'bank_statement', tags: ['MonTra'] } }));
    expect(l.proposals?.tags).toEqual([
      { value: 'MonTra', from: 'app', existing: false, ticked: false },
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
      detail: { app_id: 'a', app: 'MonTra', ...detail },
      ...over,
    });

  it('says the person via the app, and never what it sent', () => {
    expect(event('app.sent', {})?.text).toBe('Ahmed via MonTra sent a file to their Inbox');
    expect(event('app.sent', {})?.kind).toBe('added');
    expect(event('app.checked', {})?.text).toBe('Ahmed via MonTra checked on files it sent');
    expect(event('app.key_added', { by: 'app' })).toMatchObject({
      text: 'Ahmed via MonTra added a new key to MonTra',
      notable: true,
      kind: 'people',
    });
    expect(event('app.connected', {}, { actor: 'Olivia', actor_member_id: 'm-olivia' })?.text).toBe(
      'Olivia connected MonTra, acting as Ahmed',
    );
    expect(event('app.revoked', { reason: 'owner' }, { actor: 'Olivia' })?.text).toBe(
      'Olivia removed MonTra',
    );
    const refused = event('app.refused_today', { code: 'signature_invalid' }, { actor: null });
    expect(refused).toMatchObject({
      text: 'Requests from MonTra were refused today (signature not valid)',
      notable: true,
      actor_member_id: null,
    });
  });
});
