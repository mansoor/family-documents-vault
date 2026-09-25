import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deriveKey, EncryptStream, EnvKeyProvider, ScopeKeys, unwrapKey } from '@fdv/crypto';
import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { ActivityLine, DocumentView, OfflineSet, SessionRow } from '@fdv/shared';
import { adapterFromRow } from '@fdv/storage';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * Essentials a phone may keep (0.4.13): the grant, the set, its pages, and
 * what the phone says it opened while it had no connection.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const OWNER = { email: 'owner@example.test', password: 'correct horse battery' };

describe.skipIf(!testAdminUrl())('Essentials a phone may keep', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  /** The owner's phone: a session with an installation id. */
  let phone: Tokens;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  const doc: Record<string, string> = {};
  const version: Record<string, string> = {};
  let peers = 0;
  const peer = () => ({ remoteAddress: `10.49.${peers >> 8}.${peers++ & 0xff}` });

  const make = async (
    who: Tokens,
    title: string,
    fields: {
      visibility?: 'household' | 'adults' | 'private';
      is_essential?: boolean;
      file?: boolean;
    } = {},
  ) => {
    const { file = true, ...rest } = fields;
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(who),
      payload: {
        title,
        type_key: 'passport',
        owner_member_id: who.member_id,
        is_essential: true,
        ...rest,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    doc[title] = created.json<DocumentView>().id;
    if (file) version[title] = await upload(who, title);
  };
  const upload = async (who: Tokens, title: string) => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'f.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc[title]}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    return up.json<{ id: string }>().id;
  };
  /** What the worker would leave: one drawn page. */
  const draw = (who: Tokens, versionId: string) =>
    withHousehold(h.db, who.household_id, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow();
      const vault = await trx
        .selectFrom('vault')
        .selectAll()
        .where('id', '=', v.vault_id)
        .executeTakeFirstOrThrow();
      const adapter = adapterFromRow(
        vault,
        deriveKey(TEST_MASTER, 'vault-credentials'),
        h.vaultDir,
      );
      const fileKey = unwrapKey(
        v.file_key_wrapped,
        await keys.unwrapById(trx, v.wrapped_by_scope),
        `version:${v.document_id}`,
      );
      const enc = new EncryptStream(fileKey);
      await Promise.all([
        adapter.put(`${v.storage_key}.p1.enc`, enc),
        pipeline(Readable.from([jpeg]), enc),
      ]);
      await trx
        .updateTable('document_version')
        .set({ preview_state: 'ready', preview_pages: 1 })
        .where('id', '=', v.id)
        .execute();
    });

  /** A phone: signed in with an installation id, as the app does. */
  const phoneOf = async (email: string, password: string) => {
    const res = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: {
        'x-fdv-installation': randomUUID(),
        'user-agent': 'FamilyDocumentVault/0.1.5 (Android 15; Google Pixel 8a)',
      },
      payload: { email, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  const grant = (t: Tokens, password: string, include_private?: boolean) =>
    h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/offline/grant',
      headers: h.as(t),
      payload: { password, ...(include_private !== undefined ? { include_private } : {}) },
    });
  const setOf = async (t: Tokens) => {
    const res = await h.app.inject({ url: '/api/v1/offline/essentials', headers: h.as(t) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    return res.json<OfflineSet>();
  };
  const titles = (s: OfflineSet) => s.items.map((i) => i.document.title).sort();
  const page = (t: Tokens, versionId: string, n = 1) =>
    h.app.inject({ url: `/api/v1/offline/pages/${versionId}/${n}`, headers: h.as(t) });
  const codeOf = (r: { json: () => unknown }) =>
    (r.json() as { error: { code: string; message: string } }).error;
  const audits = (who: Tokens, action: string) =>
    withHousehold(h.db, who.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .selectAll()
        .where('action', '=', action)
        .orderBy('id')
        .execute(),
    );

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Adult',
      email: 'adult@example.test',
      role: 'adult',
      password: 'adult horse battery',
    });
    teen = await h.join(owner, {
      name: 'Teen',
      email: 'teen@example.test',
      role: 'teen',
      password: 'teen horse battery',
    });
    viewer = await h.join(owner, {
      name: 'Viewer',
      email: 'viewer@example.test',
      role: 'viewer',
      password: 'viewer horse battery',
    });
    await make(owner, 'Household passport');
    await make(owner, 'Adults will', { visibility: 'adults' });
    await make(owner, 'Owner private', { visibility: 'private' });
    await make(adult, 'Adult private', { visibility: 'private' });
    await make(teen, 'Teen passport');
    await make(owner, 'Water bill', { is_essential: false });
    await make(owner, 'No file yet', { file: false });
    await make(owner, 'In the bin');
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${doc['In the bin']}`,
      headers: h.as(owner),
    });
    phone = await phoneOf(OWNER.email, OWNER.password);
  }, 120_000);
  afterAll(() => h.close());

  it('says it can', async () => {
    const caps = await h.app.inject({ url: '/api/v1/capabilities' });
    expect(caps.json<{ features: Record<string, boolean> }>().features.offline_essentials).toBe(
      true,
    );
  });

  it('without a grant, the set is empty: keep nothing', async () => {
    const s = await setOf(owner);
    expect(s).toMatchObject({ items: [], grant: null, max_offline_days: 90, truncated: false });
  });

  it('the set follows role: a teen gets only their own, a viewer nothing, an adult the adults-only ones', async () => {
    const phones = {
      adult: await phoneOf('adult@example.test', 'adult horse battery'),
      teen: await phoneOf('teen@example.test', 'teen horse battery'),
    };
    expect((await grant(phone, OWNER.password)).statusCode).toBe(200);
    expect((await grant(phones.adult, 'adult horse battery')).statusCode).toBe(200);
    expect((await grant(phones.teen, 'teen horse battery')).statusCode).toBe(200);
    expect(titles(await setOf(phone))).toEqual([
      'Adults will',
      'Household passport',
      'Teen passport',
    ]);
    expect(titles(await setOf(phones.adult))).toEqual([
      'Adults will',
      'Household passport',
      'Teen passport',
    ]);
    expect(titles(await setOf(phones.teen))).toEqual(['Teen passport']);
    expect(titles(await setOf(viewer))).toEqual([]);
    const s = await setOf(phone);
    expect(s).toMatchObject({ max_offline_days: 90, truncated: false });
    expect(s.grant).not.toBeNull();
    const item = s.items.find((i) => i.document.title === 'Household passport');
    expect(item?.version).toMatchObject({
      id: version['Household passport'],
      mime: 'application/pdf',
    });
    expect(item?.private).toBe(false);
  });

  it('the grant needs the password — and a member of the family, and the app', async () => {
    const refusedBefore = (await audits(owner, 'auth.offline_grant_refused')).length;
    const wrong = await grant(phone, 'not my password');
    expect(wrong.statusCode).toBe(401);
    expect(codeOf(wrong)).toMatchObject({
      code: 'invalid_credentials',
      message: "That password isn't right.",
    });
    // Recorded, though the answer was no.
    expect(await audits(owner, 'auth.offline_grant_refused')).toHaveLength(refusedBefore + 1);
    const viewerPhone = await phoneOf('viewer@example.test', 'viewer horse battery');
    const refused = await grant(viewerPhone, 'viewer horse battery');
    expect(refused.statusCode).toBe(403);
    expect(codeOf(refused).message).toBe(
      "People outside the family can't keep documents on a phone.",
    );
    // A browser session has no installation id: only the app keeps documents.
    expect((await grant(owner, OWNER.password)).statusCode).toBe(422);

    const ok = await grant(phone, OWNER.password);
    expect(ok.statusCode, ok.body).toBe(200);
    const g = ok.json<{ granted_at: string; expires_at: string; include_private: boolean }>();
    const days = (Date.parse(g.expires_at) - Date.parse(g.granted_at)) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(g.include_private).toBe(false);
    expect((await setOf(phone)).grant).toEqual(g);
    // The device list says so.
    const sessions = (
      await h.app.inject({ url: '/api/v1/auth/sessions', headers: h.as(owner) })
    ).json<{
      items: SessionRow[];
    }>().items;
    expect(sessions.filter((s) => s.offline)).toHaveLength(1);
  });

  it('your own Only me Essentials are in the set only with include_private', async () => {
    expect(titles(await setOf(phone))).not.toContain('Owner private');
    expect((await grant(phone, OWNER.password, true)).statusCode).toBe(200);
    const s = await setOf(phone);
    expect(titles(s)).toContain('Owner private');
    expect(s.items.find((i) => i.document.title === 'Owner private')?.private).toBe(true);
    // Never anybody else's.
    expect(titles(s)).not.toContain('Adult private');
    await grant(phone, OWNER.password, false);
  });

  it('un-marking Essential removes it from the set', async () => {
    await make(owner, 'Car insurance');
    expect(titles(await setOf(phone))).toContain('Car insurance');
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${doc['Car insurance']}`,
      headers: h.as(owner),
      payload: { is_essential: false },
    });
    expect(titles(await setOf(phone))).not.toContain('Car insurance');
  });

  it('pages without a grant ask for it, after the visibility check', async () => {
    const adultPhone = await phoneOf('adult@example.test', 'adult horse battery');
    // Somebody else's private Essential is not there at all.
    const hidden = await page(adultPhone, version['Owner private'] as string);
    const missing = await page(adultPhone, randomUUID());
    expect(hidden.statusCode).toBe(404);
    expect({ ...codeOf(hidden), request_id: 0 }).toEqual({ ...codeOf(missing), request_id: 0 });
    // One in the set, without a grant: asked for.
    const asked = await page(adultPhone, version['Household passport'] as string);
    expect(asked.statusCode).toBe(403);
    expect(codeOf(asked)).toMatchObject({
      code: 'offline_grant_required',
      message: 'Please confirm it is you to keep Essentials on this phone.',
    });
  });

  it('a grant never opens a document outside the set or an older version', async () => {
    await grant(phone, OWNER.password);
    const old = version['Household passport'] as string;
    const newer = await upload(owner, 'Household passport');
    await draw(owner, newer);
    expect((await page(phone, version['Water bill'] as string)).statusCode).toBe(404);
    expect((await page(phone, old)).statusCode).toBe(404);
    expect((await page(phone, version['In the bin'] as string)).statusCode).toBe(404);
    const ok = await page(phone, newer);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect(ok.rawPayload.equals(jpeg)).toBe(true);
    version['Household passport'] = newer;
  });

  it('a phone filling its copy is recorded once per version, not once per page', async () => {
    const v = version['Household passport'] as string;
    for (let i = 0; i < 3; i += 1) expect((await page(phone, v)).statusCode).toBe(200);
    const kept = (await audits(owner, 'document.cached_offline')).filter(
      (a) => (a.detail as { version_id: string }).version_id === v,
    );
    expect(kept).toHaveLength(1);
    // Filling is not reading: no "looked at" lines.
    expect(await audits(owner, 'document.viewed')).toHaveLength(0);
    const lines = (await h.app.inject({ url: '/api/v1/audit', headers: h.as(owner) }))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
    expect(lines).toContain('Owner’s phone kept “Household passport” for offline use');
  });

  it('opens are recorded once however often they are sent', async () => {
    const events = [
      {
        id: randomUUID(),
        version_id: version['Household passport'],
        opened_at: new Date().toISOString(),
        mode: 'view',
        online: false,
      },
      {
        id: randomUUID(),
        version_id: version['Adults will'],
        opened_at: new Date().toISOString(),
        mode: 'show',
        online: false,
      },
    ];
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/opens',
      headers: h.as(phone),
      payload: { events },
    });
    expect(first.json()).toEqual({ accepted: 2, duplicates: 0, dropped: 0 });
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/opens',
      headers: h.as(phone),
      payload: { events },
    });
    expect(again.json()).toEqual({ accepted: 0, duplicates: 2, dropped: 0 });
    expect(await audits(owner, 'document.opened_offline')).toHaveLength(2);
    const lines = (await h.app.inject({ url: '/api/v1/audit', headers: h.as(owner) }))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
    expect(lines).toContain(
      'Owner opened “Household passport” on their phone without a connection',
    );
    expect(lines).toContain('Owner showed “Adults will” from their phone without a connection');
  });

  it('the phone’s time is clamped and kept in detail; the record is dated when it arrived', async () => {
    const future = {
      id: randomUUID(),
      version_id: version['Teen passport'],
      opened_at: '2099-01-01T00:00:00Z',
      mode: 'view',
      online: true,
    };
    const past = {
      id: randomUUID(),
      version_id: version['Teen passport'],
      opened_at: '2001-01-01T00:00:00Z',
      mode: 'view',
      online: false,
    };
    const before = Date.now();
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/opens',
      headers: h.as(phone),
      payload: { events: [future, past] },
    });
    const rows = (await audits(owner, 'document.opened_offline')).slice(-2);
    const [f, p] = rows.map((r) => r.detail as { opened_at: string; event_id: string });
    expect(Date.parse(f?.opened_at as string)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(f?.opened_at as string)).toBeGreaterThanOrEqual(before - 1000);
    const ninety = before - 90 * 86_400_000;
    expect(Math.abs(Date.parse(p?.opened_at as string) - ninety)).toBeLessThan(60_000);
    for (const r of rows) expect(new Date(r.at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows.map((r) => (r.detail as { event_id: string }).event_id)).toEqual([
      future.id,
      past.id,
    ]);
  });

  it('opens about what the person cannot see are dropped, and write nothing', async () => {
    const before = (await audits(owner, 'document.opened_offline')).length;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/opens',
      headers: h.as(phone),
      payload: {
        events: [
          {
            id: randomUUID(),
            version_id: version['Adult private'],
            opened_at: new Date().toISOString(),
            mode: 'view',
            online: false,
          },
          {
            id: randomUUID(),
            version_id: randomUUID(),
            opened_at: new Date().toISOString(),
            mode: 'view',
            online: false,
          },
        ],
      },
    });
    expect(res.json()).toEqual({ accepted: 0, duplicates: 0, dropped: 2 });
    expect(await audits(owner, 'document.opened_offline')).toHaveLength(before);
    // At most 200 at a time.
    const tooMany = Array.from({ length: 201 }, () => ({
      id: randomUUID(),
      version_id: version['Household passport'],
      opened_at: new Date().toISOString(),
      mode: 'view',
      online: false,
    }));
    const refused = await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/opens',
      headers: h.as(phone),
      payload: { events: tooMany },
    });
    expect(refused.statusCode).toBe(422);
  });

  it('a grant lapses after 30 days, and never outlives its session', async () => {
    await grant(phone, OWNER.password);
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ offline_expires_at: new Date(Date.now() - 1000) })
        .where('offline_expires_at', 'is not', null)
        .execute(),
    );
    expect(await setOf(phone)).toMatchObject({ grant: null, items: [] });
    expect(codeOf(await page(phone, version['Household passport'] as string)).code).toBe(
      'offline_grant_required',
    );
    // A session with five days left gives a grant of five days.
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ absolute_expires_at: new Date(Date.now() + 5 * 86_400_000) })
        .where('installation_id', 'is not', null)
        .execute(),
    );
    const g = (await grant(phone, OWNER.password)).json<{ expires_at: string }>();
    expect(Date.parse(g.expires_at)).toBeLessThanOrEqual(Date.now() + 5 * 86_400_000 + 1000);
  });

  it('what a phone sends can never stand in for the vault’s own records', async () => {
    await grant(phone, OWNER.password);
    const v = version['Adults will'] as string;
    await draw(owner, v);
    const open = (id: string) => ({
      events: [
        { id, version_id: v, opened_at: new Date().toISOString(), mode: 'view', online: true },
      ],
    });
    // Any id at all, sent first as an open…
    const id = randomUUID();
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/opens',
      headers: h.as(phone),
      payload: open(id),
    });
    // …and filling the phone is still recorded, once.
    expect((await page(phone, v)).statusCode).toBe(200);
    expect((await page(phone, v)).statusCode).toBe(200);
    const kept = (await audits(owner, 'document.cached_offline')).filter(
      (a) => (a.detail as { version_id: string }).version_id === v,
    );
    expect(kept).toHaveLength(1);
    // Another person's ids are their own: the same id from the adult is theirs to record.
    const adultPhone = await phoneOf('adult@example.test', 'adult horse battery');
    const same = await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/opens',
      headers: h.as(adultPhone),
      payload: open(id),
    });
    expect(same.json()).toEqual({ accepted: 1, duplicates: 0, dropped: 0 });
  });

  it('a password changed on the phone ends its own grant too', async () => {
    const teenPhone = await phoneOf('teen@example.test', 'teen horse battery');
    await grant(teenPhone, 'teen horse battery');
    expect((await setOf(teenPhone)).grant).not.toBeNull();
    const changed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: h.as(teenPhone),
      payload: {
        current_password: 'teen horse battery',
        new_password: 'a newer teen horse battery',
      },
    });
    expect(changed.statusCode, changed.body).toBe(204);
    expect(await setOf(teenPhone)).toMatchObject({ grant: null, items: [] });
  });

  it('ending the grant ends it; a revoked session’s grant opens nothing', async () => {
    await grant(phone, OWNER.password);
    const end = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/offline/grant',
      headers: h.as(phone),
    });
    expect(end.statusCode).toBe(204);
    // Ended: the phone is told to keep nothing, and fills nothing more.
    expect((await setOf(phone)).items).toEqual([]);
    expect(codeOf(await page(phone, version['Household passport'] as string)).code).toBe(
      'offline_grant_required',
    );

    await grant(phone, OWNER.password);
    await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: h.as(phone),
    });
    expect((await page(phone, version['Household passport'] as string)).statusCode).toBe(401);
    expect(
      (await h.app.inject({ url: '/api/v1/offline/essentials', headers: h.as(phone) })).statusCode,
    ).toBe(401);
  });
});
