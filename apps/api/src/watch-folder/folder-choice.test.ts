import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  WATCH_KEPT_WARNING,
  WATCH_PROCESSED_FOREIGN,
  WATCH_PROCESSED_UNTOUCHED,
  type SettingsCheckView,
  type WatchFolderView,
  type WatchVerifyFound,
} from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The scanner folder chosen in Settings, and kept scans (0.9.0, O1), in
 * the API: a path only inside the roots the worker said, never one of the
 * vault's own folders nor a folder above one, refused before anything is
 * written or asked of the worker; Verify and browse asked of the worker
 * and their answers read back, the owners' alone; turned on only once the
 * worker found that very folder ready, or a Verify of it just passed; and
 * how many days scans are kept, 0 to 365, 7 by default.
 */
describe.skipIf(!testAdminUrl())('the scanner folder chosen in Settings, in the API', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let nth = 0;
  let clock = Date.now();

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000, now: () => clock });
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ahmed', email: 'ahmed-o1@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tia', email: 'tia-o1@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic-o1@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 2);
    app = createPool(h.appUrl, 1);
  }, 60_000);
  afterAll(async () => {
    await app?.end();
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    clock = Date.now();
    await admin.query('delete from watch_folder');
    await admin.query('delete from watch_dir');
    await admin.query('delete from settings_check');
    h.jobs.length = 0;
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
      remoteAddress: `10.76.${++nth >> 8}.${nth & 0xff}`,
    });
  /** The worker's word on the folders: FDV_WATCH_DIR's state, the roots, its own folders. */
  const said = (
    o: {
      state?: string;
      dir?: string | null;
      roots?: string[];
      own?: string[];
      ago?: number;
      refused?: string[];
    } = {},
  ) =>
    admin.query(
      `insert into watch_dir (singleton, dir, state, roots, own_dirs, checked_at, refused_roots)
       values (true, $1, $2, $3, $4, now() - make_interval(secs => $5), $6)
       on conflict (singleton) do update
         set dir = $1, state = $2, roots = $3, own_dirs = $4,
             checked_at = now() - make_interval(secs => $5), refused_roots = $6`,
      [
        o.dir === undefined ? '/watch' : o.dir,
        o.state ?? 'ready',
        o.roots ?? ['/watch', '/scans'],
        o.own ?? ['/data/vault', '/data/backups', '/tmp', '/app', '/srv/fdv/vault'],
        o.ago ?? 0,
        o.refused ?? [],
      ],
    );
  const view = async () => {
    const r = await call(owner, 'GET', '/api/v1/watch-folder');
    expect(r.statusCode, r.body).toBe(200);
    return r.json<WatchFolderView>();
  };
  const put = (body: Record<string, unknown>, who: Tokens = owner) =>
    call(who, 'PUT', '/api/v1/watch-folder', body);
  const message = (r: { json: () => unknown }) =>
    (r.json() as { error: { code: string; message: string } }).error;
  /** The worker's answer to a check, written as the worker writes it. */
  const answer = (id: string, result: object) =>
    admin.query('update settings_check set result = $1, done_at = now() where id = $2', [
      JSON.stringify(result),
      id,
    ]);
  const verifyFound = (path: string, failAt: string | null = null): WatchVerifyFound => {
    let failed = false;
    return {
      path,
      steps: [
        'exists',
        'folder',
        'inside',
        'not_vault',
        'read',
        'create',
        'move',
        'delete',
        'space',
      ].map((check) => {
        if (failed) return { check: check as never, ok: null };
        if (check === failAt) {
          failed = true;
          return { check: check as never, ok: false };
        }
        return { check: check as never, ok: true };
      }),
      free_bytes: 50 * 1024 ** 3,
    };
  };

  it('says the folders it may be chosen inside, and keeps scans 7 days by default', async () => {
    await said();
    const v = await view();
    expect(v.choice).toEqual({
      dir: null,
      default_dir: '/watch',
      roots: ['/watch', '/scans'],
      refused_roots: [],
      refused_words: null,
    });
    expect(v.keep_days).toBe(7);
    // And that nothing else saved there is touched, or added (the O1 review, M2).
    expect(v.kept_warning).toBe(`${WATCH_KEPT_WARNING} ${WATCH_PROCESSED_UNTOUCHED}`);
    expect(v.kept_warning).toBe(
      'Scans kept here are not encrypted until they’re deleted; anyone who can open the server’s folder can read them. Anything else saved into processed is never touched, but isn’t added either.',
    );
    expect(v).toMatchObject({ processed_words: null, kept_left: 0, kept_left_words: null });
    // Roots the worker refused (M4): said, and never offered.
    await said({ roots: ['/watch'], refused: ['/', '/data'] });
    expect((await view()).choice).toMatchObject({
      roots: ['/watch'],
      refused_roots: ['/', '/data'],
      refused_words: expect.stringMatching(/refuses.*\/, \/data.*FDV_WATCH_ROOTS/) as unknown,
    });
    // A processed folder the vault didn't make (M2), and scans left in a folder no longer used (L1).
    await put({ enabled: false, dir: '/watch/a' });
    await admin.query('update watch_folder set processed_foreign = true, kept_left = 2');
    expect(await view()).toMatchObject({
      processed_words: WATCH_PROCESSED_FOREIGN,
      kept_left: 2,
      kept_left_words: expect.stringMatching(
        /^2 kept scans are in a scanner folder the vault no longer uses/,
      ) as unknown,
      kept_changed: 0,
      kept_changed_words: null,
      kept_untracked: 0,
      kept_untracked_words: null,
    });
    // Kept scans changed since, and scans kept before a restore (the O1 re-check, 1, 2).
    await admin.query('update watch_folder set kept_changed = 1, kept_untracked = 3');
    expect(await view()).toMatchObject({
      kept_changed: 1,
      kept_changed_words: expect.stringMatching(
        /^1 kept scan changed since it was kept, left in place/,
      ) as unknown,
      kept_untracked: 3,
      kept_untracked_words: expect.stringMatching(
        /^3 scans kept before a restore aren’t tracked, so the vault won’t delete them: delete them by hand/,
      ) as unknown,
    });
    await said();
    // The worker has not said lately: no roots to choose inside.
    await said({ ago: 600 });
    expect((await view()).choice?.roots).toEqual([]);
  });

  it('takes a path only inside the roots, and never one of the vault’s own folders or one above it', async () => {
    await said();
    for (const [dir, code, words] of [
      ['watch/scans', 'not_absolute', /whole path, starting with \//],
      ['/watch/../data/vault', 'not_plain', /plainly/],
      ['/watch//scans', 'not_plain', /plainly/],
      ['/watch/./scans', 'not_plain', /plainly/],
      ['/watch\\scans', 'not_plain', /plainly/],
      ['/home/me/scans', 'outside', /isn’t one the vault may use.*inside one of \/watch, \/scans/],
      ['/watchers', 'outside', /isn’t one the vault may use/],
      ['/', 'outside', /isn’t one the vault may use/],
    ] as const) {
      const r = await put({ enabled: false, dir });
      expect(r.statusCode, `${dir} ${r.body}`).toBe(422);
      expect(message(r).code, dir).toBe('watch_folder_path_refused');
      expect(message(r).message, `${code}: ${dir}`).toMatch(words);
    }
    // A root that holds the vault's own folder: the root, the folder, inside it, above it.
    await said({ roots: ['/srv'], own: ['/srv/fdv/vault'] });
    for (const dir of ['/srv', '/srv/fdv', '/srv/fdv/vault', '/srv/fdv/vault/x']) {
      const r = await put({ enabled: false, dir });
      expect(r.statusCode, dir).toBe(422);
      expect(message(r).message, dir).toMatch(
        /one of the vault’s own folders, or a folder above one/,
      );
    }
    // Browsed through, a folder above the vault's own may be; never into it.
    for (const [path, status] of [
      ['/srv', 202],
      ['/srv/fdv', 202],
      ['/srv/fdv/vault', 422],
      ['/srv/fdv/vault/x', 422],
    ] as const) {
      const b = await call(owner, 'POST', '/api/v1/watch-folder/browse', { path });
      expect(b.statusCode, path).toBe(status);
      const v = await call(owner, 'POST', '/api/v1/watch-folder/verify', { path });
      expect(v.statusCode, path).toBe(422);
    }
    // And the system's own, whatever the worker said: Docker's secrets, temp, the app.
    await said({ roots: ['/'], own: [] });
    for (const dir of [
      '/run/secrets',
      '/tmp/scans',
      '/app',
      '/data/scans',
      '/var/lib/postgresql',
    ]) {
      const r = await put({ enabled: false, dir });
      expect(r.statusCode, dir).toBe(422);
    }
    expect((await admin.query('select count(*)::int as n from watch_folder')).rows[0]).toEqual({
      n: 0,
    });
    // Inside a root: kept, and said back.
    await said();
    const ok = await put({ enabled: false, dir: '/scans/office/' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<WatchFolderView>().choice?.dir).toBe('/scans/office');
    // null: the server's own again.
    const back = await put({ enabled: false, dir: null });
    expect(back.json<WatchFolderView>().choice?.dir).toBeNull();
    // A worker that has not said lately: nothing can be chosen.
    await said({ ago: 600 });
    const stale = await put({ enabled: false, dir: '/watch/a' });
    expect(stale.statusCode).toBe(409);
    expect(message(stale).message).toMatch(/hasn’t looked at the scanner folders/);
  });

  it('keeps scans 0 to 365 days, as an owner sets', async () => {
    await said();
    for (const keep_days of [-1, 366, 1.5]) {
      expect((await put({ enabled: false, keep_days })).statusCode, String(keep_days)).toBe(422);
    }
    for (const keep_days of [0, 30, 365]) {
      const r = await put({ enabled: false, keep_days });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<WatchFolderView>().keep_days).toBe(keep_days);
    }
    // Left out: as it was.
    expect((await put({ enabled: false })).json<WatchFolderView>().keep_days).toBe(365);
    // Changed, and the owners told in the activity log — not the folder's name.
    const { rows } = await admin.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where action = 'watch_folder.folder_changed'
        order by id desc limit 1`,
    );
    expect(rows[0]?.detail).toEqual({ dir_chosen: false, keep_days: 365 });
  });

  it('turns on a folder chosen only once the worker found that very folder ready, or a Verify of it just passed', async () => {
    await said();
    // Chosen and turned on at once: the worker has not looked at it yet.
    const first = await put({ enabled: true, dir: '/scans/office' });
    expect(first.statusCode, first.body).toBe(409);
    expect(message(first).code).toBe('watch_folder_unavailable');
    expect(message(first).message).toMatch(/hasn’t looked/);
    await put({ enabled: false, dir: '/scans/office' });
    // The worker found another folder ready, or this one long ago: still not.
    await admin.query(
      `update watch_folder set dir_state = 'ready', dir_seen = '/scans/other', dir_checked_at = now()`,
    );
    expect((await put({ enabled: true })).statusCode).toBe(409);
    await admin.query(
      `update watch_folder set dir_seen = '/scans/office', dir_checked_at = now() - interval '10 minutes'`,
    );
    expect((await put({ enabled: true })).statusCode).toBe(409);
    // It found it refused: said so.
    await admin.query(`update watch_folder set dir_state = 'refused', dir_checked_at = now()`);
    const no = await put({ enabled: true });
    expect(no.statusCode).toBe(409);
    expect(message(no).message).toMatch(/won’t use \/scans\/office/);
    expect((await view()).folder).toMatchObject({ state: 'refused', dir: '/scans/office' });
    // Ready, lately, that folder: on.
    await admin.query(`update watch_folder set dir_state = 'ready', dir_checked_at = now()`);
    const on = await put({ enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<WatchFolderView>()).toMatchObject({
      enabled: true,
      available: true,
      folder: { state: 'ready', dir: '/scans/office' },
    });

    // Another folder, Verified just now: on at once, before the worker's next look.
    await put({ enabled: false });
    const asked = await call(owner, 'POST', '/api/v1/watch-folder/verify', {
      path: '/watch/upstairs',
    });
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json<SettingsCheckView>().id;
    expect((await put({ enabled: true, dir: '/watch/upstairs' })).statusCode).toBe(409);
    await answer(id, verifyFound('/watch/upstairs', 'create'));
    expect((await put({ enabled: true, dir: '/watch/upstairs' })).statusCode).toBe(409);
    await admin.query('update settings_check set result = $1 where id = $2', [
      JSON.stringify(verifyFound('/watch/upstairs')),
      id,
    ]);
    expect((await put({ enabled: true, dir: '/watch/upstairs' })).statusCode).toBe(200);
  });

  it('Verify and browse are asked of the worker, refused first as a Save would be, and answered in plain words', async () => {
    await said();
    // Refused here: nothing asked of the worker.
    for (const path of ['/data/vault', '/etc', '/home/x', 'relative']) {
      const r = await call(owner, 'POST', '/api/v1/watch-folder/verify', { path });
      expect(r.statusCode, path).toBe(422);
      const b = await call(owner, 'POST', '/api/v1/watch-folder/browse', { path });
      expect(b.statusCode, path).toBe(422);
    }
    expect(h.jobs.filter((j) => j.name === 'settings.check')).toEqual([]);
    expect((await admin.query('select count(*)::int as n from settings_check')).rows[0]).toEqual({
      n: 0,
    });

    const asked = await call(owner, 'POST', '/api/v1/watch-folder/verify', {
      path: '/watch/upstairs',
    });
    expect(asked.statusCode, asked.body).toBe(202);
    const check = asked.json<SettingsCheckView>();
    expect(check).toMatchObject({ kind: 'folder', state: 'waiting', words: null });
    expect(h.jobs.filter((j) => j.name === 'settings.check').map((j) => j.data)).toEqual([
      { household_id: owner.household_id, check_id: check.id },
    ]);
    const get = () => call(owner, 'GET', `/api/v1/settings-checks/${check.id}`);
    expect((await get()).json<SettingsCheckView>().state).toBe('waiting');
    expect((await get()).headers['cache-control']).toBe('no-store');
    // The worker found it is a link out of the roots: each check said.
    await answer(check.id, verifyFound('/watch/upstairs', 'inside'));
    const done = (await get()).json<SettingsCheckView>();
    expect(done.state).toBe('done');
    expect(done.folder).toMatchObject({ ok: false, path: '/watch/upstairs' });
    expect(done.folder?.words).toMatch(/can’t be used yet.*link inside them leads out of them/);
    expect(done.folder?.steps.map((s) => [s.check, s.ok])).toEqual([
      ['exists', true],
      ['folder', true],
      ['inside', false],
      ['not_vault', null],
      ['read', null],
      ['create', null],
      ['move', null],
      ['delete', null],
      ['space', null],
    ]);
    expect(done.folder?.steps[0]?.words).toBe('The folder is there.');
    expect(done.folder?.steps[3]?.words).toMatch(/not checked, as something before it failed/);
    // Each failure, plainly.
    for (const [at, words] of [
      ['exists', /nothing at that path in the worker/],
      ['folder', /a file, not a folder/],
      ['not_vault', /one of the vault’s own folders/],
      ['read', /can’t see what is in it.*uid 1000/],
      ['create', /can’t make a file in it/],
      ['move', /can’t move a file in it/],
      ['delete', /can’t delete a file in it.*not encrypted/],
    ] as const) {
      await answer(check.id, verifyFound('/watch/upstairs', at));
      expect((await get()).json<SettingsCheckView>().folder?.words, at).toMatch(words);
    }
    await answer(check.id, { ...verifyFound('/watch/upstairs'), free_bytes: 10 * 1024 ** 2 });
    expect(
      (await get()).json<SettingsCheckView>().folder?.steps.find((s) => s.check === 'space'),
    ).toMatchObject({ ok: true, words: 'There is 10 MB free.' });
    await answer(check.id, verifyFound('/watch/upstairs'));
    expect((await get()).json<SettingsCheckView>().folder).toMatchObject({
      ok: true,
      words: '/watch/upstairs is ready for scans.',
    });

    // A worker that never answers: late, after a minute, in words.
    const slow = (
      await call(owner, 'POST', '/api/v1/watch-folder/browse', { path: '/scans' })
    ).json<SettingsCheckView>();
    clock = Date.now() + 61_000;
    expect(
      (await call(owner, 'GET', `/api/v1/settings-checks/${slow.id}`)).json<SettingsCheckView>(),
    ).toMatchObject({
      state: 'late',
      words: expect.stringMatching(/worker hasn’t answered/) as unknown,
    });
    // A browse, answered.
    await answer(slow.id, {
      path: '/scans',
      folders: ['office', 'upstairs'],
      truncated: false,
      problem: null,
    });
    expect(
      (await call(owner, 'GET', `/api/v1/settings-checks/${slow.id}`)).json<SettingsCheckView>(),
    ).toMatchObject({ state: 'done', browse: { folders: ['office', 'upstairs'] } });
  });

  it('asking the worker is an owner’s: at the API, and in the database', async () => {
    await said();
    const mine = (
      await call(owner, 'POST', '/api/v1/watch-folder/verify', { path: '/watch' })
    ).json<SettingsCheckView>();
    for (const who of [adult, teen, viewer]) {
      for (const url of ['/api/v1/watch-folder/verify', '/api/v1/watch-folder/browse']) {
        const r = await call(who, 'POST', url, { path: '/watch' });
        expect(r.statusCode, url).toBe(403);
      }
      expect((await call(who, 'GET', `/api/v1/settings-checks/${mine.id}`)).statusCode).toBe(403);
      expect((await call(who, 'POST', '/api/v1/mail-in/mailbox/test')).statusCode).toBe(403);
    }
    expect((await call(owner, 'GET', '/api/v1/settings-checks/not-a-check')).statusCode).toBe(404);
    expect(
      (await call(owner, 'GET', '/api/v1/settings-checks/00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).toBe(404);

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
    for (const [who, role] of [
      [adult, 'adult'],
      [teen, 'teen'],
      [viewer, 'viewer'],
    ] as const) {
      expect(await asCaller(who, role, 'select * from settings_check'), role).toMatchObject({
        rows: [],
      });
      expect(
        await asCaller(
          who,
          role,
          `insert into settings_check (household_id, kind, path, requested_by)
           values (app_household(), 'folder', '/watch', app_account())`,
        ),
        role,
      ).toMatchObject({ code: '42501' });
    }
    // An owner asks, as themselves, and never answers: the worker's alone.
    // The scans the vault kept, by the names the family gave them: the vault's
    // alone, an owner given none (the O1 re-check, 3).
    await admin.query(
      `insert into watch_kept (household_id, dir, rel, file_id) values ($1, '/watch', 'processed/2026-10-18/tia-report.pdf', '1:2:3:4')`,
      [owner.household_id],
    );
    for (const [who, role] of [
      [owner, 'owner'],
      [adult, 'adult'],
    ] as const) {
      expect(await asCaller(who, role, 'select rel from watch_kept'), role).toMatchObject({
        rows: [],
      });
      expect(await asCaller(who, role, `delete from watch_kept`), role).toMatchObject({ count: 0 });
    }
    await admin.query('delete from watch_kept');
    expect(await asCaller(owner, 'owner', 'select id from settings_check')).toMatchObject({
      rows: [{ id: mine.id }],
    });
    expect(
      await asCaller(
        owner,
        'owner',
        `update settings_check set result = '{"path":"/watch","steps":[],"free_bytes":0}', done_at = now()`,
      ),
    ).toMatchObject({ count: 0 });
    expect(
      await asCaller(
        owner,
        'owner',
        `insert into settings_check (household_id, kind, path, requested_by, result, done_at)
         values (app_household(), 'folder', '/watch', app_account(), '{}', now())`,
      ),
    ).toMatchObject({ code: '42501' });
    expect(await asCaller(owner, 'owner', 'delete from settings_check')).toMatchObject({
      count: 0,
    });
    // And the folder an owner chose is theirs to write; what the worker found of it is not.
    await put({ enabled: false, dir: '/watch/a' });
    expect(
      await asCaller(
        owner,
        'owner',
        `update watch_folder set dir_state = 'ready', dir_seen = dir, dir_checked_at = now(),
                updated_by = app_account()`,
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(
        owner,
        'owner',
        `update watch_folder set keep_days = 3, dir = '/watch/b', updated_by = app_account()`,
      ),
    ).toMatchObject({ count: 1 });
    expect(
      await asCaller(
        owner,
        'owner',
        `update watch_folder set keep_days = 400, updated_by = app_account()`,
      ),
    ).toMatchObject({ code: '23514' });
  });

  it('a folder another household on this server uses is refused for Verify, browse and save, saying nothing of it (the O1 review, L2)', async () => {
    await said();
    const other = (
      await admin.query<{ id: string }>(
        "insert into household (name) values ('Next door') returning id",
      )
    ).rows[0]?.id as string;
    try {
      await admin.query(
        `insert into watch_folder (household_id, enabled, dir, keep_days) values ($1, false, '/watch/next-door', 0)`,
        [other],
      );
      const refusedCode = async (method: 'PUT' | 'POST', url: string, body: object) => {
        const r = await call(owner, method, url, body as Record<string, unknown>);
        return [r.statusCode, message(r).code, message(r).message];
      };
      const words = [
        422,
        'watch_folder_path_refused',
        expect.stringMatching(/Another household on this server uses that folder/) as unknown,
      ];
      // The folder itself, one inside it, and (but for browsing) one above it.
      for (const dir of ['/watch/next-door', '/watch/next-door/scans', '/watch']) {
        expect(
          await refusedCode('PUT', '/api/v1/watch-folder', { enabled: false, dir }),
          dir,
        ).toEqual(words);
        expect(
          await refusedCode('POST', '/api/v1/watch-folder/verify', { path: dir }),
          dir,
        ).toEqual(words);
      }
      expect(
        await refusedCode('POST', '/api/v1/watch-folder/browse', { path: '/watch/next-door' }),
      ).toEqual(words);
      // Browsing through the folder above it is fine; a folder beside it may be chosen.
      expect(
        (await call(owner, 'POST', '/api/v1/watch-folder/browse', { path: '/watch' })).statusCode,
      ).toBe(202);
      expect((await put({ enabled: false, dir: '/watch/ours' })).statusCode).toBe(200);
      expect(h.jobs.filter((j) => j.name === 'settings.check')).toHaveLength(1);
      // The other household's folder is never named to this one.
      expect(JSON.stringify(await view())).not.toContain('next-door');
      // FDV_WATCH_DIR, while the other household has the scanner folder on with none chosen.
      await admin.query(
        `update watch_folder set dir = null, enabled = false where household_id = $1`,
        [other],
      );
      expect((await put({ enabled: false, dir: '/watch/next-door' })).statusCode).toBe(200);
      // Asked of the database as anybody but an account: nothing told.
      const c = await app.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'system', true)`,
          [owner.household_id],
        );
        await admin.query(`update watch_folder set dir = '/watch/x' where household_id = $1`, [
          other,
        ]);
        expect(
          (await c.query("select watch_dir_used_elsewhere('/watch/x', false) as used")).rows[0],
        ).toEqual({ used: false });
      } finally {
        await c.query('rollback');
        c.release();
      }
    } finally {
      await admin.query('delete from household where id = $1', [other]);
    }
  });

  it('asks the worker at most so many times a minute', async () => {
    await said();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await call(owner, 'POST', '/api/v1/watch-folder/browse', { path: '/watch' }))
        .statusCode;
    }
    expect(last).toBe(429);
  });
});
