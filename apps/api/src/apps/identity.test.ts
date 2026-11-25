import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { multipartBody } from '@fdv/client';
import {
  EnvKeyProvider,
  itemProposalsBinding,
  itemTextBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, withScope, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  ActivityLine,
  AppIntakeState,
  AppMe,
  ConnectedAppView,
  DetailProposal,
  Tokens,
  VersionView,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alertsSent,
  appKeyFor,
  createHarness,
  TEST_MASTER,
  type Harness,
} from '../test-harness.js';
import type { AppCaller } from './service.js';

/**
 * A connected app acts as itself (0.9.0, APP8): no person and no hidden
 * account; what nothing routes goes to its reviewer's Inbox; the activity
 * log names the app; a file it sent names it as its uploader; an
 * ineligible reviewer refuses for a moment, and the owners are told once.
 * Acting as a person is as before.
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
  view: ConnectedAppView;
}

let peers = 0;
const peer = () => `10.78.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
const codeOf = (r: LightMyRequestResponse) => r.json<{ error?: { code?: string } }>().error?.code;

describe.skipIf(!testAdminUrl())('connected apps: acting as itself (0.9.0, APP8)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let ahmed: Tokens;
  let sara: Tokens;
  let teen: Tokens;

  const send = (t: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(t),
      ...(payload === undefined ? {} : { payload: payload as never }),
      remoteAddress: peer(),
    });

  async function connect(input: Record<string, unknown> = {}, name = 'Acme Money') {
    await h.decider(owner);
    const res = await send(owner, 'POST', '/api/v1/connected-apps', {
      name,
      allowed_kinds: ['bank_statement', 'utility_bill', 'pay_statement'],
      scopes: ['documents.send', 'documents.read', 'documents.download'],
      ...input,
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json<ConnectedAppView>();
    const key = await appKeyFor(h, owner, view);
    return { appId: view.id, ...key, view };
  }

  const call = async (
    a: TestApp,
    method: 'GET' | 'POST' | 'DELETE',
    target: string,
    body?: {
      bytes: Uint8Array;
      contentType: string;
    },
  ) =>
    h.app.inject({
      method,
      url: target,
      headers: {
        ...(await h.bearerFor(a)),
        ...(body ? { 'content-type': body.contentType } : {}),
      },
      ...(body ? { payload: Buffer.from(body.bytes) } : {}),
      remoteAddress: '127.0.0.1',
    });

  async function sent(a: TestApp, externalId: string, hints: Record<string, unknown> = {}) {
    const body = multipartBody([
      {
        name: 'metadata',
        value: JSON.stringify({
          external_id: externalId,
          hints: { kind: 'bank_statement', ...hints },
        }),
      },
      {
        name: 'file',
        filename: 'statement.pdf',
        contentType: 'application/pdf',
        bytes: PDF(externalId),
      },
    ]);
    const res = await call(a, 'POST', '/api/v1/apps/intake', body);
    const row = await admin.query<{ id: string }>(
      `select incoming_file_id as id from connected_app_intake where app_id = $1 and external_id = $2`,
      [a.appId, externalId],
    );
    return { res, item: row.rows[0]?.id as string };
  }

  async function inboxOf(a: TestApp, externalId: string) {
    const r = await admin.query<{
      member_id: string;
      created_by: string;
      intake_member: string | null;
      inbox_member_id: string | null;
    }>(
      `select b.member_id, b.created_by, i.member_id as intake_member, i.inbox_member_id
         from connected_app_intake i
         join incoming_file f on f.id = i.incoming_file_id
         join intake_batch b on b.id = f.batch_id
        where i.app_id = $1 and i.external_id = $2`,
      [a.appId, externalId],
    );
    return r.rows[0];
  }

  const accountOf = async (t: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [t.member_id],
      )
    ).rows[0]?.account_id as string;

  async function file(t: Tokens, item: string, body: Record<string, unknown>) {
    const batch = (
      await admin.query<{ batch_id: string }>('select batch_id from incoming_file where id = $1', [
        item,
      ])
    ).rows[0]?.batch_id as string;
    const r = await send(t, 'POST', `/api/v1/batches/${batch}/items/${item}/accept`, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ document_id: string; version_id: string }>();
  }

  const status = async (a: TestApp, id: string) => {
    const r = await call(a, 'GET', `/api/v1/apps/intake/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<AppIntakeState>();
  };
  const activity = async (t: Tokens) =>
    (await send(t, 'GET', '/api/v1/audit?limit=100')).json<{ items: ActivityLine[] }>().items;
  const lines = async (t: Tokens) => (await activity(t)).map((l) => l.text);
  const view = async (a: TestApp) =>
    (await send(owner, 'GET', '/api/v1/connected-apps'))
      .json<{ items: ConnectedAppView[] }>()
      .items.find((x) => x.id === a.appId) as ConnectedAppView;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 50_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    ahmed = await h.join(owner, {
      name: 'Ahmed Khan',
      email: 'ahmed-8@example.test',
      role: 'adult',
    });
    sara = await h.join(owner, { name: 'Sara Khan', email: 'sara-8@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tariq Khan', email: 'tariq-8@example.test', role: 'teen' });
  }, 180_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('connected without a person, it acts as itself: on at once, reviewed by the owner, no account made, and /apps/me says so and names nobody', async () => {
    const people = await admin.query('select count(*)::int as n from account');
    const members = await admin.query('select count(*)::int as n from member');
    const a = await connect({}, 'Itself one');
    expect(a.view).toMatchObject({
      acts_as: 'app',
      member_id: null,
      member_name: null,
      reviewer_member_id: owner.member_id,
      reviewer_needed: false,
      state: 'active',
      mine: false,
    });
    // No hidden person: the family's lists and counts are as they were.
    expect((await admin.query('select count(*)::int as n from account')).rows).toEqual(people.rows);
    expect((await admin.query('select count(*)::int as n from member')).rows).toEqual(members.rows);
    const row = await admin.query(
      'select acts_as, account_id, member_id, reviewer_member_id from connected_app where id = $1',
      [a.appId],
    );
    expect(row.rows[0]).toEqual({
      acts_as: 'app',
      account_id: null,
      member_id: null,
      reviewer_member_id: owner.member_id,
    });
    const me = (await call(a, 'GET', '/api/v1/apps/me')).json<AppMe>();
    expect(me.acts_as).toBe('app');
    expect(me.acting_as).toEqual({ name: 'Itself one' });
    expect(await lines(owner)).toContain('Owner connected Itself one, acting as itself');
    // A person named, as before: acting as them, and `me` says only "person".
    const p = await connect({ member_id: owner.member_id }, 'As a person');
    expect(p.view).toMatchObject({ acts_as: 'person', member_id: owner.member_id });
    expect((await call(p, 'GET', '/api/v1/apps/me')).json<AppMe>().acts_as).toBe('person');
    // Both, or the wrong one for each, are refused.
    for (const [body, detail] of [
      [{ acts_as: 'app', member_id: owner.member_id }, 'member_id'],
      [{ acts_as: 'person', reviewer_member_id: owner.member_id }, 'reviewer_member_id'],
      [{ acts_as: 'person' }, 'member_id'],
      [{ reviewer_member_id: teen.member_id }, 'reviewer_member_id'],
    ] as const) {
      const r = await send(owner, 'POST', '/api/v1/connected-apps', {
        name: 'Wrong',
        allowed_kinds: [],
        ...body,
      });
      expect([r.statusCode, r.json<{ error: { detail: string } }>().error.detail]).toEqual([
        422,
        detail,
      ]);
    }
  });

  it('what nothing routes lands in its reviewer’s Inbox, wrapped for them; the activity log names the app; filed, the file names the app as its uploader', async () => {
    const a = await connect({}, 'Reviewed app');
    const { res, item } = await sent(a, 'rev-1');
    expect(res.statusCode, res.body).toBe(201);
    expect(await inboxOf(a, 'rev-1')).toEqual({
      member_id: owner.member_id,
      created_by: await accountOf(owner),
      // Nobody's send: the vault keeps it on the app's behalf.
      intake_member: null,
      inbox_member_id: owner.member_id,
    });
    // Its file key under the reviewer's own member key, as their own upload's.
    const wrapped = await withSystem(h.db, owner.household_id, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['wrapped_by_scope', 'file_key_wrapped'])
        .where('id', '=', item)
        .executeTakeFirstOrThrow();
      unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${item}`,
      );
      return trx
        .selectFrom('scope_key')
        .select(['kind', 'member_id'])
        .where('id', '=', f.wrapped_by_scope)
        .executeTakeFirst();
    });
    expect(wrapped).toMatchObject({ kind: 'member', member_id: owner.member_id });
    const sentLine = (await activity(owner)).find(
      (l) => l.text === 'Reviewed app sent a file to Owner’s Inbox',
    );
    expect(sentLine).toBeDefined();
    // Nobody did it: no person is the doer.
    expect(sentLine?.actor_member_id).toBeNull();
    const filed = await file(owner, item, { type_key: 'bank_statement', title: 'Reviewed' });
    expect(await status(a, 'rev-1')).toMatchObject({ state: 'filed', content_available: true });
    const v = await admin.query<{ uploaded_by: string | null; uploaded_by_app: string | null }>(
      'select uploaded_by, uploaded_by_app from document_version where id = $1',
      [filed.version_id],
    );
    expect(v.rows[0]).toEqual({ uploaded_by: null, uploaded_by_app: a.appId });
    const history = (
      await send(owner, 'GET', `/api/v1/documents/${filed.document_id}/versions`)
    ).json<{ items: VersionView[] }>().items;
    expect(history[0]).toMatchObject({ uploaded_by_name: 'Reviewed app', uploaded_by_app: true });
    // A person's own upload still names them.
    const doc = await admin.query<{ created_by: string }>(
      'select created_by from document where id = $1',
      [filed.document_id],
    );
    expect(doc.rows[0]?.created_by).toBe(await accountOf(owner));
    // Downloaded again: "Reviewed app downloaded …", nobody's doing.
    expect((await call(a, 'GET', '/api/v1/apps/intake/rev-1/content')).statusCode).toBe(200);
    expect((await lines(owner)).some((l) => l.startsWith('Reviewed app downloaded '))).toBe(true);
    // Withdrawn from the reviewer's Inbox, as the app.
    const { item: second } = await sent(a, 'rev-2');
    expect(second).toBeDefined();
    const out = await call(a, 'DELETE', '/api/v1/apps/intake/rev-2');
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json<AppIntakeState>()).toMatchObject({
      state: 'removed',
      removed_reason: 'withdrawn',
    });
    expect(await lines(owner)).toContain('Reviewed app took back a file it sent to Owner’s Inbox');
  });

  it('a send about a person goes to them, as APP5; another adult as reviewer needs no approval, and is told once', async () => {
    const a = await connect({}, 'Router itself');
    const r = await sent(a, 'to-ahmed', { person: { member_id: ahmed.member_id } });
    expect(r.res.statusCode, r.res.body).toBe(201);
    expect((await inboxOf(a, 'to-ahmed'))?.member_id).toBe(ahmed.member_id);
    expect(await lines(ahmed)).toContain('Router itself sent a file to Ahmed Khan’s Inbox');
    // Sara reviews it now: no approval, and she is told.
    const before = alertsSent(h).length;
    const changed = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      reviewer_member_id: sara.member_id,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<ConnectedAppView>()).toMatchObject({
      state: 'active',
      reviewer_member_id: sara.member_id,
      reviewer_name: 'Sara Khan',
    });
    expect(
      alertsSent(h)
        .slice(before)
        .filter((m) => m.subject === 'You’ll review what Router itself sends'),
    ).toHaveLength(1);
    const u = await sent(a, 'to-sara');
    expect(u.res.statusCode, u.res.body).toBe(201);
    expect((await inboxOf(a, 'to-sara'))?.member_id).toBe(sara.member_id);
    // A teen is never a reviewer.
    const teenR = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      reviewer_member_id: teen.member_id,
    });
    expect([teenR.statusCode, codeOf(teenR)]).toEqual([422, 'validation_failed']);
  });

  it('a reviewer who cannot take it now: an unrouted send is 503 busy, the owners told once; routed sends still land; the app is never removed', async () => {
    const a = await connect({ reviewer_member_id: sara.member_id }, 'Locked reviewer');
    const before = alertsSent(h).length;
    await admin.query(
      `update account_household set suspended_at = now(), suspend_reason = 'locked' where member_id = $1`,
      [sara.member_id],
    );
    try {
      const first = await sent(a, 'lr-1');
      expect([first.res.statusCode, codeOf(first.res)]).toEqual([503, 'busy']);
      expect(first.res.json<{ error: { retriable: boolean } }>().error.retriable).toBe(true);
      // Nothing landed, and the id is free for the send again.
      expect(
        (await admin.query('select 1 from connected_app_intake where app_id = $1', [a.appId]))
          .rowCount,
      ).toBe(0);
      const second = await sent(a, 'lr-1');
      expect(second.res.statusCode).toBe(503);
      const told = (await lines(owner)).filter(
        (l) =>
          l ===
          'Locked reviewer needs somebody to review what it sends: choose who in Settings → Connected apps',
      );
      expect(told).toHaveLength(1);
      expect(
        alertsSent(h)
          .slice(before)
          .filter((m) => m.subject === 'Choose who reviews what Locked reviewer sends'),
      ).toHaveLength(1);
      expect((await view(a)).reviewer_needed).toBe(true);
      // About Ahmed: it still goes to him.
      const routed = await sent(a, 'lr-ahmed', { person: { member_id: ahmed.member_id } });
      expect(routed.res.statusCode, routed.res.body).toBe(201);
      expect((await call(a, 'GET', '/api/v1/apps/me')).statusCode).toBe(200);
    } finally {
      await admin.query(
        `update account_household set suspended_at = null, suspend_reason = null where member_id = $1`,
        [sara.member_id],
      );
    }
    // Unlocked: it lands, and the owners would be told again next time.
    const after = await sent(a, 'lr-1');
    expect(after.res.statusCode, after.res.body).toBe(201);
    const row = await admin.query<{ reviewer_told_at: Date | null }>(
      'select reviewer_told_at from connected_app where id = $1',
      [a.appId],
    );
    expect(row.rows[0]?.reviewer_told_at).toBeNull();
    expect((await view(a)).reviewer_needed).toBe(false);
  });

  it('its reviewer’s role drops: let go of as reviewer in the same transaction, the owners told, the app kept; an app acting as them alone is revoked', async () => {
    await h.decider(owner);
    const vic = await h.join(owner, {
      name: 'Vic Khan',
      email: 'vic-8@example.test',
      role: 'adult',
    });
    const a = await connect({ reviewer_member_id: vic.member_id }, 'Vic reviews');
    const before = alertsSent(h).length;
    await h.decider(owner);
    const role = await send(owner, 'POST', `/api/v1/members/${vic.member_id}/role`, {
      role: 'teen',
    });
    expect(role.statusCode, role.body).toBe(200);
    const row = await admin.query(
      'select reviewer_member_id, revoked_at from connected_app where id = $1',
      [a.appId],
    );
    expect(row.rows[0]).toEqual({ reviewer_member_id: null, revoked_at: null });
    expect(await lines(owner)).toContain(
      'Vic reviews needs somebody to review what it sends: choose who in Settings → Connected apps',
    );
    expect(
      alertsSent(h)
        .slice(before)
        .filter((m) => m.subject === 'Choose who reviews what Vic reviews sends'),
    ).toHaveLength(1);
    expect((await view(a)).reviewer_needed).toBe(true);
    const r = await sent(a, 'vic-1');
    expect([r.res.statusCode, codeOf(r.res)]).toEqual([503, 'busy']);
    // Told once: the send's refusal adds no second line.
    expect(
      (await lines(owner)).filter((l) => l.startsWith('Vic reviews needs somebody')),
    ).toHaveLength(1);
    // A reviewer chosen again: it lands.
    await h.decider(owner);
    const fixed = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      reviewer_member_id: owner.member_id,
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect((await sent(a, 'vic-1')).res.statusCode).toBe(201);
  });

  it('acting as a person from now: back to waiting for them, its sends theirs; and as itself again, on at once', async () => {
    const a = await connect({}, 'Turns person');
    expect((await sent(a, 'tp-1')).res.statusCode).toBe(201);
    await h.decider(owner);
    const before = alertsSent(h).length;
    const to = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      acts_as: 'person',
      member_id: ahmed.member_id,
    });
    expect(to.statusCode, to.body).toBe(200);
    expect(to.json<ConnectedAppView>()).toMatchObject({
      acts_as: 'person',
      member_id: ahmed.member_id,
      reviewer_member_id: null,
      state: 'waiting_for_approval',
    });
    expect(
      alertsSent(h)
        .slice(before)
        .some((m) => m.subject === 'Turns person was connected to your sign-in'),
    ).toBe(true);
    // Its sends follow whom it acts as only once they turn it on: while it
    // waits for Ahmed, they are nobody's (the vault's), never his.
    const intakeOf = async () =>
      (
        await admin.query<{ member_id: string | null }>(
          'select member_id from connected_app_intake where app_id = $1',
          [a.appId],
        )
      ).rows;
    expect(await intakeOf()).toEqual([{ member_id: null }]);
    expect(codeOf(await call(a, 'GET', '/api/v1/apps/intake/tp-1'))).toBe('app_not_approved');
    // The database refuses an owner turning on an app acting as another adult.
    await expect(
      withScope(
        h.db,
        {
          householdId: owner.household_id,
          actor: {
            kind: 'account',
            accountId: await accountOf(owner),
            memberId: owner.member_id,
            role: 'owner',
          },
        },
        (trx) =>
          sql`update connected_app set approval = 'approved', approved_at = now() where id = ${a.appId}::uuid`.execute(
            trx,
          ),
      ),
    ).rejects.toThrow(/only its person turns an app on/);
    await h.decider(ahmed);
    expect(
      (await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`)).statusCode,
    ).toBe(200);
    expect(await intakeOf()).toEqual([{ member_id: ahmed.member_id }]);
    const st = await status(a, 'tp-1');
    expect(st.state).toBe('waiting');
    // Itself again: on at once, reviewed by the owner changing it.
    await h.decider(owner);
    const back = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      acts_as: 'app',
    });
    expect(back.json<ConnectedAppView>()).toMatchObject({
      acts_as: 'app',
      member_id: null,
      reviewer_member_id: owner.member_id,
      state: 'active',
    });
    expect((await status(a, 'tp-1')).state).toBe('waiting');
  });

  it('reads by its grants and own rule alone, as an app acting as an adult would: never Only me', async () => {
    const itself = await connect({}, 'Reader itself');
    const asAdult = await connect({ member_id: ahmed.member_id }, 'Reader adult');
    await h.decider(owner);
    for (const a of [itself, asAdult]) {
      const g = await send(owner, 'PUT', `/api/v1/connected-apps/${a.appId}/grants`, {
        grants: [{ kind: 'bank_statement', lookback_months: 12 }],
        confirm_sensitive: true,
      });
      expect(g.statusCode, g.body).toBe(200);
    }
    // Ahmed turns on the app acting as him, once it reads what it reads.
    await h.decider(ahmed);
    const on = await send(ahmed, 'POST', `/api/v1/connected-apps/${asAdult.appId}/approve`);
    expect(on.statusCode, on.body).toBe(200);
    for (const vis of ['household', 'adults', 'private'] as const) {
      const made = await send(owner, 'POST', '/api/v1/documents', {
        type_key: 'bank_statement',
        title: `Read ${vis}`,
        visibility: vis,
        owner_member_id: owner.member_id,
      });
      expect(made.statusCode, made.body).toBe(201);
    }
    const readBy = (appId: string) =>
      withScope(
        h.db,
        { householdId: owner.household_id, actor: { kind: 'connected_app', appId } },
        async (trx) =>
          (
            await sql<{ title: string }>`select title from document order by title`.execute(trx)
          ).rows
            .map((r) => r.title)
            .filter((t) => t.startsWith('Read ')),
      );
    expect(await readBy(itself.appId)).toEqual(['Read adults', 'Read household']);
    expect(await readBy(itself.appId)).toEqual(await readBy(asAdult.appId));
    const listed = (await call(itself, 'GET', '/api/v1/apps/documents')).json<{
      items: Array<{ title: string }>;
    }>();
    expect(
      listed.items
        .map((d) => d.title)
        .filter((t) => t.startsWith('Read '))
        .sort(),
    ).toEqual(['Read adults', 'Read household']);
    expect(await lines(owner)).toContain('Reader itself looked up documents');
  });

  it('filed automatically as whoever’s Inbox it is in, naming the app', async () => {
    const a = await connect({ auto_file: true }, 'Auto itself');
    const { item } = await sent(a, 'auto-1', { title: 'Owner, October' });
    const proposal: DetailProposal = {
      type_key: { value: 'bank_statement', confidence: 0.95, cue: 'kind_words' },
      owner_member_id: { value: owner.member_id, confidence: 0.95, cue: 'name_on_page' },
      issued: {
        value: { date: '2026-10-31', precision: 'day' },
        confidence: 0.9,
        cue: 'issue_label',
      },
    };
    await withSystem(h.db, owner.household_id, async (trx) => {
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
          text_sealed: sealBytes(fileKey, Buffer.from('its words'), itemTextBinding(item)),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal })),
            itemProposalsBinding(item),
          ),
        })
        .where('id', '=', item)
        .execute();
    });
    expect(
      await h.apps.autoFile.fileReady({ household_id: owner.household_id, item_id: item }),
    ).toBe('filed');
    const st = await status(a, 'auto-1');
    expect(st.state).toBe('filed');
    const v = await admin.query<{ uploaded_by: string | null; uploaded_by_app: string | null }>(
      'select uploaded_by, uploaded_by_app from document_version where id = $1',
      [st.version_id],
    );
    expect(v.rows[0]).toEqual({ uploaded_by: null, uploaded_by_app: a.appId });
    expect(
      (await lines(owner)).some((l) => l.startsWith('Filed automatically from Auto itself')),
    ).toBe(true);
  });

  it('the database keeps a file’s uploader a person or the app, and the app only for a file of its own Inbox', async () => {
    const a = await connect({}, 'Forged');
    const doc = await send(owner, 'POST', '/api/v1/documents', {
      type_key: 'bank_statement',
      title: 'Forged upload',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    expect(doc.statusCode, doc.body).toBe(201);
    const id = doc.json<{ id: string }>().id;
    const parts = (
      await admin.query<{ vault: string; scope: string }>(
        `select (select id from vault limit 1) as vault,
                (select id from scope_key where household_id = $1 and kind = 'household' limit 1) as scope`,
        [owner.household_id],
      )
    ).rows[0] as { vault: string; scope: string };
    const forged = async (by: Tokens, uploadedBy: string | null) =>
      withScope(
        h.db,
        {
          householdId: owner.household_id,
          actor: {
            kind: 'account',
            accountId: await accountOf(by),
            memberId: by.member_id,
            role: by === owner ? 'owner' : 'adult',
          },
        },
        (trx) =>
          sql`insert into document_version (household_id, document_id, version_no, filename, mime,
                byte_size, sha256, cipher_bytes, cipher_sha256, storage_key, vault_id,
                file_key_wrapped, wrapped_by_scope, uploaded_by, uploaded_by_app)
              values (${owner.household_id}::uuid, ${id}::uuid, 9, 'f.pdf', 'application/pdf', 1,
                      sha256('x'), 1, sha256('x'), ${randomUUID()}, ${parts.vault}::uuid,
                      sha256('k'), ${parts.scope}::uuid, ${uploadedBy}::uuid, ${a.appId}::uuid)`.execute(
            trx,
          ),
      );
    // Ahmed's Inbox has no batch of that app's: refused.
    await expect(forged(ahmed, null)).rejects.toThrow(/row-level security/);
    // A person and the app both: never.
    await expect(forged(owner, await accountOf(owner))).rejects.toThrow(
      /document_version_uploaded_by_one|row-level security/,
    );
  });

  // ------------------------------------------------ the review round

  it('whose file it is is decided as it is sent: switched to a person since, the file still names the app; a send racing the switch is 503 busy', async () => {
    const a = await connect({}, 'Switches');
    const { item } = await sent(a, 'sw-1');
    expect(item).toBeDefined();
    const row = await admin.query('select as_itself from connected_app_intake where app_id = $1', [
      a.appId,
    ]);
    expect(row.rows).toEqual([{ as_itself: true }]);
    // Now it acts as the owner: what it sent as itself is still its own file.
    await h.decider(owner);
    const to = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      acts_as: 'person',
      member_id: owner.member_id,
    });
    expect(to.statusCode, to.body).toBe(200);
    const filed = await file(owner, item, { type_key: 'bank_statement', title: 'Switched' });
    const v = await admin.query(
      'select uploaded_by, uploaded_by_app from document_version where id = $1',
      [filed.version_id],
    );
    expect(v.rows[0]).toEqual({ uploaded_by: null, uploaded_by_app: a.appId });
    // A send let in as the app acting as itself, landing after the switch:
    // nothing is written as it was, and it is answered busy.
    const stale: AppCaller = {
      appId: a.appId,
      keyId: a.keyId,
      householdId: owner.household_id,
      actsAs: 'app',
      accountId: null,
      memberId: null,
      role: 'adult',
      name: 'Switches',
      memberName: null,
      timezone: 'UTC',
      scopes: ['documents.send'],
      state: 'active',
      pausedReason: null,
    };
    const bytes = PDF('sw-race');
    const out = h.apps.send(
      stale,
      { external_id: 'sw-race', hints: { kind: 'bank_statement' } },
      {
        filename: 'race.pdf',
        mime: 'application/pdf',
        stream: Readable.from([bytes]),
        truncated: () => false,
        finished: async () => undefined,
      },
      { ip: null, userAgent: null },
    );
    await expect(out).rejects.toMatchObject({ status: 503, code: 'busy' });
    expect(
      (
        await admin.query(
          `select 1 from connected_app_intake where app_id = $1 and external_id = 'sw-race'`,
          [a.appId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('who added a version never changes, and the app is named only for that very file of its own, waiting in the filer’s own Inbox', async () => {
    const a = await connect({}, 'Fixed uploader');
    const { item } = await sent(a, 'fu-1');
    const filed = await file(owner, item, { type_key: 'bank_statement', title: 'Fixed' });
    await expect(
      admin.query('update document_version set uploaded_by_app = null where id = $1', [
        filed.version_id,
      ]),
    ).rejects.toThrow(/who added a version never changes/);
    await expect(
      admin.query(
        `update document_version set uploaded_by_app = null,
                uploaded_by = (select account_id from account_household where member_id = $2)
          where id = $1`,
        [filed.version_id, owner.member_id],
      ),
    ).rejects.toThrow(/who added a version never changes/);
    // The owner's Inbox has that app's batch, but no waiting item with these
    // bytes: refused.
    const { item: waiting } = await sent(a, 'fu-2');
    expect(waiting).toBeDefined();
    const doc = await send(owner, 'POST', '/api/v1/documents', {
      type_key: 'bank_statement',
      title: 'Not the app’s',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    const id = doc.json<{ id: string }>().id;
    const parts = (
      await admin.query<{ vault: string; scope: string }>(
        `select (select id from vault limit 1) as vault,
                (select id from scope_key where household_id = $1 and kind = 'household' limit 1) as scope`,
        [owner.household_id],
      )
    ).rows[0] as { vault: string; scope: string };
    await expect(
      withScope(
        h.db,
        {
          householdId: owner.household_id,
          actor: {
            kind: 'account',
            accountId: await accountOf(owner),
            memberId: owner.member_id,
            role: 'owner',
          },
        },
        (trx) =>
          sql`insert into document_version (household_id, document_id, version_no, filename, mime,
                byte_size, sha256, cipher_bytes, cipher_sha256, storage_key, vault_id,
                file_key_wrapped, wrapped_by_scope, uploaded_by, uploaded_by_app)
              values (${owner.household_id}::uuid, ${id}::uuid, 9, 'f.pdf', 'application/pdf', 1,
                      sha256('not the app''s'), 1, sha256('x'), ${randomUUID()}, ${parts.vault}::uuid,
                      sha256('k'), ${parts.scope}::uuid, null, ${a.appId}::uuid)`.execute(trx),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a reviewer is an owner or an adult of the family who signs in, as the database keeps it', async () => {
    const a = await connect({}, 'Reviewer rule');
    await expect(
      admin.query('update connected_app set reviewer_member_id = $2 where id = $1', [
        a.appId,
        teen.member_id,
      ]),
    ).rejects.toThrow(/an app's reviewer is an owner or an adult/);
    await admin.query('update connected_app set reviewer_member_id = $2 where id = $1', [
      a.appId,
      sara.member_id,
    ]);
  });

  describe('what an owner set up to act as itself ends with them (APP8)', () => {
    /** A second owner, promoted at once. */
    async function anotherOwner(n: string): Promise<Tokens> {
      await h.decider(owner);
      const t = await h.join(owner, {
        name: `Owner ${n}`,
        email: `owner-${n}-8@example.test`,
        role: 'adult',
      });
      const up = await send(owner, 'POST', `/api/v1/members/${t.member_id}/role`, {
        role: 'owner',
      });
      expect(up.statusCode, up.body).toBe(200);
      return t;
    }
    async function connectBy(by: Tokens, name: string) {
      await h.decider(by);
      const res = await send(by, 'POST', '/api/v1/connected-apps', {
        name,
        allowed_kinds: ['bank_statement'],
        scopes: ['documents.send'],
      });
      expect(res.statusCode, res.body).toBe(201);
      const v = res.json<ConnectedAppView>();
      return { appId: v.id, ...(await appKeyFor(h, by, v)), view: v };
    }
    /** An app the first owner connected, with a key of theirs, and one the other generated. */
    async function shared(other: Tokens, name: string) {
      const a = await connectBy(owner, name);
      await h.decider(other);
      const theirs = await appKeyFor(h, other, a.view);
      return { a, theirs: { ...a, ...theirs } };
    }
    const meOf = async (k: TestApp) => {
      const r = await call(k, 'GET', '/api/v1/apps/me');
      return r.statusCode === 200 ? 'ok' : codeOf(r);
    };
    /** As though an account that is not an owner now had set these up (the database's own rule, written past its guards). */
    const forge = (accountId: string, appId: string, keyId: string) =>
      admin.query(
        `begin;
         set local session_replication_role = replica;
         update connected_app set created_by = '${accountId}' where id = '${appId}';
         update connected_app_key set created_by = '${accountId}' where id = '${keyId}';
         commit;`,
      );
    async function expectEnded(ownApp: TestApp, theirKey: TestApp, kept: TestApp, who: string) {
      expect(await meOf(ownApp)).toBe('app_revoked');
      expect(await meOf(theirKey)).toBe('app_key_revoked');
      // The first owner's own key of that app, and the app: untouched.
      expect(await meOf(kept)).toBe('ok');
      const all = await lines(owner);
      expect(
        all.some((l) => l.includes(`${ownApp.view.name}, which they connected, was removed`)),
      ).toBe(true);
      expect(all).toContain(
        `An API key of ${theirKey.view.name} that ${who} generated was revoked with them`,
      );
    }

    it('their role dropping below owner (stepping down)', async () => {
      const b = await anotherOwner('step');
      const own = await connectBy(b, 'Step own');
      const { a, theirs } = await shared(b, 'Step shared');
      const before = alertsSent(h).length;
      await h.decider(b);
      const down = await send(b, 'POST', '/api/v1/me/step-down', { role: 'adult' });
      expect(down.statusCode, down.body).toBe(200);
      await expectEnded(own, theirs, a, 'Owner step');
      const mail = alertsSent(h)
        .slice(before)
        .filter((m) => m.subject === 'Connected apps Owner step set up were stopped');
      expect(mail).toHaveLength(1);
      expect(mail[0]?.account_ids).toEqual([await accountOf(owner)]);
    });

    it('signed out everywhere by another owner', async () => {
      const b = await anotherOwner('out');
      const own = await connectBy(b, 'Out own');
      const { a, theirs } = await shared(b, 'Out shared');
      await h.decider(owner);
      const out = await send(owner, 'DELETE', `/api/v1/members/${b.member_id}/sessions`);
      expect(out.statusCode, out.body).toBe(200);
      await expectEnded(own, theirs, a, 'Owner out');
      expect(
        alertsSent(h).filter((m) => m.subject === 'Connected apps Owner out set up were stopped'),
      ).toHaveLength(1);
    });

    it('their sign-in taken away', async () => {
      const b = await anotherOwner('gone');
      const own = await connectBy(b, 'Gone own');
      const { a, theirs } = await shared(b, 'Gone shared');
      // A sign-in an owner may take away is not an owner's: as though an
      // adult had set these up.
      const vic = await h.join(owner, {
        name: 'Vic Gone',
        email: 'vic-gone-8@example.test',
        role: 'adult',
      });
      await forge(await accountOf(vic), own.appId, theirs.keyId);
      await h.decider(owner);
      const r = await send(owner, 'DELETE', `/api/v1/members/${vic.member_id}/sign-in`);
      expect(r.statusCode, r.body).toBeLessThan(300);
      await expectEnded(own, theirs, a, 'Vic Gone');
      expect(
        alertsSent(h).filter((m) => m.subject === 'Connected apps Vic Gone set up were stopped'),
      ).toHaveLength(1);
      expect(b).toBeDefined();
    });

    it('a password reset that stops their password now', async () => {
      const b = await anotherOwner('reset');
      const own = await connectBy(b, 'Reset own');
      const { a, theirs } = await shared(b, 'Reset shared');
      const rae = await h.join(owner, {
        name: 'Rae Reset',
        email: 'rae-reset-8@example.test',
        role: 'adult',
      });
      await forge(await accountOf(rae), own.appId, theirs.keyId);
      await h.decider(owner);
      const r = await send(owner, 'POST', `/api/v1/members/${rae.member_id}/password-reset`, {
        stop_now: true,
      });
      expect(r.statusCode, r.body).toBe(200);
      await expectEnded(own, theirs, a, 'Rae Reset');
      expect(
        alertsSent(h).filter((m) => m.subject === 'Connected apps Rae Reset set up were stopped'),
      ).toHaveLength(1);
    });

    it('owner_stopped, as the database’s emergency control answers it', async () => {
      const b = await anotherOwner('stop');
      const own = await connectBy(b, 'Stop own');
      const { a, theirs } = await shared(b, 'Stop shared');
      const rows = await withScope(
        h.db,
        {
          householdId: owner.household_id,
          actor: {
            kind: 'account',
            accountId: await accountOf(owner),
            memberId: owner.member_id,
            role: 'owner',
          },
        },
        async (trx) =>
          (
            await sql<{ id: string; client_id: string | null }>`
              select id, client_id from connected_apps_revoke_for(${await accountOf(b)}::uuid,
                                                                  'owner_stopped')`.execute(trx)
          ).rows,
      );
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: own.appId, client_id: null },
          { id: a.appId, client_id: theirs.clientId },
        ]),
      );
      expect(await meOf(own)).toBe('app_revoked');
      expect(await meOf(theirs)).toBe('app_key_revoked');
      expect(await meOf(a)).toBe('ok');
    });
  });
});
