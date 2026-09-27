import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, ShareLinkPreview, SharedSession } from '@fdv/shared';
import argon2 from 'argon2';
import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { CreatedShare, SharedDocument, SharePreview, ShareView } from './shares.js';

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

  const make = async (title: string, visibility: 'household' | 'private') => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: {
        title,
        type_key: 'utility_bill',
        visibility,
        ...(visibility === 'private' ? { owner_member_id: owner.member_id } : {}),
      },
    });
    const id = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
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
        .select(['attempts', 'open_count', 'flow', 'paused_at'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
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
    // Every combination of the options a link can have today.
    for (const withPin of [false, true]) {
      for (const label of [undefined, 'the notary']) {
        const created = await made(lease, {
          ...(withPin ? { with_pin: true } : {}),
          ...(label ? { recipient_label: label } : {}),
        });
        const t = created.link_token;
        const what = `pin ${withPin}, label ${label ?? 'none'}`;
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
  });

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

  it('a paused link opens nothing until an owner, or its maker, turns it back on', async () => {
    const adult = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
    const ownersLink = await made(lease, { recipient_label: 'the bank' });
    const samsLink = json<CreatedShare>(
      await share(lease, { recipient_label: "Sam's solicitor" }, adult),
    );
    for (const l of [ownersLink, samsLink]) {
      await setLink(l.share.id, { paused_at: new Date(), paused_reason: 'restored' });
      expect((await preview(l.link_token)).statusCode).toBe(404);
    }

    const pausedFor = async (who: Tokens) =>
      json<{ links: ShareView[] }>(
        await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(who) }),
      ).links.map((l) => l.id);
    // The owner sees both; Sam, his own.
    expect(await pausedFor(owner)).toEqual(
      expect.arrayContaining([ownersLink.share.id, samsLink.share.id]),
    );
    expect(await pausedFor(adult)).toEqual([samsLink.share.id]);

    const resume = (who: Tokens, id: string) =>
      h.app.inject({ method: 'POST', url: `/api/v1/shares/${id}/resume`, headers: h.as(who) });
    // Sam may not turn the owner's back on.
    const refused = await resume(adult, ownersLink.share.id);
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('forbidden');

    const back = await resume(adult, samsLink.share.id);
    expect(back.statusCode).toBe(200);
    expect(json<ShareView>(back)).toMatchObject({ state: 'active', paused_at: null });
    expect((await resume(owner, ownersLink.share.id)).statusCode).toBe(200);
    for (const l of [ownersLink, samsLink]) {
      expect((await preview(l.link_token)).statusCode).toBe(200);
    }
    // Once on, there is nothing more to turn on.
    expect((await resume(owner, ownersLink.share.id)).statusCode).toBe(404);
    expect(await pausedFor(owner)).not.toContain(ownersLink.share.id);
    expect((await auditOf(samsLink.share.id)).map((a) => a.action)).toContain('share.resumed');
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

    const text = logged.join('\n');
    // The log was written, and names the routes ...
    expect(text).toContain('/api/v1/shared/unlock');
    expect(text).toContain('/api/v1/shared/items');
    // ... and nothing that opens anything.
    expect(text).not.toContain(created.link_token);
    expect(text).not.toContain(cookie);
    expect(text).not.toContain(sha256(cookie).toString('hex'));
    // A PIN is four digits, which a request id or a timing could hold by
    // chance: what is looked for is a PIN as a body or a query would log it.
    for (const p of [pin, wrongPin]) {
      expect(text).not.toContain(`"${p}"`);
      expect(text).not.toContain(`=${p}`);
    }
    expect(text).not.toMatch(/secret|"pin"|pin=|fdv_share/);
  });
});
