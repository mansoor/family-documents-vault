import { BACKUP_OFFSITE_KEY_PURPOSE, deriveKey, openBackupOffsiteSecret } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { Capabilities, OffsiteTestResult, OffsiteView } from '@fdv/shared';
import { OffsiteError, type OffsiteBucket } from '@fdv/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { alertsSent, createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { offsiteEndpoint, offsitePrefix } from './offsite.js';

/**
 * Settings → Backups (0.9.0-dev.76): the bucket the nightly backups are
 * copied to. An owner's, with a passkey or a code; the secret key sealed
 * and never answered; a test that must pass before the copy is turned on,
 * which only the vault says passed; and nothing the worker says of a copy
 * is an owner's to write.
 */

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const codeOf = (r: { json: <T>() => T }) =>
  r.json<{ error?: { code: string } }>().error?.code ?? 'ok';

describe('what an owner types', () => {
  it('keeps an address to its scheme, host and port', () => {
    expect(offsiteEndpoint('https://s3.eu-central-003.backblazeb2.com/')).toBe(
      'https://s3.eu-central-003.backblazeb2.com',
    );
    expect(offsiteEndpoint('http://192.168.1.20:9000')).toBe('http://192.168.1.20:9000');
    expect(offsiteEndpoint('')).toBeNull();
    for (const bad of [
      'ftp://x.example',
      'https://user:pass@s3.example.com',
      'https://s3.example.com/bucket',
      'https://s3.example.com?x=1',
      'not an address',
    ]) {
      expect(() => offsiteEndpoint(bad)).toThrow();
    }
  });

  it('keeps a prefix to folder names, none of them . or ..', () => {
    expect(offsitePrefix('/vault/backups/')).toBe('vault/backups');
    expect(offsitePrefix('  ')).toBeNull();
    for (const bad of ['a/../b', './a', 'a//b', 'a b', 'a/./b', '..']) {
      expect(() => offsitePrefix(bad)).toThrow();
    }
  });
});

