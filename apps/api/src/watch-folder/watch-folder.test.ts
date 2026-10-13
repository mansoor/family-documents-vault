import { randomBytes } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { Capabilities, WatchFolderView, WatchNoticeView } from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The scanner folder (0.8.0, S3), in the API: offered in /capabilities only
 * while the worker has the folder set, there and writable, and said so
 * lately; an owner's setting, at the API and in the database's own rules;
 * never filling a viewer's Inbox; paused, and why; and "a scanned file
 * couldn't be added" its person's alone — what the folder adds, too.
 */
describe.skipIf(!testAdminUrl())('the scanner folder, in the API', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let other: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let nth = 0;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ahmed', email: 'ahmed@example.test', role: 'adult' });
    other = await h.join(owner, { name: 'Bea', email: 'bea@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tia', email: 'tia@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 2);
    app = createPool(h.appUrl, 1);
  }, 60_000);
  afterAll(async () => {
    await app?.end();
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    await admin.query('delete from watch_folder');
    await admin.query('delete from watch_notice');
    await admin.query('delete from watch_dir');
  });

  const call = (
    who: Tokens,
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(who),
      ...(payload ? { payload } : {}),
      remoteAddress: `10.68.${++nth >> 8}.${nth & 0xff}`,
    });
  /** The folder as the worker says it, `ago` seconds ago. */
  const said = (state: string, ago = 0, dir = '/watch') =>
    admin.query(
      `insert into watch_dir (singleton, dir, state, checked_at)
       values (true, $1, $2, now() - make_interval(secs => $3))
       on conflict (singleton) do update set dir = $1, state = $2, checked_at = now() - make_interval(secs => $3)`,
      [dir, state, ago],
    );
  const offered = async () =>
    (await h.app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json<Capabilities>()
      .features.watch_folder;
  const view = async (who: Tokens = owner) => {
    const r = await call(who, 'GET', '/api/v1/watch-folder');
    expect(r.statusCode, r.body).toBe(200);
    return r.json<WatchFolderView>();
  };

  // ------------------------------------------------------------ offered

  it('is offered only while the folder is set, there, writable, and said so lately', async () => {
    expect(await offered()).toBe(false);
    await said('ready');
    expect(await offered()).toBe(true);
    // The worker has not looked for three minutes: not running, not offered.
    await said('ready', 180);
    expect(await offered()).toBe(false);
    for (const state of ['off', 'missing', 'not_a_folder', 'not_writable']) {
      await said(state);
      expect(await offered(), state).toBe(false);
    }
    // And Settings says why, in words an owner can act on.
    await said('not_writable');
    expect((await view()).folder).toMatchObject({
      state: 'not_writable',
      dir: '/watch',
      words: expect.stringMatching(/can’t write to \/watch/) as unknown,
    });
    await said('missing');
    expect((await view()).folder.words).toMatch(/nothing there/);
    await said('off');
    expect((await view()).folder.words).toMatch(/FDV_WATCH_DIR is not set/);
    await admin.query('delete from watch_dir');
    expect((await view()).folder).toMatchObject({
      state: 'unknown',
      words: expect.stringMatching(/hasn’t looked at the scanner folder/) as unknown,
    });
    expect((await view()).available).toBe(false);
  });

  // ------------------------------------------------------------ the owners'

  it('is an owner’s to see and change: anybody else is refused', async () => {
    await said('ready');
    for (const who of [adult, other, teen, viewer]) {
      expect((await call(who, 'GET', '/api/v1/watch-folder')).statusCode).toBe(403);
      const put = await call(who, 'PUT', '/api/v1/watch-folder', {
        enabled: true,
        member_id: who.member_id,
      });
      expect(put.statusCode).toBe(403);
      expect(put.json<{ error: { message: string } }>().error.message).toMatch(/Only an owner/);
    }
    expect((await admin.query('select count(*)::int as n from watch_folder')).rows[0]).toEqual({
      n: 0,
    });
    // An owner: turned on with nobody named, it fills their own Inbox.
    const v = await view();
    expect(v).toMatchObject({ available: true, enabled: false, member_id: null, paused: null });
    expect(v.candidates.map((c) => c.display_name).sort()).toEqual([
      'Ahmed',
      'Bea',
      'Owner',
      'Tia',
    ]);
    const on = await call(owner, 'PUT', '/api/v1/watch-folder', { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<WatchFolderView>()).toMatchObject({
      enabled: true,
      member_id: owner.member_id,
      member_name: 'Owner',
    });
    // Or anybody of the family who signs in and adds documents: a teen too.
    for (const who of [adult, teen]) {
      const r = await call(owner, 'PUT', '/api/v1/watch-folder', {
        enabled: true,
        member_id: who.member_id,
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<WatchFolderView>().member_id).toBe(who.member_id);
    }
    // Never a viewer; never somebody who is nobody.
    for (const member of [viewer.member_id, '00000000-0000-4000-8000-000000000000']) {
      const r = await call(owner, 'PUT', '/api/v1/watch-folder', {
        enabled: true,
        member_id: member,
      });
      expect(r.statusCode).toBe(422);
      expect(r.json<{ error: { message: string } }>().error.message).toMatch(/not a viewer/);
    }
    expect((await view()).member_id).toBe(teen.member_id);
    // Turned on only while the folder is offered; turned off always.
    await said('missing');
    const refused = await call(owner, 'PUT', '/api/v1/watch-folder', { enabled: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('watch_folder_unavailable');
    const off = await call(owner, 'PUT', '/api/v1/watch-folder', { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json<WatchFolderView>()).toMatchObject({
      enabled: false,
      member_id: teen.member_id,
    });
    // A body it does not know is refused.
    await said('ready');
    expect(
      (await call(owner, 'PUT', '/api/v1/watch-folder', { enabled: true, paused_reason: null }))
        .statusCode,
    ).toBe(422);
  });

  /** One statement as somebody signed in, straight to the database: rows, or the error's code. */
  const asCaller = async (who: Tokens, role: string, text: string, args: unknown[] = []) => {
    const c = await app.connect();
    try {
      await c.query('begin');
      const acct = await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [who.member_id],
      );
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                set_config('app.role', $4, true)`,
        [who.household_id, acct.rows[0]?.account_id, who.member_id, role],
      );
      const r = await c.query(text, args);
      return { rows: r.rows as unknown[], count: r.rowCount ?? 0 };
    } catch (err) {
      return { code: (err as { code?: string }).code ?? 'error' };
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };

  it('is the owners’ in the database too: nobody else reads or writes it, and an owner only what is theirs', async () => {
    await admin.query(
      `insert into watch_folder (household_id, enabled, member_id, paused_reason)
       values ($1, true, $2, 'sealed')`,
      [owner.household_id, adult.member_id],
    );
    // Anybody but an owner is given nothing, and changes nothing.
    for (const [who, role] of [
      [adult, 'adult'],
      [teen, 'teen'],
      [viewer, 'viewer'],
    ] as const) {
      expect(await asCaller(who, role, 'select * from watch_folder'), role).toMatchObject({
        rows: [],
      });
      expect(
        await asCaller(who, role, 'update watch_folder set member_id = app_member()'),
        role,
      ).toMatchObject({ count: 0 });
    }
    expect(
      await asCaller(
        adult,
        'adult',
        `insert into watch_folder (household_id, enabled, member_id, updated_by)
         values (app_household(), true, app_member(), app_account())
         on conflict (household_id) do nothing`,
      ),
    ).toMatchObject({ code: '42501' });
    // An owner reads it, and changes whether it is on and whose Inbox, as themselves.
    expect(await asCaller(owner, 'owner', 'select * from watch_folder')).toMatchObject({
      rows: [expect.objectContaining({ member_id: adult.member_id })],
    });
    expect(
      await asCaller(
        owner,
        'owner',
        'update watch_folder set member_id = $1, updated_by = app_account()',
        [teen.member_id],
      ),
    ).toMatchObject({ count: 1 });
    // Never a viewer's Inbox; never what the worker says; never as somebody else.
    expect(
      await asCaller(
        owner,
        'owner',
        'update watch_folder set member_id = $1, updated_by = app_account()',
        [viewer.member_id],
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(
        owner,
        'owner',
        'update watch_folder set paused_reason = null, updated_by = app_account()',
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(owner, 'owner', 'update watch_folder set enabled = false, updated_by = null'),
    ).toMatchObject({ code: '42501' });
    // Nor makes a scanner's batch, nor a note: those are the vault's.
    const acct = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [adult.member_id],
    );
    expect(
      await asCaller(
        adult,
        'adult',
        `insert into intake_batch (household_id, created_by, member_id, watch_day, ends_at)
         values (app_household(), $1, app_member(), current_date, now() + interval '1 day')`,
        [acct.rows[0]?.account_id],
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(
        adult,
        'adult',
        `insert into watch_notice (household_id, member_id, file_name, reason)
         values (app_household(), app_member(), 'x.pdf', 'empty')`,
      ),
    ).toMatchObject({ code: '42501' });
    // The folder's state: read by the application, written by the vault's owning role alone.
    expect(
      await asCaller(owner, 'owner', `insert into watch_dir (state) values ('ready')`),
    ).toMatchObject({ code: '42501' });
  });

  // ------------------------------------------------------------ paused

  it('says when it is paused and why: as its person is now, and what only the worker can tell', async () => {
    await said('ready');
    expect(
      (
        await call(owner, 'PUT', '/api/v1/watch-folder', {
          enabled: true,
          member_id: adult.member_id,
        })
      ).statusCode,
    ).toBe(200);
    expect((await view()).paused).toBeNull();
    const signIn = (set: string) =>
      admin.query(`update account_household set ${set} where member_id = $1`, [adult.member_id]);
    await signIn("suspended_at = now(), suspend_reason = 'locked'");
    expect((await view()).paused).toEqual({
      reason: 'locked',
      words: 'Paused: Ahmed’s sign-in is locked. Scans wait in the folder until then.',
    });
    await signIn("suspend_reason = 'restored'");
    expect((await view()).paused?.reason).toBe('restored');
    await signIn('suspended_at = null, suspend_reason = null');
    await signIn("role = 'viewer'");
    expect((await view()).paused?.reason).toBe('cannot_add');
    await signIn("role = 'adult'");
    expect((await view()).paused).toBeNull();
    // What the worker said: the vault cannot open their key.
    await admin.query("update watch_folder set paused_reason = 'sealed'");
    expect((await view()).paused).toMatchObject({
      reason: 'sealed',
      words: expect.stringMatching(/can’t open Ahmed’s key/) as unknown,
    });
    // Off, it is not paused: it is off.
    await call(owner, 'PUT', '/api/v1/watch-folder', { enabled: false });
    expect((await view()).paused).toBeNull();
  });

  // ------------------------------------------------------------ the notes

  it('“a scanned file couldn’t be added” is its person’s alone, an owner’s too', async () => {
    const note = await admin.query<{ id: string }>(
      `insert into watch_notice (household_id, member_id, file_name, reason)
       values ($1, $2, 'AHMED-SCAN-77.zip', 'unsupported') returning id`,
      [owner.household_id, adult.member_id],
    );
    const id = note.rows[0]?.id as string;
    const listed = await call(adult, 'GET', '/api/v1/watch-folder/notices');
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: WatchNoticeView[] }>().items).toEqual([
      {
        id,
        file_name: 'AHMED-SCAN-77.zip',
        reason: 'unsupported',
        title: 'A scanned file couldn’t be added',
        words: expect.stringMatching(
          /^AHMED-SCAN-77\.zip was moved to the scanner folder’s rejected folder\. It isn’t a kind of file/,
        ) as unknown,
        at: expect.any(String) as unknown,
      },
    ]);
    for (const who of [owner, other, teen]) {
      const r = await call(who, 'GET', '/api/v1/watch-folder/notices');
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('AHMED-SCAN-77');
      const dismissed = await call(who, 'POST', `/api/v1/watch-folder/notices/${id}/dismiss`);
      expect(dismissed.statusCode).toBe(404);
      expect(dismissed.body).not.toContain('AHMED-SCAN-77');
    }
    expect((await call(viewer, 'GET', '/api/v1/watch-folder/notices')).statusCode).toBe(403);
    expect(
      (await call(adult, 'POST', '/api/v1/watch-folder/notices/not-an-id/dismiss')).statusCode,
    ).toBe(404);
    expect(
      (await call(adult, 'POST', `/api/v1/watch-folder/notices/${id}/dismiss`)).statusCode,
    ).toBe(204);
    expect(
      (await call(adult, 'GET', '/api/v1/watch-folder/notices')).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });

  // ------------------------------------------------------------ whose Inbox

  it('what it adds is in its person’s Inbox alone', async () => {
    const acct = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [adult.member_id],
    );
    const batch = await admin.query<{ id: string }>(
      `insert into intake_batch (household_id, created_by, member_id, name, watch_day, ends_at)
       values ($1, $2, $3, 'Scanner, 12 Oct', '2026-10-12', now() + interval '20 days') returning id`,
      [owner.household_id, acct.rows[0]?.account_id, adult.member_id],
    );
    const scope = await admin.query<{ id: string }>(
      "select id from scope_key where kind = 'member' and member_id = $1",
      [adult.member_id],
    );
    const vault = await admin.query<{ active_vault_id: string }>(
      'select active_vault_id from household where id = $1',
      [owner.household_id],
    );
    await admin.query(
      `insert into incoming_file (household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes,
                                  cipher_sha256, storage_key, vault_id, file_key_wrapped,
                                  wrapped_by_scope, scope, scan_state, read_state, received_at,
                                  submitted_at, idempotency_key)
       values ($1, $2, 'me', $3, 'received', 'AHMED-SCANNED-DEED.pdf', 'application/pdf', 1, $4, 1,
               $4, $5, $6, '\\x00', $7, 'member', 'unscanned', 'waiting', now(), now(),
               gen_random_uuid())`,
      [
        owner.household_id,
        batch.rows[0]?.id,
        adult.member_id,
        randomBytes(32),
        `${owner.household_id}/batches/x.enc`,
        vault.rows[0]?.active_vault_id,
        scope.rows[0]?.id,
      ],
    );
    const theirs = await call(adult, 'GET', '/api/v1/batches');
    expect(theirs.statusCode).toBe(200);
    const listed = theirs.json<{ items: Array<{ name: string; counts: { waiting: number } }> }>();
    expect(listed.items.map((b) => [b.name, b.counts.waiting])).toEqual([['Scanner, 12 Oct', 1]]);
    for (const who of [owner, other, teen]) {
      for (const url of [
        '/api/v1/batches',
        '/api/v1/batches/counts',
        `/api/v1/batches/${batch.rows[0]?.id}`,
      ]) {
        const r = await call(who, 'GET', url);
        expect(r.body, url).not.toContain('Scanner, 12 Oct');
        expect(r.body, url).not.toContain('AHMED-SCANNED-DEED');
        if (url.endsWith('counts')) expect(r.json<{ waiting: number }>().waiting).toBe(0);
      }
    }
  });

  // ------------------------------------------------------------ the log

  it('says in the activity log who turned it on, and for whom: to the owners and that person', async () => {
    await said('ready');
    await call(owner, 'PUT', '/api/v1/watch-folder', { enabled: true, member_id: adult.member_id });
    await call(owner, 'PUT', '/api/v1/watch-folder', { enabled: false });
    const lines = async (who: Tokens) =>
      (await call(who, 'GET', '/api/v1/audit'))
        .json<{ items: Array<{ text: string }> }>()
        .items.map((l) => l.text);
    for (const who of [owner, adult]) {
      const said = await lines(who);
      expect(said).toContain('Owner set the scanner folder to fill Ahmed’s Inbox');
      expect(said).toContain('Owner turned off the scanner folder');
    }
    expect((await lines(other)).some((t) => t.includes('scanner folder to fill'))).toBe(false);
  });
});
