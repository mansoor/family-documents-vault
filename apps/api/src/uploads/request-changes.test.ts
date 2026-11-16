import { randomUUID } from 'node:crypto';
import { deriveKey, openUploadRequestCopy, UPLOAD_REQUEST_COPY_PURPOSE } from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  ChangedUploadRequest,
  CreatedUploadRequest,
  RevealedUploadRequest,
  Tokens,
  UploadRequestInput,
  UploadRequestView,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, mailSent, TEST_MASTER, type Harness } from '../test-harness.js';

const COPY_KEY = deriveKey(TEST_MASTER, UPLOAD_REQUEST_COPY_PURPOSE);
const DAY = 864e5;
const PUBLIC_URL = 'https://share.example.test';

/**
 * A request to send documents shown again, and changed, by whoever asked
 * (0.9.0, LK; the owner's decision of 15 Nov 2026), as a share link is.
 * What none of it can be made to do: show or change anybody else's request
 * (an owner's included), show or change one that has ended, reach further
 * without confirming it's them, outlast the longest from when it was made,
 * change what it asks for or who looks at what comes in, keep a page opened
 * with an old password open, or write the link or a password down.
 */
describe.skipIf(!testAdminUrl())('a request shown again and changed (0.9.0, LK)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let adult: Tokens;
  let ownerAccount: string;
  let ip = 0;
  const addr = () => `10.86.${(++ip >> 8) & 0xff}.${ip & 0xff}`;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; message: string; action?: string } }>(r).error;
  const at = (ms: number) => new Date(ms).toISOString();

  const accountOf = async (t: Tokens) =>
    json<{ account_id: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(t) }))
      .account_id;
  const confirmed = (account: string, yes: boolean) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (yes ? 0 : 10 * 60_000)) })
        .where('account_id', '=', account)
        .execute(),
    );

  const make = async (as: Tokens, body: Partial<UploadRequestInput> = {}) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(as),
      payload: { title: 'Your tax papers', expires_at: at(Date.now() + 7 * DAY), ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<CreatedUploadRequest>();
  };
  const reveal = (who: Tokens, id: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/upload-requests/${id}/reveal`,
      headers: h.as(who),
    });
  const change = (who: Tokens, id: string, body: Record<string, unknown>, ifMatch?: string) =>
    h.app.inject({
      method: 'PATCH',
      url: `/api/v1/upload-requests/${id}`,
      headers: { ...h.as(who), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      payload: body,
      remoteAddress: addr(),
    });
  const changed = async (who: Tokens, id: string, body: Record<string, unknown>) => {
    const r = await change(who, id, body);
    expect(r.statusCode, r.body).toBe(200);
    return json<ChangedUploadRequest>(r);
  };
  const listed = async (who: Tokens) =>
    json<{ items: UploadRequestView[] }>(
      await h.app.inject({ url: '/api/v1/upload-requests', headers: h.as(who) }),
    ).items;
  const unlock = async (token: string, extra: Record<string, string> = {}) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/unlock',
      payload: { token, ...extra },
      remoteAddress: addr(),
    });
    const set = res.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
    return { res, cookie: { [set?.name as string]: set?.value as string } };
  };
  const session = (cookie: Record<string, string>) =>
    h.app.inject({ url: '/api/v1/drop/session', cookies: cookie, remoteAddress: addr() });
  const lines = (action: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['object_type', 'object_id', 'detail', 'actor_account_id'])
        .where('action', '=', action)
        .execute(),
    );
  const sealedOf = async (id: string) =>
    (
      await admin.query<{ c: Buffer | null }>(
        'select link_copy_sealed as c from upload_request where id = $1',
        [id],
      )
    ).rows[0]?.c ?? null;

  beforeAll(async () => {
    h = await createHarness({ publicUrl: PUBLIC_URL });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sana', email: 'sana-rq@example.test', role: 'adult' });
    ownerAccount = await accountOf(owner);
  }, 90_000);
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  it('keeps a sealed copy of the link and a made-up password, never a typed one', async () => {
    const made = await make(owner, { with_password: true });
    const sealed = (await sealedOf(made.request.id)) as Buffer;
    for (const plain of [made.link_token, made.password]) {
      expect(sealed.includes(Buffer.from(plain as string))).toBe(false);
    }
    expect(openUploadRequestCopy(COPY_KEY, sealed, owner.household_id, made.request.id)).toEqual({
      token: made.link_token,
      password: made.password,
    });
    expect(() =>
      openUploadRequestCopy(COPY_KEY, sealed, owner.household_id, randomUUID()),
    ).toThrow();
    const typed = await make(owner, { password: 'one I typed myself' });
    expect(
      openUploadRequestCopy(
        COPY_KEY,
        (await sealedOf(typed.request.id)) as Buffer,
        owner.household_id,
        typed.request.id,
      ),
    ).toEqual({ token: typed.link_token });
    // Nobody in the household puts a copy on a request afterwards.
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('upload_request')
          .set({ link_copy_sealed: Buffer.alloc(64) })
          .where('id', '=', made.request.id)
          .execute(),
      ),
    ).rejects.toThrow(/keeps the copy it was made with/);
  });

  it('shows whoever asked the same link and password, only after confirming it’s them', async () => {
    const made = await make(owner, { with_password: true });
    expect(made.request).toMatchObject({ revealable: true, changeable: true, version: 1 });
    await confirmed(ownerAccount, false);
    const asked = await reveal(owner, made.request.id);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'reveal_share' });
    await confirmed(ownerAccount, true);
    const shown = await reveal(owner, made.request.id);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(json<RevealedUploadRequest>(shown)).toEqual({
      link_token: made.link_token,
      link_url: `${PUBLIC_URL}/drop#${made.link_token}`,
      password: made.password,
    });
    // It opens, as the one handed over did.
    expect(
      (
        await unlock(json<RevealedUploadRequest>(shown).link_token, {
          password: made.password as string,
        })
      ).res.statusCode,
    ).toBe(200);
    const all = await lines('upload_request.revealed');
    expect(all.find((l) => l.object_id === made.request.id)).toMatchObject({
      object_type: 'upload_request',
      actor_account_id: ownerAccount,
    });
    expect(JSON.stringify(all)).not.toContain(made.link_token);
    expect(JSON.stringify(all)).not.toContain(made.password as string);
  });

  it('never shows anybody else’s request; an owner changes it but its password, an adult not at all', async () => {
    // For any adult to look at, so the owner and another adult can see it.
    const hers = await make(adult, { review_by: 'adults', with_password: true });
    const other = await h.join(owner, {
      name: 'Omar',
      email: 'omar-rq@example.test',
      role: 'adult',
    });
    await confirmed(ownerAccount, true);
    expect((await listed(owner)).find((r) => r.id === hers.request.id)).toMatchObject({
      revealable: false,
      changeable: true,
      mine: false,
    });
    for (const r of [await reveal(owner, hers.request.id), await reveal(owner, randomUUID())]) {
      expect(r.statusCode, r.body).toBe(404);
      expect(errorOf(r).code).toBe('not_found');
    }
    // An owner: its end, its limits, what it asks for in words.
    const done = await changed(owner, hers.request.id, {
      expires_at: at(Date.now() + 20 * DAY),
      title: 'Tax papers, renamed',
    });
    expect(done.request).toMatchObject({ title: 'Tax papers, renamed', mine: false });
    const all = await lines('upload_request.changed');
    expect(all.find((l) => l.object_id === hers.request.id)?.detail).toMatchObject({
      made_by: await accountOf(adult),
      reaches_further: true,
    });
    // Never its password.
    const pw = await change(owner, hers.request.id, { secret: 'none' });
    expect(pw.statusCode, pw.body).toBe(403);
    expect(errorOf(pw).code).toBe('request_secret_makers_only');
    // Another adult: nothing.
    const theirs = await change(other, hers.request.id, { recipient_label: 'mine now' });
    expect(theirs.statusCode, theirs.body).toBe(404);
  });

  it('emails a request’s link for whoever asked, in neutral words, never its password; counted, masked and written down', async () => {
    await confirmed(ownerAccount, true);
    const made = await make(owner, {
      with_password: true,
      title: 'Secret tax title',
      message: 'private words',
    });
    expect(made.request.emailable).toBe(true);
    const email = (id: string, body: Record<string, unknown>, who: Tokens = owner) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/upload-requests/${id}/email`,
        headers: h.as(who),
        payload: body,
        remoteAddress: addr(),
      });
    const before = mailSent(h).length;
    const sent = await email(made.request.id, {
      to: 'jane.smith@example.com',
      message: 'For the tax return.',
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ sent_to: 'j•••@e•••.com', sends_left: 2 });
    const [mail, ...more] = mailSent(h).slice(before);
    expect(more).toEqual([]);
    expect(mail?.to).toBe('jane.smith@example.com');
    const words = `${mail?.subject}\n${mail?.text}`;
    expect(words).toContain(`${PUBLIC_URL}/drop#${made.link_token}`);
    expect(words).toContain('For the tax return.');
    expect(words).toContain('It asks for a password');
    for (const kept of [made.password as string, 'Secret tax title', 'private words']) {
      expect(words).not.toContain(kept);
    }
    expect((await listed(owner)).find((r) => r.id === made.request.id)?.emailed_to).toBe(
      'j•••@e•••.com',
    );
    const all = await lines('upload_request.emailed');
    expect(all.find((l) => l.object_id === made.request.id)).toMatchObject({
      object_type: 'upload_request',
      actor_account_id: ownerAccount,
      detail: { to: 'j•••@e•••.com', with_message: true },
    });
    expect(JSON.stringify(all)).not.toContain('jane.smith');
    expect(JSON.stringify(all)).not.toContain(made.link_token);
    // Three a request in a day.
    for (let i = 0; i < 2; i++) {
      expect((await email(made.request.id, { to: 'jane.smith@example.com' })).statusCode).toBe(200);
    }
    const fourth = await email(made.request.id, { to: 'jane.smith@example.com' });
    expect(fourth.statusCode, fourth.body).toBe(429);
    expect(errorOf(fourth).code).toBe('email_link_limit');
    // Not an address: refused before anything else.
    expect((await email(made.request.id, { to: 'jane@' })).statusCode).toBe(422);
    // Somebody else's — an owner's included — is not there.
    const hers = await make(adult, { review_by: 'adults' });
    const theirs = await email(hers.request.id, { to: 'jane.smith@example.com' });
    expect(theirs.statusCode, theirs.body).toBe(404);
    // One made before copies were kept says so.
    const older = await make(owner);
    await admin.query('update upload_request set link_copy_sealed = null where id = $1', [
      older.request.id,
    ]);
    const noCopy = await email(older.request.id, { to: 'jane.smith@example.com' });
    expect(noCopy.statusCode, noCopy.body).toBe(409);
    expect(errorOf(noCopy).code).toBe('request_not_revealable');
    // Later than a quarter of an hour after making it, it asks who is asking.
    const later = await make(owner);
    await admin.query(
      `update upload_request set created_at = now() - interval '20 minutes' where id = $1`,
      [later.request.id],
    );
    await confirmed(ownerAccount, false);
    const asked = await email(later.request.id, { to: 'jane.smith@example.com' });
    expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'email_share' });
  });

  it('a request’s title and message change, as made, asking nobody; never in the log', async () => {
    const made = await make(owner, { message: 'The usual' });
    await confirmed(ownerAccount, false);
    const done = await changed(owner, made.request.id, {
      title: '  2025 papers  ',
      message: 'W-2 and 1099s, by Friday',
    });
    expect([...done.changed].sort()).toEqual(['message', 'title']);
    expect(done.request).toMatchObject({
      title: '2025 papers',
      message: 'W-2 and 1099s, by Friday',
    });
    expect((await change(owner, made.request.id, { title: '' })).statusCode).toBe(422);
    expect((await change(owner, made.request.id, { title: 'x'.repeat(200) })).statusCode).toBe(422);
    const all = JSON.stringify(await lines('upload_request.changed'));
    expect(all).not.toContain('2025 papers');
    expect(all).not.toContain('by Friday');
  });

  it('a request made before copies were kept stays shown once, and says so', async () => {
    const made = await make(owner);
    await admin.query('update upload_request set link_copy_sealed = null where id = $1', [
      made.request.id,
    ]);
    expect((await listed(owner)).find((r) => r.id === made.request.id)?.revealable).toBe(false);
    const r = await reveal(owner, made.request.id);
    expect(r.statusCode, r.body).toBe(409);
    expect(errorOf(r).code).toBe('request_not_revealable');
    expect(errorOf(r).message).toContain('made before the vault kept a copy');
  });

  it('an ended or used-up request is neither shown nor changed; one taken back forgets its copy', async () => {
    await confirmed(ownerAccount, true);
    const taken = await make(owner);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/upload-requests/${taken.request.id}`,
      headers: h.as(owner),
    });
    expect(await sealedOf(taken.request.id)).toBeNull();
    const used = await make(owner, { max_visits: 1 });
    await admin.query('update upload_request set visits_used = 1 where id = $1', [used.request.id]);
    const closed = await make(owner);
    await admin.query(
      `update upload_request set closed_at = now(), closed_reason = 'submitted' where id = $1`,
      [closed.request.id],
    );
    const ran = await make(owner);
    await admin.query(
      `update upload_request set expires_at = now() - interval '1 minute' where id = $1`,
      [ran.request.id],
    );
    for (const ended of [taken, used, closed, ran]) {
      expect((await listed(owner)).find((r) => r.id === ended.request.id)).toMatchObject({
        revealable: false,
        changeable: false,
      });
      const shown = await reveal(owner, ended.request.id);
      expect(shown.statusCode, shown.body).toBe(410);
      expect(errorOf(shown).code).toBe('request_ended');
      const r = await change(owner, ended.request.id, { max_visits: null });
      expect(r.statusCode, r.body).toBe(410);
      expect(errorOf(r).code).toBe('request_ended');
    }
  });

  it('narrows without asking, asks before it reaches further, and holds its longest and what was used', async () => {
    const made = await make(owner, {
      max_visits: 3,
      max_files: 5,
      max_total_bytes: 50_000_000,
      close_after_submit: true,
    });
    const createdAt = Date.parse(made.request.created_at);
    expect(Date.parse(made.request.latest_end as string)).toBe(createdAt + 90 * DAY);
    await confirmed(ownerAccount, false);
    const narrowed = await changed(owner, made.request.id, {
      recipient_label: 'Jane, accountant',
      expires_at: at(Date.now() + 3 * DAY),
      max_visits: 2,
      max_files: 4,
      max_total_bytes: 40_000_000,
      secret: 'password',
    });
    expect(narrowed.changed.sort()).toEqual(
      [
        'expires_at',
        'max_files',
        'max_total_bytes',
        'max_visits',
        'recipient_label',
        'secret',
      ].sort(),
    );
    expect(narrowed.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(narrowed.request).toMatchObject({
      recipient_label: 'Jane, accountant',
      max_visits: 2,
      protection: ['password'],
      version: 2,
    });
    for (const [what, body] of [
      ['a later end', { expires_at: at(Date.now() + 20 * DAY) }],
      ['more visits', { max_visits: 5 }],
      ['no visit limit', { max_visits: null }],
      ['more files', { max_files: 9 }],
      ['more room', { max_total_bytes: 60_000_000 }],
      ['Word and Excel too', { accept_types: 'office' }],
      ['no longer closing once sent', { close_after_submit: false }],
      ['its password taken away', { secret: 'none' }],
    ] as const) {
      const asked = await change(owner, made.request.id, body);
      expect(asked.statusCode, `${what}: ${asked.body}`).toBe(403);
      expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'change_share' });
    }
    await confirmed(ownerAccount, true);
    const widened = await changed(owner, made.request.id, {
      max_visits: null,
      accept_types: 'office',
      secret: 'none',
    });
    expect(widened.request).toMatchObject({
      max_visits: null,
      accept_types: 'office',
      protection: [],
    });
    const all = await lines('upload_request.changed');
    expect(
      all.find((l) => (l.detail as { changed: string[] }).changed.includes('accept_types')),
    ).toMatchObject({
      object_type: 'upload_request',
      object_id: made.request.id,
      detail: { reaches_further: true, protection: 'none', accept_types: 'office' },
    });
    expect(JSON.stringify(all)).not.toContain(narrowed.password as string);

    // Its longest is from when it was made; what was used already holds.
    const past = await change(owner, made.request.id, { expires_at: at(createdAt + 91 * DAY) });
    expect(past.statusCode, past.body).toBe(422);
    expect(errorOf(past).message).toContain('90 days at most from when it was made');
    await admin.query('update upload_request set visits_used = 2, files_used = 3 where id = $1', [
      made.request.id,
    ]);
    expect((await change(owner, made.request.id, { max_visits: 1 })).statusCode).toBe(422);
    expect((await change(owner, made.request.id, { max_files: 2 })).statusCode).toBe(422);
    // The things to send, who looks at what comes in, and its code are not a change's to say.
    for (const body of [
      { items: ['W-2'] },
      { review_by: 'adults' },
      { email_code: true },
      { this_device_only: true },
    ]) {
      expect((await change(owner, made.request.id, body)).statusCode).toBe(422);
    }
    // A version moved on since is refused.
    const stale = await change(owner, made.request.id, { recipient_label: 'x' }, '"1"');
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorOf(stale).code).toBe('conflict');
  });

  it('a new password ends the pages opened with the old one, and is the one shown again', async () => {
    await confirmed(ownerAccount, true);
    const made = await make(owner, { with_password: true });
    const before = await unlock(made.link_token, { password: made.password as string });
    expect(before.res.statusCode, before.res.body).toBe(200);
    expect((await session(before.cookie)).statusCode).toBe(200);
    const done = await changed(owner, made.request.id, { secret: 'password' });
    expect((await session(before.cookie)).statusCode).toBe(401);
    expect(
      (await unlock(made.link_token, { password: made.password as string })).res.statusCode,
    ).toBe(401);
    expect(
      (await unlock(made.link_token, { password: done.password as string })).res.statusCode,
    ).toBe(200);
    const shown = json<RevealedUploadRequest>(await reveal(owner, made.request.id));
    expect(shown).toMatchObject({ link_token: made.link_token, password: done.password });
  });

  it('a page held open as its password changes is refused at its next request (the LK review)', async () => {
    await confirmed(ownerAccount, true);
    const made = await make(owner, { with_password: true });
    const before = await unlock(made.link_token, { password: made.password as string });
    expect(before.res.statusCode, before.res.body).toBe(200);
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from upload_session where request_id = $1 for update', [
        made.request.id,
      ]);
      await changed(owner, made.request.id, { secret: 'password' });
      await holder.query('commit');
    } finally {
      holder.release();
    }
    const left = await admin.query<{ n: number }>(
      'select count(*)::int as n from upload_session where request_id = $1',
      [made.request.id],
    );
    expect(left.rows[0]?.n).toBe(1);
    const after = await session(before.cookie);
    expect(after.statusCode, after.body).toBe(401);
    expect(errorOf(after).code).toBe('drop_session_ended');
  });

  it('a made-up password swapped for a typed one asks who is asking; a kept copy that will not open is let go', async () => {
    const made = await make(owner, { with_password: true });
    await confirmed(ownerAccount, false);
    const asked = await change(owner, made.request.id, {
      secret: 'password',
      password: 'typed by me here',
    });
    expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'change_share' });
    await confirmed(ownerAccount, true);
    await admin.query(
      `update upload_request set link_copy_sealed = decode(repeat('ab', 64), 'hex') where id = $1`,
      [made.request.id],
    );
    const done = await changed(owner, made.request.id, { secret: 'password' });
    expect(done.password).toBeTruthy();
    expect(done.request.revealable).toBe(false);
    expect(await sealedOf(made.request.id)).toBeNull();
  });
});