describe.skipIf(!testAdminUrl())('the off-site backup copy, set in Settings', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let admin: ReturnType<typeof createPool>;
  /** What the next test answers, and what it was given. */
  let answer: OffsiteError | null = null;
  /** Whether the next test's key may delete. */
  let deletes = true;
  const tested: OffsiteBucket[] = [];

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      offsiteTest: async (b) => {
        tested.push(b);
        if (answer) throw answer;
        return { canDelete: deletes };
      },
    });
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ada', email: 'ada-offsite@example.test', role: 'adult' });
    admin = createPool(h.adminUrl, 1);
    await h.decider(owner);
  });
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    answer = null;
    deletes = true;
    tested.length = 0;
    await admin.query('delete from backup_offsite');
    await h.decider(owner);
  });

  const call = (
    who: Tokens,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(who),
      // Each from an address of its own: a test is five a minute from one.
      remoteAddress: `10.9.${Math.floor(++peer / 250)}.${(peer % 250) + 1}`,
      ...(payload ? { payload } : {}),
    });
  let peer = 0;
  const AT = '/api/v1/backups/offsite';
  const body = (over: Record<string, unknown> = {}) => ({
    endpoint: 'https://s3.eu-central-003.backblazeb2.com',
    region: 'eu-central-003',
    bucket: 'family-backups',
    prefix: 'vault',
    access_key_id: '003abcdef0123456789000001',
    secret_access_key: SECRET,
    ...over,
  });
  const save = async (over: Record<string, unknown> = {}) => {
    const r = await call(owner, 'PUT', AT, body(over));
    expect(r.statusCode, r.body).toBe(200);
    return r.json<OffsiteView>();
  };
  const stored = async () =>
    (
      await admin.query<{
        secret_encrypted: Buffer;
        status: string;
        enabled: boolean;
        endpoint: string | null;
        bucket: string;
        access_key_id: string;
      }>('select * from backup_offsite where household_id = $1', [owner.household_id])
    ).rows[0];

  it('is offered to a self-hosted vault, and says a backup is the database alone', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<Capabilities>();
    expect(caps.features.backup_offsite).toBe(true);
    const v = (await call(owner, 'GET', AT)).json<OffsiteView>();
    expect(v).toEqual({ available: true, settings: null, covers: 'database' });
  });

  it('is an owner’s alone: anybody else is refused, before their body is read', async () => {
    for (const [method, url] of [
      ['GET', AT],
      ['PUT', AT],
      ['DELETE', AT],
      ['PUT', `${AT}/enabled`],
      ['POST', `${AT}/test`],
    ] as const) {
      const r = await call(adult, method, url, method === 'PUT' ? { nonsense: true } : undefined);
      expect([url, method, r.statusCode, codeOf(r)]).toEqual([url, method, 403, 'forbidden']);
    }
    // And the database's own rule: an adult is given nothing of it, an owner
    // and the vault all of it, a connected app nothing.
    await save();
    const seen = async (actor: string, role: string) => {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query('set local role fdv_app');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true),
                  set_config('app.role', $3, true)`,
          [owner.household_id, actor, role],
        );
        const { rows } = await client.query<{ n: number }>(
          'select count(*)::int as n from backup_offsite',
        );
        await client.query('commit');
        return rows[0]?.n;
      } finally {
        client.release();
      }
    };
    expect(await seen('account', 'adult')).toBe(0);
    expect(await seen('account', 'owner')).toBe(1);
    expect(await seen('system', '')).toBe(1);
    expect(await seen('connected_app', '')).toBe(0);
    expect(await seen('anonymous', '')).toBe(0);
  });

  it('seals the secret key, never answers it, and binds it to the bucket it was given for', async () => {
    const v = await save();
    expect(v.settings).toMatchObject({
      endpoint: 'https://s3.eu-central-003.backblazeb2.com',
      bucket: 'family-backups',
      prefix: 'vault',
      path_style: true,
      secret_access_key: 'set',
      retain_count: 30,
      enabled: false,
      status: 'untested',
      late: false,
    });
    expect(JSON.stringify(v)).not.toContain(SECRET);
    const row = await stored();
    expect(row?.secret_encrypted.includes(Buffer.from(SECRET))).toBe(false);
    const key = deriveKey(TEST_MASTER, BACKUP_OFFSITE_KEY_PURPOSE);
    const to = {
      endpoint: row?.endpoint ?? null,
      bucket: 'family-backups',
      accessKeyId: row?.access_key_id ?? '',
    };
    expect(
      openBackupOffsiteSecret(key, row?.secret_encrypted as Buffer, owner.household_id, to),
    ).toBe(SECRET);
    // Bound to its bucket: under another, it does not open.
    expect(() =>
      openBackupOffsiteSecret(key, row?.secret_encrypted as Buffer, owner.household_id, {
        ...to,
        bucket: 'somebody-elses',
      }),
    ).toThrow();

    // Left out, the secret is kept — for the same address, bucket and key only.
    expect((await call(owner, 'PUT', AT, body({ secret_access_key: undefined }))).statusCode).toBe(
      200,
    );
    const moved = await call(
      owner,
      'PUT',
      AT,
      body({ secret_access_key: undefined, bucket: 'another-bucket' }),
    );
    expect([moved.statusCode, codeOf(moved)]).toEqual([422, 'offsite_secret_needed']);
  });

  it('asks for a passkey or a code to change it', async () => {
    await admin.query(
      `update session set factor_verified_at = null, verified_at = null
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    for (const [method, url, payload] of [
      ['PUT', AT, body()],
      ['PUT', `${AT}/enabled`, { enabled: true }],
      ['DELETE', AT, undefined],
    ] as const) {
      const r = await call(owner, method, url, payload);
      expect([url, r.statusCode, codeOf(r)]).toEqual([url, 403, 'step_up_required']);
      expect(r.json<{ error: { action: string } }>().error.action).toBe('change_backups');
    }
  });

  it('turns on only after a test of what is saved passed', async () => {
    await save();
    const early = await call(owner, 'PUT', `${AT}/enabled`, { enabled: true });
    expect([early.statusCode, codeOf(early)]).toEqual([409, 'offsite_untested']);

    // A test that fails says why, in words, and stays off.
    answer = new OffsiteError('credentials_rejected', 'InvalidAccessKeyId: provider words');
    const failed = (await call(owner, 'POST', `${AT}/test`)).json<OffsiteTestResult>();
    expect(failed).toMatchObject({ ok: false, problem: 'credentials_rejected' });
    expect(failed.words).toMatch(/access key ID or secret key was not accepted/);
    expect(failed.words).not.toContain('provider words');
    expect(failed.view.settings?.status).toBe('failed');

    answer = null;
    const passed = (await call(owner, 'POST', `${AT}/test`)).json<OffsiteTestResult>();
    expect(passed.ok).toBe(true);
    expect(passed.view.settings?.status).toBe('ok');
    // It was given the bucket as saved, the secret opened.
    expect(tested.at(-1)).toEqual({
      endpoint: 'https://s3.eu-central-003.backblazeb2.com',
      region: 'eu-central-003',
      bucket: 'family-backups',
      prefix: 'vault',
      pathStyle: true,
      accessKeyId: '003abcdef0123456789000001',
      secretAccessKey: SECRET,
    });

    const on = await call(owner, 'PUT', `${AT}/enabled`, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<OffsiteView>().settings?.enabled).toBe(true);

    // Only the copy count changed: still on, still tested.
    const kept = await save({ secret_access_key: undefined, retain_count: 10 });
    expect(kept.settings).toMatchObject({ enabled: true, status: 'ok', retain_count: 10 });
    // A new bucket waits for a test of its own: off, untested.
    const moved = await save({ bucket: 'new-bucket' });
    expect(moved.settings).toMatchObject({ enabled: false, status: 'untested' });

    // The activity log, this test's lines: saved, tested, turned on — never a key.
    const { rows } = await admin.query<{ action: string; detail: unknown }>(
      `select action, detail from audit_event
        where household_id = $1 and action like 'backup.%' order by id`,
      [owner.household_id],
    );
    expect(rows.slice(-6).map((r) => r.action)).toEqual([
      'backup.offsite_saved',
      'backup.offsite_tested',
      'backup.offsite_tested',
      'backup.offsite_changed',
      'backup.offsite_saved',
      'backup.offsite_saved',
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain('003abcdef');
  });

  it('a key that may not delete is a choice: the copy may go, and nothing is removed there', async () => {
    await save();
    deletes = false;
    const r = (await call(owner, 'POST', `${AT}/test`)).json<OffsiteTestResult>();
    expect(r.ok).toBe(true);
    expect(r.words).toMatch(/can’t delete.*lifecycle rule/);
    expect(r.view.settings).toMatchObject({ status: 'ok', can_delete: false });
    const on = await call(owner, 'PUT', `${AT}/enabled`, { enabled: true });
    expect(on.statusCode).toBe(200);
    // A new key waits for a test of its own: what the last one found is forgotten.
    const moved = await save({ access_key_id: 'another-key' });
    expect(moved.settings).toMatchObject({ status: 'untested', can_delete: null });
  });

  it('fewer copies kept while it is on: the other owners are told, once a change', async () => {
    const other = await h.join(owner, {
      name: 'Omar',
      email: 'omar-offsite@example.test',
      role: 'owner',
    });
    await save();
    await call(owner, 'POST', `${AT}/test`);
    await call(owner, 'PUT', `${AT}/enabled`, { enabled: true });
    const before = alertsSent(h).length;
    await save({ secret_access_key: undefined, retain_count: 40 });
    expect(alertsSent(h).length).toBe(before);
    await save({ secret_access_key: undefined, retain_count: 3 });
    const told = alertsSent(h).slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ subject: 'Fewer backups are kept off-site now' });
    expect(String(told[0]?.body)).toMatch(/keep 3 off-site copies of the backups, down from 40/);
    // The other owner alone: not whoever changed it.
    const { rows } = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [other.member_id],
    );
    expect(told[0]?.account_ids).toEqual([rows[0]?.account_id]);
  });

  it('a failed test does not turn off a copy that is on', async () => {
    await save();
    await call(owner, 'POST', `${AT}/test`);
    await call(owner, 'PUT', `${AT}/enabled`, { enabled: true });
    answer = new OffsiteError('unreachable', 'ECONNREFUSED');
    const r = (await call(owner, 'POST', `${AT}/test`)).json<OffsiteTestResult>();
    expect(r.ok).toBe(false);
    expect(r.view.settings).toMatchObject({ enabled: true, status: 'ok' });
  });

  it('whether a test passed, and what became of a copy, are never an owner’s to write', async () => {
    await save();
    const { rows: me } = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [owner.member_id],
    );
    const asOwner = async (set: string) => {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query('set local role fdv_app');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', 'owner', true), set_config('app.account_id', $2, true)`,
          [owner.household_id, me[0]?.account_id],
        );
        await client.query(`update backup_offsite set ${set}`);
        await client.query('commit');
        return 'ok';
      } catch (err) {
        await client.query('rollback');
        return (err as Error).message;
      } finally {
        client.release();
      }
    };
    expect(await asOwner(`status = 'ok', last_tested_at = now()`)).toMatch(/vault's to say/);
    expect(await asOwner(`last_copy_at = now()`)).toMatch(/vault's to say/);
    expect(await asOwner(`enabled = true, enabled_at = now()`)).toMatch(/backup_offsite_on_tested/);
  });

  it('forgets the bucket, secret and all', async () => {
    await save();
    const r = await call(owner, 'DELETE', AT);
    expect(r.json<OffsiteView>().settings).toBeNull();
    expect(await stored()).toBeUndefined();
  });

  it('refuses what is not an address, a bucket or a folder', async () => {
    for (const [over, words] of [
      [{ endpoint: 'https://s3.example.com/bucket' }, /address alone/],
      [{ prefix: 'a/../b' }, /folder/],
      [{ bucket: 'no spaces' }, /bucket/],
      [{ endpoint: null, region: null }, /region/],
      [{ retain_count: 0 }, /copies/],
    ] as const) {
      const r = await call(owner, 'PUT', AT, body(over));
      expect(r.statusCode, JSON.stringify(over)).toBe(422);
      expect(r.json<{ error: { message: string } }>().error.message).toMatch(words);
    }
  });
});

describe.skipIf(!testAdminUrl())('the off-site backup copy on the hosted edition', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness({
      edition: 'hosted',
      offsiteTest: async () => ({ canDelete: true }),
    });
    owner = await h.setup();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('is not offered: the operator keeps the backups', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<Capabilities>();
    expect(caps.features).not.toHaveProperty('backup_offsite');
    const v = await h.app.inject({ url: '/api/v1/backups/offsite', headers: h.as(owner) });
    expect(v.json<OffsiteView>()).toEqual({ available: false, settings: null, covers: 'database' });
  });
});
