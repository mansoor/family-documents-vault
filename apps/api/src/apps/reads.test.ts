import { randomUUID } from 'node:crypto';
import { createPool, householdZone, withScope, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  appMayRead,
  localToday,
  lookbackStart,
  type ActivityLine,
  type AppChanges,
  type AppDocument,
  type AppDocumentList,
  type AppIntakeState,
  type AppMe,
  type ConnectedAppList,
  type ConnectedAppView,
  type DocumentView,
  type Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appKeyFor, basicFor, alertsSent, createHarness, type Harness } from '../test-harness.js';
import { paperDate } from './reads.js';

/**
 * Connected apps read (0.9.0, APP2): an app reads its own documents and
 * what an owner's grants cover — never anything else — and the database
 * keeps the same rule as the API, so a document the API's own copy would
 * let through by mistake is still not given.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

interface TestApp {
  appId: string;
  keyId: string;
  clientId: string;
  secret: string;
}

let peers = 0;
const peer = () => `10.73.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const codeOf = (r: { json: () => unknown }) =>
  (r.json() as { error?: { code?: string } }).error?.code;
const ALL = ['documents.send', 'documents.read', 'documents.download'];

describe.skipIf(!testAdminUrl())('connected apps read (0.9.0, APP2)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let ahmed: Tokens;
  let sara: Tokens;
  let teen: Tokens;
  let today: string;
  let zone: string;

  const send = (t: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(t),
      ...(payload === undefined ? {} : { payload: payload as never }),
      remoteAddress: peer(),
    });

  async function connect(
    by: Tokens,
    input: Record<string, unknown> = {},
    name = 'Reader',
  ): Promise<TestApp & { view: ConnectedAppView }> {
    await h.decider(by);
    const res = await send(by, 'POST', '/api/v1/connected-apps', {
      name,
      member_id: by.member_id,
      allowed_kinds: ['utility_bill'],
      scopes: ALL,
      ...input,
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json<ConnectedAppView>();
    const key = await appKeyFor(h, by, view);
    return { appId: view.id, ...key, view };
  }

  async function call(
    a: TestApp,
    target: string,
    headers: Record<string, string> = {},
    method: 'GET' | 'DELETE' = 'GET',
  ): Promise<LightMyRequestResponse> {
    const signed = basicFor(a);
    return h.app.inject({
      method,
      url: target,
      headers: { ...signed, 'x-forwarded-for': peer(), ...headers },
      remoteAddress: '127.0.0.1',
    });
  }

  const grants = (by: Tokens, a: TestApp, body: Record<string, unknown>) =>
    send(by, 'PUT', `/api/v1/connected-apps/${a.appId}/grants`, body);
  const listOf = async (a: TestApp, q = '') => {
    const r = await call(a, `/api/v1/apps/documents${q}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<AppDocumentList>();
  };
  const idsOf = async (a: TestApp, q = '') => (await listOf(a, q)).items.map((d) => d.id);
  const lines = async (t: Tokens) =>
    (await send(t, 'GET', '/api/v1/audit?limit=100'))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);

  /** A document, and its file: as `who`, with whatever details are asked. */
  async function make(
    who: Tokens,
    body: Record<string, unknown>,
    bytes: Buffer = PDF(String(body.title)),
  ): Promise<string> {
    const created = await send(who, 'POST', '/api/v1/documents', {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: who.member_id,
      ...body,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', bytes, {
      filename: `${String(body.title)}.pdf`,
      contentType: 'application/pdf',
    });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
      remoteAddress: peer(),
    });
    expect(up.statusCode, up.body).toBeLessThan(300);
    return id;
  }
  const issued = (date: string) => ({ issued: { date, precision: 'day' } });
  const daysAgo = (n: number) => shift(today, -n);
  function shift(day: string, n: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /**
   * What an app sent, filed as this document, as filing it leaves it: the
   * document, and the version the app's file became (its current one, or
   * the one given).
   */
  const fileAsOwn = (
    appId: string,
    externalId: string,
    documentId: string,
    version?: string,
    /** Filed into a document that was there, rather than making it. */
    asVersion = false,
  ) =>
    admin.query(
      `insert into connected_app_intake (household_id, app_id, member_id, external_id, state,
                                         document_id, version_id, made_document, decided_at)
       values ($1, $2, $3, $4, 'filed', $5,
               coalesce($6::uuid, (select id from document_version where document_id = $5
                                    order by version_no desc limit 1)), $7, now())`,
      [
        owner.household_id,
        appId,
        owner.member_id,
        externalId,
        documentId,
        version ?? null,
        !asVersion,
      ],
    );

  /** What the database's own rule gives an app: its function, asked directly. */
  const dbRule = async (appId: string) =>
    new Set(
      (
        await withSystem(h.db, owner.household_id, async (trx) => {
          await sql`select set_config('app.zone', ${zone}, true)`.execute(trx);
          return sql<{ id: string }>`select connected_app_documents(${appId}::uuid) as id`.execute(
            trx,
          );
        })
      ).rows.map((r) => r.id),
    );

  /** What a transaction acting for the app is given of a table, counted. */
  const asApp = (appId: string, q: string) =>
    withScope(
      h.db,
      { householdId: owner.household_id, actor: { kind: 'connected_app', appId } },
      async (trx) => (await sql<{ n: number }>`${sql.raw(q)}`.execute(trx)).rows[0]?.n ?? 0,
    );

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 50_000, publicApps: 'on' });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    ahmed = await h.join(owner, {
      name: 'Ahmed Khan',
      email: 'ahmed-r@example.test',
      role: 'adult',
    });
    sara = await h.join(owner, { name: 'Sara Khan', email: 'sara-r@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tariq', email: 'tariq-r@example.test', role: 'teen' });
    const tz = await admin.query<{ timezone: string | null }>(
      'select timezone from household where id = $1',
      [owner.household_id],
    );
    zone = householdZone(tz.rows[0]?.timezone ?? null);
    today = localToday(zone, new Date());
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  // ------------------------------------------------------------ never

  it('a passport is never listed or downloaded, even granted by writing to the database itself', async () => {
    const a = await connect(owner, {}, 'Passports');
    const passport = await make(owner, {
      type_key: 'passport',
      title: 'Owner passport R',
      is_essential: false,
      sensitive: false,
      ...issued(daysAgo(10)),
    });
    // The API refuses to grant it, a kind or its category.
    for (const g of [
      { kind: 'passport', lookback_months: 12 },
      { category: 'identity', lookback_months: 12 },
      { category: 'medical', lookback_months: 12 },
    ]) {
      const r = await grants(owner, a, { grants: [g], confirm_sensitive: true });
      expect([r.statusCode, codeOf(r)]).toEqual([422, 'validation_failed']);
    }
    // Written into the database as if granted, and as if the app had sent it.
    await admin.query(
      `insert into connected_app_grant (household_id, app_id, kind_key, lookback_months, sensitive_kinds)
       values ($1, $2, 'passport', 36, '{passport}')`,
      [owner.household_id, a.appId],
    );
    await fileAsOwn(a.appId, 'stolen-1', passport);
    expect(await idsOf(a)).not.toContain(passport);
    for (const url of [
      `/api/v1/apps/documents/${passport}`,
      `/api/v1/apps/documents/${passport}/content`,
    ]) {
      const r = await call(a, url);
      expect([r.statusCode, codeOf(r)]).toEqual([404, 'not_found']);
    }
    const feed = (await call(a, '/api/v1/apps/changes')).json<AppChanges>();
    expect(JSON.stringify(feed)).not.toContain(passport);
    // The database's rule, asked directly, and a transaction acting for the app.
    expect((await dbRule(a.appId)).has(passport)).toBe(false);
    expect(
      await asApp(a.appId, `select count(*)::int as n from document where id = '${passport}'`),
    ).toBe(0);
    expect(
      await asApp(
        a.appId,
        `select count(*)::int as n from document_version where document_id = '${passport}'`,
      ),
    ).toBe(0);
    // Its intake says unavailable, never why, nor which document.
    const st = (await call(a, '/api/v1/apps/intake/stolen-1')).json<AppIntakeState>();
    expect(st).toMatchObject({ state: 'unavailable', document_id: null, version_id: null });
  });

  it('a transaction acting for an app is given nothing of any other table', async () => {
    const a = await connect(owner, {}, 'Walled reader');
    await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 36 }] });
    const bill = await make(owner, { title: 'Walled bill', ...issued(daysAgo(3)) });
    const tables = (
      await admin.query<{ name: string }>(
        `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by 1`,
      )
    ).rows.map((r) => r.name);
    const given: string[] = [];
    for (const t of tables) {
      const n = await asApp(a.appId, `select count(*)::int as n from ${t}`);
      if (n > 0) given.push(t);
    }
    expect(given.sort()).toEqual(['document', 'document_version']);
    // And of those, its bill and the bill's file alone: never a version but the current one.
    expect(
      await asApp(a.appId, `select count(*)::int as n from document where id = '${bill}'`),
    ).toBe(1);
    // It writes nothing.
    await expect(
      withScope(
        h.db,
        { householdId: owner.household_id, actor: { kind: 'connected_app', appId: a.appId } },
        (trx) => sql`update document set title = 'changed' where id = ${bill}::uuid`.execute(trx),
      ),
    ).resolves.toMatchObject({ numAffectedRows: 0n });
  });

  // ------------------------------------------------------------ the window

  it('the lookback counts on the paper’s date, to the day: issued, else due, else filed', async () => {
    const a = await connect(owner, {}, 'Window');
    const r = await grants(owner, a, { grants: [{ kind: 'utility_bill', lookback_months: 12 }] });
    expect(r.statusCode, r.body).toBe(200);
    const edge = lookbackStart(today, 12);
    const inside = await make(owner, { title: 'Edge bill', ...issued(edge) });
    const outside = await make(owner, { title: 'Past edge bill', ...issued(shift(edge, -1)) });
    const due = await make(owner, {
      title: 'Due bill',
      extra: { due_date: { date: shift(edge, 2), precision: 'day' } },
    });
    const dueOld = await make(owner, {
      title: 'Old due bill',
      extra: { due_date: { date: shift(edge, -2), precision: 'day' } },
    });
    const filed = await make(owner, { title: 'Undated bill' });
    const ids = await idsOf(a);
    expect(ids).toContain(inside);
    expect(ids).not.toContain(outside);
    expect(ids).toContain(due);
    expect(ids).not.toContain(dueOld);
    expect(ids).toContain(filed);
    const all = (await listOf(a)).items;
    expect(all.find((d) => d.id === due)?.paper_date).toBe(shift(edge, 2));
    expect(all.find((d) => d.id === filed)?.paper_date).toBe(today);
    // A month back from the 31st is the month's last day, as the database counts it.
    expect(lookbackStart('2026-03-31', 1)).toBe('2026-02-28');
    expect(lookbackStart('2024-03-31', 1)).toBe('2024-02-29');
    expect(lookbackStart('2026-11-16', 12)).toBe('2025-11-16');
    expect(lookbackStart('2026-01-15', 36)).toBe('2023-01-15');
    const pg = await admin.query<{ d: string }>(
      `select to_char((date '2026-03-31' - make_interval(months => 1))::date, 'YYYY-MM-DD') as d`,
    );
    expect(pg.rows[0]?.d).toBe('2026-02-28');
    // A shorter lookback narrows at once.
    await grants(owner, a, { grants: [{ kind: 'utility_bill', lookback_months: 1 }] });
    expect(await idsOf(a)).not.toContain(inside);
  });

  // ------------------------------------------------- whom it acts as, and Sensitive

  it('never Only me (its own included), a paper marked Sensitive, Essential, the Trash, or what its person cannot see', async () => {
    const a = await connect(owner, { member_id: ahmed.member_id }, 'Ahmed’s reader');
    await h.decider(ahmed);
    expect(
      (await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`)).statusCode,
    ).toBe(200);
    expect(
      (await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 12 }] })).statusCode,
    ).toBe(200);
    // Granting widened what it does as Ahmed: he turns it on again.
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    const when = issued(daysAgo(20));
    const open = await make(owner, { title: 'Family bill', ...when });
    const ownersOnlyMe = await make(owner, {
      title: 'Owner only me bill',
      visibility: 'private',
      ...when,
    });
    const ahmedsOnlyMe = await make(ahmed, {
      title: 'Ahmed only me bill',
      visibility: 'private',
      ...when,
    });
    const marked = await make(owner, { title: 'Marked bill', sensitive: true, ...when });
    const essential = await make(owner, { title: 'Essential bill', is_essential: true, ...when });
    const trashed = await make(owner, { title: 'Trashed bill', ...when });
    expect((await send(owner, 'DELETE', `/api/v1/documents/${trashed}`)).statusCode).toBe(204);
    const teens = await make(teen, { title: 'Teen only me bill', visibility: 'private', ...when });
    const ids = await idsOf(a);
    expect(ids).toContain(open);
    for (const never of [ownersOnlyMe, ahmedsOnlyMe, marked, essential, trashed, teens]) {
      expect(ids).not.toContain(never);
      const r = await call(a, `/api/v1/apps/documents/${never}`);
      expect([r.statusCode, codeOf(r)]).toEqual([404, 'not_found']);
    }
    // The database's rule says the same of each.
    const rule = await dbRule(a.appId);
    expect(rule.has(open)).toBe(true);
    for (const never of [ownersOnlyMe, ahmedsOnlyMe, marked, essential, trashed, teens]) {
      expect(rule.has(never)).toBe(false);
    }
  });

  it('a caregiver’s paper is never read through the caregiver: Only me, and Medical', async () => {
    const a = await connect(owner, { member_id: ahmed.member_id }, 'Care reader');
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    await h.decider(sara);
    const rx = await make(sara, {
      type_key: 'prescription',
      title: 'Sara prescription R',
      visibility: 'private',
      ...issued(daysAgo(5)),
    });
    const named = await send(sara, 'POST', `/api/v1/members/${sara.member_id}/caregivers`, {
      caregiver_member_id: ahmed.member_id,
    });
    expect(named.statusCode, named.body).toBe(201);
    // Ahmed reads it, as her caregiver.
    expect((await send(ahmed, 'GET', `/api/v1/documents/${rx}`)).statusCode).toBe(200);
    // Granted in the database as if it could be: still never the app's.
    await admin.query(
      `insert into connected_app_grant (household_id, app_id, kind_key, lookback_months, sensitive_kinds)
       values ($1, $2, 'prescription', 36, '{prescription}')`,
      [owner.household_id, a.appId],
    );
    expect(await idsOf(a)).not.toContain(rx);
    expect((await call(a, `/api/v1/apps/documents/${rx}`)).statusCode).toBe(404);
    expect((await dbRule(a.appId)).has(rx)).toBe(false);
  });

  it('a kind Sensitive by default asks once; a paper somebody marks Sensitive stays out', async () => {
    const a = await connect(owner, {}, 'Statements');
    const statement = await make(owner, {
      type_key: 'bank_statement',
      title: 'Northgate statement R',
      ...issued(daysAgo(30)),
    });
    const notSensitive = await make(owner, {
      type_key: 'bank_statement',
      title: 'Plain statement R',
      sensitive: false,
      ...issued(daysAgo(31)),
    });
    const marked = await make(owner, {
      type_key: 'bank_statement',
      title: 'Marked statement R',
      sensitive: true,
      ...issued(daysAgo(32)),
    });
    const asked = await grants(owner, a, {
      grants: [{ kind: 'bank_statement', lookback_months: 12 }],
    });
    expect([asked.statusCode, codeOf(asked)]).toEqual([409, 'sensitive_confirm']);
    expect(asked.json<{ error: { message: string } }>().error.message).toBe(
      'Bank statement is sensitive. Statements will be able to read it. Allow anyway?',
    );
    // Nothing was kept of the refused change.
    expect((await idsOf(a)).length).toBe(0);
    const yes = await grants(owner, a, {
      grants: [{ kind: 'bank_statement', lookback_months: 12 }],
      confirm_sensitive: true,
    });
    expect(yes.statusCode, yes.body).toBe(200);
    expect(yes.json<ConnectedAppView>().grants).toEqual([
      {
        kind: 'bank_statement',
        category: null,
        lookback_months: 12,
        sensitive_confirmed: true,
        sensitive_kinds: ['bank_statement'],
      },
    ]);
    const ids = await idsOf(a);
    expect(ids).toContain(statement);
    expect(ids).toContain(notSensitive);
    expect(ids).not.toContain(marked);
    // Asked once: a change that keeps the grant does not ask again.
    const again = await grants(owner, a, {
      grants: [{ kind: 'bank_statement', lookback_months: 6 }],
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<ConnectedAppView>().grants?.[0]?.sensitive_confirmed).toBe(true);
    // A grant nobody confirmed gives the kind's papers that are not marked otherwise.
    await admin.query(`update connected_app_grant set sensitive_kinds = '{}' where app_id = $1`, [
      a.appId,
    ]);
    const unconfirmed = await idsOf(a);
    expect(unconfirmed).not.toContain(statement);
    expect(unconfirmed).toContain(notSensitive);
    const rule = await dbRule(a.appId);
    expect([rule.has(statement), rule.has(notSensitive), rule.has(marked)]).toEqual([
      false,
      true,
      false,
    ]);
    // The API refuses a kind or category the app may never read, whatever it is told.
    const never = await grants(owner, a, { grants: [{ category: 'legal', lookback_months: 1 }] });
    expect([never.statusCode, codeOf(never)]).toEqual([422, 'validation_failed']);
    // Only an owner, with a passkey or a code.
    const adult = await grants(ahmed, a, { grants: [] });
    expect(adult.statusCode).toBe(403);
  });

  it('the database’s rule and the API’s own copy give the same answers', async () => {
    const a = await connect(owner, {}, 'Held equal');
    await grants(owner, a, {
      grants: [
        { category: 'bills', lookback_months: 6 },
        { kind: 'bank_statement', lookback_months: 24 },
        { category: 'tax', lookback_months: 36 },
      ],
      confirm_sensitive: true,
    });
    await admin.query(
      `update connected_app_grant set sensitive_kinds = '{}'
        where app_id = $1 and category = 'tax'`,
      [a.appId],
    );
    await make(owner, { type_key: 'tax_form', title: 'W-2 R', ...issued(daysAgo(40)) });
    await make(owner, {
      type_key: 'tax_form',
      title: 'W-2 plain R',
      sensitive: false,
      ...issued(daysAgo(41)),
    });
    await make(owner, {
      type_key: 'investment_statement',
      title: 'Brokerage R',
      ...issued(daysAgo(9)),
    });
    await make(owner, {
      type_key: 'bank_statement',
      title: 'Old statement R',
      ...issued(daysAgo(800)),
    });
    // Every document of the household, asked of both.
    const rows = await admin.query<{
      id: string;
      visibility: string;
      is_essential: boolean;
      sensitive: boolean | null;
      deleted_at: Date | null;
      type_key: string | null;
      category: string | null;
      issued_on: string | null;
      extra: unknown;
      created_at: Date;
      kind_category: string | null;
      kind_sensitive: boolean | null;
      kind_essential: boolean | null;
      own: boolean;
    }>(
      `select d.id, d.visibility::text, d.is_essential, d.sensitive, d.deleted_at, d.type_key, d.category,
              to_char(d.issued_on, 'YYYY-MM-DD') as issued_on, d.extra, d.created_at,
              t.category as kind_category, coalesce(s.sensitive_default, t.sensitive_default) as kind_sensitive,
              coalesce(s.usually_essential, t.usually_essential) as kind_essential,
              (exists (select 1 from connected_app_intake i where i.app_id = $2 and i.document_id = d.id
                         and i.state = 'filed' and i.unlinked_at is null and i.made_document)
               and exists (select 1 from connected_app_intake i where i.app_id = $2 and i.document_id = d.id
                         and i.state = 'filed' and i.unlinked_at is null
                         and i.version_id = (select v.id from document_version v where v.document_id = d.id
                                              order by v.version_no desc limit 1))) as own
         from document d
         left join document_type t on t.key = d.type_key
         left join document_type_setting s on s.household_id = d.household_id and s.type_key = d.type_key
        where d.household_id = $1`,
      [owner.household_id, a.appId],
    );
    const g = await admin.query<{
      kind_key: string | null;
      category: string | null;
      lookback_months: number;
      sensitive_kinds: string[];
    }>(
      `select kind_key, category, lookback_months, sensitive_kinds
         from connected_app_grant where app_id = $1`,
      [a.appId],
    );
    const ts = new Set(
      rows.rows
        .filter((d) =>
          appMayRead({
            document: {
              visibility: d.visibility,
              is_essential: d.is_essential,
              sensitive: d.sensitive,
              deleted: d.deleted_at !== null,
              type_key: d.type_key,
              category: d.category,
              paper_date: paperDate(d, zone),
            },
            kind: d.kind_category
              ? {
                  category: d.kind_category,
                  sensitive_default: d.kind_sensitive,
                  usually_essential: d.kind_essential,
                }
              : null,
            role: 'owner',
            own: d.own,
            grants: g.rows.map((x) => ({
              kind_key: x.kind_key,
              category: x.category,
              lookback_months: x.lookback_months,
              sensitive_kinds: x.sensitive_kinds,
            })),
            today,
          }),
        )
        .map((d) => d.id),
    );
    const db = await dbRule(a.appId);
    expect(rows.rows.length).toBeGreaterThan(10);
    expect([...db].sort()).toEqual([...ts].sort());
    expect(new Set(await idsOf(a, '?limit=100'))).toEqual(db);
  });

  // ------------------------------------------------------------ the feed

  it('the changes feed: everything first, in pages; then what changed, in order; unavailable never says why', async () => {
    const a = await connect(owner, {}, 'Feed');
    await grants(owner, a, { grants: [{ kind: 'utility_bill', lookback_months: 36 }] });
    // Its own view of the household's bills, made fresh.
    const before = (await dbRule(a.appId)).size;
    const made: string[] = [];
    for (let i = 0; i < 3; i++)
      made.push(await make(owner, { title: `Feed bill ${i}`, ...issued(daysAgo(i + 1)) }));
    const total = before + 3;
    // From the start, a page at a time: every document once.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const r = await call(a, `/api/v1/apps/changes?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.statusCode, r.body).toBe(200);
      const page = r.json<AppChanges>();
      pages += 1;
      for (const c of page.changes) {
        expect(c.change).toBe('changed');
        if (c.change === 'changed') seen.push(c.document.id);
      }
      cursor = page.cursor;
      if (!page.more) break;
      expect(pages).toBeLessThan(200);
    }
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    for (const id of made) expect(seen).toContain(id);
    expect(pages).toBeGreaterThan(1);
    const at = cursor;
    // Nothing since.
    expect((await call(a, `/api/v1/apps/changes?cursor=${at}`)).json<AppChanges>()).toMatchObject({
      changes: [],
      more: false,
    });
    // Its notes and tags are not what it is told: no line.
    await send(owner, 'PATCH', `/api/v1/documents/${made[0]}`, {
      notes: 'paid by card',
      tags: ['house'],
    });
    expect((await call(a, `/api/v1/apps/changes?cursor=${at}`)).json<AppChanges>().changes).toEqual(
      [],
    );
    // A new title, then to the Trash, then a new title for another: in that order.
    await send(owner, 'PATCH', `/api/v1/documents/${made[0]}`, { title: 'Feed bill 0, paid' });
    const one = (await call(a, `/api/v1/apps/changes?cursor=${at}`)).json<AppChanges>();
    expect(one.changes).toMatchObject([
      { change: 'changed', document: { id: made[0], title: 'Feed bill 0, paid' } },
    ]);
    await send(owner, 'DELETE', `/api/v1/documents/${made[1]}`);
    const gone = (await call(a, `/api/v1/apps/changes?cursor=${one.cursor}`)).json<AppChanges>();
    expect(gone.changes).toEqual([
      { change: 'unavailable', at: expect.any(String) as string, document_id: made[1] },
    ]);
    await send(owner, 'PATCH', `/api/v1/documents/${made[2]}`, { title: 'Feed bill 2, paid' });
    const two = (await call(a, `/api/v1/apps/changes?cursor=${gone.cursor}`)).json<AppChanges>();
    expect(two.changes).toMatchObject([
      { change: 'changed', document: { id: made[2], title: 'Feed bill 2, paid' } },
    ]);
    // Read again from before them all: in the order they were found.
    const since = (await call(a, `/api/v1/apps/changes?cursor=${at}`)).json<AppChanges>();
    expect(
      since.changes.map((c) => [c.change, c.change === 'changed' ? c.document.id : c.document_id]),
    ).toEqual([
      ['changed', made[0]],
      ['unavailable', made[1]],
      ['changed', made[2]],
    ]);
    // Made Only me, it is unavailable in the very same words.
    await send(owner, 'PATCH', `/api/v1/documents/${made[2]}`, { visibility: 'private' });
    const three = (await call(a, `/api/v1/apps/changes?cursor=${two.cursor}`)).json<AppChanges>();
    expect(three.changes).toEqual([
      { change: 'unavailable', at: expect.any(String) as string, document_id: made[2] },
    ]);
    // Out of the Trash: changed again.
    await send(owner, 'POST', `/api/v1/documents/${made[1]}/restore`);
    const four = (await call(a, `/api/v1/apps/changes?cursor=${three.cursor}`)).json<AppChanges>();
    expect(four.changes).toMatchObject([{ change: 'changed', document: { id: made[1] } }]);
    // A cursor older than the lines kept, or from before a restore, is too old; a made-up one is refused.
    await admin.query(
      'update connected_app set changes_pruned_to = 9223372036854775000 where id = $1',
      [a.appId],
    );
    const old = await call(a, `/api/v1/apps/changes?cursor=${four.cursor}`);
    expect([old.statusCode, codeOf(old)]).toEqual([410, 'cursor_expired']);
    await admin.query(
      "update connected_app set changes_pruned_to = 0, restored_at = now() - interval '1 hour' where id = $1",
      [a.appId],
    );
    const restored = await call(a, `/api/v1/apps/changes?cursor=${four.cursor}`);
    expect([restored.statusCode, codeOf(restored)]).toEqual([410, 'cursor_expired']);
    const madeUp = await call(a, '/api/v1/apps/changes?cursor=bm90LWEtY3Vyc29y');
    expect([madeUp.statusCode, codeOf(madeUp)]).toEqual([422, 'validation_failed']);
    // A page is 1 to 100.
    expect((await call(a, '/api/v1/apps/changes?limit=101')).statusCode).toBe(422);
  });

  it('its own: filed from what it sent, unavailable when made Only me, the intake says so too', async () => {
    const a = await connect(owner, { allowed_kinds: ['utility_bill'] }, 'Own');
    // Its own document, as filing an Inbox item leaves it.
    const bill = await make(owner, { title: 'Own bill R', ...issued(daysAgo(2000)) });
    await fileAsOwn(a.appId, 'own-1', bill);
    // No grant, and older than any lookback: still its own.
    const doc = (await call(a, `/api/v1/apps/documents/${bill}`)).json<AppDocument>();
    expect(doc).toMatchObject({ id: bill, own: true, external_id: 'own-1', title: 'Own bill R' });
    expect((await call(a, '/api/v1/apps/intake/own-1')).json<AppIntakeState>()).toMatchObject({
      state: 'filed',
      document_id: bill,
    });
    const start = (await call(a, '/api/v1/apps/changes')).json<AppChanges>();
    await send(owner, 'PATCH', `/api/v1/documents/${bill}`, { visibility: 'private' });
    expect((await call(a, `/api/v1/apps/documents/${bill}`)).statusCode).toBe(404);
    expect((await call(a, '/api/v1/apps/intake/own-1')).json<AppIntakeState>()).toEqual({
      external_id: 'own-1',
      state: 'unavailable',
      received_at: null,
      sha256: null,
      byte_size: null,
      document_id: null,
      version_id: null,
      filed_at: null,
      removed_reason: null,
      refusal: null,
      content_available: false,
    });
    const after = (await call(a, `/api/v1/apps/changes?cursor=${start.cursor}`)).json<AppChanges>();
    expect(after.changes).toEqual([
      { change: 'unavailable', at: expect.any(String) as string, document_id: bill },
    ]);
  });

  it('its own, removed for good: its intake says unavailable, and so does its feed', async () => {
    const a = await connect(owner, {}, 'Purged');
    const bill = await make(owner, { title: 'Purged bill R', ...issued(daysAgo(3)) });
    await fileAsOwn(a.appId, 'purged-1', bill);
    const start = (await call(a, '/api/v1/apps/changes')).json<AppChanges>();
    expect(start.changes.some((c) => c.change === 'changed' && c.document.id === bill)).toBe(true);
    // Removed for good: the intake keeps its state, and lets go of the id alone.
    await admin.query('delete from document where id = $1', [bill]);
    const row = await admin.query<{ state: string; document_id: string | null }>(
      `select state, document_id from connected_app_intake where app_id = $1`,
      [a.appId],
    );
    expect(row.rows).toEqual([{ state: 'filed', document_id: null }]);
    expect((await call(a, '/api/v1/apps/intake/purged-1')).json<AppIntakeState>()).toMatchObject({
      state: 'unavailable',
      document_id: null,
    });
    const after = (await call(a, `/api/v1/apps/changes?cursor=${start.cursor}`)).json<AppChanges>();
    expect(after.changes).toEqual([
      { change: 'unavailable', at: expect.any(String) as string, document_id: bill },
    ]);
  });

  // ------------------------------------------------------------ download

  it('a download: its own scope, an attachment never a page, a Range, its ETag; counted and in the document’s Activity', async () => {
    const a = await connect(owner, { scopes: ['documents.send', 'documents.read'] }, 'Downloader');
    await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 12 }] });
    const bytes = PDF('DOWNLOAD-ME');
    const bill = await make(
      owner,
      { title: 'Download bill R', visibility: 'adults', ...issued(daysAgo(4)) },
      bytes,
    );
    const url = `/api/v1/apps/documents/${bill}/content`;
    // Reading is not downloading.
    const noScope = await call(a, url);
    expect([noScope.statusCode, codeOf(noScope)]).toEqual([403, 'scope_not_granted']);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { scopes: ALL });
    // Its key was made before: it may still not download (APP6) — a key
    // given the new scope may.
    const before = await call(a, url);
    expect([before.statusCode, codeOf(before)]).toEqual([403, 'scope_not_granted']);
    Object.assign(a, await appKeyFor(h, owner, { id: a.appId, scopes: ALL }));
    const doc = (await call(a, `/api/v1/apps/documents/${bill}`)).json<AppDocument>();
    const got = await call(a, url);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.rawPayload.equals(bytes)).toBe(true);
    expect(got.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      etag: `"${doc.version?.id}"`,
      'content-length': String(bytes.length),
    });
    expect(String(got.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(doc.version).toMatchObject({ byte_size: bytes.length, content_type: 'application/pdf' });
    // A part of it.
    const part = await call(a, url, { range: 'bytes=0-3' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('%PDF');
    expect(part.headers['content-range']).toBe(`bytes 0-3/${bytes.length}`);
    const bad = await call(a, url, { range: `bytes=${bytes.length + 5}-` });
    expect([bad.statusCode, codeOf(bad)]).toEqual([416, 'range_not_satisfiable']);
    // The version it has: 304, nothing sent, nothing counted.
    const kept = await call(a, url, { 'if-none-match': `"${doc.version?.id}"` });
    expect([kept.statusCode, kept.body]).toEqual([304, '']);
    // Counted against its day: its downloads said in GET /apps/me.
    const me = (await call(a, '/api/v1/apps/me')).json<AppMe>();
    expect(me.limits.read_bytes_today).toBe(bytes.length + 4);
    expect(me.limits.read_bytes_per_day).toBe(1024 ** 3);
    await admin.query(
      'update connected_app set read_bytes_today = daily_read_bytes - 3 where id = $1',
      [a.appId],
    );
    const full = await call(a, url);
    expect([full.statusCode, codeOf(full)]).toEqual([429, 'app_read_day_full']);
    expect(Number(full.headers['retry-after'])).toBeGreaterThan(0);
    // In the document's own Activity, as Owner via the app; and its details read.
    const activity = (await send(owner, 'GET', `/api/v1/documents/${bill}/activity?limit=50`))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
    expect(activity).toContain('Owner via Downloader downloaded “Download bill R”');
    expect(activity).toContain('Owner via Downloader read the details of “Download bill R”');
    // Downloads in one sitting are one line.
    expect(activity.filter((l) => l.includes('via Downloader downloaded'))).toHaveLength(1);
    // A teen, who does not see Adults only papers, is told nothing of it.
    expect((await lines(teen)).join('\n')).not.toContain('Download bill R');
  });

  // ------------------------------------------------------------ widening

  it('a grant or a scope more, for an app acting as another adult, waits for them and emails them; less does not', async () => {
    const a = await connect(
      owner,
      { member_id: sara.member_id, scopes: ['documents.send'] },
      'Sara’s app',
    );
    await h.decider(sara);
    await send(sara, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    const stateOf = async () =>
      (await send(owner, 'GET', '/api/v1/connected-apps'))
        .json<ConnectedAppList>()
        .items.find((x) => x.id === a.appId)?.state;
    expect(await stateOf()).toBe('active');
    const before = alertsSent(h).length;
    const widen = async (fn: () => Promise<LightMyRequestResponse>) => {
      const r = await fn();
      expect(r.statusCode, r.body).toBe(200);
      expect(await stateOf()).toBe('waiting_for_approval');
      await send(sara, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
      expect(await stateOf()).toBe('active');
    };
    await widen(() =>
      send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
        scopes: ['documents.send', 'documents.read'],
      }),
    );
    await widen(() => grants(owner, a, { grants: [{ category: 'bills', lookback_months: 6 }] }));
    await widen(() => grants(owner, a, { grants: [{ category: 'bills', lookback_months: 12 }] }));
    await widen(() =>
      grants(owner, a, {
        grants: [
          { category: 'bills', lookback_months: 12 },
          { kind: 'pay_statement', lookback_months: 12 },
        ],
        confirm_sensitive: true,
      }),
    );
    await widen(() =>
      send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
        daily_read_bytes: 2 * 1024 ** 3,
      }),
    );
    const asked = alertsSent(h)
      .slice(before)
      .filter((m) => m.subject === 'Sara’s app waits for you to turn it on again');
    expect(asked).toHaveLength(5);
    // Less: a grant taken away, a shorter lookback, a scope gone.
    for (const fn of [
      () => grants(owner, a, { grants: [{ kind: 'pay_statement', lookback_months: 6 }] }),
      () => grants(owner, a, { grants: [] }),
      () =>
        send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { scopes: ['documents.send'] }),
    ]) {
      expect((await fn()).statusCode).toBe(200);
      expect(await stateOf()).toBe('active');
    }
    expect(await lines(owner)).toContain(
      'Owner changed what Sara’s app may do, so Sara Khan must turn it on again',
    );
  });

  // ------------------------------------------------------------ enumeration

  it('an id it may not read is the same 404 as one that is not there, or not an id at all', async () => {
    const a = await connect(owner, {}, 'Prober');
    await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 12 }] });
    const hidden = await make(owner, {
      title: 'Hidden bill R',
      visibility: 'private',
      ...issued(daysAgo(3)),
    });
    const bodyOf = async (url: string) => {
      const r = await call(a, url);
      const { error } = r.json<{ error: Record<string, unknown> }>();
      delete error.request_id;
      const rest = error;
      return [r.statusCode, rest];
    };
    for (const tail of ['', '/content']) {
      const hiddenOne = await bodyOf(`/api/v1/apps/documents/${hidden}${tail}`);
      expect(await bodyOf(`/api/v1/apps/documents/${randomUUID()}${tail}`)).toEqual(hiddenOne);
      expect(await bodyOf(`/api/v1/apps/documents/not-an-id${tail}`)).toEqual(hiddenOne);
      expect(hiddenOne[0]).toBe(404);
    }
  });

  // ------------------------------------------------------------ households

  it('another household’s documents are never an app’s, whatever its grants', async () => {
    const a = await connect(owner, {}, 'Neighbour');
    await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 36 }] });
    const other = randomUUID();
    await admin.query(`insert into household (id, name) values ($1, 'The neighbours')`, [other]);
    const theirs = (
      await admin.query<{ id: string }>(
        `insert into document (household_id, type_key, title, category, visibility, issued_on, issued_precision)
         values ($1, 'utility_bill', 'Neighbour bill', 'bills', 'household', current_date - 3, 'day') returning id`,
        [other],
      )
    ).rows[0]?.id as string;
    expect(await idsOf(a, '?limit=100')).not.toContain(theirs);
    expect((await call(a, `/api/v1/apps/documents/${theirs}`)).statusCode).toBe(404);
    expect((await dbRule(a.appId)).has(theirs)).toBe(false);
    // A transaction acting for the app, told the other household: nothing.
    const n = await withScope(
      h.db,
      { householdId: other, actor: { kind: 'connected_app', appId: a.appId } },
      async (trx) =>
        (await sql<{ n: number }>`select count(*)::int as n from document`.execute(trx)).rows[0]?.n,
    );
    expect(n).toBe(0);
  });

  // ------------------------------------------------------------ list

  it('the list: newest paper first, filters, a cursor, its fields and never more', async () => {
    const a = await connect(owner, {}, 'Lister');
    await grants(owner, a, {
      grants: [
        { kind: 'credit_card_statement', lookback_months: 12 },
        { kind: 'pay_statement', lookback_months: 12 },
      ],
      confirm_sensitive: true,
    });
    const card = await make(owner, {
      type_key: 'credit_card_statement',
      title: 'Card R',
      issued_by: 'Northgate Bank',
      notes: 'never told',
      tags: ['secret-tag'],
      identifier: 'ID-NEVER',
      extra: { account_last4: '1234', amount: '2,450.10 USD' },
      expires: { date: shift(today, 20), precision: 'day' },
      ...issued(daysAgo(10)),
    });
    const slip = await make(owner, {
      type_key: 'pay_statement',
      title: 'Payslip R',
      extra: { period: 'October 2026', amount: '3100 GBP' },
      ...issued(daysAgo(12)),
    });
    const list = await listOf(a);
    expect(list.items.map((d) => d.id)).toEqual([card, slip]);
    expect(list.items[0]).toEqual({
      id: card,
      kind: { key: 'credit_card_statement', label: 'Credit card statement', category: 'financial' },
      title: 'Card R',
      paper_date: daysAgo(10),
      issued: { date: daysAgo(10), precision: 'day' },
      expires: { date: shift(today, 20), precision: 'day' },
      due_date: null,
      amount: { text: '2,450.10 USD', value: '2450.10', currency: 'USD' },
      issuer: 'Northgate Bank',
      account_last4: '1234',
      period: null,
      tax_year: null,
      status: { value: expect.any(String) as string, label: expect.any(String) as string },
      version: {
        id: expect.any(String) as string,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        byte_size: expect.any(Number) as number,
        content_type: 'application/pdf',
      },
      own: false,
      external_id: null,
      updated_at: expect.any(String) as string,
    });
    expect(JSON.stringify(list)).not.toMatch(/never told|secret-tag|ID-NEVER|owner_member_id/);
    expect((await listOf(a, '?kind=pay_statement')).items.map((d) => d.id)).toEqual([slip]);
    expect((await listOf(a, `?from=${daysAgo(11)}`)).items.map((d) => d.id)).toEqual([card]);
    expect((await listOf(a, `?to=${daysAgo(11)}`)).items.map((d) => d.id)).toEqual([slip]);
    expect((await listOf(a, '?own=true')).items).toEqual([]);
    const first = await listOf(a, '?limit=1');
    expect(first.items.map((d) => d.id)).toEqual([card]);
    const second = await listOf(a, `?limit=1&cursor=${first.next}`);
    expect([second.items.map((d) => d.id), second.next]).toEqual([[slip], null]);
    for (const q of [
      '?limit=0',
      '?limit=101',
      '?from=2026-13-01',
      '?own=yes',
      '?cursor=x',
      '?kind=a&kind=b',
    ]) {
      const r = await call(a, `/api/v1/apps/documents${q}`);
      expect([q, r.statusCode, codeOf(r)]).toEqual([q, 422, 'validation_failed']);
    }
    // Listing is one line an hour, never one a call.
    expect(
      (await lines(owner)).filter((l) => l === 'Owner via Lister looked up documents'),
    ).toHaveLength(1);
  });

  it('reading needs its scope, and an app paused reads nothing', async () => {
    const a = await connect(owner, { scopes: ['documents.send'] }, 'Sender only');
    for (const url of [
      '/api/v1/apps/documents',
      '/api/v1/apps/changes',
      `/api/v1/apps/documents/${randomUUID()}`,
    ]) {
      const r = await call(a, url);
      expect([r.statusCode, codeOf(r)]).toEqual([403, 'scope_not_granted']);
    }
    const b = await connect(owner, {}, 'Paused reader');
    await grants(owner, b, { grants: [{ category: 'bills', lookback_months: 12 }] });
    await make(owner, { title: 'Paused bill', ...issued(daysAgo(1)) });
    expect((await dbRule(b.appId)).size).toBeGreaterThan(0);
    await send(owner, 'POST', `/api/v1/connected-apps/${b.appId}/pause`);
    expect((await dbRule(b.appId)).size).toBe(0);
    expect(codeOf(await call(b, '/api/v1/apps/documents'))).toBe('app_paused');
  });

  // ------------------------------------------------------------ the review round

  /** A new file for a document, as `who` uploads one; its version's id. */
  const upload = async (who: Tokens, id: string, bytes: Buffer = PDF(`v-${randomUUID()}`)) => {
    const form = new FormData();
    form.append('file', bytes, { filename: 'again.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
      remoteAddress: peer(),
    });
    expect(up.statusCode, up.body).toBeLessThan(300);
    const v = await admin.query<{ id: string }>(
      'select id from document_version where document_id = $1 order by version_no desc limit 1',
      [id],
    );
    return v.rows[0]?.id as string;
  };

  it('filed as a new version of a family paper: never the app’s own, read only as a grant allows', async () => {
    const a = await connect(owner, {}, 'Versions');
    // The family's paper, long ago; the app granted nothing.
    const family = await make(owner, { title: 'Family bill R', ...issued(daysAgo(3000)) });
    // The app's file, filed by a reviewer as its new version: the newest, and still the family's.
    const appsFile = await upload(owner, family);
    await fileAsOwn(a.appId, 'as-version-1', family, appsFile, true);
    const r = await call(a, `/api/v1/apps/documents/${family}`);
    expect([r.statusCode, codeOf(r)]).toEqual([404, 'not_found']);
    expect((await call(a, `/api/v1/apps/documents/${family}/content`)).statusCode).toBe(404);
    expect(await idsOf(a, '?limit=100')).not.toContain(family);
    expect(JSON.stringify((await call(a, '/api/v1/apps/changes')).json())).not.toContain(family);
    expect((await dbRule(a.appId)).has(family)).toBe(false);
    expect(
      (await call(a, '/api/v1/apps/intake/as-version-1')).json<AppIntakeState>(),
    ).toMatchObject({ state: 'unavailable', document_id: null, version_id: null });
    // Granted its kind, it reads it as any granted paper: not its own.
    await grants(owner, a, { grants: [{ kind: 'utility_bill', lookback_months: 36 }] });
    await send(owner, 'PATCH', `/api/v1/documents/${family}`, {
      issued: { date: daysAgo(5), precision: 'day' },
    });
    expect((await call(a, `/api/v1/apps/documents/${family}`)).json<AppDocument>()).toMatchObject({
      own: false,
      external_id: null,
    });
  });

  it('the app’s own paper stays its own with its own next file, and with a newer family file (18 Nov 2026)', async () => {
    const a = await connect(owner, {}, 'Own versions');
    // A paper the app's send made, long ago: its own, nothing granted.
    const made = await make(owner, { title: 'Made bill R', ...issued(daysAgo(3000)) });
    await fileAsOwn(a.appId, 'made-1', made);
    expect((await call(a, `/api/v1/apps/documents/${made}`)).json<AppDocument>()).toMatchObject({
      own: true,
      external_id: 'made-1',
    });
    // Its own next file, filed into it as a new version: still its own.
    const second = await upload(owner, made);
    await fileAsOwn(a.appId, 'made-2', made, second, true);
    expect((await call(a, `/api/v1/apps/documents/${made}`)).json<AppDocument>()).toMatchObject({
      own: true,
      external_id: 'made-1',
      version: { id: second },
    });
    expect((await dbRule(a.appId)).has(made)).toBe(true);
    // The family adds a newer file: the app that made the paper still
    // reads it, in the database's rule and the API's alike, and its feed
    // tells it of the newer version — never that it went.
    const start = (await call(a, '/api/v1/apps/changes')).json<AppChanges>();
    const third = await upload(owner, made);
    expect((await call(a, `/api/v1/apps/documents/${made}`)).json<AppDocument>()).toMatchObject({
      own: true,
      external_id: 'made-1',
      version: { id: third },
    });
    expect((await dbRule(a.appId)).has(made)).toBe(true);
    const after = (await call(a, `/api/v1/apps/changes?cursor=${start.cursor}`)).json<AppChanges>();
    expect(after.changes).toEqual([
      {
        change: 'changed',
        at: expect.any(String) as string,
        document: expect.objectContaining({
          id: made,
          own: true,
          version: expect.objectContaining({ id: third }) as AppDocument['version'],
        }) as AppDocument,
      },
    ]);
    for (const id of ['made-1', 'made-2']) {
      expect((await call(a, `/api/v1/apps/intake/${id}`)).json<AppIntakeState>()).toMatchObject({
        state: 'filed',
        document_id: made,
      });
    }
    // (Its current file is the family's now: never the app's to delete — links.test.ts.)
  });

  it('the rule answers only for the household asking: never another’s app', async () => {
    const a = await connect(owner, {}, 'Household-bound');
    await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 36 }] });
    await make(owner, { title: 'Bound bill R', ...issued(daysAgo(2)) });
    expect((await dbRule(a.appId)).size).toBeGreaterThan(0);
    const other = randomUUID();
    await admin.query(`insert into household (id, name) values ($1, 'Strangers')`, [other]);
    const asked = await withSystem(h.db, other, (trx) =>
      sql<{ id: string }>`select connected_app_documents(${a.appId}::uuid) as id`.execute(trx),
    );
    expect(asked.rows).toEqual([]);
  });

  it('a category grant never reaches a kind kept as an Essential; a kind newly Sensitive waits to be confirmed', async () => {
    const a = await connect(owner, {}, 'Categories');
    expect(
      (await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 12 }] })).statusCode,
    ).toBe(200);
    const bill = await make(owner, { title: 'Category bill R', ...issued(daysAgo(6)) });
    expect(await idsOf(a)).toContain(bill);
    try {
      // The household keeps its bills as Essentials: no grant reaches them.
      await admin.query(
        `insert into document_type_setting (household_id, type_key, usually_essential)
         values ($1, 'utility_bill', true)
         on conflict (household_id, type_key) do update set usually_essential = true`,
        [owner.household_id],
      );
      expect(await idsOf(a)).not.toContain(bill);
      expect((await dbRule(a.appId)).has(bill)).toBe(false);
      // Back as they were; then made Sensitive by default: read only once confirmed.
      await admin.query(
        `update document_type_setting set usually_essential = null, sensitive_default = true
          where household_id = $1 and type_key = 'utility_bill'`,
        [owner.household_id],
      );
      expect(await idsOf(a)).not.toContain(bill);
      const view = (await send(owner, 'GET', '/api/v1/connected-apps'))
        .json<ConnectedAppList>()
        .items.find((x) => x.id === a.appId);
      expect(view?.grants?.[0]).toMatchObject({ sensitive_confirmed: false, sensitive_kinds: [] });
      const asked = await grants(owner, a, {
        grants: [{ category: 'bills', lookback_months: 12 }],
      });
      expect([asked.statusCode, codeOf(asked)]).toEqual([409, 'sensitive_confirm']);
      const yes = await grants(owner, a, {
        grants: [{ category: 'bills', lookback_months: 12 }],
        confirm_sensitive: true,
      });
      expect(yes.json<ConnectedAppView>().grants?.[0]).toMatchObject({
        sensitive_confirmed: true,
        sensitive_kinds: ['utility_bill'],
      });
      expect(await idsOf(a)).toContain(bill);
      // Said in the log by keys alone.
      const said = await admin.query<{ detail: { grants?: unknown } }>(
        `select detail from audit_event where action = 'app.changed' and detail->>'app_id' = $1
          order by id desc limit 1`,
        [a.appId],
      );
      expect(said.rows[0]?.detail.grants).toEqual([
        { category: 'bills', lookback_months: 12, sensitive_confirmed: true },
      ]);
    } finally {
      await admin.query(
        `update document_type_setting set usually_essential = null, sensitive_default = null
          where household_id = $1 and type_key = 'utility_bill'`,
        [owner.household_id],
      );
    }
  });

  it('an app paused while it asks reads nothing, and its feed is not told everything went', async () => {
    const a = await connect(owner, {}, 'Paused between');
    await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 36 }] });
    await make(owner, { title: 'Between bill R', ...issued(daysAgo(2)) });
    const start = (await call(a, '/api/v1/apps/changes')).json<AppChanges>();
    expect(start.changes.length).toBeGreaterThan(0);
    // Let in, then paused before its feed is read.
    await admin.query(`update connected_app set paused_reason = 'owner' where id = $1`, [a.appId]);
    const caller = {
      appId: a.appId,
      keyId: a.keyId,
      householdId: owner.household_id,
      actsAs: 'person' as const,
      accountId: (
        await admin.query<{ account_id: string }>(
          'select account_id from account_household where member_id = $1',
          [owner.member_id],
        )
      ).rows[0]?.account_id as string,
      memberId: owner.member_id,
      role: 'owner' as const,
      name: 'Paused between',
      memberName: 'Owner',
      timezone: zone,
      scopes: ['documents.read' as const],
      state: 'active' as const,
      pausedReason: null,
    };
    await expect(
      h.apps.reads?.changes(caller, { cursor: start.cursor }, { ip: null }),
    ).rejects.toMatchObject({ status: 403, code: 'app_paused' });
    const lines = await admin.query(
      `select 1 from connected_app_change where app_id = $1 and change = 'unavailable'`,
      [a.appId],
    );
    expect(lines.rowCount).toBe(0);
  });

  it('a file larger than a day’s downloads is refused for good, not to be retried; a Range takes it in parts; no HEAD', async () => {
    const a = await connect(owner, { daily_read_bytes: 1024 * 1024 }, 'Big');
    await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 12 }] });
    const big = Buffer.concat([PDF('BIG'), Buffer.alloc(1024 * 1024 + 10, 0x20)]);
    const bill = await make(owner, { title: 'Big bill R', ...issued(daysAgo(2)) }, big);
    const url = `/api/v1/apps/documents/${bill}/content`;
    const whole = await call(a, url);
    expect([whole.statusCode, codeOf(whole)]).toEqual([413, 'larger_than_daily_read']);
    expect(whole.json<{ error: { retriable: boolean } }>().error.retriable).toBe(false);
    expect(whole.headers['retry-after']).toBeUndefined();
    const part = await call(a, url, { range: 'bytes=0-1023' });
    expect(part.statusCode).toBe(206);
    // A HEAD with the app's key is no download: refused, counted nowhere.
    const signed = basicFor(a);
    const head = await h.app.inject({
      method: 'HEAD',
      url,
      headers: { ...signed, 'x-forwarded-for': peer() },
      remoteAddress: '127.0.0.1',
    });
    expect(head.statusCode).toBe(401);
    const me = (await call(a, '/api/v1/apps/me')).json<AppMe>();
    expect(me.limits.read_bytes_today).toBe(1024);
  });

  it('two downloads at once at the edge of the day’s bytes: one is sent, the other refused', async () => {
    const a = await connect(owner, {}, 'At the edge');
    await grants(owner, a, { grants: [{ category: 'bills', lookback_months: 12 }] });
    const bytes = PDF('EDGE');
    const bill = await make(owner, { title: 'Edge download R', ...issued(daysAgo(2)) }, bytes);
    await admin.query(
      `update connected_app set read_day = $2::date, read_bytes_today = daily_read_bytes - $3
        where id = $1`,
      [a.appId, today, bytes.length],
    );
    const url = `/api/v1/apps/documents/${bill}/content`;
    const both = await Promise.all([call(a, url), call(a, url)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 429]);
  });

  it('the feed: a change between pages of the first read, a narrower grant, a lookback, a new file or kind', async () => {
    const a = await connect(owner, {}, 'Feed two');
    await grants(owner, a, {
      grants: [
        { kind: 'utility_bill', lookback_months: 36 },
        { kind: 'insurance_policy', lookback_months: 36 },
      ],
    });
    const mine = [
      await make(owner, { title: 'Paged bill 1', ...issued(daysAgo(10)) }),
      await make(owner, { title: 'Paged bill 2', ...issued(daysAgo(200)) }),
    ];
    // The first read, a page at a time; a paper already given is changed meanwhile.
    const first = (await call(a, '/api/v1/apps/changes?limit=1')).json<AppChanges>();
    const given = first.changes[0];
    if (!given || given.change !== 'changed') throw new Error('no first page');
    await send(owner, 'PATCH', `/api/v1/documents/${given.document.id}`, {
      title: 'Changed between pages',
    });
    // The rest of the first read, then the feed from where it began.
    let cursor = first.cursor;
    let more = first.more;
    const rest = [] as AppChanges['changes'];
    for (let i = 0; i < 300 && more; i++) {
      const page = (
        await call(a, `/api/v1/apps/changes?limit=100&cursor=${cursor}`)
      ).json<AppChanges>();
      rest.push(...page.changes);
      cursor = page.cursor;
      more = page.more;
    }
    // Given before it changed, it is given again as it is now.
    expect(rest).toContainEqual(
      expect.objectContaining({
        change: 'changed',
        document: expect.objectContaining({
          id: given.document.id,
          title: 'Changed between pages',
        }) as unknown,
      }),
    );
    // A new file: changed, with its new version.
    const v = await upload(owner, mine[0] as string);
    const newFile = (await call(a, `/api/v1/apps/changes?cursor=${cursor}`)).json<AppChanges>();
    expect(newFile.changes).toMatchObject([
      { change: 'changed', document: { id: mine[0], version: { id: v } } },
    ]);
    // Another kind it may read: changed, said as that kind.
    await send(owner, 'PATCH', `/api/v1/documents/${mine[0]}`, { type_key: 'insurance_policy' });
    const kind = (
      await call(a, `/api/v1/apps/changes?cursor=${newFile.cursor}`)
    ).json<AppChanges>();
    expect(kind.changes).toMatchObject([
      { change: 'changed', document: { id: mine[0], kind: { key: 'insurance_policy' } } },
    ]);
    // A shorter lookback: the older paper is unavailable.
    await grants(owner, a, {
      grants: [
        { kind: 'utility_bill', lookback_months: 6 },
        { kind: 'insurance_policy', lookback_months: 36 },
      ],
    });
    const shorter = (
      await call(a, `/api/v1/apps/changes?cursor=${kind.cursor}`)
    ).json<AppChanges>();
    expect(
      shorter.changes.map((c) => (c.change === 'unavailable' ? c.document_id : null)),
    ).toContain(mine[1]);
    // A grant taken away: its kind is unavailable.
    await grants(owner, a, { grants: [{ kind: 'utility_bill', lookback_months: 6 }] });
    const narrower = (
      await call(a, `/api/v1/apps/changes?cursor=${shorter.cursor}`)
    ).json<AppChanges>();
    expect(narrower.changes).toContainEqual({
      change: 'unavailable',
      at: expect.any(String) as string,
      document_id: mine[0],
    });
    // Lines let go up to its cursor: the cursor still works.
    const at = Number(
      (
        await admin.query<{ seq: string }>(
          'select max(seq) as seq from connected_app_change where app_id = $1',
          [a.appId],
        )
      ).rows[0]?.seq,
    );
    await admin.query('update connected_app set changes_pruned_to = $2 where id = $1', [
      a.appId,
      at,
    ]);
    await admin.query('delete from connected_app_change where app_id = $1 and seq <= $2', [
      a.appId,
      at,
    ]);
    const kept = await call(a, `/api/v1/apps/changes?cursor=${narrower.cursor}`);
    expect(kept.statusCode, kept.body).toBe(200);
  });
});
