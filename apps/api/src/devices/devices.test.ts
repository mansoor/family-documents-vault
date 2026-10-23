import { randomUUID } from 'node:crypto';
import { createPool, householdZone } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  BATCH_MAX_FILES,
  localToday,
  PAIRING_ALPHABET,
  deviceBatchName,
  type BatchView,
  type DeviceMe,
  type DevicePaired,
  type DevicePairingCode,
  type PairedDevice,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsSent, createHarness, type Harness } from '../test-harness.js';
import { DEVICE_KEY_ROUTES } from './routes.js';
import { deviceKeyHash } from './service.js';

/**
 * A computer that sends scans (0.8.0, D1): pairing with a one-time code,
 * and an upload-only key.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

const CODE = new RegExp(`^[${PAIRING_ALPHABET}]{4}-[${PAIRING_ALPHABET}]{4}$`);

let peers = 0;
/** A different address each time: the pairing's own limit is for one address. */
const peer = () => ({ remoteAddress: `10.71.${(peers >> 8) & 0xff}.${peers++ & 0xff}` });

describe.skipIf(!testAdminUrl())('a computer that sends scans (0.8.0, D1)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let ahmed: Tokens;
  let sara: Tokens;
  let tariq: Tokens;
  let vera: Tokens;

  const send = (t: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(t),
      ...(payload === undefined ? {} : { payload: payload as never }),
      ...peer(),
    });
  /** Their sessions just confirmed it is them (the step-up). */
  const fresh = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [t.member_id],
    );
  const stale = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now() - interval '1 hour', factor_verified_at = null
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [t.member_id],
    );
  const newCode = async (t: Tokens) => {
    await fresh(t);
    const res = await send(t, 'POST', '/api/v1/device-pairings', {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json<DevicePairingCode>();
  };
  const trade = (code: string, name = 'Laptop', platform = 'windows') =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { code, device_name: name, platform },
      ...peer(),
    });
  const pair = async (t: Tokens, name = 'Laptop') => {
    const { code } = await newCode(t);
    const res = await trade(code, name);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<DevicePaired>();
  };
  const keyOf = (d: DevicePaired) => ({ authorization: `Device ${d.device_id}.${d.key}` });
  const upload = (
    d: DevicePaired,
    key: string | null = randomUUID(),
    file: { bytes: Buffer; name: string; type: string } = {
      bytes: PDF('SCAN'),
      name: 'scan.pdf',
      type: 'application/pdf',
    },
    relativePath?: string,
  ) => {
    const form = new FormData();
    if (relativePath !== undefined) form.append('relative_path', relativePath);
    form.append('file', file.bytes, { filename: file.name, contentType: file.type });
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/device-uploads',
      headers: { ...keyOf(d), ...form.getHeaders(), ...(key ? { 'idempotency-key': key } : {}) },
      payload: form.getBuffer(),
      ...peer(),
    });
  };
  const me = (d: DevicePaired) =>
    h.app.inject({ url: '/api/v1/devices/me', headers: keyOf(d), ...peer() });
  const accountOf = async (t: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [t.member_id],
      )
    ).rows[0]?.account_id as string;
  const lines = async (action: string, memberId: string) =>
    (
      await admin.query<{ detail: Record<string, unknown>; actor_account_id: string }>(
        `select detail, actor_account_id from audit_event
          where action = $1 and object_id = $2 order by id`,
        [action, memberId],
      )
    ).rows;
  const signInAgain = async (email: string) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email, password: 'another correct horse' },
      ...peer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  const batchesOf = async (t: Tokens) =>
    (await send(t, 'GET', '/api/v1/batches')).json<{
      items: BatchView[];
    }>().items;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-d1@example.test', role: 'adult' });
    sara = await h.join(owner, { name: 'Sara', email: 'sara-d1@example.test', role: 'adult' });
    tariq = await h.join(owner, { name: 'Tariq', email: 'tariq-d1@example.test', role: 'teen' });
    vera = await h.join(owner, { name: 'Vera', email: 'vera-d1@example.test', role: 'viewer' });
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  // ------------------------------------------------------------- pairing

  it('a code takes the step-up first, and is shown once: two halves of four that read as nothing else, for 10 minutes, with the vault’s address', async () => {
    await stale(ahmed);
    const asked = await send(ahmed, 'POST', '/api/v1/device-pairings', {});
    expect(asked.statusCode).toBe(403);
    expect(asked.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
    expect((await admin.query('select 1 from device_pairing')).rowCount).toBe(0);

    const made = await newCode(ahmed);
    expect(made.code).toMatch(CODE);
    const left = Date.parse(made.expires_at) - Date.now();
    expect(left).toBeGreaterThan(9 * 60_000);
    expect(left).toBeLessThanOrEqual(10 * 60_000 + 2_000);
    expect(made.vault_address).toBe('http://localhost:8080');
    expect(made.download_url).toBeNull();
    // Kept as two HMACs, never the code.
    const kept = await admin.query<{ row: string }>(
      'select to_jsonb(p)::text as row from device_pairing p',
    );
    expect(kept.rowCount).toBe(1);
    for (const form of [made.code, made.code.replace('-', '')]) {
      expect(kept.rows[0]?.row).not.toContain(form);
    }
  });

  it('a viewer cannot pair a computer, nor list one', async () => {
    await fresh(vera);
    const res = await send(vera, 'POST', '/api/v1/device-pairings', {});
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    expect((await send(vera, 'GET', '/api/v1/paired-devices')).statusCode).toBe(403);
  });

  it('a code traded for a key: answered once, told by email and in the activity log, and used once', async () => {
    const before = alertsSent(h).length;
    const { code } = await newCode(ahmed);
    const res = await trade(code.toLowerCase(), '  Ahmed’s   laptop\n', 'windows');
    expect(res.statusCode, res.body).toBe(201);
    const paired = res.json<DevicePaired>();
    expect(Object.keys(paired).sort()).toEqual(['device_id', 'key', 'member_name', 'vault_name']);
    expect(paired).toMatchObject({ member_name: 'Ahmed', vault_name: 'The Test family' });
    expect(paired.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Its name as the vault keeps it.
    expect((await me(paired)).json<DeviceMe>()).toMatchObject({
      device_id: paired.device_id,
      device_name: 'Ahmed’s laptop',
      member_name: 'Ahmed',
      active: true,
      paused: null,
      limits: { max_upload_bytes: 5 * 1024 * 1024, batch_max_files: BATCH_MAX_FILES },
    });
    // Used once.
    const again = await trade(code);
    expect(again.statusCode).toBe(401);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('pairing_code_invalid');
    // The person is told, by email only, in the words the brief gives.
    const told = alertsSent(h).slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      account_ids: [await accountOf(ahmed)],
      subject: 'A computer was added to your sign-in',
      email_only: true,
    });
    expect(String(told[0]?.body)).toContain(
      'A computer was added to your sign-in: Ahmed’s laptop (Windows), on ',
    );
    expect(String(told[0]?.body)).toContain("If this wasn't you, remove it in Settings");
    // And a line in the activity log: theirs, the owners', nobody else's.
    expect(await lines('computer.paired', ahmed.member_id)).toEqual([
      {
        detail: { name: 'Ahmed’s laptop', platform: 'windows' },
        actor_account_id: await accountOf(ahmed),
      },
    ]);
    const seen = async (t: Tokens) =>
      (await send(t, 'GET', '/api/v1/audit?limit=100')).body.includes('Ahmed’s laptop');
    expect(await seen(ahmed)).toBe(true);
    expect(await seen(owner)).toBe(true);
    expect(await seen(sara)).toBe(false);
    expect(await seen(tariq)).toBe(false);
  });

  it('a code runs out after 10 minutes', async () => {
    const { code } = await newCode(sara);
    await admin.query(
      "update device_pairing set expires_at = now() - interval '1 second' where member_id = $1",
      [sara.member_id],
    );
    expect((await trade(code)).statusCode).toBe(401);
  });

  it('five wrong tries end a code, counted on the code its first half names, and only on it', async () => {
    const { code } = await newCode(sara);
    const first = code.slice(0, 4);
    const second = code.slice(5);
    const swapped = [...PAIRING_ALPHABET].find((c) => c !== second[0]) as string;
    const wrong = `${first}-${swapped}${second.slice(1)}`;
    const attempts = async () =>
      (
        await admin.query<{ attempts: number }>(
          'select attempts from device_pairing where member_id = $1',
          [sara.member_id],
        )
      ).rows[0]?.attempts;
    // A first half that names no code is answered the same, and counts on nothing.
    const nobody = [...PAIRING_ALPHABET].find((c) => c !== code[0]) as string;
    expect((await trade(`${nobody}${code.slice(1)}`)).statusCode).toBe(401);
    expect(await attempts()).toBe(0);
    for (let i = 1; i <= 5; i++) {
      const res = await trade(wrong);
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('pairing_code_invalid');
      expect(await attempts()).toBe(i);
    }
    // Ended: the right code no longer works.
    expect((await trade(code)).statusCode).toBe(401);
    expect(await attempts()).toBe(5);
  });

  it('one live code a person: a new one ends the old', async () => {
    const one = await newCode(sara);
    const two = await newCode(sara);
    expect(two.code).not.toBe(one.code);
    expect((await trade(one.code)).statusCode).toBe(401);
    const rows = await admin.query('select 1 from device_pairing where member_id = $1', [
      sara.member_id,
    ]);
    expect(rows.rowCount).toBe(1);
    expect((await trade(two.code, 'Sara desk')).statusCode).toBe(201);
    // Spent: gone.
    expect(
      (await admin.query('select 1 from device_pairing where member_id = $1', [sara.member_id]))
        .rowCount,
    ).toBe(0);
  });

  it('pairing is limited for each address', async () => {
    const from = { remoteAddress: '10.72.0.1' };
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/devices/pair',
        payload: { code: 'AAAA-AAAA', device_name: 'Guess', platform: 'other' },
        ...from,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  });

  it('a name and a platform are asked for', async () => {
    const { code } = await newCode(sara);
    expect((await trade(code, '   ')).statusCode).toBe(422);
    expect((await trade(code, 'Laptop', 'amiga')).statusCode).toBe(422);
    // Neither a refusal of the form is a try at the code.
    expect((await trade(code, 'Sara laptop')).statusCode).toBe(201);
  });

  // ------------------------------------------------------------ the key

  it('the key is refused with 401 on every route but its two, the public ones too (the all-routes walk)', async () => {
    const d = await pair(ahmed, 'Walk');
    const routes = routeTable(h);
    expect(routes.length).toBeGreaterThan(170);
    const answered: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      const url = r.url.replace(/:[A-Za-z]+/g, (p) => (p === ':n' ? '1' : randomUUID()));
      const res = await h.app.inject({
        method: r.method as 'GET',
        url,
        headers: keyOf(d),
        ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
        ...peer(),
      });
      if (DEVICE_KEY_ROUTES.has(key)) {
        expect(res.statusCode, key).not.toBe(401);
        answered.push(key);
      } else {
        expect(res.statusCode, key).toBe(401);
        expect(res.json<{ error: { code: string } }>().error.code, key).toBe(
          'device_key_not_accepted',
        );
      }
    }
    expect(answered.sort()).toEqual([...DEVICE_KEY_ROUTES].sort());
    // A route that is not there, and the scheme in another case: refused too.
    const nowhere = await h.app.inject({ url: '/api/v1/nowhere', headers: keyOf(d), ...peer() });
    expect(nowhere.statusCode).toBe(401);
    const lower = await h.app.inject({
      url: '/api/v1/batches',
      headers: { authorization: `device ${d.device_id}.${d.key}` },
      ...peer(),
    });
    expect(lower.statusCode).toBe(401);
    // And a sign-in is not a key: the two routes refuse a bearer.
    const bearer = await h.app.inject({ url: '/api/v1/devices/me', headers: h.as(ahmed) });
    expect(bearer.statusCode).toBe(401);
    // A key that is not this computer's: nothing.
    const forged = await h.app.inject({
      url: '/api/v1/devices/me',
      headers: { authorization: `Device ${d.device_id}.${'A'.repeat(43)}` },
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  }, 120_000);

  it('a file lands in its person’s batch for the day, and a repeat of its Idempotency-Key is the item it made', async () => {
    const d = await pair(ahmed, 'Ahmed scanner');
    const key = randomUUID();
    const first = await upload(d, key, undefined, 'Bills/2026/electric.pdf');
    expect(first.statusCode, first.body).toBe(201);
    const sent = first.json<{ item_id: string; status: string }>();
    // Nothing else about the vault.
    expect(Object.keys(sent).sort()).toEqual(['item_id', 'status']);
    expect(sent.status).toBe('waiting');
    const again = await upload(d, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(sent);
    // Into Ahmed's own uploads, a batch for the day on the household's calendar.
    const tz = householdZone(
      (await admin.query<{ timezone: string | null }>('select timezone from household')).rows[0]
        ?.timezone,
    );
    const name = deviceBatchName('Ahmed scanner', localToday(tz));
    const day = (await batchesOf(ahmed)).find((b) => b.name === name);
    expect(day?.counts).toMatchObject({ items: 1, waiting: 1 });
    // A second file the same day: the same batch.
    expect((await upload(d)).statusCode).toBe(201);
    expect((await batchesOf(ahmed)).filter((b) => b.name === name)).toHaveLength(1);
    // The path a relative_path names is not kept (S2's, later).
    const kept = await admin.query<{ row: string }>(
      'select to_jsonb(f)::text as row from incoming_file f where f.id = $1',
      [sent.item_id],
    );
    expect(kept.rows[0]?.row).not.toContain('electric');
    expect(kept.rows[0]?.row).not.toContain('Bills/2026');
    // Nobody else sees it: an owner and another adult neither list it nor open it.
    for (const t of [owner, sara, tariq]) {
      expect((await batchesOf(t)).some((b) => b.id === day?.id)).toBe(false);
      expect((await send(t, 'GET', `/api/v1/batches/${day?.id}`)).statusCode).toBe(404);
    }
    // Nor does the database give it to an owner signed in (RLS).
    const pool = createPool(h.appUrl, 1);
    try {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', 'owner', true), set_config('app.member_id', $2, true),
                  set_config('app.account_id', $3, true)`,
          [owner.household_id, owner.member_id, await accountOf(owner)],
        );
        const batches = await client.query('select 1 from intake_batch where id = $1', [day?.id]);
        const items = await client.query('select 1 from incoming_file where batch_id = $1', [
          day?.id,
        ]);
        await client.query('rollback');
        expect(batches.rowCount).toBe(0);
        expect(items.rowCount).toBe(0);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
    // A relative_path is checked, though not kept: its length, and no control character.
    for (const bad of ['x'.repeat(1025), 'Bills\u0007/scan.pdf', 'Bills\n/scan.pdf']) {
      const res = await upload(d, randomUUID(), undefined, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      expect(res.json<{ error: { detail: string } }>().error.detail).toBe('relative_path');
    }
    expect(
      (await upload(d, randomUUID(), undefined, 'Pay slips/2026/ünïcode.pdf')).statusCode,
    ).toBe(201);
    // An Idempotency-Key is required, and a UUID.
    expect((await upload(d, null)).statusCode).toBe(422);
    expect((await upload(d, 'not-a-uuid')).statusCode).toBe(422);
  });

  it('a file sent again after midnight is still the item it made', async () => {
    const d = await pair(sara, 'Sara midnight');
    const key = randomUUID();
    const first = (await upload(d, key)).json<{ item_id: string }>();
    // Its batch made yesterday, as far as the vault can tell.
    await admin.query('update intake_batch set device_day = device_day - 1 where device_id = $1', [
      d.device_id,
    ]);
    const again = await upload(d, key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<{ item_id: string }>().item_id).toBe(first.item_id);
    // A new file today makes today's batch.
    expect((await upload(d)).statusCode).toBe(201);
    const days = await admin.query('select 1 from intake_batch where device_id = $1', [
      d.device_id,
    ]);
    expect(days.rowCount).toBe(2);
  });

  it('a teen’s computer files to the teen alone', async () => {
    const d = await pair(tariq, 'Tariq laptop');
    const sent = await upload(d);
    expect(sent.statusCode, sent.body).toBe(201);
    const mine = (await batchesOf(tariq)).filter((b) => b.name?.startsWith('From Tariq laptop'));
    expect(mine).toHaveLength(1);
    for (const t of [owner, ahmed, sara]) {
      expect((await batchesOf(t)).some((b) => b.id === mine[0]?.id)).toBe(false);
    }
    const row = await admin.query<{ requester_member_id: string; scope: string }>(
      'select requester_member_id, scope from incoming_file where id = $1',
      [sent.json<{ item_id: string }>().item_id],
    );
    expect(row.rows[0]).toEqual({ requester_member_id: tariq.member_id, scope: 'member' });
  });

  it('refusals the app can show: too large, a kind not taken, a full batch, a lock, a pause after a restore', async () => {
    const d = await pair(sara, 'Sara refusals');
    const big = await upload(d, randomUUID(), {
      bytes: Buffer.concat([PDF('BIG'), Buffer.alloc(6 * 1024 * 1024, 0x20)]),
      name: 'big.pdf',
      type: 'application/pdf',
    });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ error: { code: string } }>().error.code).toBe('too_large');
    const text = await upload(d, randomUUID(), {
      bytes: Buffer.from('just words'),
      name: 'notes.txt',
      type: 'text/plain',
    });
    expect(text.statusCode).toBe(415);
    expect(text.json<{ error: { code: string } }>().error.code).toBe('unsupported_type');

    // A full day: 200 in its batch.
    const first = await upload(d);
    expect(first.statusCode).toBe(201);
    await admin.query(
      `insert into incoming_file
       select (jsonb_populate_record(null::incoming_file,
                 to_jsonb(f) || jsonb_build_object('id', gen_random_uuid(),
                                                   'idempotency_key', gen_random_uuid(),
                                                   'storage_key', f.storage_key || '-' || n))).*
         from incoming_file f, generate_series(1, $2::int) n
        where f.id = $1`,
      [first.json<{ item_id: string }>().item_id, BATCH_MAX_FILES - 1],
    );
    const full = await upload(d);
    expect(full.statusCode).toBe(422);
    expect(full.json<{ error: { code: string } }>().error.code).toBe('batch_full');

    // Locked by an owner: refused, and said.
    await h.decider(owner);
    const locked = await send(owner, 'POST', `/api/v1/members/${sara.member_id}/lock`, {});
    expect(locked.statusCode, locked.body).toBe(200);
    expect((await me(d)).json<DeviceMe>()).toMatchObject({ active: false, paused: 'locked' });
    const refused = await upload(d);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('member_locked');
    await h.decider(owner);
    expect((await send(owner, 'DELETE', `/api/v1/members/${sara.member_id}/lock`)).statusCode).toBe(
      204,
    );
    // Her lock ended her sessions: she signs in again.
    sara = await signInAgain('sara-d1@example.test');

    // Waiting after a restore: refused, and said.
    await admin.query(
      `update account_household set suspended_at = now(), suspend_reason = 'restored'
        where member_id = $1`,
      [sara.member_id],
    );
    expect((await me(d)).json<DeviceMe>()).toMatchObject({
      active: false,
      paused: 'paused_after_restore',
    });
    const paused = await upload(d);
    expect(paused.statusCode).toBe(403);
    expect(paused.json<{ error: { code: string } }>().error.code).toBe('member_paused');
    await admin.query(
      `update account_household set suspended_at = null, suspend_reason = null where member_id = $1`,
      [sara.member_id],
    );
    expect((await me(d)).json<DeviceMe>().active).toBe(true);
  }, 60_000);

  // ------------------------------------------------------- managing them

  it('owners see every computer by name and person, never what it sent nor when somebody else used it', async () => {
    const d = await pair(ahmed, 'Ahmed listed');
    const sent = (await upload(d)).json<{ item_id: string }>();
    const asOwner = await send(owner, 'GET', '/api/v1/paired-devices');
    expect(asOwner.statusCode).toBe(200);
    const theirs = asOwner
      .json<{ items: PairedDevice[] }>()
      .items.find((x) => x.id === d.device_id);
    expect(theirs).toEqual({
      id: d.device_id,
      name: 'Ahmed listed',
      platform: 'windows',
      member_id: ahmed.member_id,
      member_name: 'Ahmed',
      mine: false,
      added_at: expect.any(String) as unknown,
      last_used_at: null,
    });
    expect(asOwner.body).not.toContain(sent.item_id);
    expect(asOwner.body).not.toContain('scan.pdf');
    expect(asOwner.body).not.toContain('From Ahmed');
    // Its person sees when it was last used.
    const own = (await send(ahmed, 'GET', '/api/v1/paired-devices'))
      .json<{ items: PairedDevice[] }>()
      .items.find((x) => x.id === d.device_id);
    expect(own).toMatchObject({ mine: true, last_used_at: expect.any(String) as unknown });
    // Another adult and a teen see their own alone.
    for (const t of [sara, tariq]) {
      const items = (await send(t, 'GET', '/api/v1/paired-devices')).json<{
        items: PairedDevice[];
      }>().items;
      expect(items.every((x) => x.member_id === t.member_id)).toBe(true);
    }
  });

  it('revoked by its person, or an owner, never another adult; a revoked key is 401 device_revoked; each with a line', async () => {
    const own = await pair(ahmed, 'Ahmed revoked');
    const byOwner = await pair(ahmed, 'Ahmed owner-revoked');
    // Another adult: not here.
    expect((await send(sara, 'DELETE', `/api/v1/paired-devices/${own.device_id}`)).statusCode).toBe(
      404,
    );
    expect((await me(own)).statusCode).toBe(200);
    expect(
      (await send(ahmed, 'DELETE', `/api/v1/paired-devices/${own.device_id}`)).statusCode,
    ).toBe(204);
    expect(
      (await send(owner, 'DELETE', `/api/v1/paired-devices/${byOwner.device_id}`)).statusCode,
    ).toBe(204);
    for (const d of [own, byOwner]) {
      const res = await me(d);
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('device_revoked');
      const up = await upload(d);
      expect(up.statusCode).toBe(401);
      expect(up.json<{ error: { code: string } }>().error.code).toBe('device_revoked');
    }
    // Once: a second revoke is not here.
    expect(
      (await send(ahmed, 'DELETE', `/api/v1/paired-devices/${own.device_id}`)).statusCode,
    ).toBe(404);
    const said = (await lines('computer.revoked', ahmed.member_id)).map((l) => l.detail);
    expect(said).toContainEqual({ name: 'Ahmed revoked', platform: 'windows', reason: 'member' });
    expect(said).toContainEqual({
      name: 'Ahmed owner-revoked',
      platform: 'windows',
      reason: 'owner',
    });
    // Nobody signed in un-revokes one, as themselves (0070's guard).
    const pool = createPool(h.appUrl, 1);
    try {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', 'owner', true), set_config('app.member_id', $2, true),
                  set_config('app.account_id', $3, true)`,
          [owner.household_id, owner.member_id, await accountOf(owner)],
        );
        const refused = await client
          .query(
            'update upload_device set revoked_at = null, revoked_reason = null where id = $1',
            [own.device_id],
          )
          .then(
            () => null,
            (e: { code?: string }) => e.code,
          );
        expect(refused).toBe('42501');
        await client.query('rollback');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('revoked as a sign-in is taken away, as somebody is made a viewer, and as an owner steps down to one — each with a line', async () => {
    await h.decider(owner);
    const kim = await h.join(owner, { name: 'Kim', email: 'kim-d1@example.test', role: 'adult' });
    const lea = await h.join(owner, { name: 'Lea', email: 'lea-d1@example.test', role: 'teen' });
    await h.decider(owner);
    const omar = await h.join(owner, {
      name: 'Omar',
      email: 'omar-d1@example.test',
      role: 'owner',
    });
    const kims = await pair(kim, 'Kim laptop');
    const leas = await pair(lea, 'Lea laptop');
    const omars = await pair(omar, 'Omar laptop');

    // A sign-in taken away.
    await h.decider(owner);
    expect(
      (await send(owner, 'DELETE', `/api/v1/members/${kim.member_id}/sign-in`)).statusCode,
    ).toBe(204);
    // Made a viewer: no longer able to add.
    await h.decider(owner);
    const demoted = await send(owner, 'POST', `/api/v1/members/${lea.member_id}/role`, {
      role: 'viewer',
    });
    expect(demoted.statusCode, demoted.body).toBe(200);
    // An owner who steps down to viewer themselves.
    await fresh(omar);
    const stepped = await send(omar, 'POST', '/api/v1/me/step-down', { role: 'viewer' });
    expect(stepped.statusCode, stepped.body).toBe(200);

    for (const [d, reason] of [
      [kims, 'sign_in_removed'],
      [leas, 'cannot_add'],
      [omars, 'cannot_add'],
    ] as const) {
      const res = await me(d);
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('device_revoked');
      const row = await admin.query<{ revoked_reason: string; revoked_by: string | null }>(
        'select revoked_reason, revoked_by from upload_device where id = $1',
        [d.device_id],
      );
      expect(row.rows[0]).toEqual({ revoked_reason: reason, revoked_by: null });
    }
    expect((await lines('computer.revoked', kim.member_id)).map((l) => l.detail)).toEqual([
      { name: 'Kim laptop', platform: 'windows', reason: 'sign_in_removed' },
    ]);
    expect((await lines('computer.revoked', lea.member_id)).map((l) => l.detail)).toEqual([
      { name: 'Lea laptop', platform: 'windows', reason: 'cannot_add' },
    ]);
    expect((await lines('computer.revoked', omar.member_id)).map((l) => l.detail)).toEqual([
      { name: 'Omar laptop', platform: 'windows', reason: 'cannot_add' },
    ]);
    // A sign-in given back, or a role given back, does not bring a key back.
    await h.decider(owner);
    const back = await send(owner, 'POST', `/api/v1/members/${kim.member_id}/sign-in`, {
      role: 'adult',
    });
    expect(back.statusCode, back.body).toBeLessThan(300);
    await h.decider(owner);
    expect(
      (await send(owner, 'POST', `/api/v1/members/${lea.member_id}/role`, { role: 'teen' }))
        .statusCode,
    ).toBe(200);
    expect((await me(kims)).statusCode).toBe(401);
    expect((await me(leas)).statusCode).toBe(401);
    // And a code waiting as somebody was made a viewer is forgotten.
    const waiting = await newCode(lea);
    await h.decider(owner);
    await send(owner, 'POST', `/api/v1/members/${lea.member_id}/role`, { role: 'viewer' });
    expect((await trade(waiting.code)).statusCode).toBe(401);
  }, 60_000);

  // ---------------------------------------------------------- the secrets

  it('neither a code nor a key is kept, logged or answered in plain form', async () => {
    const logged: string[] = [];
    const lh = await createHarness({
      rateLimitPerMinute: 100_000,
      logger: { level: 'trace', stream: { write: (s: string) => void logged.push(s) } },
    });
    try {
      const o = await lh.setup();
      const code = await lh.app.inject({
        method: 'POST',
        url: '/api/v1/device-pairings',
        headers: lh.as(o),
        payload: {},
      });
      expect(code.statusCode, code.body).toBe(201);
      const shown = code.json<DevicePairingCode>().code;
      const paired = (
        await lh.app.inject({
          method: 'POST',
          url: '/api/v1/devices/pair',
          payload: { code: shown, device_name: 'Logged', platform: 'macos' },
        })
      ).json<DevicePaired>();
      const form = new FormData();
      form.append('file', PDF('LOGGED'), { filename: 'l.pdf', contentType: 'application/pdf' });
      const sent = await lh.app.inject({
        method: 'POST',
        url: '/api/v1/device-uploads',
        headers: {
          authorization: `Device ${paired.device_id}.${paired.key}`,
          ...form.getHeaders(),
          'idempotency-key': randomUUID(),
        },
        payload: form.getBuffer(),
      });
      expect(sent.statusCode, sent.body).toBe(201);
      // A refusal with the key, on another route: its words say nothing of it.
      const refused = await lh.app.inject({
        url: '/api/v1/documents',
        headers: { authorization: `Device ${paired.device_id}.${paired.key}` },
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.body).not.toContain(paired.key);
      const log = logged.join('\n');
      expect(log.length).toBeGreaterThan(0);
      for (const secret of [shown, shown.replace('-', ''), paired.key]) {
        expect(log).not.toContain(secret);
      }
      // The database: no table holds either, in any column.
      const lAdmin = createPool(lh.adminUrl, 1);
      try {
        const tables = await lAdmin.query<{ t: string }>(
          `select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'pgboss') and c.relkind = 'r'`,
        );
        for (const { t } of tables.rows) {
          const rows = await lAdmin.query<{ row: string }>(
            `select to_jsonb(x)::text as row from ${t} x`,
          );
          for (const r of rows.rows) {
            for (const secret of [shown.replace('-', ''), paired.key]) {
              expect(r.row, t).not.toContain(secret);
            }
          }
        }
        // What is kept is the key's SHA-256, and no answer carries it.
        const kept = await lAdmin.query<{ key_hash: Buffer }>(
          'select key_hash from upload_device where id = $1',
          [paired.device_id],
        );
        const hash = kept.rows[0]?.key_hash as Buffer;
        expect(hash.equals(deviceKeyHash(paired.device_id, paired.key))).toBe(true);
        const listed = await lh.app.inject({
          url: '/api/v1/paired-devices',
          headers: lh.as(o),
        });
        const meRes = await lh.app.inject({
          url: '/api/v1/devices/me',
          headers: { authorization: `Device ${paired.device_id}.${paired.key}` },
        });
        for (const body of [listed.body, meRes.body, sent.body, code.body]) {
          expect(body).not.toContain(hash.toString('hex'));
          expect(body).not.toContain(hash.toString('base64'));
          expect(body).not.toContain(paired.key);
        }
      } finally {
        await lAdmin.end();
      }
    } finally {
      await lh.close();
    }
  }, 60_000);

  it('the pairing dialog is told where the uploader app is, when the vault says', async () => {
    const dh = await createHarness({ desktopDownloadUrl: 'https://example.test/uploader' });
    try {
      const o = await dh.setup();
      const res = await dh.app.inject({
        method: 'POST',
        url: '/api/v1/device-pairings',
        headers: dh.as(o),
        payload: {},
      });
      expect(res.json<DevicePairingCode>().download_url).toBe('https://example.test/uploader');
    } finally {
      await dh.close();
    }
  });
});

/**
 * Every route the API answers, as Fastify's router holds it: one tree a
 * method (as release-exit.test.ts reads it).
 */
function routeTable(h: Harness): Array<{ method: string; url: string }> {
  const out: Array<{ method: string; url: string }> = [];
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const tree = h.app.printRoutes({ method: method as 'GET', commonPrefix: false });
    const stack: string[] = [];
    for (const line of tree.split('\n')) {
      const m = /^([│ ]*)(?:├── |└── )(.*?)(?: \(([A-Z, ]+)\))?$/.exec(line.replace(/\r$/, ''));
      if (!m) continue;
      const depth = (m[1] as string).length / 4;
      stack.length = depth;
      stack.push(m[2] as string);
      if (
        (m[3] ?? '')
          .split(',')
          .map((s) => s.trim())
          .includes(method)
      ) {
        out.push({ method, url: stack.join('') });
      }
    }
  }
  return out;
}
