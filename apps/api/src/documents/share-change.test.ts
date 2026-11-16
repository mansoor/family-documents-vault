import { randomUUID } from 'node:crypto';
import { deriveKey, openShareLinkCopy, SHARE_LINK_COPY_PURPOSE } from '@fdv/crypto';
import { createPool, withPrincipal, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { ChangedShare, CollectionDetail, DocumentView, RevealedShare } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import type { CreatedShare, ShareView } from './shares.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const COPY_KEY = deriveKey(TEST_MASTER, SHARE_LINK_COPY_PURPOSE);
const DAY = 864e5;

/**
 * A link changed after it is made (0.9.0, LK; the owner's decision of 15 Nov
 * 2026): its properties, by whoever made it, while it works. What matters is
 * what none of it can be made to do: change anybody else's link (an owner's
 * included), reach further without confirming it's them, outlast the
 * longest a link may last from when it was made, bring an ended link back,
 * change what it is to, keep a page opened with an old PIN open, or write a
 * PIN or a password into the activity log.
 */
describe.skipIf(!testAdminUrl())('a share link changed by whoever made it (0.9.0, LK)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let ownerAccount: string;
  let adultAccount: string;
  let lease: string;
  let broker: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; message: string; action?: string } }>(r).error;

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.85.${Math.floor(++nth / 200)}.${nth % 200}` });

  const accountOf = async (t: Tokens) =>
    json<{ account_id: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(t) }))
      .account_id;

  /** Whether `account` confirmed it's them a moment ago, or ten minutes ago. */
  const confirmed = (account: string, yes: boolean) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (yes ? 0 : 10 * 60_000)) })
        .where('account_id', '=', account)
        .execute(),
    );

  const make = async (title: string) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title, type_key: 'utility_bill', visibility: 'household' },
    });
    const id = json<DocumentView>(created).id;
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

  const share = async (who: Tokens, body: Record<string, unknown> = {}) => {
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/share`,
      headers: h.as(who),
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };
  const change = (who: Tokens, id: string, body: Record<string, unknown>, ifMatch?: string) =>
    h.app.inject({
      method: 'PATCH',
      url: `/api/v1/shares/${id}`,
      headers: { ...h.as(who), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      payload: body,
      ...peer(),
    });
  const changed = async (who: Tokens, id: string, body: Record<string, unknown>) => {
    const r = await change(who, id, body);
    expect(r.statusCode, r.body).toBe(200);
    return json<ChangedShare>(r);
  };
  const reveal = (who: Tokens, id: string) =>
    h.app.inject({ method: 'POST', url: `/api/v1/shares/${id}/reveal`, headers: h.as(who) });
  const listed = async (who: Tokens) =>
    json<{ items: ShareView[] }>(await h.app.inject({ url: '/api/v1/shares', headers: h.as(who) }))
      .items;
  const unlock = async (token: string, secret?: string) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: secret === undefined ? { token } : { token, secret },
      ...peer(),
    });
    return { res, cookie: res.cookies.find((c) => c.name === 'fdv_share')?.value };
  };
  const items = (cookie: string | undefined) =>
    h.app.inject({ url: '/api/v1/shared/items', cookies: { fdv_share: cookie ?? '' }, ...peer() });
  const content = (cookie: string | undefined) =>
    h.app.inject({
      url: `/api/v1/shared/items/${lease}/content`,
      cookies: { fdv_share: cookie ?? '' },
      ...peer(),
    });
  const lines = (action: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['object_type', 'object_id', 'detail', 'actor_account_id'])
        .where('action', '=', action)
        .execute(),
    );
  const at = (ms: number) => new Date(ms).toISOString();

  beforeAll(async () => {
    h = await createHarness();
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sana', email: 'sana-lk@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tariq', email: 'tariq-lk@example.test', role: 'teen' });
    ownerAccount = await accountOf(owner);
    adultAccount = await accountOf(adult);
    lease = await make('Flat 3 tenancy agreement');
    const c = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'For the broker', audience: 'everyone' },
    });
    broker = json<CollectionDetail>(c).id;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/items`,
      headers: h.as(owner),
      payload: { document_ids: [lease] },
    });
  }, 90_000);
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  it('narrows a link without asking who is asking, and says what changed — never the PIN', async () => {
    const made = await share(owner, {
      recipient_label: 'the letting agent',
      max_opens: 5,
      expires_at: at(Date.now() + 7 * DAY),
    });
    expect(made.share).toMatchObject({ changeable: true, version: 1 });
    expect(Date.parse(made.share.latest_end)).toBeCloseTo(
      Date.parse(made.share.created_at) + 90 * DAY,
      -3,
    );
    await confirmed(ownerAccount, false);
    const end = at(Date.now() + 2 * DAY);
    const done = await changed(owner, made.share.id, {
      recipient_label: 'the new agent',
      expires_at: end,
      permission: 'view',
      max_opens: 3,
      secret: 'pin',
    });
    expect(done.changed.sort()).toEqual(
      ['expires_at', 'max_opens', 'permission', 'recipient_label', 'secret'].sort(),
    );
    expect(done.pin).toMatch(/^\d{4}$/);
    expect(done.share).toMatchObject({
      recipient_label: 'the new agent',
      expires_at: end,
      permission: 'view',
      max_opens: 3,
      has_pin: true,
      protection: ['pin'],
      version: 2,
    });
    // The same again changes nothing, and moves nothing on.
    const same = await changed(owner, made.share.id, { recipient_label: 'the new agent' });
    expect(same.changed).toEqual([]);
    expect(same.share.version).toBe(2);

    const [line] = (await lines('share.changed')).filter(
      (l) => (l.detail as { share_id?: string }).share_id === made.share.id,
    );
    expect(line).toMatchObject({
      object_type: 'document',
      object_id: lease,
      actor_account_id: ownerAccount,
      detail: {
        share_id: made.share.id,
        recipient_label: 'the new agent',
        expires_at: end,
        permission: 'view',
        max_opens: 3,
        protection: 'pin',
      },
    });
    expect(line?.detail).not.toHaveProperty('reaches_further');
    expect(JSON.stringify(await lines('share.changed'))).not.toContain(`"${done.pin}"`);
  });

  it('asks who is asking before a link reaches further, each way it can', async () => {
    const base = { expires_at: at(Date.now() + 3 * DAY), max_opens: 2, with_password: true };
    const widenings: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['a later end', base, { expires_at: at(Date.now() + 10 * DAY) }],
      ['view to download', { ...base, permission: 'view' }, { permission: 'download' }],
      ['a limit raised', base, { max_opens: 4 }],
      ['a limit taken away', base, { max_opens: null }],
      ['the password taken away', base, { secret: 'none' }],
      ['a password weakened to a PIN', base, { secret: 'pin' }],
      ['its title shown', { ...base, show_title: false }, { show_title: true }],
      // A password made up for them is stronger than one typed (the LK review).
      ['a made-up password for a typed one', base, { secret: 'password', password: 'typed by me' }],
    ];
    for (const [what, made, body] of widenings) {
      const link = await share(owner, made);
      await confirmed(ownerAccount, false);
      const asked = await change(owner, link.share.id, body);
      expect(asked.statusCode, `${what}: ${asked.body}`).toBe(403);
      expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'change_share' });
      expect(errorOf(asked).message).toContain('to let a link you made reach further');
      // Nothing changed meanwhile.
      expect((await listed(owner)).find((s) => s.id === link.share.id)?.version).toBe(1);
      await confirmed(ownerAccount, true);
      const r = await change(owner, link.share.id, body);
      expect(r.statusCode, `${what}: ${r.body}`).toBe(200);
      const [line] = (await lines('share.changed')).filter(
        (l) => (l.detail as { share_id?: string }).share_id === link.share.id,
      );
      expect(line?.detail, what).toMatchObject({ reaches_further: true });
    }
    // A new PIN for a PIN, a typed password for a PIN, a made-up one for a
    // typed one: none of it reaches further.
    const pinned = await share(owner, { with_pin: true });
    await confirmed(ownerAccount, false);
    for (const body of [
      { secret: 'pin' },
      { secret: 'password', password: 'one typed by me' },
      { secret: 'password' },
    ]) {
      const r = await change(owner, pinned.share.id, body);
      expect(r.statusCode, r.body).toBe(200);
    }
  });

  it('holds every link to its longest from when it was made, its start, and the limits already used', async () => {
    await confirmed(ownerAccount, true);
    const made = await share(owner, { max_opens: 3 });
    const createdAt = Date.parse(made.share.created_at);
    const past = await change(owner, made.share.id, { expires_at: at(createdAt + 91 * DAY) });
    expect(past.statusCode, past.body).toBe(422);
    expect(errorOf(past)).toMatchObject({ code: 'expiry_out_of_range' });
    expect(errorOf(past).message).toContain('90 days at most from when it was made');
    const soon = await change(owner, made.share.id, { expires_at: at(Date.now() + 60_000) });
    expect(errorOf(soon).code).toBe('expiry_out_of_range');
    // Up to its longest — and a minute past it for a clock ahead, cut to it.
    const longest = await changed(owner, made.share.id, {
      expires_at: at(createdAt + 90 * DAY + 60_000),
    });
    expect(longest.share.expires_at).toBe(at(createdAt + 90 * DAY));

    await admin.query('update share_link set open_count = 2 where id = $1', [made.share.id]);
    const below = await change(owner, made.share.id, { max_opens: 1 });
    expect(below.statusCode, below.body).toBe(422);
    expect(errorOf(below).message).toContain('opened 2 times already');

    // A link that keeps up with its collection: 30 days from when it was made.
    const follows = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/shares`,
      headers: h.as(owner),
      payload: { document_ids: [lease], follow_collection: true },
    });
    expect(follows.statusCode, follows.body).toBe(201);
    const following = json<CreatedShare>(follows);
    const madeAt = Date.parse(following.share.created_at);
    expect(Date.parse(following.share.latest_end)).toBe(madeAt + 30 * DAY);
    const tooLong = await change(owner, following.share.id, { expires_at: at(madeAt + 31 * DAY) });
    expect(errorOf(tooLong).message).toContain('30 days at most from when it was made');
    expect(
      (await change(owner, following.share.id, { expires_at: at(madeAt + 29 * DAY) })).statusCode,
    ).toBe(200);
  });

  it('a clinician’s link stays within a day of when it was made, and to view', async () => {
    await confirmed(ownerAccount, true);
    const saved = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${owner.member_id}/emergency`,
      headers: h.as(owner),
      payload: { fields: { blood_type: 'O-' } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${owner.member_id}/emergency/links`,
      headers: h.as(owner),
      payload: { fields: ['blood_type'], expires_in_hours: 2 },
    });
    expect(r.statusCode, r.body).toBe(201);
    const link = json<CreatedShare>(r);
    const madeAt = Date.parse(link.share.created_at);
    expect(Date.parse(link.share.latest_end)).toBe(madeAt + 24 * 3_600_000);
    const tooLong = await change(owner, link.share.id, { expires_at: at(madeAt + 25 * 3_600_000) });
    expect(tooLong.statusCode, tooLong.body).toBe(422);
    expect(errorOf(tooLong).message).toContain('24 hours at most');
    const download = await change(owner, link.share.id, { permission: 'download' });
    expect(download.statusCode, download.body).toBe(422);
    const longer = await changed(owner, link.share.id, {
      expires_at: at(madeAt + 20 * 3_600_000),
      secret: 'pin',
    });
    expect(longer.share.expires_at).toBe(at(madeAt + 20 * 3_600_000));
    expect(longer.pin).toMatch(/^\d{4}$/);
  });

  it('a new PIN ends the pages opened with the old one, and showing it again shows the new one', async () => {
    await confirmed(ownerAccount, true);
    const made = await share(owner, { with_pin: true });
    const before = await unlock(made.link_token, made.pin);
    expect(before.res.statusCode, before.res.body).toBe(200);
    expect((await items(before.cookie)).statusCode).toBe(200);

    const done = await changed(owner, made.share.id, { secret: 'pin' });
    expect((await items(before.cookie)).statusCode).toBe(401);
    // The old PIN opens nothing; the new one does.
    expect((await unlock(made.link_token, made.pin)).res.statusCode).toBe(401);
    expect((await unlock(made.link_token, done.pin)).res.statusCode).toBe(200);

    const shown = await reveal(owner, made.share.id);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(json<RevealedShare>(shown)).toMatchObject({
      link_token: made.link_token,
      pin: done.pin,
    });

    // Typed by the sharer: theirs, never kept — the copy keeps the link alone.
    await changed(owner, made.share.id, { secret: 'password', password: 'typed on the day' });
    const sealed = (
      await admin.query<{ c: Buffer }>(
        'select link_copy_sealed as c from share_link where id = $1',
        [made.share.id],
      )
    ).rows[0]?.c as Buffer;
    expect(openShareLinkCopy(COPY_KEY, sealed, owner.household_id, made.share.id)).toEqual({
      token: made.link_token,
    });
    // Taken away: the link alone opens it.
    await changed(owner, made.share.id, { secret: 'none' });
    expect((await unlock(made.link_token)).res.statusCode).toBe(200);
  });

  it('download to view holds at once for a page already open; other changes leave it open', async () => {
    await confirmed(ownerAccount, true);
    const made = await share(owner);
    const open = await unlock(made.link_token);
    expect(open.res.statusCode, open.res.body).toBe(200);
    expect((await content(open.cookie)).statusCode).toBe(200);
    await changed(owner, made.share.id, { recipient_label: 'someone else', max_opens: 9 });
    expect((await items(open.cookie)).statusCode).toBe(200);
    await changed(owner, made.share.id, { permission: 'view' });
    const refused = await content(open.cookie);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused).code).toBe('view_only');
  });

  it('an adult changes nobody else’s link, nor learns one is there', async () => {
    const his = await share(owner);
    await confirmed(adultAccount, true);
    for (const id of [his.share.id, randomUUID()]) {
      const r = await change(adult, id, { expires_at: at(Date.now() + 9 * DAY) });
      expect(r.statusCode, r.body).toBe(404);
      expect(errorOf(r).code).toBe('not_found');
    }
    expect((await listed(adult)).find((s) => s.id === his.share.id)).toMatchObject({
      changeable: false,
      mine: false,
    });
    // A teen shares nothing, and changes nothing.
    expect((await change(teen, his.share.id, { recipient_label: 'x' })).statusCode).toBe(403);
    // Nor does the database let an adult change it, however asked.
    await expect(
      withPrincipal(
        h.db,
        {
          householdId: owner.household_id,
          accountId: adultAccount,
          memberId: adult.member_id,
          role: 'adult',
        },
        (trx) =>
          trx
            .updateTable('share_link')
            .set({ expires_at: new Date(Date.now() + 9 * DAY), version: 7 })
            .where('id', '=', his.share.id)
            .execute(),
      ),
    ).rejects.toThrow(/changed by whoever made it, or an owner/);
  });

  it('an owner changes somebody else’s link — reaching further after confirming it’s them — never its PIN', async () => {
    const hers = await share(adult, { with_pin: true, recipient_label: 'the agent' });
    expect((await listed(owner)).find((s) => s.id === hers.share.id)).toMatchObject({
      changeable: true,
      mine: false,
    });
    await confirmed(ownerAccount, false);
    const later = at(Date.now() + 20 * DAY);
    const asked = await change(owner, hers.share.id, { expires_at: later });
    expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'change_share' });
    await confirmed(ownerAccount, true);
    const done = await changed(owner, hers.share.id, { expires_at: later, max_opens: 3 });
    expect(done.share).toMatchObject({ expires_at: later, max_opens: 3, mine: false });
    // Still hers: her list says so, and it is hers to see again.
    expect((await listed(adult)).find((s) => s.id === hers.share.id)).toMatchObject({
      mine: true,
      revealable: true,
      created_by_name: 'Sana',
    });
    const [line] = (await lines('share.changed')).filter(
      (l) => (l.detail as { share_id?: string }).share_id === hers.share.id,
    );
    expect(line).toMatchObject({
      actor_account_id: ownerAccount,
      detail: { made_by: adultAccount, reaches_further: true },
    });
    // Its PIN is hers alone: asked before anything else.
    for (const secret of ['pin', 'password', 'none']) {
      const r = await change(owner, hers.share.id, { secret });
      expect(r.statusCode, r.body).toBe(403);
      expect(errorOf(r).code).toBe('share_secret_makers_only');
    }
    // Nor does the database let an owner give it a new one.
    await expect(
      withPrincipal(
        h.db,
        {
          householdId: owner.household_id,
          accountId: ownerAccount,
          memberId: owner.member_id,
          role: 'owner',
        },
        (trx) =>
          trx
            .updateTable('share_link')
            .set({ pin_hash: 'x', secret_kind: 'pin', version: 50, secret_version: 50 })
            .where('id', '=', hers.share.id)
            .execute(),
      ),
    ).rejects.toThrow(/keeps the protection it was made with/);
  });

  it('never brings an ended link back: taken back, run out of time, locked or used up', async () => {
    await confirmed(ownerAccount, true);
    const taken = await share(owner);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/shares/${taken.share.id}`,
      headers: h.as(owner),
    });
    const ran = await share(owner);
    await admin.query(
      `update share_link set expires_at = now() - interval '1 minute' where id = $1`,
      [ran.share.id],
    );
    const locked = await share(owner, { with_pin: true });
    await admin.query('update share_link set attempts = 10 where id = $1', [locked.share.id]);
    const used = await share(owner, { max_opens: 1 });
    await admin.query('update share_link set open_count = 1 where id = $1', [used.share.id]);
    for (const ended of [taken, ran, locked, used]) {
      expect((await listed(owner)).find((s) => s.id === ended.share.id)?.changeable).toBe(false);
      const r = await change(owner, ended.share.id, {
        expires_at: at(Date.now() + 5 * DAY),
        max_opens: null,
      });
      expect(r.statusCode, r.body).toBe(410);
      expect(errorOf(r).code).toBe('share_ended');
    }
    // Paused after a restore, it is still its maker's to change.
    const paused = await share(owner);
    await admin.query(
      `update share_link set paused_at = now(), paused_reason = 'restored' where id = $1`,
      [paused.share.id],
    );
    expect((await change(owner, paused.share.id, { recipient_label: 'paused' })).statusCode).toBe(
      200,
    );
  });

  it('a version moved on since is refused; what it is to never changes, by any route', async () => {
    await confirmed(ownerAccount, true);
    const made = await share(owner);
    const stale = await change(owner, made.share.id, { recipient_label: 'one' }, '"1"');
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.headers.etag).toBe('"2"');
    const again = await change(owner, made.share.id, { recipient_label: 'two' }, '"1"');
    expect(again.statusCode, again.body).toBe(409);
    expect(errorOf(again).code).toBe('conflict');

    // Not something a change can say.
    const other = await make('The will');
    const target = await change(owner, made.share.id, { document_id: other });
    expect(target.statusCode, target.body).toBe(422);
    const device = await change(owner, made.share.id, { this_device_only: true });
    expect(device.statusCode).toBe(422);

    // Nor the database: what it is to, and its protection, but by its maker's change.
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('share_link')
          .set({ document_id: other } as never)
          .where('id', '=', made.share.id)
          .execute(),
      ),
    ).rejects.toThrow(/keeps what it was made for/);
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('share_link')
          .set({ pin_hash: 'x', secret_kind: 'pin', version: 9 })
          .where('id', '=', made.share.id)
          .execute(),
      ),
    ).rejects.toThrow(/keeps the protection it was made with/);
  });

  it('a link made before copies were kept can change its PIN, and stays shown once', async () => {
    await confirmed(ownerAccount, true);
    const made = await share(owner, { with_pin: true });
    await admin.query('update share_link set link_copy_sealed = null where id = $1', [
      made.share.id,
    ]);
    const done = await changed(owner, made.share.id, { secret: 'pin' });
    expect(done.pin).toMatch(/^\d{4}$/);
    expect(done.share.revealable).toBe(false);
    const r = await reveal(owner, made.share.id);
    expect(errorOf(r).code).toBe('share_not_revealable');
  });

  it('a page held open as its PIN changes is refused at its next request (the LK review)', async () => {
    await confirmed(ownerAccount, true);
    const made = await share(owner, { with_pin: true });
    const open = await unlock(made.link_token, made.pin);
    expect(open.res.statusCode, open.res.body).toBe(200);
    // In use as the change is made: its row held, so the change's removal
    // of the sessions passes over it.
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from share_session where share_id = $1 for update', [
        made.share.id,
      ]);
      await changed(owner, made.share.id, { secret: 'pin' });
      await holder.query('commit');
    } finally {
      holder.release();
    }
    const left = await admin.query<{ n: number }>(
      'select count(*)::int as n from share_session where share_id = $1',
      [made.share.id],
    );
    expect(left.rows[0]?.n).toBe(1);
    const after = await items(open.cookie);
    expect(after.statusCode, after.body).toBe(401);
    expect(errorOf(after).code).toBe('share_session_ended');
  });

  it('switched to view, every document it gives must be drawable and there (the LK review)', async () => {
    await confirmed(ownerAccount, true);
    // A collection's link with a Word file in it.
    const word = await make('The spreadsheet');
    await admin.query(
      `update document_version set mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        where document_id = $1`,
      [word],
    );
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/shares`,
      headers: h.as(owner),
      payload: { document_ids: [lease] },
    });
    const col = json<CreatedShare>(r);
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/items`,
      headers: h.as(owner),
      payload: { document_ids: [word] },
    });
    await admin.query(
      `insert into share_link_item (household_id, share_id, collection_id, document_id, kind, position)
       select household_id, $1, collection_id, $2, 'ticked', 2 from share_link where id = $1`,
      [col.share.id, word],
    );
    const refused = await change(owner, col.share.id, { permission: 'view' });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorOf(refused).code).toBe('view_not_possible');
    expect(errorOf(refused).message).toContain('The spreadsheet');

    // A document whose file was removed for good.
    const gone = await make('A removed file');
    await admin.query(
      'update document_version set file_removed_at = now() where document_id = $1',
      [gone],
    );
    const link = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/share`,
      headers: h.as(owner),
      payload: {},
    });
    const doc = json<CreatedShare>(link);
    await admin.query(
      'update document_version set file_removed_at = now() where document_id = $1',
      [lease],
    );
    try {
      const removed = await change(owner, doc.share.id, { permission: 'view' });
      expect(removed.statusCode, removed.body).toBe(422);
      expect(errorOf(removed).code).toBe('file_removed');
    } finally {
      await admin.query(
        'update document_version set file_removed_at = null where document_id = $1',
        [lease],
      );
    }
  });

  it('says whether its page shows the title as it does now, a sensitive document’s hidden unless chosen', async () => {
    await confirmed(ownerAccount, true);
    const plain = await share(owner);
    expect(plain.share.show_title).toBe(true);
    // Showing what it shows already changes nothing.
    expect((await changed(owner, plain.share.id, { show_title: true })).changed).toEqual([]);
    await admin.query('update document set sensitive = true where id = $1', [lease]);
    try {
      const hidden = await share(owner, { confirm_sensitive: true });
      expect(hidden.share.show_title).toBe(false);
      await confirmed(ownerAccount, false);
      const asked = await change(owner, hidden.share.id, { show_title: true });
      expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'change_share' });
    } finally {
      await admin.query('update document set sensitive = null where id = $1', [lease]);
    }
  });

  it('an end that comes to the same once cut changes nothing; an earlier one is let through past a lowered longest', async () => {
    await confirmed(ownerAccount, true);
    const made = await share(owner);
    const createdAt = Date.parse(made.share.created_at);
    const longest = await changed(owner, made.share.id, { expires_at: at(createdAt + 90 * DAY) });
    expect(longest.share.version).toBe(2);
    const same = await changed(owner, made.share.id, {
      expires_at: at(createdAt + 90 * DAY + 60_000),
    });
    expect(same.changed).toEqual([]);
    expect(same.share.version).toBe(2);
    // Its end past its longest (as when the vault's longest is lowered):
    // an earlier one, still past it, is let through; a later one is not.
    await admin.query(
      `update share_link set expires_at = created_at + interval '95 days' where id = $1`,
      [made.share.id],
    );
    const earlier = await changed(owner, made.share.id, { expires_at: at(createdAt + 93 * DAY) });
    expect(earlier.share.expires_at).toBe(at(createdAt + 93 * DAY));
    const later = await change(owner, made.share.id, { expires_at: at(createdAt + 94 * DAY) });
    expect(errorOf(later).code).toBe('expiry_out_of_range');
    // The end it has, past the longest, sent back as it is: no change.
    const kept = await changed(owner, made.share.id, { expires_at: at(createdAt + 93 * DAY) });
    expect(kept.changed).toEqual([]);
  });

  it('a collection link unticked goes back to how one made unticked is, never hiding every title', async () => {
    await confirmed(ownerAccount, true);
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/shares`,
      headers: h.as(owner),
      payload: { document_ids: [lease] },
    });
    const col = json<CreatedShare>(r);
    const stored = async () =>
      (
        await admin.query<{ s: boolean | null }>(
          'select show_title as s from share_link where id = $1',
          [col.share.id],
        )
      ).rows[0]?.s;
    expect(await stored()).toBeNull();
    await changed(owner, col.share.id, { show_title: true });
    expect(await stored()).toBe(true);
    await changed(owner, col.share.id, { show_title: false });
    expect(await stored()).toBeNull();
  });

  it('a kept copy that will not open is let go, and the PIN still changes', async () => {
    await confirmed(ownerAccount, true);
    const made = await share(owner, { with_pin: true });
    await admin.query(
      `update share_link set link_copy_sealed = decode(repeat('ab', 64), 'hex') where id = $1`,
      [made.share.id],
    );
    const done = await changed(owner, made.share.id, { secret: 'pin' });
    expect(done.pin).toMatch(/^\d{4}$/);
    expect(done.share.revealable).toBe(false);
    const sealed = await admin.query<{ c: Buffer | null }>(
      'select link_copy_sealed as c from share_link where id = $1',
      [made.share.id],
    );
    expect(sealed.rows[0]?.c).toBeNull();
  });

  it('says so in the capabilities', async () => {
    const caps = json<{ features: Record<string, boolean> }>(
      await h.app.inject({ url: '/api/v1/capabilities' }),
    );
    expect(caps.features.link_changes).toBe(true);
  });
});
