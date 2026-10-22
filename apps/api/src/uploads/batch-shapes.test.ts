import { randomUUID } from 'node:crypto';
import {
  EnvKeyProvider,
  intakeShapeBinding,
  itemProposalsBinding,
  itemTextBinding,
  openBytes,
  ScopeKeys,
  sealBytes,
  shapeNumberHash,
  shapeNumberKey,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  readPaper,
  SHAPE_WORDS,
  storedShape,
  type BatchAcceptReadyResult,
  type BatchDetail,
  type BatchItemView,
  type BatchLearning,
  type DetailProposal,
  type PaperReading,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * The vault learns each sender's papers from your corrections (0.9.0, R1),
 * in the API: an accept of an item that was read teaches its sender's
 * layout, from the page's reading the worker sealed beside its proposal —
 * the API reads no page. A shape is sealed under its person's own key: its
 * row holds nothing in the clear but whose it is and the day. Each person's
 * alone, as their rules are: nobody else, an owner included, is given
 * another's, at the API or in the database; an Undo takes back exactly what
 * an accept taught; Forget all and being made a viewer take them away.
 */

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${randomUUID()}\n%%EOF\n`);
const day = (date: string) => ({ date, precision: 'day' as const });

/** A water bill from Northgate, due on its "Payment date". */
const bill = (billed: string, pay: string) =>
  [
    'NORTHGATE WATER',
    'Your water bill',
    '',
    `Account number        NW 4417 3391          Bill date        ${billed}`,
    'Customer              The occupier',
    '',
    'Standing charge                     £12.40',
    'Water supply                        £30.11',
    'Total to pay                        £42.51',
    '',
    `Payment date          ${pay}`,
    'We will collect this by Direct Debit from your account.',
  ].join('\n');
const paperOf = (billed: string, pay: string): PaperReading =>
  readPaper(bill(billed, pay), { people: [], household: 'The Khan family', dateOrder: 'dmy' });
/** What the pages alone propose for such a bill: a bill from Northgate, and no due date. */
const pages: DetailProposal = {
  type_key: { value: 'utility_bill', confidence: 0.97, cue: 'kind_words' },
  issued_by: { value: 'Northgate Water', confidence: 0.95, cue: 'known_issuer' },
  issued: { value: day('2026-03-03'), confidence: 0.81, cue: 'issue_label' },
};

describe.skipIf(!testAdminUrl())('learning each sender’s papers (R1)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let other: Tokens;
  let teen: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    hh = owner.household_id;
    adult = await h.join(owner, { name: 'Sana', email: 'sana-r1@example.test', role: 'adult' });
    other = await h.join(owner, { name: 'Imran', email: 'imran-r1@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Zara', email: 'zara-r1@example.test', role: 'teen' });
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
  /** An item of `who`'s, read as the worker reads it: this proposal and this page's reading, sealed. */
  const readItem = async (who: Tokens, proposal: DetailProposal, paper: PaperReading | null) => {
    const b = await call(who, 'POST', '/api/v1/batches', {});
    expect(b.statusCode, b.body).toBe(201);
    const batch = b.json<BatchDetail>().id;
    const form = new FormData();
    form.append('file', PDF('bill'), { filename: 'bill.pdf', contentType: 'application/pdf' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batch}/items`,
      headers: { ...h.as(who), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
    expect(res.statusCode, res.body).toBe(201);
    const item = res.json<BatchItemView>().id;
    await withSystem(h.db, hh, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', item)
        .executeTakeFirstOrThrow();
      const fileKey = unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${item}`,
      );
      await trx
        .updateTable('incoming_file')
        .set({
          read_state: 'read',
          preview_state: 'ready',
          preview_pages: 1,
          text_sealed: sealBytes(fileKey, Buffer.from('its words'), itemTextBinding(item)),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal, ...(paper ? { paper } : {}) })),
            itemProposalsBinding(item),
          ),
        })
        .where('id', '=', item)
        .execute();
    });
    return { batch, item };
  };
  const accept = async (who: Tokens, at: { batch: string; item: string }, body: unknown) => {
    const res = await call(
      who,
      'POST',
      `/api/v1/batches/${at.batch}/items/${at.item}/accept`,
      body,
    );
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ document_id: string }>();
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
  const filed = (who: Tokens, pay: string, billed: string) => ({
    type_key: 'utility_bill',
    title: 'TITLE-SECRET-R1',
    owner_member_id: who.member_id,
    issued_by: 'Northgate Water',
    identifier: 'NW 4417 3391',
    issued: day(billed),
    expires: day(pay),
    notes: 'NOTE-SECRET-R1',
  });
  /** One month's bill read and accepted as it truly is: due on its Payment date. */
  const month = async (who: Tokens, m: number) => {
    const mm = String(m).padStart(2, '0');
    const name = new Date(Date.UTC(2026, m - 1, 1)).toLocaleString('en-GB', {
      month: 'long',
      timeZone: 'UTC',
    });
    const at = await readItem(who, pages, paperOf(`3 ${name} 2026`, `20 ${name} 2026`));
    await accept(who, at, filed(who, `2026-${mm}-20`, `2026-${mm}-03`));
    return at;
  };
  const lessonsOf = (l: BatchLearning) =>
    (l.shapes ?? []).flatMap((s) =>
      s.lessons.map(
        (x) =>
          `${s.issuer} ${x.field}=${x.label ?? x.value} ${x.confirmed}/${x.contradicted}${x.sure ? ' sure' : ''}`,
      ),
    );
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

  it('an accept teaches the sender’s layout, sealed: its row holds nothing in the clear but whose and the day', async () => {
    await forget(adult);
    await month(adult, 3);
    const got = await learned(adult);
    expect(got.shapes_max).toBe(200);
    expect(got.shapes).toHaveLength(1);
    expect(lessonsOf(got)).toEqual(
      expect.arrayContaining([
        'northgate water type_key=Utility / bill 1/0',
        `northgate water owner_member_id=Sana 1/0`,
        'northgate water expires=payment date 1/0',
        'northgate water issued=date 1/0',
        'northgate water identifier=account number 1/0',
      ]),
    );
    const columns = (
      await admin.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'intake_shape' order by column_name`,
      )
    ).rows.map((r) => r.column_name);
    expect(columns).toEqual(['household_id', 'id', 'last_used', 'member_id', 'shape_sealed']);
    const row = (
      await admin.query<{ id: string; shape_sealed: Buffer }>(
        'select id, shape_sealed from intake_shape where member_id = $1',
        [adult.member_id],
      )
    ).rows[0] as { id: string; shape_sealed: Buffer };
    // Sealed: not even the issuer in the clear.
    expect(row.shape_sealed.toString('latin1')).not.toContain('northgate');
    // Opened under her key: the issuer, the list's words, labels — never the
    // number, the dates, the title, the note or the amounts.
    const key = await withSystem(h.db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: adult.member_id }),
    );
    const plain = openBytes(
      key.key,
      row.shape_sealed,
      intakeShapeBinding(hh, adult.member_id, row.id),
    ).toString('utf8');
    for (const secret of ['4417', '2026', 'TITLE-SECRET', 'NOTE-SECRET', '42.51', 'occupier']) {
      expect(plain, secret).not.toContain(secret);
    }
    const shape = storedShape(JSON.parse(plain));
    expect(shape?.words.every((w) => SHAPE_WORDS.has(w))).toBe(true);
    // Whose it is keeps the account's keyed hash, as the worker's thread
    // makes it (W1), under a key derived from hers: never the number.
    expect(shape?.lessons.find((l) => l.field === 'owner_member_id')?.numbers).toEqual([
      shapeNumberHash(shapeNumberKey(key.key), 'NW44173391'),
    ]);
    // Under anybody else's key, or bound to another row, it does not open.
    const theirs = await withSystem(h.db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: other.member_id }),
    );
    expect(() =>
      openBytes(theirs.key, row.shape_sealed, intakeShapeBinding(hh, adult.member_id, row.id)),
    ).toThrow();
    expect(() =>
      openBytes(key.key, row.shape_sealed, intakeShapeBinding(hh, other.member_id, row.id)),
    ).toThrow();
  });

  it('trusted once confirmed three times, and a contradiction unlearns it', async () => {
    await forget(adult);
    for (const m of [3, 4, 5]) await month(adult, m);
    const got = await learned(adult);
    expect(got.shapes).toHaveLength(1);
    expect(lessonsOf(got)).toEqual(
      expect.arrayContaining(['northgate water expires=payment date 3/0 sure']),
    );
    // Filed with another day as its due date: the label is no longer trusted.
    const at = await readItem(adult, pages, paperOf('3 June 2026', '20 June 2026'));
    await accept(adult, at, filed(adult, '2026-06-03', '2026-06-03'));
    expect(lessonsOf(await learned(adult))).toEqual(
      expect.arrayContaining(['northgate water expires=payment date 3/1']),
    );
  });

  it('an item read before 0.9.0, with no page’s reading sealed, teaches no shape', async () => {
    await forget(adult);
    const at = await readItem(adult, pages, null);
    await accept(adult, at, filed(adult, '2026-03-20', '2026-03-03'));
    const got = await learned(adult);
    expect(got.shapes).toEqual([]);
    expect(got.counted).toBe(1);
  });

  it('as a version, an accept teaches too', async () => {
    await forget(adult);
    const first = await month(adult, 3);
    void first;
    const doc = (
      await admin.query<{ id: string }>(
        `select id from document where owner_member_id = $1 and type_key = 'utility_bill'
          and deleted_at is null order by created_at desc limit 1`,
        [adult.member_id],
      )
    ).rows[0]?.id as string;
    const at = await readItem(adult, pages, paperOf('3 April 2026', '20 April 2026'));
    await accept(adult, at, { into_document_id: doc, expires: day('2026-04-20') });
    expect(lessonsOf(await learned(adult))).toEqual(
      expect.arrayContaining(['northgate water expires=payment date 2/0']),
    );
  });

  it('Accept all Ready teaches no shape (W2); an Undo takes back exactly what an accept as a version taught', async () => {
    await forget(adult);
    await month(adult, 3);
    const before = lessonsOf(await learned(adult));
    // Ready, as the pages and the shape would propose it.
    const at = await readItem(
      adult,
      {
        ...pages,
        owner_member_id: {
          value: adult.member_id,
          confidence: 0.9,
          cue: 'learned',
          shape: true,
        },
        expires: { value: day('2026-04-20'), confidence: 0.9, cue: 'learned', shape: true },
      },
      paperOf('3 April 2026', '20 April 2026'),
    );
    // A bill from the same sender for the same person is a near match: out of the way.
    await admin.query(
      `update document set deleted_at = now() where owner_member_id = $1 and type_key = 'utility_bill'`,
      [adult.member_id],
    );
    const item = (await call(adult, 'GET', `/api/v1/batches/${at.batch}`))
      .json<BatchDetail>()
      .items.find((i) => i.id === at.item) as BatchItemView;
    expect(item.level, JSON.stringify(item.tags)).toBe('ready');
    expect(item.proposals?.expires).toMatchObject({ from: 'learned', shape: true });
    const res = await call(adult, 'POST', `/api/v1/batches/${at.batch}/accept-ready`, {});
    expect(res.json<BatchAcceptReadyResult>().accepted).toHaveLength(1);
    // Filed unseen: nothing taught, nothing to take back.
    expect(lessonsOf(await learned(adult))).toEqual(before);
    const undone = await call(adult, 'POST', `/api/v1/batches/${at.batch}/accept-ready/undo`, {
      item_ids: [at.item],
    });
    expect(undone.json<{ restored: string[] }>().restored).toEqual([at.item]);
    expect(lessonsOf(await learned(adult))).toEqual(before);
    // Added as a version from its card, it teaches; its Undo takes it back exactly.
    const doc = (
      await admin.query<{ id: string }>(
        `select id from document where owner_member_id = $1 and type_key = 'utility_bill'
          order by created_at desc limit 1`,
        [adult.member_id],
      )
    ).rows[0]?.id as string;
    await admin.query('update document set deleted_at = null where id = $1', [doc]);
    const v = await readItem(adult, pages, paperOf('3 May 2026', '20 May 2026'));
    await accept(adult, v, { into_document_id: doc, expires: day('2026-05-20') });
    expect(lessonsOf(await learned(adult))).toEqual(
      expect.arrayContaining(['northgate water expires=payment date 2/0']),
    );
    const back = await call(adult, 'POST', `/api/v1/batches/${v.batch}/accept-ready/undo`, {
      item_ids: [v.item],
    });
    expect(back.json<{ restored: string[] }>().restored).toEqual([v.item]);
    expect(lessonsOf(await learned(adult))).toEqual(before);
  });

  it('a teen is taught no person; theirs are their own', async () => {
    await forget(teen);
    await month(teen, 3);
    const got = lessonsOf(await learned(teen));
    expect(got.some((l) => l.includes('owner_member_id'))).toBe(false);
    expect(got).toEqual(expect.arrayContaining(['northgate water expires=payment date 1/0']));
  });

  it('nobody else is given anybody’s shapes — an owner included — at the API or in the database', async () => {
    await forget(adult);
    await month(adult, 3);
    for (const who of [owner, other, teen]) {
      const got = await learned(who);
      expect(JSON.stringify(got.shapes ?? [])).not.toContain(adult.member_id);
      expect(JSON.stringify(got)).not.toContain('Sana');
    }
    const count = 'select count(*)::int as n from intake_shape where member_id = $1';
    for (const [who, role] of [
      [owner, 'owner'],
      [other, 'adult'],
      [teen, 'teen'],
      [adult, 'viewer'],
    ] as const) {
      expect(await asThem({ who, role }, count, [adult.member_id])).toEqual([{ n: 0 }]);
    }
    expect(await asThem({ who: adult, role: 'adult' }, count, [adult.member_id])).toEqual([
      { n: 1 },
    ]);
    expect(await asThem('system', count, [adult.member_id])).toEqual([{ n: 1 }]);
    // Nobody writes one for somebody else.
    expect(
      await asThem(
        { who: owner, role: 'owner' },
        `insert into intake_shape (household_id, member_id, shape_sealed) values ($1, $2, $3)`,
        [hh, adult.member_id, Buffer.alloc(64)],
      ),
    ).toBe('42501');
    // Somebody with a shape keeps something private: no hand-over link for them.
    await admin.query('delete from intake_rule where member_id = $1', [adult.member_id]);
    await admin.query('delete from intake_batch where member_id = $1', [adult.member_id]);
    await admin.query(
      `update document set visibility = 'household', owner_member_id = null where owner_member_id = $1`,
      [adult.member_id],
    );
    expect(
      await asThem(
        { who: owner, role: 'owner' },
        `select member_holds_private((select account_id from account_household where member_id = $1)) as held`,
        [adult.member_id],
      ),
    ).toEqual([{ held: true }]);
  });

  it('Forget all takes the shapes too; made a viewer, somebody keeps none', async () => {
    await month(other, 3);
    await month(adult, 3);
    await forget(adult);
    expect((await learned(adult)).shapes).toEqual([]);
    expect((await learned(other)).shapes).toHaveLength(1);
    await admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const made = await call(owner, 'POST', `/api/v1/members/${other.member_id}/role`, {
      role: 'viewer',
    });
    expect(made.statusCode, made.body).toBe(200);
    const left = await admin.query<{ n: number }>(
      'select count(*)::int as n from intake_shape where member_id = $1',
      [other.member_id],
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it('Forget all sends back to be read an item a shape spoke on', async () => {
    await forget(adult);
    const spoke = await readItem(
      adult,
      {
        ...pages,
        expires: { value: day('2026-04-20'), confidence: 0.78, cue: 'learned', shape: true },
      },
      paperOf('3 April 2026', '20 April 2026'),
    );
    const plain = await readItem(adult, pages, paperOf('3 April 2026', '20 April 2026'));
    await forget(adult);
    const state = async (id: string) =>
      (
        await admin.query<{ read_state: string }>(
          'select read_state from incoming_file where id = $1',
          [id],
        )
      ).rows[0]?.read_state;
    expect(await state(spoke.item)).toBe('waiting');
    expect(await state(plain.item)).toBe('read');
  });

  it('somebody added whose name is a word a shape kept: the word goes from it at the next accept (P2)', async () => {
    await forget(owner);
    await month(owner, 3);
    const wordsOf = async () => {
      const row = (
        await admin.query<{ id: string; shape_sealed: Buffer }>(
          'select id, shape_sealed from intake_shape where member_id = $1',
          [owner.member_id],
        )
      ).rows[0] as { id: string; shape_sealed: Buffer };
      const key = await withSystem(h.db, hh, (trx) =>
        keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: owner.member_id }),
      );
      return storedShape(
        JSON.parse(
          openBytes(
            key.key,
            row.shape_sealed,
            intakeShapeBinding(hh, owner.member_id, row.id),
          ).toString('utf8'),
        ),
      )?.words;
    };
    expect(await wordsOf()).toContain('supply');
    // A guest of the household called Supply.
    await admin.query(
      "insert into member (household_id, display_name, kind) values ($1, 'Tom Supply', 'guest')",
      [hh],
    );
    await month(owner, 4);
    expect(await wordsOf()).not.toContain('supply');
  });
});
