import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, EnvKeyProvider, ScopeKeys, unwrapKey } from '@fdv/crypto';
import { withScope, withSystem, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  pagesNotSharedNote,
  sharePagesNote,
  type DocumentView,
  type ShareLinkPreview,
  type SharedSession,
} from '@fdv/shared';
import { LocalAdapter } from '@fdv/storage';
import argon2 from 'argon2';
import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import type { CreatedShare, SharedDocument, SharePreview, ShareView } from './shares.js';

const testKeys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Share links (SHR-05). What matters is what a link cannot do: outlive
 * its expiry, survive being taken back, carry a document it was not made
 * for, or reach anything else in the vault.
 *
 * Since 5.16 a new link is opened by the page at /s: a preview, then Open
 * (a POST, the PIN in its body), then a session cookie. The links made
 * before then keep the old routes, and only they do.
 */
describe.skipIf(!testAdminUrl())('share links', () => {
  let h: Harness;
  let owner: Tokens;
  let ownerAccount: string;
  let lease: string;
  let privateDoc: string;
  /** Everything the API wrote to its log, line by line. */
  const logged: string[] = [];

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const code = (r: LightMyRequestResponse) => json<{ error: { code: string } }>(r).error.code;

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.7.${Math.floor(++nth / 200)}.${nth % 200}` });

  const make = async (title: string, visibility: 'household' | 'private', as: Tokens = owner) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(as),
      payload: {
        title,
        type_key: 'utility_bill',
        visibility,
        ...(visibility === 'private' ? { owner_member_id: as.member_id } : {}),
      },
    });
    const id = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(as), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    return id;
  };

  const share = (documentId: string, body: Record<string, unknown> = {}, as: Tokens = owner) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/share`,
      headers: h.as(as),
      payload: body,
    });
  const made = async (documentId: string, body: Record<string, unknown> = {}) =>
    json<CreatedShare>(await share(documentId, body));

  // ------------------------------------------------ the page's calls (5.16)

  const preview = (token: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/preview',
      payload: { token },
      ...peer(),
    });
  const unlock = (token: string, secret?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: secret === undefined ? { token } : { token, secret },
      ...peer(),
    });
  const cookieOf = (r: LightMyRequestResponse) =>
    r.cookies.find((c) => c.name === 'fdv_share') as
      { name: string; value: string; path?: string; maxAge?: number } | undefined;
  const items = (cookie?: string) =>
    h.app.inject({
      url: '/api/v1/shared/items',
      ...(cookie ? { cookies: { fdv_share: cookie } } : {}),
      ...peer(),
    });
  const content = (cookie: string, documentId: string) =>
    h.app.inject({
      url: `/api/v1/shared/items/${documentId}/content`,
      cookies: { fdv_share: cookie },
      ...peer(),
    });
  const page = (cookie: string, documentId: string, n: number) =>
    h.app.inject({
      url: `/api/v1/shared/items/${documentId}/pages/${n}`,
      cookies: { fdv_share: cookie },
      ...peer(),
    });
  /** Open, and the session's cookie. */
  const opened = async (token: string, secret?: string) => {
    const res = await unlock(token, secret);
    expect(res.statusCode, res.body).toBe(200);
    return { res, cookie: cookieOf(res)?.value as string };
  };

  // ----------------------------------------------- the old routes (A25)

  const legacyPreview = (token: string) =>
    h.app.inject({ url: `/api/v1/shared/${token}`, ...peer() });
  const legacyOpen = (token: string, pin?: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/shared/${token}/open`,
      payload: pin ? { pin } : {},
      ...peer(),
    });
  const legacyContent = (token: string, pin?: string) =>
    h.app.inject({
      url: `/api/v1/shared/${token}/content${pin ? `?pin=${pin}` : ''}`,
      ...peer(),
    });

  /**
   * A link as 0.5.13 and before made them, in the database as such a vault
   * has it: nothing makes one any more, so it is put there directly.
   */
  const legacyLink = async (documentId: string, opts: { pin?: string; label?: string } = {}) => {
    const token = randomBytes(32).toString('base64url');
    const pinHash = opts.pin ? await argon2.hash(opts.pin, { type: argon2.argon2id }) : null;
    const row = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('share_link')
        .values({
          household_id: owner.household_id,
          document_id: documentId,
          token_hash: sha256(token),
          pin_hash: pinHash,
          recipient_label: opts.label ?? null,
          created_by: ownerAccount,
          expires_at: new Date(Date.now() + 7 * 864e5),
          flow: 'legacy',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return { token, id: row.id };
  };

  const linkRow = (id: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('share_link')
        .select(['attempts', 'open_count', 'flow', 'paused_at', 'downloads_used'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );

  // ----------------------------------------- a view-only link's pages (5.18)

  /** The newest version of a document, as the vault keeps it. */
  const newestOf = (documentId: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document_version')
        .selectAll()
        .where('document_id', '=', documentId)
        .orderBy('version_no', 'desc')
        .executeTakeFirstOrThrow(),
    );
  /** What the worker would have found: the version's own pages drawn, and how long it is. */
  const drawnAlready = async (documentId: string, drawn: number, pageCount = drawn) => {
    const v = await newestOf(documentId);
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_state: 'ready', preview_pages: drawn, page_count: pageCount })
        .where('id', '=', v.id)
        .execute(),
    );
    // The vault's own previews, which a link must never hand out.
    for (let n = 1; n <= drawn; n += 1) await putFor(documentId, `${v.storage_key}.p${n}.enc`, OWN);
  };
  const OWN = Buffer.from("the vault's own preview, not for a link");
  const marked = (shareId: string, n: number) =>
    Buffer.from(
      `\xff\xd8\xff a page for ${shareId}, number ${n}, carrying its watermark`,
      'latin1',
    );
  /** Stores bytes as the vault stores a file: encrypted under the version's own key. */
  const putFor = async (documentId: string, key: string, plain: Buffer) => {
    const v = await newestOf(documentId);
    const fileKey = await withSystem(h.db, owner.household_id, async (trx) =>
      unwrapKey(
        v.file_key_wrapped,
        await testKeys.unwrapById(trx, v.wrapped_by_scope),
        `version:${documentId}`,
      ),
    );
    const enc = new EncryptStream(fileKey);
    await Promise.all([
      new LocalAdapter(h.vaultDir).put(key, enc),
      pipeline(Readable.from([plain]), enc),
    ]);
  };
  /**
   * What the worker's share.pages job leaves (apps/worker, share-pages.ts):
   * a page for the link, encrypted beside the version, and its row. The
   * drawing itself, watermark and all, is the worker's own test.
   */
  const drawAsWorker = async (shareId: string, documentId: string, pages: number) => {
    const v = await newestOf(documentId);
    for (let n = 1; n <= pages; n += 1) {
      await putFor(documentId, `${v.storage_key}.share-${shareId}.p${n}.enc`, marked(shareId, n));
    }
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('share_page')
        .values(
          Array.from({ length: pages }, (_, i) => ({
            household_id: owner.household_id,
            share_id: shareId,
            document_id: documentId,
            version_id: v.id,
            n: i + 1,
            storage_key: `${v.storage_key}.share-${shareId}.p${i + 1}.enc`,
          })),
        )
        .execute(),
    );
  };
  const jobsFor = (name: string, shareId: string) =>
    h.jobs.filter((j) => j.name === name && j.data.share_id === shareId);
  /** A link's pages gone from storage, their rows left: a restore's view of them. */
  const rmPages = async (documentId: string, shareId: string) => {
    const v = await newestOf(documentId);
    await new LocalAdapter(h.vaultDir).delete(`${v.storage_key}.share-${shareId}.p1.enc`);
  };
  /** A transaction asked as whoever holds a link. */
  const withScopeOfLink = <T>(shareId: string, fn: (trx: Db) => Promise<T>) =>
    withScope(h.db, { householdId: owner.household_id, actor: { kind: 'link', shareId } }, fn);
  const sessionsOf = (shareId: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx.selectFrom('share_session').selectAll().where('share_id', '=', shareId).execute(),
    );
  const auditOf = (shareId: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'ip'])
        .where(sql<boolean>`detail->>'share_id' = ${shareId}`)
        .orderBy('id')
        .execute(),
    );
  const setLink = (id: string, set: { paused_at?: Date; paused_reason?: 'restored' }) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx.updateTable('share_link').set(set).where('id', '=', id).execute(),
    );
  /**
   * A restore from a backup made before this link was taken back: in the
   * backup it was never revoked, so it comes back live, and the restore
   * then pauses it with its own rule (restore.ts, PAUSE_LINKS) — here for
   * this one link, so the other tests' links are left as they are.
   */
  const restoredFromBefore = (id: string) =>
    withSystem(h.db, owner.household_id, async (trx) => {
      await trx
        .updateTable('share_link')
        .set({ revoked_at: null, revoked_by: null })
        .where('id', '=', id)
        .execute();
      await sql`update public.share_link set paused_at = now(), paused_reason = 'restored'
         where paused_at is null and revoked_at is null and expires_at > now() and attempts < 10
           and id = ${id}`.execute(trx);
    });
  const pausedFor = async (who: Tokens) =>
    json<{ links: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(who) }),
    ).links.map((l) => l.id);
  const resume = (who: Tokens, id: string) =>
    h.app.inject({ method: 'POST', url: `/api/v1/shares/${id}/resume`, headers: h.as(who) });
  const takeBack = (who: Tokens, id: string) =>
    h.app.inject({ method: 'DELETE', url: `/api/v1/shares/${id}`, headers: h.as(who) });

  beforeAll(async () => {
    h = await createHarness({
      logger: { level: 'info', stream: { write: (s: string) => void logged.push(s) } },
    });
    owner = await h.setup();
    ownerAccount = json<{ account_id: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) }),
    ).account_id;
    lease = await make('Flat 3 tenancy agreement', 'household');
    privateDoc = await make('Therapy notes', 'private');
  }, 90_000);
  afterAll(() => h.close());

  it('makes a link that opens the document and nothing else', async () => {
    const created = await made(lease, { recipient_label: 'the letting agent' });
    expect(created.link_token.length).toBeGreaterThan(32);
    expect(created.pin).toBeUndefined();
    expect(created.share).toMatchObject({
      document_title: 'Flat 3 tenancy agreement',
      recipient_label: 'the letting agent',
      has_pin: false,
      open_count: 0,
      state: 'active',
      flow: 'v2',
      paused_at: null,
    });
    expect(created.share.summary).toMatch(/Shared with the letting agent, not opened yet/);

    const shown = json<ShareLinkPreview>(await preview(created.link_token));
    expect(shown).toMatchObject({
      household_name: 'The Test family',
      protection: [],
      document_title: 'Flat 3 tenancy agreement',
      shared_by: 'Owner',
    });

    const { res, cookie } = await opened(created.link_token);
    const session = json<SharedSession>(res);
    expect(session.items).toEqual([
      expect.objectContaining({
        id: lease,
        title: 'Flat 3 tenancy agreement',
        filename: 'scan.pdf',
        content_type: 'application/pdf',
        byte_size: PDF.length,
      }),
    ]);
    // A cookie for the share routes alone, which no script can read and no
    // other site's page can send.
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/Path=\/api\/v1\/shared(;|$)/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Strict/);

    expect(json<SharedSession>(await items(cookie)).items[0]?.id).toBe(lease);
    const file = await content(cookie, lease);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    expect(file.headers['content-disposition']).toContain('scan.pdf');
    // Never cached anywhere, never indexed.
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.headers['x-robots-tag']).toContain('noindex');
  });

  it('the family sees that it was opened, and how often', async () => {
    const shares = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items;
    const link = shares.find((s) => s.recipient_label === 'the letting agent') as ShareView;
    expect(link.open_count).toBe(1);
    expect(link.last_opened_at).not.toBeNull();
    expect(link.summary).toMatch(/opened once/);
  });

  it('a PIN withholds even the title until it is right', async () => {
    const created = await made(lease, { with_pin: true });
    expect(created.pin).toMatch(/^\d{4}$/);

    const shown = json<ShareLinkPreview>(await preview(created.link_token));
    expect(shown.protection).toEqual(['pin']);
    // A title can say a great deal, and the PIN is there because somebody
    // wanted a second lock on exactly this.
    expect(shown.document_title).toBeNull();

    const wrong = await unlock(created.link_token, created.pin === '0000' ? '1111' : '0000');
    expect(wrong.statusCode).toBe(401);
    expect(code(wrong)).toBe('pin_wrong');
    expect(cookieOf(wrong)).toBeUndefined();
    expect((await unlock(created.link_token)).statusCode).toBe(401);

    const { res } = await opened(created.link_token, created.pin);
    expect(json<SharedSession>(res).items[0]?.title).toBe('Flat 3 tenancy agreement');
    // Each wrong one used a try; the right one gave its own back.
    expect((await linkRow(created.share.id)).attempts).toBe(2);
  });

  it('downloading after opening is one visit, not two', async () => {
    const created = await made(lease, { recipient_label: 'counter' });
    const { cookie } = await opened(created.link_token);
    await content(cookie, lease);
    await content(cookie, lease);
    await items(cookie);

    const link = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items.find((s) => s.recipient_label === 'counter') as ShareView;
    expect(link.open_count).toBe(1);
  });

  it('taking it back stops it at once', async () => {
    const created = await made(lease, { recipient_label: 'gone' });
    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: `/api/v1/shares/${created.share.id}`,
          headers: h.as(owner),
        })
      ).statusCode,
    ).toBe(204);

    expect((await preview(created.link_token)).statusCode).toBe(404);
    expect((await unlock(created.link_token)).statusCode).toBe(404);
  });

  it('an expired link is refused, in the same words as every other dead one', async () => {
    const created = await made(lease, { expires_in_days: 1 });
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('share_link')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', created.share.id)
        .execute(),
    );
    const res = await preview(created.link_token);
    expect(res.statusCode).toBe(404);
    expect(code(res)).toBe('link_not_valid');
    expect(code(await unlock(created.link_token))).toBe('link_not_valid');
  });

  it('a link to a document that goes in the bin stops working', async () => {
    const doomed = await make('Old bill', 'household');
    const created = await made(doomed);
    expect((await preview(created.link_token)).statusCode).toBe(200);

    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${doomed}`,
      headers: h.as(owner),
    });
    expect((await preview(created.link_token)).statusCode).toBe(404);
  });

  it('ten wrong PINs and the link is dead, right code or not', async () => {
    const created = await made(lease, { with_pin: true });
    const wrongPin = created.pin === '9999' ? '1111' : '9999';
    for (let i = 0; i < 10; i++) {
      expect((await unlock(created.link_token, wrongPin)).statusCode).toBe(401);
    }
    expect((await unlock(created.link_token, created.pin)).statusCode).toBe(404);
  });

  it('nine wrong PINs, and the tenth try, right, still opens it', async () => {
    const created = await made(lease, { with_pin: true });
    const wrongPin = created.pin === '9999' ? '1111' : '9999';
    for (let i = 0; i < 9; i++) await unlock(created.link_token, wrongPin);
    await opened(created.link_token, created.pin);
    expect(await linkRow(created.share.id)).toMatchObject({ attempts: 9, open_count: 1 });
  });

  it('twenty parallel wrong PINs lock the link at exactly ten', async () => {
    const created = await made(lease, { with_pin: true, recipient_label: 'the scanner' });
    const wrongPin = created.pin === '9999' ? '1111' : '9999';
    const before = h.jobs.length;
    const tries = await Promise.all(
      Array.from({ length: 20 }, () => unlock(created.link_token, wrongPin)),
    );
    const answers = tries.map((r) => r.statusCode);
    // Ten tries, and not one more, however many arrived at once: ten are
    // told the PIN was wrong, the rest that the link has stopped.
    expect(answers.filter((s) => s === 401)).toHaveLength(10);
    expect(answers.filter((s) => s === 404)).toHaveLength(10);
    expect((await linkRow(created.share.id)).attempts).toBe(10);
    expect(tries.some((r) => /stopped working/.test(r.body))).toBe(true);

    // Written down once, as locked; the wrong tries are counters, never
    // audit rows. And the sharer is told, once.
    expect((await auditOf(created.share.id)).map((a) => a.action)).toEqual([
      'share.created',
      'share.locked',
    ]);
    const told = h.jobs
      .slice(before)
      .filter((j) => j.name === 'alert.send' && /stopped working/.test(String(j.data.subject)));
    expect(told).toHaveLength(1);
    expect(told[0]?.data.account_ids).toEqual([ownerAccount]);
    // Nothing in the alert says what the document is or who it was for.
    expect(JSON.stringify(told[0]?.data)).not.toMatch(/tenancy|scanner/);

    expect((await unlock(created.link_token, created.pin)).statusCode).toBe(404);
    const listed = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items.find((s) => s.id === created.share.id);
    expect(listed?.state).toBe('locked');
  }, 60_000);

  it('a v2 token is 404 on each legacy route', async () => {
    // Every combination of the options a link can have today: a PIN, a
    // label, to view or to download (5.18), limits or none, and an end at
    // a time rather than in days.
    const limitsFor = (permission: 'view' | 'download') =>
      permission === 'view'
        ? [{}, { max_opens: 3 }]
        : [{}, { max_opens: 3 }, { max_downloads: 2 }, { max_opens: 3, max_downloads: 2 }];
    for (const withPin of [false, true]) {
      for (const label of [undefined, 'the notary']) {
        for (const permission of ['download', 'view'] as const) {
          for (const limits of limitsFor(permission)) {
            const created = await made(lease, {
              ...(withPin ? { with_pin: true } : {}),
              ...(label ? { recipient_label: label } : {}),
              permission,
              ...limits,
              expires_at: new Date(Date.now() + 26 * 3_600_000).toISOString(),
            });
            const t = created.link_token;
            const what = `pin ${withPin}, label ${label ?? 'none'}, ${permission}, ${JSON.stringify(limits)}`;
            expect(created.share, what).toMatchObject({ permission, flow: 'v2' });
            for (const res of [
              await legacyPreview(t),
              await legacyOpen(t, created.pin),
              await legacyContent(t, created.pin),
              await legacyOpen(t, '0000'),
            ]) {
              expect(res.statusCode, what).toBe(404);
              expect(code(res), what).toBe('link_not_valid');
            }
            // Nothing was tried, opened or written down on its way past.
            expect(await linkRow(created.share.id), what).toMatchObject({
              attempts: 0,
              open_count: 0,
              downloads_used: 0,
              flow: 'v2',
            });
            expect(
              (await auditOf(created.share.id)).map((a) => a.action),
              what,
            ).toEqual(['share.created']);
            // And it still works where it belongs.
            expect((await preview(t)).statusCode, what).toBe(200);
          }
        }
      }
    }
  }, 60_000);

  it('a legacy link cannot be given a new option', async () => {
    const old = await legacyLink(lease, { pin: '4321' });
    // Not the new routes: no preview, no Open, so no session.
    for (const res of [await preview(old.token), await unlock(old.token, '4321')]) {
      expect(res.statusCode).toBe(404);
      expect(code(res)).toBe('link_not_valid');
    }
    expect(await linkRow(old.id)).toMatchObject({ attempts: 0, open_count: 0 });

    // Nor by the database: a session is a v2 link's alone ...
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .insertInto('share_session')
          .values({
            household_id: owner.household_id,
            share_id: old.id,
            cookie_hash: sha256('a cookie'),
            verified_by: 'pin',
            expires_at: new Date(Date.now() + 60_000),
          })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key|share_session/);
    // ... and a link keeps the flow it was made with, both ways.
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx.updateTable('share_link').set({ flow: 'v2' }).where('id', '=', old.id).execute(),
      ),
    ).rejects.toThrow(/keeps the flow/);
    const fresh = await made(lease);
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('share_link')
          .set({ flow: 'legacy' })
          .where('id', '=', fresh.share.id)
          .execute(),
      ),
    ).rejects.toThrow(/keeps the flow/);
    // ... and 5.18's options are a v2 link's alone (0041): a legacy link
    // downloads, as the old routes do, and has no limits they would ignore.
    for (const [set, rule] of [
      [{ permission: 'view' }, /share_link_permission_v2/],
      [{ max_opens: 5 }, /share_link_max_opens_v2/],
      [{ max_downloads: 5 }, /share_link_max_downloads_v2/],
    ] as const) {
      await expect(
        withSystem(h.db, owner.household_id, (trx) =>
          trx.updateTable('share_link').set(set).where('id', '=', old.id).execute(),
        ),
        JSON.stringify(set),
      ).rejects.toThrow(rule);
    }
    // And the old routes still open it.
    expect((await legacyOpen(old.token, '4321')).statusCode).toBe(200);
  });

  it('a session opened five minutes before the link ends stops when it ends', async () => {
    const created = await made(lease);
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('share_link')
        .set({ expires_at: new Date(Date.now() + 5 * 60_000) })
        .where('id', '=', created.share.id)
        .execute(),
    );
    const { res, cookie } = await opened(created.link_token);
    // Not four hours: the link's own end (A26).
    const maxAge = cookieOf(res)?.maxAge ?? 0;
    expect(maxAge).toBeGreaterThan(290);
    expect(maxAge).toBeLessThanOrEqual(300);
    const [session] = await sessionsOf(created.share.id);
    const link = json<SharedSession>(res);
    expect(session?.expires_at.toISOString()).toBe(link.expires_at);
    expect(link.session_expires_at).toBe(link.expires_at);
    expect((await items(cookie)).statusCode).toBe(200);

    // Five minutes and a second go by: every time the vault holds moves back.
    await withSystem(h.db, owner.household_id, async (trx) => {
      await sql`update share_link
                   set expires_at = expires_at - interval '301 seconds',
                       created_at = created_at - interval '301 seconds'
                 where id = ${created.share.id}`.execute(trx);
      await sql`update share_session
                   set expires_at = expires_at - interval '301 seconds',
                       created_at = created_at - interval '301 seconds',
                       last_seen_at = last_seen_at - interval '301 seconds'
                 where share_id = ${created.share.id}`.execute(trx);
    });
    const after = await items(cookie);
    expect(after.statusCode).toBe(401);
    expect(code(after)).toBe('share_session_ended');
    expect((await content(cookie, lease)).statusCode).toBe(401);
  });

  it('revoking, pausing or trashing ends an open session at its next request', async () => {
    const ends: Array<[string, (shareId: string, doc: string) => Promise<unknown>]> = [
      [
        'revoked',
        (id) =>
          h.app.inject({ method: 'DELETE', url: `/api/v1/shares/${id}`, headers: h.as(owner) }),
      ],
      ['paused', (id) => setLink(id, { paused_at: new Date(), paused_reason: 'restored' })],
      [
        'trashed',
        (_, doc) =>
          h.app.inject({ method: 'DELETE', url: `/api/v1/documents/${doc}`, headers: h.as(owner) }),
      ],
    ];
    for (const [how, end] of ends) {
      const doc = await make(`Ends when ${how}`, 'household');
      const created = await made(doc);
      const { cookie } = await opened(created.link_token);
      expect((await items(cookie)).statusCode, how).toBe(200);
      await end(created.share.id, doc);
      for (const res of [await items(cookie), await content(cookie, doc), await items(cookie)]) {
        expect([401, 404], how).toContain(res.statusCode);
      }
      expect(await sessionsOf(created.share.id), how).toEqual([]);
    }
  });

  it('a link session asking for a document outside its share by id gets 404', async () => {
    const other = await make('Somebody else entirely', 'household');
    const created = await made(lease);
    const { cookie } = await opened(created.link_token);
    for (const doc of [other, privateDoc, randomUUID()]) {
      const res = await content(cookie, doc);
      expect(res.statusCode).toBe(404);
      expect(res.rawPayload.equals(PDF)).toBe(false);
    }
    // Its own, yes; and only that one was written down as downloaded.
    expect((await content(cookie, lease)).statusCode).toBe(200);
    expect((await auditOf(created.share.id)).map((a) => a.action)).toEqual([
      'share.created',
      'share.opened',
      'share.downloaded',
    ]);
  });

  it('the cookie in the database is a hash; the stored value opens nothing', async () => {
    const created = await made(lease);
    const { cookie } = await opened(created.link_token);
    const [row] = await sessionsOf(created.share.id);
    expect(row?.cookie_hash.equals(sha256(cookie))).toBe(true);
    expect(row?.cookie_hash.toString('base64url')).not.toBe(cookie);
    // Whoever has a copy of the table has nothing to present.
    for (const stored of [
      row?.cookie_hash.toString('base64url'),
      row?.cookie_hash.toString('hex'),
      row?.cookie_hash.toString('base64'),
    ]) {
      const res = await items(stored);
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe('share_session_ended');
    }
    expect((await items(cookie)).statusCode).toBe(200);
    // Kept as little as will do: the network, not the machine (A24).
    expect(row?.ip).toMatch(/^10\.7\.\d+\.0\/24$/);
  });

  it('a preview counts and audits nothing', async () => {
    const created = await made(lease, { with_pin: true });
    for (let i = 0; i < 3; i++) expect((await preview(created.link_token)).statusCode).toBe(200);
    expect(await linkRow(created.share.id)).toMatchObject({ attempts: 0, open_count: 0 });
    expect((await auditOf(created.share.id)).map((a) => a.action)).toEqual(['share.created']);
    expect(await sessionsOf(created.share.id)).toEqual([]);
  });

  it('loading the page opens nothing until Open', async () => {
    const created = await made(lease);
    // What /s does as it loads: the preview, and whether this browser has
    // the link open already (it has not).
    expect((await preview(created.link_token)).statusCode).toBe(200);
    expect((await items()).statusCode).toBe(401);
    expect(await linkRow(created.share.id)).toMatchObject({ open_count: 0 });
    expect(await sessionsOf(created.share.id)).toEqual([]);
    expect((await auditOf(created.share.id)).map((a) => a.action)).toEqual(['share.created']);

    // Open is the step that counts.
    await opened(created.link_token);
    expect(await linkRow(created.share.id)).toMatchObject({ open_count: 1 });
    expect(await sessionsOf(created.share.id)).toHaveLength(1);
    expect((await auditOf(created.share.id)).map((a) => a.action)).toEqual([
      'share.created',
      'share.opened',
    ]);
  });

  it('old links still open', async () => {
    const plain = await legacyLink(lease, { label: 'the old landlord' });
    const shown = json<SharePreview>(await legacyPreview(plain.token));
    expect(shown).toMatchObject({ needs_pin: false, document_title: 'Flat 3 tenancy agreement' });
    const res = await legacyOpen(plain.token);
    expect(res.statusCode).toBe(200);
    expect(json<SharedDocument>(res).filename).toBe('scan.pdf');
    const file = await legacyContent(plain.token);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    expect(await linkRow(plain.id)).toMatchObject({ open_count: 1, flow: 'legacy' });

    const pinned = await legacyLink(lease, { pin: '2468' });
    expect(json<SharePreview>(await legacyPreview(pinned.token)).document_title).toBeNull();
    expect((await legacyOpen(pinned.token, '1357')).statusCode).toBe(401);
    expect((await legacyOpen(pinned.token, '2468')).statusCode).toBe(200);
    expect((await legacyContent(pinned.token, '2468')).statusCode).toBe(200);
    expect((await legacyContent(pinned.token)).statusCode).toBe(401);
    expect((await linkRow(pinned.id)).attempts).toBe(2);

    // Listed as the family always saw them, and taken back the same way.
    const listed = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items.find((s) => s.id === plain.id);
    expect(listed).toMatchObject({ flow: 'legacy', state: 'active' });
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/shares/${plain.id}`,
      headers: h.as(owner),
    });
    expect((await legacyPreview(plain.token)).statusCode).toBe(404);

    // Paused by a restore, an old link waits like a new one.
    await setLink(pinned.id, { paused_at: new Date(), paused_reason: 'restored' });
    expect((await legacyPreview(pinned.token)).statusCode).toBe(404);
  });

  describe('after a restore, a paused link waits for an owner (A55)', () => {
    let sam: Tokens;
    beforeAll(async () => {
      sam = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
    });

    /** Sam's link, taken back by an owner, and brought back by a restore from before then. */
    const samsLinkAfterRestore = async (label: string) => {
      const link = json<CreatedShare>(await share(lease, { recipient_label: label }, sam));
      expect((await takeBack(owner, link.share.id)).statusCode).toBe(204);
      expect((await preview(link.link_token)).statusCode).toBe(404);
      await restoredFromBefore(link.share.id);
      expect((await linkRow(link.share.id)).paused_at).not.toBeNull();
      return link;
    };

    /** Whether the document with this id may be seen by whoever this is. */
    const sees = async (who: Tokens, documentId: string) =>
      (await h.app.inject({ url: `/api/v1/documents/${documentId}`, headers: h.as(who) }))
        .statusCode === 200;
    const setVisibility = (who: Tokens, documentId: string, visibility: 'household' | 'private') =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${documentId}/visibility`,
        headers: h.as(who),
        payload: { visibility },
      });

    it("an owner revokes an adult's link, a restore brings it back, and the adult's resume gets 403", async () => {
      const link = await samsLinkAfterRestore("Sam's solicitor");
      expect((await preview(link.link_token)).statusCode).toBe(404);

      // Not Sam's to decide: the owner who took it back has no say in the
      // backup, and nobody would see it come back.
      const refused = await resume(sam, link.share.id);
      expect(refused.statusCode).toBe(403);
      expect(code(refused)).toBe('forbidden');
      expect((await linkRow(link.share.id)).paused_at).not.toBeNull();
      expect((await preview(link.link_token)).statusCode).toBe(404);
      expect((await unlock(link.link_token)).statusCode).toBe(404);
      expect((await auditOf(link.share.id)).map((a) => a.action)).not.toContain('share.resumed');
    });

    it('the maker of a paused link still has it listed, only to take it back', async () => {
      const link = await samsLinkAfterRestore("Sam's surveyor");
      const diary = await make("Sam's travel diary", 'private', sam);
      const own = json<CreatedShare>(await share(diary, { recipient_label: 'the GP' }, sam));
      await restoredFromBefore(own.share.id);

      // Both are his to see, so that he can take them back: his own Only me
      // document's link as much as the one an owner decides about.
      const listed = await pausedFor(sam);
      expect(listed).toContain(link.share.id);
      expect(listed).toContain(own.share.id);
      expect(await pausedFor(owner)).toContain(link.share.id);

      // Taking a link back only closes, so that stays his.
      for (const id of [link.share.id, own.share.id]) {
        expect((await takeBack(sam, id)).statusCode).toBe(204);
      }
      expect(await pausedFor(sam)).not.toContain(link.share.id);
      expect(await pausedFor(sam)).not.toContain(own.share.id);
      expect(await pausedFor(owner)).not.toContain(link.share.id);
      expect((await preview(link.link_token)).statusCode).toBe(404);
      expect((await preview(own.link_token)).statusCode).toBe(404);
    });

    it("an owner turns an adult's paused link back on", async () => {
      const link = await samsLinkAfterRestore("Sam's accountant");
      expect(await pausedFor(owner)).toContain(link.share.id);

      const back = await resume(owner, link.share.id);
      expect(back.statusCode).toBe(200);
      expect(json<ShareView>(back)).toMatchObject({ state: 'active', paused_at: null });
      expect((await preview(link.link_token)).statusCode).toBe(200);
      expect((await auditOf(link.share.id)).map((a) => a.action)).toContain('share.resumed');
      // Once on, there is nothing more to turn on.
      expect((await resume(owner, link.share.id)).statusCode).toBe(404);
      expect(await pausedFor(owner)).not.toContain(link.share.id);
    });

    it('no one but an owner turns a paused link back on, even the maker of a link to their own Only me document', async () => {
      const diary = await make("Sam's diary", 'private', sam);
      const link = json<CreatedShare>(await share(diary, { recipient_label: 'the GP' }, sam));
      expect(link.share.state).toBe('active');
      await restoredFromBefore(link.share.id);
      expect((await preview(link.link_token)).statusCode).toBe(404);

      // The owner cannot see the document, so the link is not theirs to list.
      expect(await pausedFor(owner)).not.toContain(link.share.id);
      expect((await resume(owner, link.share.id)).statusCode).toBe(404);

      // Nor is it Sam's to decide (A55): every link waits for an owner. So
      // this one stays paused; if it is still wanted, he makes a new one.
      const refused = await resume(sam, link.share.id);
      expect(refused.statusCode).toBe(403);
      expect(code(refused)).toBe('forbidden');
      expect((await linkRow(link.share.id)).paused_at).not.toBeNull();
      expect((await preview(link.link_token)).statusCode).toBe(404);
      expect((await unlock(link.link_token)).statusCode).toBe(404);
      expect((await auditOf(link.share.id)).map((a) => a.action)).not.toContain('share.resumed');
    });

    it('making a document Only me after a restore does not let its maker turn the link back on', async () => {
      // An owner takes back Sam's link to a household document, and a
      // restore from before then brings it back, paused.
      const policy = await make('Car insurance policy', 'household', sam);
      const link = json<CreatedShare>(await share(policy, { recipient_label: 'the garage' }, sam));
      expect((await takeBack(owner, link.share.id)).statusCode).toBe(204);
      await restoredFromBefore(link.share.id);
      expect(await pausedFor(owner)).toContain(link.share.id);

      // Sam makes the document his, then Only me: no owner can see it now.
      const his = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/documents/${policy}`,
        headers: h.as(sam),
        payload: { owner_member_id: sam.member_id },
      });
      expect(his.statusCode, his.body).toBe(200);
      const onlyHis = await setVisibility(sam, policy, 'private');
      expect(onlyHis.statusCode, onlyHis.body).toBe(200);
      expect(await sees(owner, policy)).toBe(false);
      expect(await pausedFor(owner)).not.toContain(link.share.id);

      // That does not make the link his to turn back on.
      const refused = await resume(sam, link.share.id);
      expect(refused.statusCode).toBe(403);
      expect(code(refused)).toBe('forbidden');
      expect((await linkRow(link.share.id)).paused_at).not.toBeNull();

      // Put back for the household, the leaked link still does not work:
      // it waits for an owner, as it did before.
      const shared = await setVisibility(sam, policy, 'household');
      expect(shared.statusCode, shared.body).toBe(200);
      expect((await preview(link.link_token)).statusCode).toBe(404);
      expect((await unlock(link.link_token)).statusCode).toBe(404);
      expect(await pausedFor(owner)).toContain(link.share.id);
      expect((await auditOf(link.share.id)).map((a) => a.action)).not.toContain('share.resumed');
    });
  });

  describe('until a date and time, view or download, so many opens (5.18)', () => {
    it('the fifth open works and the sixth is refused, also when both arrive together', async () => {
      const created = await made(lease, { max_opens: 5, recipient_label: 'five opens' });
      const t = created.link_token;
      expect(json<ShareLinkPreview>(await preview(t)).opens_left).toBe(5);
      for (let i = 0; i < 4; i += 1) await opened(t);
      expect(json<ShareLinkPreview>(await preview(t)).opens_left).toBe(1);

      // The fifth and the sixth at the same moment: one opens, one is told.
      const both = await Promise.all([unlock(t), unlock(t)]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 410]);
      const refused = both.find((r) => r.statusCode === 410) as LightMyRequestResponse;
      expect(code(refused)).toBe('link_used_up');
      expect(refused.body).toMatch(/opened as many times as it allows/);
      expect(cookieOf(refused)).toBeUndefined();
      expect((await linkRow(created.share.id)).open_count).toBe(5);

      // After it, the same, and the page's preview says so before Open.
      for (const res of [await unlock(t), await preview(t)]) {
        expect(res.statusCode).toBe(410);
        expect(code(res)).toBe('link_used_up');
      }
      expect((await linkRow(created.share.id)).open_count).toBe(5);
      expect(
        (await auditOf(created.share.id)).filter((a) => a.action === 'share.opened'),
      ).toHaveLength(5);
      const listed = json<{ items: ShareView[] }>(
        await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
      ).items.find((s) => s.id === created.share.id) as ShareView;
      expect(listed).toMatchObject({ state: 'used_up', open_count: 5, max_opens: 5 });
      expect(listed.summary).toMatch(
        /opened 5 of 5 times.*\. Used up: it cannot be opened again\.$/,
      );

      // Twelve at once on a link with five: five open, however they race.
      const crowd = await made(lease, { max_opens: 5, with_pin: true });
      const tries = await Promise.all(
        Array.from({ length: 12 }, () => unlock(crowd.link_token, crowd.pin)),
      );
      expect(tries.filter((r) => r.statusCode === 200)).toHaveLength(5);
      expect(tries.filter((r) => r.statusCode === 410)).toHaveLength(7);
      // A right PIN gives its try back; one refused as used up tried none.
      expect(await linkRow(crowd.share.id)).toMatchObject({ open_count: 5, attempts: 0 });
    }, 60_000);

    it('a reload inside a session is free', async () => {
      const created = await made(lease, { max_opens: 1, max_downloads: 1 });
      const { res, cookie } = await opened(created.link_token);
      expect(json<SharedSession>(res)).toMatchObject({ permission: 'download', downloads_left: 1 });
      for (let i = 0; i < 3; i += 1) {
        expect((await items(cookie)).statusCode).toBe(200);
        expect((await content(cookie, lease)).statusCode).toBe(200);
      }
      // One Open, one download, however often the page was reloaded or the
      // file fetched again; and one line each in the activity log.
      expect(await linkRow(created.share.id)).toMatchObject({ open_count: 1, downloads_used: 1 });
      expect((await auditOf(created.share.id)).map((a) => a.action)).toEqual([
        'share.created',
        'share.opened',
        'share.downloaded',
      ]);
      // Its one open used, the page opened with it still works to its end;
      // nobody else gets in.
      expect(json<SharedSession>(await items(cookie)).downloads_left).toBe(0);
      expect((await content(cookie, lease)).statusCode).toBe(200);
      expect(code(await unlock(created.link_token))).toBe('link_used_up');
    });

    it('a view-only link never gives the original, by any route', async () => {
      const doc = await make('Settlement agreement', 'household');
      await drawnAlready(doc, 2);
      const created = await made(doc, { permission: 'view', recipient_label: 'the mediator' });
      expect(created.share).toMatchObject({ permission: 'view', max_downloads: null });
      // Asked of the worker as it was made, for the link and its version:
      // asked as often as it may be, one key, so the queue draws it once.
      const v1 = (await newestOf(doc)).id;
      const asked = jobsFor('share.pages', created.share.id);
      expect(asked.length).toBeGreaterThan(0);
      for (const job of asked) {
        expect(job).toEqual({
          name: 'share.pages',
          data: { household_id: owner.household_id, share_id: created.share.id, version_id: v1 },
          options: { singletonKey: `share-pages:${created.share.id}:${v1}`, priority: 10 },
        });
      }
      await drawAsWorker(created.share.id, doc, 2);

      const shown = json<ShareLinkPreview>(await preview(created.link_token));
      expect(shown).toMatchObject({ permission: 'view', opens_left: null });
      const { res, cookie } = await opened(created.link_token);
      const session = json<SharedSession>(res);
      expect(session).toMatchObject({ permission: 'view', downloads_left: null });
      expect(session.items[0]?.pages).toEqual({ state: 'ready', shown: 2, total: 2 });

      // Its pages: the ones drawn for it, never the vault's own previews.
      for (const n of [1, 2, 1]) {
        const res = await page(cookie, doc, n);
        expect(res.statusCode, `page ${n}`).toBe(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(res.rawPayload.equals(marked(created.share.id, n))).toBe(true);
        expect(res.rawPayload.equals(OWN)).toBe(false);
        expect(res.rawPayload.includes(Buffer.from('%PDF'))).toBe(false);
      }
      expect((await page(cookie, doc, 3)).statusCode).toBe(404);

      // Not the file inside the session ...
      const file = await content(cookie, doc);
      expect(file.statusCode).toBe(403);
      expect(code(file)).toBe('view_only');
      expect(file.rawPayload.includes(Buffer.from('%PDF'))).toBe(false);
      // ... nor on the old routes, which do not know its token ...
      for (const res of [
        await legacyPreview(created.link_token),
        await legacyOpen(created.link_token),
        await legacyContent(created.link_token),
      ]) {
        expect(res.statusCode).toBe(404);
        expect(res.rawPayload.includes(Buffer.from('%PDF'))).toBe(false);
      }
      // ... nor the family's own, which need a sign-in, whatever cookie comes.
      const v = await newestOf(doc);
      for (const url of [
        `/api/v1/versions/${v.id}/content`,
        `/api/v1/versions/${v.id}/pages/1`,
        `/api/v1/documents/${doc}`,
      ]) {
        const res = await h.app.inject({ url, cookies: { fdv_share: cookie }, ...peer() });
        expect(res.statusCode, url).toBe(401);
      }
      // A link cannot make itself one to download either: that is the sharer's.
      await expect(
        withScopeOfLink(created.share.id, (trx) =>
          trx
            .updateTable('share_link')
            .set({ permission: 'download' })
            .where('id', '=', created.share.id)
            .execute(),
        ),
      ).rejects.toThrow(/only count its opens|row-level security/);

      // Looked at twice, written down once; nothing was downloaded.
      expect((await auditOf(created.share.id)).map((a) => a.action)).toEqual([
        'share.created',
        'share.opened',
        'share.viewed',
      ]);
      expect((await linkRow(created.share.id)).downloads_used).toBe(0);

      // A link to download has no pages to give.
      const whole = await made(doc);
      const other = await opened(whole.link_token);
      expect(code(await page(other.cookie, doc, 1))).toBe('no_preview');

      // Taken back, its pages go: the worker is asked to remove them.
      await takeBack(owner, created.share.id);
      expect(jobsFor('share.pages.prune', created.share.id)).toHaveLength(1);
    });

    it('a download counts once per session', async () => {
      const created = await made(lease, { max_downloads: 2, recipient_label: 'two downloads' });
      const first = await opened(created.link_token);
      for (let i = 0; i < 3; i += 1) {
        expect((await content(first.cookie, lease)).statusCode).toBe(200);
      }
      expect((await linkRow(created.share.id)).downloads_used).toBe(1);

      const second = await opened(created.link_token);
      // Two requests of one session at once still count one.
      const pair = await Promise.all([
        content(second.cookie, lease),
        content(second.cookie, lease),
      ]);
      expect(pair.map((r) => r.statusCode)).toEqual([200, 200]);
      expect((await linkRow(created.share.id)).downloads_used).toBe(2);

      // A third session finds none left, and is told so.
      const third = await opened(created.link_token);
      expect(json<SharedSession>(third.res).downloads_left).toBe(0);
      const refused = await content(third.cookie, lease);
      expect(refused.statusCode).toBe(403);
      expect(code(refused)).toBe('downloads_used_up');
      expect(refused.rawPayload.includes(Buffer.from('%PDF'))).toBe(false);
      // Refused is not counted, nor half-noted: it is refused again.
      expect(code(await content(third.cookie, lease))).toBe('downloads_used_up');
      expect((await linkRow(created.share.id)).downloads_used).toBe(2);
      // The sessions that downloaded may still, free.
      expect((await content(first.cookie, lease)).statusCode).toBe(200);

      expect(
        (await auditOf(created.share.id)).filter((a) => a.action === 'share.downloaded'),
      ).toHaveLength(2);
      const listed = json<{ items: ShareView[] }>(
        await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
      ).items.find((s) => s.id === created.share.id) as ShareView;
      expect(listed).toMatchObject({ downloads_used: 2, max_downloads: 2, open_count: 3 });
      expect(listed.summary).toMatch(/opened 3 times; 2 of 2 downloads/);
    });

    it('a 42-page document: the sharer is told, and the recipient gets 30 pages and the sentence', async () => {
      const long = await make('Mortgage offer', 'household');
      await drawnAlready(long, 30, 42);
      const created = await made(long, { permission: 'view' });
      // Told as it is made: the first 30 of 42, being drawn.
      expect(created.share.pages).toEqual({ state: 'drawing', shown: 30, total: 42 });
      expect(sharePagesNote(created.share.pages)).toMatch(
        /^They will see the first 30 of 42 pages\. The pages are still being drawn/,
      );
      await drawAsWorker(created.share.id, long, 30);
      const listed = json<{ items: ShareView[] }>(
        await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
      ).items.find((s) => s.id === created.share.id) as ShareView;
      expect(listed.pages).toEqual({ state: 'ready', shown: 30, total: 42 });
      expect(sharePagesNote(listed.pages)).toBe('They will see the first 30 of 42 pages.');

      const { res, cookie } = await opened(created.link_token);
      const pages = json<SharedSession>(res).items[0]?.pages;
      expect(pages).toEqual({ state: 'ready', shown: 30, total: 42 });
      expect(pagesNotSharedNote(pages)).toBe('Pages after 30 were not shared.');
      expect((await page(cookie, long, 30)).statusCode).toBe(200);
      const past = await page(cookie, long, 31);
      expect(past.statusCode).toBe(404);
      expect(code(past)).toBe('no_preview');
      expect(past.body).toMatch(/Pages after 30 were not shared/);
    });

    it('a link made before the previews are ready says so, then works', async () => {
      // Just added: nothing drawn yet, not even the vault's own pages.
      const fresh = await make('Just scanned', 'household');
      expect((await newestOf(fresh)).preview_state).toBe('none');
      const created = await made(fresh, { permission: 'view' });
      expect(created.share.pages?.state).toBe('drawing');
      expect(sharePagesNote(created.share.pages)).toMatch(
        /The pages are still being drawn; the link works in a minute\./,
      );
      const asked = jobsFor('share.pages', created.share.id).length;
      expect(asked).toBeGreaterThan(0);

      // Opened meanwhile: the page says so, and asks the worker again.
      const { res, cookie } = await opened(created.link_token);
      expect(json<SharedSession>(res).items[0]?.pages?.state).toBe('drawing');
      const waiting = await page(cookie, fresh, 1);
      expect(waiting.statusCode).toBe(404);
      expect(code(waiting)).toBe('preview_pending');
      expect(json<{ error: { retriable: boolean } }>(waiting).error.retriable).toBe(true);
      expect(waiting.headers['retry-after']).toBe('3');
      expect(jobsFor('share.pages', created.share.id).length).toBeGreaterThan(asked);

      // The worker draws them (its own and then the link's), and it works.
      await drawnAlready(fresh, 1);
      await drawAsWorker(created.share.id, fresh, 1);
      expect(json<SharedSession>(await items(cookie)).items[0]?.pages).toEqual({
        state: 'ready',
        shown: 1,
        total: 1,
      });
      const shown = await page(cookie, fresh, 1);
      expect(shown.statusCode).toBe(200);
      expect(shown.rawPayload.equals(marked(created.share.id, 1))).toBe(true);
    });

    it('an expiry in the past or under 5 minutes is refused', async () => {
      const at = (ms: number) => new Date(Date.now() + ms).toISOString();
      for (const [when, words] of [
        [at(-60_000), /at least 5 minutes from now/],
        [at(4 * 60_000), /at least 5 minutes from now/],
        [at(91 * 864e5), /90 days at most/],
      ] as const) {
        const res = await share(lease, { expires_at: when });
        expect(res.statusCode, when).toBe(422);
        expect(code(res), when).toBe('expiry_out_of_range');
        expect(res.body, when).toMatch(words);
      }
      // One end, said once.
      const both = await share(lease, { expires_at: at(864e5), expires_in_days: 2 });
      expect(code(both)).toBe('validation_failed');
      expect(code(await share(lease, { expires_at: 'Friday at five' }))).toBe('validation_failed');

      // Six minutes is enough, and the page opened with it ends when it does.
      const end = at(6 * 60_000);
      const soon = await made(lease, { expires_at: end });
      expect(soon.share.expires_at).toBe(end);
      const { res } = await opened(soon.link_token);
      expect(cookieOf(res)?.maxAge).toBeLessThanOrEqual(360);
      expect(json<SharedSession>(res).session_expires_at).toBe(end);
      // An end given with an offset is the same moment.
      const friday = new Date(Date.now() + 3 * 864e5);
      friday.setUTCSeconds(0, 0);
      const local = `${friday.toISOString().slice(0, 16)}:00+00:00`;
      expect((await made(lease, { expires_at: local })).share.expires_at).toBe(
        friday.toISOString(),
      );
    });

    it("under a limit shorter than a week, the default and an older client's days are cut to it, and the limit is said (5.18 review)", async () => {
      const short = await createHarness({ shareMaxDays: 3 });
      try {
        const who = await short.setup();
        const res = await short.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: short.as(who),
          payload: { title: 'Short-lived', visibility: 'household' },
        });
        const doc = res.json<DocumentView>().id;
        const form = new FormData();
        form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
        await short.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${doc}/versions`,
          headers: { ...short.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
          payload: form.getBuffer(),
        });
        const ask = (payload: Record<string, unknown>) =>
          short.app.inject({
            method: 'POST',
            url: `/api/v1/documents/${doc}/share`,
            headers: short.as(who),
            payload,
          });
        // Said in the capability document, for a client to offer only what
        // the vault takes.
        const caps = await short.app.inject({ url: '/api/v1/capabilities' });
        expect(caps.json<{ limits: { share_max_days: number } }>().limits.share_max_days).toBe(3);
        // Nothing said (the API's default, a week) and an older client's
        // seven days both make a link, to the longest the vault allows.
        for (const payload of [{}, { recipient_label: 'the agent' }, { expires_in_days: 7 }]) {
          const before = Date.now();
          const res = await ask(payload);
          expect(res.statusCode, JSON.stringify(payload)).toBe(201);
          const end = Date.parse(res.json<CreatedShare>().share.expires_at);
          expect(end, JSON.stringify(payload)).toBeGreaterThanOrEqual(before + 3 * 864e5);
          expect(end, JSON.stringify(payload)).toBeLessThanOrEqual(Date.now() + 3 * 864e5);
        }
        // A client that says a date and time knows the limit: past it is refused.
        const refused = await ask({ expires_at: new Date(Date.now() + 4 * 864e5).toISOString() });
        expect(refused.statusCode).toBe(422);
        expect(code(refused)).toBe('expiry_out_of_range');
        expect(refused.body).toMatch(/3 days at most/);
      } finally {
        await short.close();
      }
    }, 60_000);

    it('expires_in_days still works', async () => {
      const before = Date.now();
      const three = await made(lease, { expires_in_days: 3 });
      const end = Date.parse(three.share.expires_at);
      expect(end).toBeGreaterThanOrEqual(before + 3 * 864e5);
      expect(end).toBeLessThan(Date.now() + 3 * 864e5 + 1000);
      // Nothing said: a week, as always.
      const week = Date.parse((await made(lease)).share.expires_at);
      expect(week).toBeGreaterThanOrEqual(before + 7 * 864e5);
      expect(week).toBeLessThan(Date.now() + 7 * 864e5 + 1000);
      expect(code(await share(lease, { expires_in_days: 91 }))).toBe('validation_failed');
    });

    it('a Word file cannot be shared view-only', async () => {
      const notes = await make('Tenancy notes', 'household');
      const v = await newestOf(notes);
      await withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('document_version')
          .set({
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            filename: 'notes.docx',
          })
          .where('id', '=', v.id)
          .execute(),
      );
      const refused = await share(notes, { permission: 'view' });
      expect(refused.statusCode).toBe(422);
      expect(code(refused)).toBe('view_not_possible');
      expect(refused.body).toMatch(/Word and Excel files can only be shared to download/);
      // To download, as always.
      const whole = await share(notes, { permission: 'download' });
      expect(whole.statusCode).toBe(201);
      // And a link to view has nothing to download.
      const muddled = await share(lease, { permission: 'view', max_downloads: 2 });
      expect(code(muddled)).toBe('validation_failed');
    });

    it('a newer version is drawn again for a page that only asks what is open (5.18 review)', async () => {
      const doc = await make('Lease, unsigned', 'household');
      await drawnAlready(doc, 1);
      const created = await made(doc, { permission: 'view', recipient_label: 'the tenant' });
      await drawAsWorker(created.share.id, doc, 1);
      const { cookie } = await opened(created.link_token);
      const v1 = (await newestOf(doc)).id;

      // The signed copy is added, and its own pages drawn.
      const form = new FormData();
      form.append('file', PDF, { filename: 'signed.pdf', contentType: 'application/pdf' });
      const added = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc}/versions`,
        headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
      expect(added.statusCode, added.body).toBe(201);
      await drawnAlready(doc, 1);
      const v2 = (await newestOf(doc)).id;
      expect(v2).not.toBe(v1);

      // The recipient's page asks only what is open, as it does while it
      // waits: that alone asks the worker for the new version's pages.
      const forV2 = () =>
        jobsFor('share.pages', created.share.id).filter((j) => j.data.version_id === v2);
      expect(forV2()).toEqual([]);
      const polled = json<SharedSession>(await items(cookie));
      expect(polled.items[0]?.pages?.state).toBe('drawing');
      expect(forV2()).toEqual([
        {
          name: 'share.pages',
          data: { household_id: owner.household_id, share_id: created.share.id, version_id: v2 },
          options: { singletonKey: `share-pages:${created.share.id}:${v2}`, priority: 10 },
        },
      ]);
      // And so do the page before Open, and the family's own list.
      await preview(created.link_token);
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) });
      expect(forV2()).toHaveLength(3);
      // Drawn, the page shows them.
      await drawAsWorker(created.share.id, doc, 1);
      expect(json<SharedSession>(await items(cookie)).items[0]?.pages?.state).toBe('ready');
    });

    it('pages the worker could not draw are said to both ends, and not asked for again (5.18 review)', async () => {
      const doc = await make('Scanned badly', 'household');
      await drawnAlready(doc, 1);
      const created = await made(doc, { permission: 'view' });
      const { cookie } = await opened(created.link_token);
      // The worker's last try failed, for this version.
      await withSystem(h.db, owner.household_id, async (trx) =>
        trx
          .updateTable('share_link')
          .set({ pages_failed_version: (await newestOf(doc)).id })
          .where('id', '=', created.share.id)
          .execute(),
      );
      const before = jobsFor('share.pages', created.share.id).length;
      expect(json<SharedSession>(await items(cookie)).items[0]?.pages?.state).toBe('failed');
      const listed = json<{ items: ShareView[] }>(
        await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
      ).items.find((s) => s.id === created.share.id);
      expect(listed?.pages?.state).toBe('failed');
      expect(sharePagesNote(listed?.pages)).toMatch(/could not draw the pages/);
      expect(code(await page(cookie, doc, 1))).toBe('no_preview');
      expect(jobsFor('share.pages', created.share.id)).toHaveLength(before);
      // A link cannot clear it for itself.
      await expect(
        withScopeOfLink(created.share.id, (trx) =>
          trx
            .updateTable('share_link')
            .set({ pages_failed_version: null })
            .where('id', '=', created.share.id)
            .execute(),
        ),
      ).rejects.toThrow(/only count its opens|row-level security/);
    });

    it('a document this page has downloaded stays downloadable here once downloads are used up (5.18 review)', async () => {
      const created = await made(lease, { max_downloads: 1 });
      const { res, cookie } = await opened(created.link_token);
      expect(json<SharedSession>(res).items[0]?.downloaded).toBe(false);
      expect((await content(cookie, lease)).statusCode).toBe(200);
      // Reloaded: none left for anybody, and this page may have it again.
      const after = json<SharedSession>(await items(cookie));
      expect(after.downloads_left).toBe(0);
      expect(after.items[0]?.downloaded).toBe(true);
      expect((await content(cookie, lease)).statusCode).toBe(200);
      // Another page opened with it has had nothing, and is refused.
      const other = await opened(created.link_token);
      expect(json<SharedSession>(other.res).items[0]?.downloaded).toBe(false);
      expect(code(await content(other.cookie, lease))).toBe('downloads_used_up');
    });

    it('turned back on after a restore, a view-only link has its pages drawn again', async () => {
      const doc = await make('Restored lease', 'household');
      await drawnAlready(doc, 1);
      const created = await made(doc, { permission: 'view' });
      await drawAsWorker(created.share.id, doc, 1);
      await restoredFromBefore(created.share.id);
      expect((await resume(owner, created.share.id)).statusCode).toBe(200);
      expect(jobsFor('share.pages', created.share.id).at(-1)?.data).toEqual({
        household_id: owner.household_id,
        share_id: created.share.id,
        version_id: (await newestOf(doc)).id,
        redraw: true,
      });
      // A page whose file is gone since is drawn again rather than broken.
      await rmPages(doc, created.share.id);
      const { cookie } = await opened(created.link_token);
      expect(code(await page(cookie, doc, 1))).toBe('preview_pending');
    });
  });

  it('a link nobody made is refused, and a token is not a document id', async () => {
    expect((await preview('a'.repeat(43))).statusCode).toBe(404);
    expect((await legacyPreview('a'.repeat(43))).statusCode).toBe(404);
    // The document's own id, offered as a link secret, is not one.
    expect((await preview(lease)).statusCode).toBe(404);
    expect((await legacyPreview(lease)).statusCode).toBe(404);
  });

  it('a viewer cannot share, and a teen cannot either', async () => {
    const viewer = await h.join(owner, {
      name: 'Accountant',
      email: 'acc@example.test',
      role: 'viewer',
    });
    const teen = await h.join(owner, { name: 'Kid', email: 'kid@example.test', role: 'teen' });
    for (const who of [viewer, teen]) {
      const res = await share(lease, {}, who);
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('forbidden');
    }
    // Nor do they see who else's documents went where (0.5.0): the owner's
    // link to a document they can both see is not in their list.
    expect((await made(lease, { recipient_label: 'the letting agent' })).share.id).toBeTruthy();
    for (const who of [viewer, teen]) {
      const list = await h.app.inject({ url: '/api/v1/shares', headers: h.as(who) });
      expect(list.statusCode).toBe(200);
      expect(json<{ items: ShareView[] }>(list).items).toEqual([]);
      expect(
        json<{ links: ShareView[] }>(
          await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(who) }),
        ).links,
      ).toEqual([]);
    }
  });

  it("another adult cannot share somebody else's private document, or even see the link", async () => {
    // The owner may share their own private document: it is theirs.
    const mine = await made(privateDoc);
    expect(mine.share.document_title).toBe('Therapy notes');

    const sam = await h.join(owner, { name: 'Sam 2', email: 'sam2@example.test', role: 'adult' });
    const res = await share(privateDoc, {}, sam);
    expect(res.statusCode).toBe(404);

    // And the existing link is not in Sam's list: naming it would name a
    // document Sam cannot see.
    const theirs = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(sam) }),
    ).items;
    expect(theirs.map((s) => s.document_title)).not.toContain('Therapy notes');
    expect(
      json<{ items: ShareView[] }>(
        await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
      ).items.map((s) => s.document_title),
    ).toContain('Therapy notes');
  });

  it('a document with no file on it cannot be shared', async () => {
    const empty = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Nothing here yet' },
    });
    const res = await share(empty.json<DocumentView>().id);
    expect(res.statusCode).toBe(422);
    expect(code(res)).toBe('nothing_to_share');
  });

  it('every open is in the audit chain, under a label and not a person', async () => {
    const rows = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'actor_account_id', 'actor_label', 'ip'])
        .where('action', 'like', 'share.%')
        .orderBy('id')
        .execute(),
    );
    const opens = rows.filter((r) => r.action === 'share.opened');
    expect(opens.length).toBeGreaterThan(0);
    for (const o of opens) {
      expect(o.actor_account_id).toBeNull();
      expect(o.actor_label).toMatch(/^shared link/);
      // An outsider's address, cut to its network (A24).
      expect(o.ip).toMatch(/\.0\/24$/);
    }
    for (const action of ['share.created', 'share.revoked', 'share.downloaded', 'share.locked']) {
      expect(rows.map((r) => r.action)).toContain(action);
    }
  });

  it('no token or PIN appears in the request log', async () => {
    logged.length = 0;
    const created = await made(lease, { with_pin: true });
    const pin = created.pin as string;
    const wrongPin = pin === '9999' ? '1111' : '9999';
    await preview(created.link_token);
    await unlock(created.link_token, wrongPin);
    const { cookie } = await opened(created.link_token, pin);
    await items(cookie);
    await content(cookie, lease);
    await content(cookie, randomUUID());
    await items('not-a-session');
    // And a view-only link's pages (5.18), with an end at a time.
    const viewed = await made(lease, {
      with_pin: true,
      permission: 'view',
      max_opens: 2,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
    });
    await drawnAlready(lease, 1);
    await drawAsWorker(viewed.share.id, lease, 1);
    await preview(viewed.link_token);
    const inside = await opened(viewed.link_token, viewed.pin);
    await page(inside.cookie, lease, 1);
    await page(inside.cookie, lease, 2);
    await content(inside.cookie, lease);

    const text = logged.join('\n');
    // The log was written, and names the routes ...
    expect(text).toContain('/api/v1/shared/unlock');
    expect(text).toContain('/api/v1/shared/items');
    expect(text).toContain(`/api/v1/shared/items/${lease}/pages/1`);
    // ... and nothing that opens anything.
    for (const secret of [created.link_token, viewed.link_token, cookie, inside.cookie]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(sha256(cookie).toString('hex'));
    expect(text).not.toContain(sha256(inside.cookie).toString('hex'));
    expect(text).not.toContain(`"${viewed.pin}"`);
    // A PIN is four digits, which a request id or a timing could hold by
    // chance: what is looked for is a PIN as a body or a query would log it.
    for (const p of [pin, wrongPin]) {
      expect(text).not.toContain(`"${p}"`);
      expect(text).not.toContain(`=${p}`);
    }
    expect(text).not.toMatch(/secret|"pin"|pin=|fdv_share/);
  });
});
