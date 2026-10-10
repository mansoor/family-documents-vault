import { randomUUID } from 'node:crypto';
import {
  EnvKeyProvider,
  itemProposalsBinding,
  itemTextBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  LEARNED_RULES_MAX,
  untouchedAccept,
  type BatchAcceptReadyResult,
  type BatchDetail,
  type BatchItemView,
  type BatchLearning,
  type DetailProposal,
  type DocumentTypeView,
  type LearnedClash,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * The vault learns from your corrections (Phase 6, I4), in the API: what an
 * accept teaches — a rule for the issuer, never the text — the count, an
 * Undo taking back what it taught, and forgetting. Each person's alone:
 * nobody else, an owner included, is given another's rules, at the API or
 * in the database. The worker is not here: what it seals is planted as it
 * seals it.
 */

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${randomUUID()}\n%%EOF\n`);
const day = (date: string) => ({ date, precision: 'day' as const });

describe.skipIf(!testAdminUrl())('learning from corrections (I4)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let other: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    hh = owner.household_id;
    adult = await h.join(owner, { name: 'Sana', email: 'sana@example.test', role: 'adult' });
    other = await h.join(owner, { name: 'Imran', email: 'imran@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Zara', email: 'zara@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 1);
    app = createPool(h.appUrl, 1);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await app?.end();
    await h?.close();
  });

  const call = (who: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(who),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const made = async (who: Tokens, body: Record<string, unknown> = {}) => {
    const res = await call(who, 'POST', '/api/v1/batches', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<BatchDetail>();
  };
  const sent = async (who: Tokens, batchId: string) => {
    const form = new FormData();
    form.append('file', PDF('scan'), {
      filename: 'scan-of-secret.pdf',
      contentType: 'application/pdf',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batchId}/items`,
      headers: { ...h.as(who), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<BatchItemView>();
  };
  const itemOf = async (who: Tokens, batchId: string, itemId: string) => {
    const res = await call(who, 'GET', `/api/v1/batches/${batchId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BatchDetail>().items.find((i) => i.id === itemId) as BatchItemView;
  };
  /** What the worker writes once it has read an item: its words and what they propose, sealed. */
  const plant = async (itemId: string, proposal: DetailProposal, clash?: LearnedClash) =>
    withSystem(h.db, hh, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow();
      const fileKey = unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${itemId}`,
      );
      await trx
        .updateTable('incoming_file')
        .set({
          read_state: 'read',
          preview_state: 'ready',
          preview_pages: 1,
          text_sealed: sealBytes(fileKey, Buffer.from('its words'), itemTextBinding(itemId)),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(
              JSON.stringify(clash ? { v: 1, proposal, learned_clash: clash } : { v: 1, proposal }),
            ),
            itemProposalsBinding(itemId),
          ),
        })
        .where('id', '=', itemId)
        .execute();
    });
  /** An item of `who`'s, read with this proposal, in a batch of its own. */
  const readItem = async (who: Tokens, proposal: DetailProposal, clash?: LearnedClash) => {
    const b = await made(who);
    const it = await sent(who, b.id);
    await plant(it.id, proposal, clash);
    return { batch: b.id, item: it.id };
  };
  const accept = async (
    who: Tokens,
    at: { batch: string; item: string },
    body: Record<string, unknown>,
  ) => {
    const res = await call(
      who,
      'POST',
      `/api/v1/batches/${at.batch}/items/${at.item}/accept`,
      body,
    );
    expect(res.statusCode, res.body).toBe(201);
  };
  const learned = async (who: Tokens) => {
    const res = await call(who, 'GET', '/api/v1/batches/learned');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BatchLearning>();
  };
  const forget = async (who: Tokens) => {
    const res = await call(who, 'DELETE', '/api/v1/batches/learned');
    expect(res.statusCode, res.body).toBe(204);
  };
  const rulesOf = async (who: Tokens) =>
    (await learned(who)).rules.map(
      (r) => `${r.issuer} ${r.field}=${r.label ?? r.value} ${r.confirmed}/${r.contradicted}`,
    );
  const types = async (who: Tokens) =>
    (await call(who, 'GET', '/api/v1/document-types')).json<{ items: DocumentTypeView[] }>().items;

  /** As somebody signed in, or the vault, one statement, rolled back: its rows or the error's code. */
  const asThem = async (
    as: { who: Tokens; role: string } | 'system',
    text: string,
    params: unknown[] = [],
  ): Promise<unknown[] | string> => {
    const client = await app.connect();
    try {
      await client.query('begin');
      if (as === 'system') {
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'system', true)`,
          [hh],
        );
      } else {
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true), set_config('app.role', $3, true)`,
          [hh, as.who.member_id, as.role],
        );
      }
      return (await client.query<Record<string, unknown>>(text, params)).rows;
    } catch (err) {
      return (err as { code?: string }).code ?? 'error';
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  };

  /** A letter from the dentist: the pages say a tax return, wrongly, and name nobody. */
  const dentist = (extra: DetailProposal = {}): DetailProposal => ({
    type_key: { value: 'tax_return', confidence: 0.9, cue: 'kind_words' },
    issued_by: { value: 'Northgate Dental Ltd', confidence: 0.9, cue: 'letterhead' },
    ...extra,
  });

  it('says it learns', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<{
      features: Record<string, unknown>;
    }>();
    expect(caps.features.batch_learning).toBe(true);
  });

  it('a correction makes a rule, and it keeps nothing but the issuer’s key, what it says, its counts and a day', async () => {
    await forget(adult);
    const at = await readItem(
      adult,
      dentist({
        identifier: { value: 'ND-SECRET-991', confidence: 0.85, cue: 'number_label' },
        issued: { value: day('2026-03-02'), confidence: 0.85, cue: 'issue_label' },
      }),
    );
    await accept(adult, at, {
      type_key: 'medical_record',
      title: 'TITLE-SECRET-4471',
      owner_member_id: owner.member_id,
      issued_by: 'Northgate Dental Ltd',
      identifier: 'ND-SECRET-991',
      issued: day('2026-03-02'),
      notes: 'NOTE-SECRET-5512',
    });
    const got = await learned(adult);
    expect(got).toMatchObject({ counted: 1, unchanged: 0, window: 50, rules_max: 500 });
    expect(got.rules.map((r) => ({ ...r, id: 'id', last_used: 'day' }))).toEqual([
      {
        id: 'id',
        issuer: 'northgate dental',
        field: 'type_key',
        value: 'medical_record',
        label: expect.any(String) as string,
        confirmed: 1,
        contradicted: 0,
        sure: false,
        last_used: 'day',
      },
      {
        id: 'id',
        issuer: 'northgate dental',
        field: 'owner_member_id',
        value: owner.member_id,
        label: expect.any(String) as string,
        confirmed: 1,
        contradicted: 0,
        sure: false,
        last_used: 'day',
      },
    ]);
    expect(got.rules[0]?.last_used).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The tables hold these columns and no others…
    const columns = async (table: string) =>
      (
        await admin.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1 order by column_name`,
          [table],
        )
      ).rows.map((r) => r.column_name);
    expect(await columns('intake_rule')).toEqual([
      'confirmed',
      'contradicted',
      'household_id',
      'id',
      'issuer_key',
      'last_used',
      'member_id',
      'person_id',
      'type_key',
    ]);
    expect(await columns('intake_outcome')).toEqual([
      'accepted_at',
      'confirmed_rules',
      'contradicted_rules',
      'household_id',
      'item_id',
      'member_id',
      'unchanged',
    ]);
    // …and none of what was filed: not the number, the date, the name, the
    // note, the file's name, nor the issuer as written.
    const rows = await admin.query(
      `select r.*, o.* from intake_rule r join intake_outcome o
          on o.member_id = r.member_id where r.member_id = $1`,
      [adult.member_id],
    );
    const said = JSON.stringify(rows.rows);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const secret of [
      'ND-SECRET-991',
      '2026-03-02',
      'TITLE-SECRET-4471',
      'NOTE-SECRET-5512',
      'scan-of-secret',
      'Northgate Dental Ltd',
      'Ltd',
    ]) {
      expect(said).not.toContain(secret);
    }
  });

  it('an unchanged accept confirms a rule and counts as needing no change; a contradiction counts against it, and drops it', async () => {
    await forget(adult);
    const kindRule = async () =>
      (await learned(adult)).rules.find(
        (r) => r.field === 'type_key' && r.value === 'medical_record',
      );
    // Taught once…
    await accept(adult, await readItem(adult, dentist()), {
      type_key: 'medical_record',
      issued_by: 'Northgate Dental',
    });
    expect(await kindRule()).toMatchObject({ confirmed: 1, contradicted: 0 });
    // …then proposed (as the worker would, from the rule) and accepted untouched.
    for (let n = 2; n <= 3; n++) {
      const at = await readItem(adult, {
        type_key: { value: 'medical_record', confidence: 0.78, cue: 'learned' },
        issued_by: { value: 'Northgate Dental', confidence: 0.9, cue: 'known_issuer' },
      });
      const item = await itemOf(adult, at.batch, at.item);
      expect(item.proposals?.type_key).toMatchObject({ value: 'medical_record', from: 'learned' });
      await accept(adult, at, { type_key: 'medical_record', issued_by: 'Northgate Dental' });
      expect(await kindRule()).toMatchObject({ confirmed: n, contradicted: 0, sure: n >= 3 });
    }
    expect(await learned(adult)).toMatchObject({ counted: 3, unchanged: 2 });
    // Something else filed for the dentist: counted against it — as often
    // as it was confirmed, and it stays…
    for (let n = 1; n <= 3; n++) {
      await accept(adult, await readItem(adult, dentist()), {
        type_key: 'utility_bill',
        issued_by: 'Northgate Dental',
      });
      expect(await kindRule()).toMatchObject({ confirmed: 3, contradicted: n, sure: false });
    }
    // …more often, and it is dropped.
    await accept(adult, await readItem(adult, dentist()), {
      type_key: 'utility_bill',
      issued_by: 'Northgate Dental',
    });
    expect(await kindRule()).toBeUndefined();
    expect(await rulesOf(adult)).toEqual([
      expect.stringMatching(/^northgate dental type_key=.+ 4\/0$/) as string,
    ]);
  });

  it('a teen is taught no person: their documents are their own', async () => {
    await forget(teen);
    await accept(teen, await readItem(teen, dentist()), {
      type_key: 'medical_record',
      issued_by: 'Northgate Dental',
    });
    expect((await learned(teen)).rules.map((r) => r.field)).toEqual(['type_key']);
  });

  it('keeps at most 500 rules a person: past it the least used go, never the one just made', async () => {
    await forget(other);
    await admin.query(
      `insert into intake_rule (household_id, member_id, issuer_key, type_key, confirmed, last_used)
       select $1, $2, 'issuer ' || n, 'tax_return', 1,
              case when n = 0 then date '2026-01-01' else current_date end
         from generate_series(0, $3::int - 1) n`,
      [hh, other.member_id, LEARNED_RULES_MAX],
    );
    await accept(other, await readItem(other, dentist()), {
      type_key: 'medical_record',
      issued_by: 'Northgate Dental',
    });
    const got = await learned(other);
    expect(got.rules).toHaveLength(LEARNED_RULES_MAX);
    expect(got.rules.some((r) => r.issuer === 'northgate dental')).toBe(true);
    expect(got.rules.some((r) => r.issuer === 'issuer 0')).toBe(false);
    await forget(other);
  });

  it('Undo of Accept all Ready takes back what its accept taught, and its count', async () => {
    await forget(adult);
    // Taught: the dentist's letters are medical records.
    await accept(adult, await readItem(adult, dentist()), {
      type_key: 'medical_record',
      issued_by: 'Northgate Dental',
    });
    const before = await learned(adult);
    // An item Ready, as the rule and the pages propose it.
    const at = await readItem(adult, {
      type_key: { value: 'medical_record', confidence: 0.97, cue: 'kind_words', learned: true },
      owner_member_id: { value: adult.member_id, confidence: 0.95, cue: 'name_labelled' },
      issued_by: { value: 'Northgate Dental', confidence: 0.9, cue: 'known_issuer' },
    });
    expect((await itemOf(adult, at.batch, at.item)).level).toBe('ready');
    const res = await call(adult, 'POST', `/api/v1/batches/${at.batch}/accept-ready`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<BatchAcceptReadyResult>().accepted).toHaveLength(1);
    const after = await learned(adult);
    expect(after).toMatchObject({ counted: 2, unchanged: 1 });
    expect(after.rules.find((r) => r.field === 'type_key')).toMatchObject({ confirmed: 2 });
    const undone = await call(adult, 'POST', `/api/v1/batches/${at.batch}/accept-ready/undo`, {
      item_ids: [at.item],
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json<{ restored: string[] }>().restored).toEqual([at.item]);
    const back = await learned(adult);
    expect(back.counted).toBe(before.counted);
    expect(back.unchanged).toBe(before.unchanged);
    expect(back.rules.map((r) => [r.field, r.confirmed, r.contradicted])).toEqual(
      before.rules.map((r) => [r.field, r.confirmed, r.contradicted]),
    );
  });

  it('the card says a learned suggestion; a sure rule against the pages makes it Check, with both', async () => {
    const kinds = await types(adult);
    const label = (key: string) => kinds.find((t) => t.key === key)?.label as string;
    const at = await readItem(
      adult,
      {
        type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
        owner_member_id: { value: owner.member_id, confidence: 0.9, cue: 'learned' },
        issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'issuing_country' },
      },
      { type_key: 'visa' },
    );
    const item = await itemOf(adult, at.batch, at.item);
    expect(item.proposals?.owner_member_id).toMatchObject({
      value: owner.member_id,
      from: 'learned',
      cue: 'learned',
    });
    expect(item.level).toBe('check');
    expect(item.tags?.find((t) => t.code === 'clash_learned')?.words).toBe(
      `The pages say a ${label('passport').toLowerCase()}, your earlier choices say a ${label('visa').toLowerCase()}`,
    );
    // Untouched, the card files what the pages said, and the person the rule proposed.
    const body = untouchedAccept({
      proposals: item.proposals as NonNullable<BatchItemView['proposals']>,
      defaults: (await call(adult, 'GET', `/api/v1/batches/${at.batch}`)).json<BatchDetail>()
        .defaults,
      types: kinds,
      people: [],
      role: 'adult',
      me: adult.member_id,
    });
    expect(body).toMatchObject({ type_key: 'passport', owner_member_id: owner.member_id });
  });

  it('nobody else is given anybody’s rules or count — an owner included — and forgetting is the person’s own', async () => {
    await forget(adult);
    await accept(adult, await readItem(adult, dentist()), {
      type_key: 'medical_record',
      owner_member_id: adult.member_id,
      issued_by: 'Northgate Dental',
    });
    expect(await rulesOf(adult)).toHaveLength(2);
    for (const who of [owner, other, teen]) {
      await forget(who);
      const got = await learned(who);
      expect({ counted: got.counted, rules: got.rules }).toEqual({ counted: 0, rules: [] });
      expect(JSON.stringify(got)).not.toContain(adult.member_id);
    }
    // A viewer adds nothing, and is refused.
    for (const method of ['GET', 'DELETE']) {
      expect((await call(viewer, method, '/api/v1/batches/learned')).statusCode).toBe(403);
    }
    // Their forgetting left hers.
    expect(await rulesOf(adult)).toHaveLength(2);

    // In the database: an owner, another adult, a teen and a viewer are given
    // none of hers; the vault is; and nobody writes one for somebody else.
    const count = 'select count(*)::int as n from intake_rule where member_id = $1';
    const outcomes = 'select count(*)::int as n from intake_outcome where member_id = $1';
    for (const [who, role] of [
      [owner, 'owner'],
      [other, 'adult'],
      [teen, 'teen'],
      [viewer, 'viewer'],
      [adult, 'viewer'],
    ] as const) {
      for (const q of [count, outcomes]) {
        expect(await asThem({ who, role }, q, [adult.member_id])).toEqual([{ n: 0 }]);
      }
    }
    expect(await asThem({ who: adult, role: 'adult' }, count, [adult.member_id])).toEqual([
      { n: 2 },
    ]);
    expect(await asThem('system', count, [adult.member_id])).toEqual([{ n: 2 }]);
    expect(
      await asThem(
        { who: owner, role: 'owner' },
        `insert into intake_rule (household_id, member_id, issuer_key, type_key)
         values ($1, $2, 'planted', 'passport')`,
        [hh, adult.member_id],
      ),
    ).toBe('42501');
    expect(
      await asThem(
        { who: owner, role: 'owner' },
        `update intake_rule set confirmed = 99 where member_id = $1 returning id`,
        [adult.member_id],
      ),
    ).toEqual([]);

    // Forgotten: her rules and her count, and nobody else's.
    await accept(other, await readItem(other, dentist()), {
      type_key: 'medical_record',
      issued_by: 'Northgate Dental',
    });
    await forget(adult);
    expect(await learned(adult)).toMatchObject({ counted: 0, unchanged: 0, rules: [] });
    expect(await rulesOf(other)).toHaveLength(1);
  });

  it('somebody with rules keeps something private: an owner is never handed a reset link for them', async () => {
    const plain = await h.join(owner, {
      name: 'Nadia',
      email: 'nadia@example.test',
      role: 'adult',
    });
    const ask = async () =>
      (
        (await asThem(
          { who: owner, role: 'owner' },
          `select member_holds_private((select account_id from account_household
                                        where member_id = $1)) as held`,
          [plain.member_id],
        )) as Array<{ held: boolean }>
      )[0]?.held;
    expect(await ask()).toBe(false);
    // Taught by an accept from a batch since removed: the rules stay, and are hers alone.
    const at = await readItem(plain, dentist());
    await accept(plain, at, { type_key: 'medical_record', issued_by: 'Northgate Dental' });
    expect((await call(plain, 'DELETE', `/api/v1/batches/${at.batch}`)).statusCode).toBe(204);
    await admin.query(
      `update document set visibility = 'household', owner_member_id = null
        where id in (select document_id from incoming_file where id = $1)`,
      [at.item],
    );
    expect(await rulesOf(plain)).toHaveLength(1);
    expect(await ask()).toBe(true);
    await forget(plain);
    expect(await ask()).toBe(false);
  });
});
