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
import { createPool, withPrincipal, withScope, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  ActivityLine,
  AppIntakeState,
  AppMe,
  BatchDetail,
  BatchView,
  ConnectedAppView,
  DetailProposal,
  Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appKeyFor, basicFor, createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { SENT_VERSION_COLUMNS } from './reads.js';
import type { AppCaller, AppFile } from './service.js';

/**
 * Connected apps (0.9.0, APP5): an app downloads again the exact file it
 * sent, by its own external id; and the vault sends each paper to the Inbox
 * of the person it is about, when that person is an adult of the family who
 * signs in — else to the app's own person's, as before.
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
const peer = () => `10.76.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
const codeOf = (r: LightMyRequestResponse) => r.json<{ error?: { code?: string } }>().error?.code;

describe.skipIf(!testAdminUrl())(
  'connected apps: sends again, and whose Inbox (0.9.0, APP5)',
  () => {
    let h: Harness;
    let admin: ReturnType<typeof createPool>;
    let owner: Tokens;
    let ahmed: Tokens;
    let sara: Tokens;
    let saraP: Tokens;
    let teen: Tokens;
    let locked: Tokens;

    const send = (t: Tokens, method: string, url: string, payload?: unknown) =>
      h.app.inject({
        method: method as 'GET',
        url,
        headers: h.as(t),
        ...(payload === undefined ? {} : { payload: payload as never }),
        remoteAddress: peer(),
      });

    async function connect(
      input: Record<string, unknown> = {},
      name = 'Acme Money',
      by: () => Tokens = () => owner,
    ): Promise<TestApp> {
      await h.decider(owner);
      const res = await send(owner, 'POST', '/api/v1/connected-apps', {
        name,
        member_id: by().member_id,
        allowed_kinds: ['bank_statement', 'utility_bill', 'pay_statement'],
        scopes: ['documents.send', 'documents.read', 'documents.download'],
        ...input,
      });
      expect(res.statusCode, res.body).toBe(201);
      const view = res.json<ConnectedAppView>();
      const key = await appKeyFor(h, owner, view);
      return { appId: view.id, ...key, view };
    }

    async function call(
      a: TestApp,
      method: 'GET' | 'POST' | 'DELETE',
      target: string,
      body?: { bytes: Uint8Array; contentType: string },
      headers: Record<string, string> = {},
    ): Promise<LightMyRequestResponse> {
      const signed = basicFor(a);
      return h.app.inject({
        method,
        url: target,
        headers: {
          ...signed,
          ...(body ? { 'content-type': body.contentType } : {}),
          ...headers,
        },
        ...(body ? { payload: Buffer.from(body.bytes) } : {}),
        remoteAddress: '127.0.0.1',
      });
    }

    /** A file the app sends: the answer, and the item it became. */
    async function sent(
      a: TestApp,
      externalId: string,
      hints: Record<string, unknown> = { kind: 'bank_statement' },
      bytes = PDF(externalId),
    ): Promise<{ res: LightMyRequestResponse; item: string }> {
      const body = multipartBody([
        { name: 'metadata', value: JSON.stringify({ external_id: externalId, hints }) },
        { name: 'file', filename: 'statement.pdf', contentType: 'application/pdf', bytes },
      ]);
      const res = await call(a, 'POST', '/api/v1/apps/intake', body);
      const row = await admin.query<{ id: string }>(
        `select incoming_file_id as id from connected_app_intake where app_id = $1 and external_id = $2`,
        [a.appId, externalId],
      );
      return { res, item: row.rows[0]?.id as string };
    }

    /** Whose Inbox a send is in: its batch's person and maker, and what the send keeps. */
    async function inboxOf(a: TestApp, externalId: string) {
      const r = await admin.query<{
        member_id: string;
        created_by: string;
        name: string;
        inbox_member_id: string | null;
      }>(
        `select b.member_id, b.created_by, b.name, i.inbox_member_id
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

    /** An item filed by whoever's Inbox it is in, through their own batch: as made, or into a document. */
    async function file(t: Tokens, item: string, body: Record<string, unknown>) {
      const batch = (
        await admin.query<{ batch_id: string }>(
          'select batch_id from incoming_file where id = $1',
          [item],
        )
      ).rows[0]?.batch_id as string;
      const r = await send(t, 'POST', `/api/v1/batches/${batch}/items/${item}/accept`, body);
      expect(r.statusCode, r.body).toBe(201);
      return r.json<{ document_id: string; version_id: string }>();
    }

    /** A document of the family's, with its file. */
    async function make(who: Tokens, title: string, bytes: Buffer = PDF(title)): Promise<string> {
      const created = await send(who, 'POST', '/api/v1/documents', {
        type_key: 'bank_statement',
        title,
        visibility: 'household',
        owner_member_id: who.member_id,
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json<{ id: string }>().id;
      await addVersion(who, id, bytes);
      return id;
    }
    async function addVersion(who: Tokens, id: string, bytes: Buffer) {
      const form = multipartBody([
        { name: 'file', filename: 'newer.pdf', contentType: 'application/pdf', bytes },
      ]);
      const up = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${id}/versions`,
        headers: {
          ...h.as(who),
          'content-type': form.contentType,
          'idempotency-key': randomUUID(),
        },
        payload: Buffer.from(form.bytes),
        remoteAddress: peer(),
      });
      expect(up.statusCode, up.body).toBeLessThan(300);
    }

    const status = async (a: TestApp, id: string) => {
      const r = await call(a, 'GET', `/api/v1/apps/intake/${id}`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json<AppIntakeState>();
    };
    const again = (a: TestApp, id: string, headers: Record<string, string> = {}) =>
      call(a, 'GET', `/api/v1/apps/intake/${id}/content`, undefined, headers);
    const lines = async (t: Tokens) =>
      (await send(t, 'GET', '/api/v1/audit?limit=100'))
        .json<{ items: ActivityLine[] }>()
        .items.map((l) => l.text);

    /** What a transaction acting for the app is given of the versions, by id. */
    const appVersions = (appId: string, household: string) =>
      withScope(
        h.db,
        { householdId: household, actor: { kind: 'connected_app', appId } },
        async (trx) =>
          (await sql<{ id: string }>`select id from document_version`.execute(trx)).rows.map(
            (r) => r.id,
          ),
      );

    beforeAll(async () => {
      h = await createHarness({ rateLimitPerMinute: 50_000 });
      admin = createPool(h.adminUrl, 2);
      owner = await h.setup();
      ahmed = await h.join(owner, {
        name: 'Ahmed Khan',
        email: 'ahmed-5@example.test',
        role: 'adult',
      });
      sara = await h.join(owner, {
        name: 'Sara Khan',
        email: 'sara-5@example.test',
        role: 'adult',
      });
      saraP = await h.join(owner, {
        name: 'Sara Patel',
        email: 'saraP-5@example.test',
        role: 'adult',
      });
      teen = await h.join(owner, {
        name: 'Tariq Khan',
        email: 'tariq-5@example.test',
        role: 'teen',
      });
      locked = await h.join(owner, {
        name: 'Lena Khan',
        email: 'lena-5@example.test',
        role: 'adult',
      });
      await admin.query(
        `update account_household set suspended_at = now(), suspend_reason = 'locked'
        where member_id = $1`,
        [locked.member_id],
      );
    }, 180_000);
    afterAll(async () => {
      await admin?.end();
      await h?.close();
    });

    // -------------------------------------------------- the file it sent, again

    it('filed as its own document: the exact file again, said in its status, counted and written down', async () => {
      const a = await connect({}, 'Again own');
      const bytes = PDF('again-own-1');
      const { res, item } = await sent(a, 'own-1', { kind: 'bank_statement' }, bytes);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json<AppIntakeState>().content_available).toBe(false);
      // Nothing to download while it waits.
      expect([(await again(a, 'own-1')).statusCode, codeOf(await again(a, 'own-1'))]).toEqual([
        404,
        'not_found',
      ]);
      const filed = await file(owner, item, { type_key: 'bank_statement', title: 'Own again' });
      const st = await status(a, 'own-1');
      expect(st).toMatchObject({ state: 'filed', content_available: true });
      const before = (await call(a, 'GET', '/api/v1/apps/me')).json<AppMe>().limits
        .read_bytes_today;
      const r = await again(a, 'own-1');
      expect(r.statusCode, r.body).toBe(200);
      expect(Buffer.from(r.rawPayload).equals(bytes)).toBe(true);
      expect(r.headers.etag).toBe(`"${filed.version_id}"`);
      expect(r.headers['content-disposition']).toMatch(/^attachment/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cache-control']).toBe('no-store');
      // A range, and 304 for the version it has.
      const part = await again(a, 'own-1', { range: 'bytes=0-3' });
      expect(part.statusCode).toBe(206);
      expect(part.rawPayload.toString()).toBe('%PDF');
      expect(
        (await again(a, 'own-1', { 'if-none-match': `"${filed.version_id}"` })).statusCode,
      ).toBe(304);
      // Counted against the day's download bytes, as its downloads are.
      const after = (await call(a, 'GET', '/api/v1/apps/me')).json<AppMe>().limits.read_bytes_today;
      expect(after - before).toBe(bytes.length + 4);
      // One line like a download's.
      expect((await lines(owner)).some((l) => l.startsWith('Owner via Again own downloaded'))).toBe(
        true,
      );
      // The download scope, as its downloads need.
      await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
        scopes: ['documents.send', 'documents.read'],
      });
      const refused = await again(a, 'own-1');
      expect([refused.statusCode, codeOf(refused)]).toEqual([403, 'scope_not_granted']);
      // …and its status never says available while the route refuses it.
      expect(await status(a, 'own-1')).toMatchObject({ state: 'filed', content_available: false });
    });

    it('reads only what serving the bytes needs of a version: never the details it keeps', () => {
      // What `sentVersions` selects, as the app: no detail a version keeps of
      // its document (an older one keeps them as they were), and nothing of
      // them is answered — the route gives the file's bytes and headers alone.
      expect([...SENT_VERSION_COLUMNS].sort()).toEqual(
        [
          'byte_size',
          'document_id',
          'file_key_wrapped',
          'file_removed_at',
          'filename',
          'id',
          'mime',
          'sha256',
          'storage_key',
          'uploaded_at',
          'vault_id',
          'version_no',
          'wrapped_by_scope',
        ].sort(),
      );
      for (const detail of [
        'identifier',
        'issued_on',
        'expires_on',
        'details_kept_at',
        'uploaded_by',
        'preview_pages',
      ]) {
        expect(SENT_VERSION_COLUMNS as readonly string[]).not.toContain(detail);
      }
    });

    it('filed into a family paper as a new version: not its own, unavailable, and still its file again', async () => {
      const a = await connect({}, 'Again version');
      const family = await make(owner, 'Family statement');
      const bytes = PDF('again-version-1');
      const { item } = await sent(a, 'ver-1', { kind: 'bank_statement' }, bytes);
      const filed = await file(owner, item, { into_document_id: family });
      expect(filed.document_id).toBe(family);
      // The family's paper: never read by the app without a grant.
      expect((await call(a, 'GET', `/api/v1/apps/documents/${family}`)).statusCode).toBe(404);
      const st = await status(a, 'ver-1');
      expect(st).toMatchObject({
        state: 'unavailable',
        document_id: null,
        content_available: true,
      });
      const r = await again(a, 'ver-1');
      expect(r.statusCode, r.body).toBe(200);
      expect(Buffer.from(r.rawPayload).equals(bytes)).toBe(true);
      // The database gives it that version and no other of the paper's.
      const versions = await admin.query<{ id: string }>(
        'select id from document_version where document_id = $1 order by version_no',
        [family],
      );
      expect(versions.rows).toHaveLength(2);
      const given = await appVersions(a.appId, owner.household_id);
      expect(given).toContain(filed.version_id);
      expect(given).not.toContain(versions.rows[0]?.id);
    });

    it('a newer family file after its own: still the file it sent, never the newer one', async () => {
      const a = await connect({}, 'Again superseded');
      const bytes = PDF('again-newer-1');
      const { item } = await sent(a, 'newer-1', { kind: 'bank_statement' }, bytes);
      const filed = await file(owner, item, { type_key: 'bank_statement', title: 'Superseded' });
      const newer = PDF('the family’s newer file');
      await addVersion(owner, filed.document_id, newer);
      // Still the app's to read (18 Nov 2026): filed, its document the same.
      expect(await status(a, 'newer-1')).toMatchObject({
        state: 'filed',
        document_id: filed.document_id,
        content_available: true,
      });
      const r = await again(a, 'newer-1');
      expect(r.statusCode).toBe(200);
      expect(Buffer.from(r.rawPayload).equals(bytes)).toBe(true);
      expect(r.headers.etag).toBe(`"${filed.version_id}"`);
    });

    it('never once its document is Only me, in the Trash, removed for good, or made an identity paper', async () => {
      const a = await connect({}, 'Again never');
      const docs: Record<string, string> = {};
      for (const id of ['private-1', 'trash-1', 'purged-1', 'identity-1']) {
        const { item } = await sent(a, id, { kind: 'bank_statement' });
        docs[id] = (await file(owner, item, { type_key: 'bank_statement', title: id })).document_id;
        expect((await again(a, id)).statusCode).toBe(200);
      }
      await admin.query(
        `update document set visibility = 'private', owner_member_id = $2 where id = $1`,
        [docs['private-1'], owner.member_id],
      );
      await admin.query(`update document set deleted_at = now() where id = $1`, [docs['trash-1']]);
      await admin.query(`delete from document where id = $1`, [docs['purged-1']]);
      await admin.query(
        `update document set type_key = 'passport', category = 'identity' where id = $1`,
        [docs['identity-1']],
      );
      for (const id of ['private-1', 'trash-1', 'purged-1', 'identity-1']) {
        const r = await again(a, id);
        expect([id, r.statusCode, codeOf(r)]).toEqual([id, 404, 'not_found']);
        expect((await status(a, id)).content_available).toBe(false);
      }
      // Nor in the database: a transaction acting for the app is given none of them.
      const given = await appVersions(a.appId, owner.household_id);
      const theirs = await admin.query<{ id: string }>(
        'select id from document_version where document_id = any($1::uuid[])',
        [Object.values(docs)],
      );
      for (const v of theirs.rows) expect(given).not.toContain(v.id);
      // Back from the Trash: its file again.
      await admin.query(`update document set deleted_at = null where id = $1`, [docs['trash-1']]);
      expect((await again(a, 'trash-1')).statusCode).toBe(200);
    });

    it('never another app’s send, nor in another household', async () => {
      const a = await connect({}, 'Again mine');
      const b = await connect({}, 'Again theirs');
      const { item } = await sent(a, 'shared-id', { kind: 'bank_statement' });
      const filed = await file(owner, item, { type_key: 'bank_statement', title: 'Mine' });
      expect((await again(a, 'shared-id')).statusCode).toBe(200);
      // Another app asking for the same external id: it sent nothing by it.
      const r = await again(b, 'shared-id');
      expect([r.statusCode, codeOf(r)]).toEqual([404, 'not_found']);
      expect(await appVersions(b.appId, owner.household_id)).not.toContain(filed.version_id);
      // A transaction acting for the app, told another household: nothing.
      const other = randomUUID();
      await admin.query(`insert into household (id, name) values ($1, 'The neighbours')`, [other]);
      expect(await appVersions(a.appId, other)).toEqual([]);
      const rule = await withSystem(h.db, other, (trx) =>
        sql<{ id: string }>`select connected_app_sent_versions(${a.appId}::uuid) as id`.execute(
          trx,
        ),
      );
      expect(rule.rows).toEqual([]);
      // Paused: nothing, as for its other downloads.
      await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/pause`);
      expect(await appVersions(a.appId, owner.household_id)).not.toContain(filed.version_id);
      expect([(await again(a, 'shared-id')).statusCode]).toEqual([403]);
    });

    it('let go of by the app: not its file any more', async () => {
      const a = await connect(
        { scopes: ['documents.send', 'documents.read', 'documents.download', 'documents.delete'] },
        'Again unlinked',
      );
      const { item } = await sent(a, 'unlink-1', { kind: 'bank_statement' });
      const filed = await file(owner, item, { type_key: 'bank_statement', title: 'Unlinked' });
      const del = await call(a, 'DELETE', `/api/v1/apps/documents/${filed.document_id}`);
      expect(del.statusCode, del.body).toBe(200);
      expect((await again(a, 'unlink-1')).statusCode).toBe(404);
      expect((await status(a, 'unlink-1')).content_available).toBe(false);
    });

    // ------------------------------------------------------- whose Inbox

    it('by person.id: to the Inbox of the person it is about, as their own; the app is never told', async () => {
      const a = await connect({}, 'Router');
      expect(a.view.route_to_person).toBe(true);
      const { res, item } = await sent(a, 'to-ahmed', {
        kind: 'bank_statement',
        person: { member_id: ahmed.member_id },
      });
      expect(res.statusCode, res.body).toBe(201);
      const state = res.json<AppIntakeState>();
      expect(Object.keys(state).sort()).toEqual(
        [
          'byte_size',
          'content_available',
          'document_id',
          'external_id',
          'filed_at',
          'received_at',
          'refusal',
          'removed_reason',
          'sha256',
          'state',
          'version_id',
        ].sort(),
      );
      expect(state.state).toBe('waiting');
      const inbox = await inboxOf(a, 'to-ahmed');
      expect(inbox).toMatchObject({
        member_id: ahmed.member_id,
        created_by: await accountOf(ahmed),
        inbox_member_id: ahmed.member_id,
      });
      expect(inbox?.name).toMatch(/^From Router, /);
      // In Ahmed's Inbox, with what the app said; not in the owner's.
      const theirs = (await send(ahmed, 'GET', '/api/v1/batches')).json<{ items: BatchView[] }>();
      const batch = theirs.items.find((b) => b.name?.startsWith('From Router'));
      expect(batch).toBeDefined();
      const detail = (
        await send(ahmed, 'GET', `/api/v1/batches/${batch?.id as string}`)
      ).json<BatchDetail>();
      expect(detail.items.map((i) => i.id)).toContain(item);
      const mine = (await send(owner, 'GET', '/api/v1/batches')).json<{ items: BatchView[] }>();
      expect(mine.items.some((b) => b.id === batch?.id)).toBe(false);
      // The activity log names the Inbox it went to.
      expect(await lines(owner)).toContain('Owner via Router sent a file to Ahmed Khan’s Inbox');
      expect(await lines(ahmed)).toContain('Owner via Router sent a file to Ahmed Khan’s Inbox');
      // Ahmed files it, as themselves.
      const filed = await file(ahmed, item, { type_key: 'bank_statement', title: 'Ahmed’s' });
      expect(await status(a, 'to-ahmed')).toMatchObject({
        state: 'filed',
        content_available: true,
      });
      const by = await admin.query<{ created_by: string }>(
        'select created_by from document where id = $1',
        [filed.document_id],
      );
      expect(by.rows[0]?.created_by).toBe(await accountOf(ahmed));
    });

    it('by a name: the whole name, or a first name only one person has', async () => {
      const a = await connect({}, 'Namer');
      await sent(a, 'to-sara', { kind: 'bank_statement', person: { name: '  sara   KHAN ' } });
      expect((await inboxOf(a, 'to-sara'))?.member_id).toBe(sara.member_id);
      await sent(a, 'to-ahmed-first', { kind: 'bank_statement', person: { name: 'Ahmed' } });
      expect((await inboxOf(a, 'to-ahmed-first'))?.member_id).toBe(ahmed.member_id);
      // Two Saras: nobody by that name, so the app's own person's.
      await sent(a, 'two-saras', { kind: 'bank_statement', person: { name: 'Sara' } });
      expect((await inboxOf(a, 'two-saras'))?.member_id).toBe(owner.member_id);
      await sent(a, 'nobody', { kind: 'bank_statement', person: { name: 'J Smith' } });
      expect((await inboxOf(a, 'nobody'))?.member_id).toBe(owner.member_id);
      // One batch a person a day: Sara's and Ahmed's are their own.
      const names = await admin.query<{ member_id: string; n: string }>(
        `select b.member_id, count(*) as n from intake_batch b where b.app_id = $1 group by b.member_id`,
        [a.appId],
      );
      expect(names.rows.map((r) => r.member_id).sort()).toEqual(
        [owner.member_id, ahmed.member_id, sara.member_id].sort(),
      );
      expect(saraP.member_id).not.toBe(sara.member_id);
    });

    it('a teen, somebody with no sign-in, a guest, a locked adult, the household or nobody: the app’s own person’s', async () => {
      const a = await connect({}, 'Keeper');
      const child = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name) values ($1, 'Mina Khan') returning id`,
          [owner.household_id],
        )
      ).rows[0]?.id as string;
      const guest = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name, kind) values ($1, 'Gita Guest', 'guest') returning id`,
          [owner.household_id],
        )
      ).rows[0]?.id as string;
      const cases: Array<[string, Record<string, unknown>]> = [
        ['teen', { kind: 'bank_statement', person: { member_id: teen.member_id } }],
        ['child', { kind: 'bank_statement', person: { member_id: child } }],
        ['child-name', { kind: 'bank_statement', person: { name: 'Mina Khan' } }],
        ['guest', { kind: 'bank_statement', person: { member_id: guest } }],
        ['guest-name', { kind: 'bank_statement', person: { name: 'Gita Guest' } }],
        ['locked', { kind: 'bank_statement', person: { member_id: locked.member_id } }],
        ['household', { kind: 'bank_statement', person: { household: true } }],
        // A kind that usually belongs to the household, whoever it names.
        ['bill', { kind: 'utility_bill', person: { member_id: ahmed.member_id } }],
        ['none', { kind: 'bank_statement' }],
        ['stranger', { kind: 'bank_statement', person: { member_id: randomUUID() } }],
      ];
      for (const [id, hints] of cases) {
        const { res } = await sent(a, id, hints);
        expect([id, res.statusCode]).toEqual([id, 201]);
        expect([id, (await inboxOf(a, id))?.member_id]).toEqual([id, owner.member_id]);
      }
    });

    it('switched off: everything to its person’s Inbox; switching it on asks the person it acts as again', async () => {
      const a = await connect({ route_to_person: false }, 'Off router');
      expect(a.view.route_to_person).toBe(false);
      await sent(a, 'off-1', { kind: 'bank_statement', person: { member_id: ahmed.member_id } });
      expect((await inboxOf(a, 'off-1'))?.member_id).toBe(owner.member_id);
      // Not a boolean: refused.
      const bad = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
        route_to_person: 'yes',
      });
      expect(bad.statusCode).toBe(422);
      // An app acting as Ahmed, switched on by an owner: Ahmed turns it on again.
      await h.decider(ahmed);
      const theirs = await connect({ route_to_person: false }, 'Ahmed’s router', () => ahmed);
      await send(ahmed, 'POST', `/api/v1/connected-apps/${theirs.appId}/approve`);
      const on = await send(owner, 'PATCH', `/api/v1/connected-apps/${theirs.appId}`, {
        route_to_person: true,
      });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json<ConnectedAppView>()).toMatchObject({
        route_to_person: true,
        state: 'waiting_for_approval',
      });
    });

    it('an app from before keeps its person’s Inbox: the migration left it off, new apps on', async () => {
      const d = await admin.query<{ d: string }>(
        `select column_default as d from information_schema.columns
        where table_name = 'connected_app' and column_name = 'route_to_person'`,
      );
      expect(d.rows[0]?.d).toBe('true');
    });

    it('the caps are the app’s, whoever’s Inbox; a send taken back leaves their Inbox', async () => {
      const a = await connect({ daily_files: 2 }, 'Capped');
      expect(
        (await sent(a, 'cap-1', { kind: 'bank_statement', person: { member_id: ahmed.member_id } }))
          .res.statusCode,
      ).toBe(201);
      expect(
        (await sent(a, 'cap-2', { kind: 'bank_statement', person: { member_id: sara.member_id } }))
          .res.statusCode,
      ).toBe(201);
      const full = (await sent(a, 'cap-3', { kind: 'bank_statement' })).res;
      expect([full.statusCode, codeOf(full)]).toEqual([429, 'app_day_full']);
      expect((await call(a, 'GET', '/api/v1/apps/me')).json<AppMe>().limits.files_today).toBe(2);
      // Taken back: out of Sara's Inbox, as the app's person withdrew it.
      expect((await inboxOf(a, 'cap-2'))?.member_id).toBe(sara.member_id);
      const item = (
        await admin.query<{ id: string }>(
          'select incoming_file_id as id from connected_app_intake where app_id = $1 and external_id = $2',
          [a.appId, 'cap-2'],
        )
      ).rows[0]?.id;
      const w = await call(a, 'DELETE', '/api/v1/apps/intake/cap-2');
      expect(w.statusCode, w.body).toBe(200);
      expect(w.json<AppIntakeState>()).toMatchObject({
        state: 'removed',
        removed_reason: 'withdrawn',
      });
      const gone = await admin.query<{ state: string }>(
        'select state from incoming_file where id = $1',
        [item],
      );
      expect(gone.rows[0]?.state ?? 'rejected').toBe('rejected');
      expect(await lines(owner)).toContain(
        'Owner via Capped took back a file it sent to Sara Khan’s Inbox',
      );
      // What it sent its person, in Settings: its own Inbox alone.
      const view = (await send(owner, 'GET', '/api/v1/connected-apps')).json<{
        items: ConnectedAppView[];
      }>();
      expect(view.items.find((x) => x.id === a.appId)?.counts).toEqual({ waiting: 0, filed: 0 });
    });

    it('filed automatically as the person it went to, by the same rule', async () => {
      const a = await connect({ auto_file: true }, 'Auto router');
      const { item } = await sent(a, 'auto-ahmed', {
        kind: 'bank_statement',
        person: { member_id: ahmed.member_id },
        title: 'Ahmed, October',
      });
      expect((await inboxOf(a, 'auto-ahmed'))?.member_id).toBe(ahmed.member_id);
      const read = async (proposal: DetailProposal) =>
        withSystem(h.db, owner.household_id, async (trx) => {
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
      await read({
        type_key: { value: 'bank_statement', confidence: 0.95, cue: 'kind_words' },
        owner_member_id: { value: ahmed.member_id, confidence: 0.95, cue: 'name_on_page' },
        issued: {
          value: { date: '2026-10-31', precision: 'day' },
          confidence: 0.9,
          cue: 'issue_label',
        },
      });
      expect(
        await h.apps.autoFile.fileReady({ household_id: owner.household_id, item_id: item }),
      ).toBe('filed');
      const st = await status(a, 'auto-ahmed');
      expect(st.state).toBe('filed');
      const doc = await admin.query<{ created_by: string; owner_member_id: string }>(
        'select created_by, owner_member_id from document where id = $1',
        [st.document_id],
      );
      expect(doc.rows[0]).toEqual({
        created_by: await accountOf(ahmed),
        owner_member_id: ahmed.member_id,
      });
      // Locked since: never filed as them.
      const { item: second } = await sent(a, 'auto-ahmed-2', {
        kind: 'bank_statement',
        person: { member_id: ahmed.member_id },
      });
      await admin.query(
        `update account_household set suspended_at = now(), suspend_reason = 'locked' where member_id = $1`,
        [ahmed.member_id],
      );
      try {
        expect(
          await h.apps.autoFile.fileReady({ household_id: owner.household_id, item_id: second }),
        ).toBe('off');
      } finally {
        await admin.query(
          `update account_household set suspended_at = null, suspend_reason = null where member_id = $1`,
          [ahmed.member_id],
        );
      }
    });

    // ------------------------------------------------ the review round

    /**
     * A send straight to the service, as the route makes it, with `meanwhile`
     * run as the body ends: between the transaction that makes its item and
     * the one that lands it.
     */
    async function sendHolding(
      a: TestApp,
      by: Tokens,
      role: 'owner' | 'adult',
      externalId: string,
      hints: Record<string, unknown>,
      meanwhile: () => Promise<void>,
    ) {
      const caller: AppCaller = {
        appId: a.appId,
        keyId: a.keyId,
        householdId: owner.household_id,
        accountId: await accountOf(by),
        memberId: by.member_id,
        role,
        name: a.view.name,
        memberName: 'Them',
        timezone: 'UTC',
        scopes: ['documents.send', 'documents.read', 'documents.download'],
        state: 'active',
        pausedReason: null,
      };
      const bytes = PDF(externalId);
      const file: AppFile = {
        filename: `${externalId}.pdf`,
        mime: 'application/pdf',
        stream: Readable.from([bytes]),
        truncated: () => false,
        finished: meanwhile,
      };
      return h.apps.send(caller, { external_id: externalId, hints }, file, {
        ip: null,
        userAgent: null,
      });
    }
    const landed = async (a: TestApp, externalId: string) =>
      (
        await admin.query<{ n: number }>(
          `select count(*)::int as n from connected_app_intake
            where app_id = $1 and external_id = $2 and state <> 'arriving'`,
          [a.appId, externalId],
        )
      ).rows[0]?.n ?? 0;
    const receivedFor = async (a: TestApp, member: string) =>
      (
        await admin.query<{ n: number }>(
          `select count(*)::int as n from incoming_file f
             join intake_batch b on b.id = f.batch_id
            where b.app_id = $1 and b.member_id = $2 and f.state = 'received'`,
          [a.appId, member],
        )
      ).rows[0]?.n ?? 0;
    const suspend = (t: Tokens, reason: 'locked' | 'restored') =>
      admin.query(
        `update account_household set suspended_at = now(), suspend_reason = $2 where member_id = $1`,
        [t.member_id, reason],
      );
    const resume = (t: Tokens) =>
      admin.query(
        `update account_household set suspended_at = null, suspend_reason = null where member_id = $1`,
        [t.member_id],
      );

    it('the app’s own person locked while a send to somebody else lands: nothing lands', async () => {
      await h.decider(ahmed);
      const a = await connect({}, 'Ahmed’s sender', () => ahmed);
      const on = await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
      expect(on.statusCode, on.body).toBe(200);
      try {
        await expect(
          sendHolding(
            a,
            ahmed,
            'adult',
            'lock-a',
            { kind: 'bank_statement', person: { member_id: sara.member_id } },
            () => suspend(ahmed, 'locked').then(() => undefined),
          ),
        ).rejects.toMatchObject({ code: 'member_locked' });
      } finally {
        await resume(ahmed);
      }
      expect(await landed(a, 'lock-a')).toBe(0);
      expect(await receivedFor(a, sara.member_id)).toBe(0);
      // Paused instead: the same.
      try {
        await expect(
          sendHolding(
            a,
            ahmed,
            'adult',
            'pause-a',
            { kind: 'bank_statement', person: { member_id: sara.member_id } },
            () => suspend(ahmed, 'restored').then(() => undefined),
          ),
        ).rejects.toMatchObject({ code: 'member_paused' });
      } finally {
        await resume(ahmed);
      }
      expect(await landed(a, 'pause-a')).toBe(0);
      expect(await receivedFor(a, sara.member_id)).toBe(0);
    });

    it('the person it goes to paused while it lands: nothing in their Inbox, and sent again it goes to the app’s person', async () => {
      const a = await connect({}, 'Paused recipient');
      try {
        await expect(
          sendHolding(
            a,
            owner,
            'owner',
            'pause-r',
            { kind: 'bank_statement', person: { member_id: sara.member_id } },
            () => suspend(sara, 'restored').then(() => undefined),
          ),
        ).rejects.toMatchObject({ code: 'busy', options: { retriable: true } });
        expect(await landed(a, 'pause-r')).toBe(0);
        expect(await receivedFor(a, sara.member_id)).toBe(0);
        // Sent again, while she is paused: the app's own person's Inbox.
        const again = await sent(a, 'pause-r', {
          kind: 'bank_statement',
          person: { member_id: sara.member_id },
        });
        expect(again.res.statusCode, again.res.body).toBe(201);
        expect((await inboxOf(a, 'pause-r'))?.member_id).toBe(owner.member_id);
      } finally {
        await resume(sara);
      }
    });

    it('the person it went to paused before it is filed with nobody looking: it is not filed', async () => {
      const a = await connect({ auto_file: true }, 'Paused filer');
      const { item } = await sent(a, 'pause-file', {
        kind: 'bank_statement',
        person: { member_id: sara.member_id },
      });
      expect((await inboxOf(a, 'pause-file'))?.member_id).toBe(sara.member_id);
      await suspend(sara, 'restored');
      try {
        // Asked in the filing's own transaction, as her, whatever was asked before it.
        const out = await h.batches.fileFromApp(
          {
            accountId: await accountOf(sara),
            sessionId: '',
            householdId: owner.household_id,
            memberId: sara.member_id,
            role: 'adult',
            seesAdults: true,
          },
          item,
          { id: a.appId, name: 'Paused filer' },
          async () => true,
          { ip: null, userAgent: null },
        );
        expect(out).toEqual({ filed: false, why: 'off' });
        expect(
          await h.apps.autoFile.fileReady({ household_id: owner.household_id, item_id: item }),
        ).toBe('off');
      } finally {
        await resume(sara);
      }
      expect((await status(a, 'pause-file')).state).toBe('waiting');
    });

    it('the database lets a batch name an app for a teen, a guest or another household’s person never', async () => {
      const a = await connect({}, 'Batch rule');
      const guest = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name, kind) values ($1, 'Gil Guest', 'guest') returning id`,
          [owner.household_id],
        )
      ).rows[0]?.id as string;
      const other = randomUUID();
      await admin.query(`insert into household (id, name) values ($1, 'Next door')`, [other]);
      const stranger = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name) values ($1, 'Next door adult') returning id`,
          [other],
        )
      ).rows[0]?.id as string;
      const inbox = (member: string) =>
        withSystem(
          h.db,
          owner.household_id,
          async (trx) =>
            (
              await sql<{
                ok: boolean;
              }>`select connected_app_inbox(${a.appId}::uuid, ${member}::uuid) as ok`.execute(trx)
            ).rows[0]?.ok,
        );
      expect(await inbox(sara.member_id)).toBe(true);
      expect(await inbox(owner.member_id)).toBe(true);
      for (const m of [teen.member_id, guest, stranger]) expect(await inbox(m)).toBe(false);
      // A batch written by hand: the teen, as themselves; the vault, for the guest.
      const ownerAccount = await accountOf(owner);
      const batch = (member: string) => ({
        household_id: owner.household_id,
        created_by: ownerAccount,
        member_id: member,
        name: 'By hand',
        app_id: a.appId,
        app_day: '2026-11-17',
        app_part: 1,
        ends_at: new Date(Date.now() + 864e5),
      });
      await expect(
        withPrincipal(
          h.db,
          {
            householdId: owner.household_id,
            accountId: await accountOf(teen),
            memberId: teen.member_id,
            role: 'teen',
          },
          async (trx) =>
            trx
              .insertInto('intake_batch')
              .values({ ...batch(teen.member_id), created_by: await accountOf(teen) })
              .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        withSystem(h.db, owner.household_id, (trx) =>
          trx.insertInto('intake_batch').values(batch(guest)).execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      // Another household's person, named as this one's: never.
      await expect(
        withSystem(h.db, other, (trx) =>
          trx
            .insertInto('intake_batch')
            .values({ ...batch(stranger), household_id: other })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security|violates/);
      // An adult of the family, by hand as the vault: let in.
      await withSystem(h.db, owner.household_id, (trx) =>
        trx.insertInto('intake_batch').values(batch(sara.member_id)).execute(),
      );
    });
  },
);
