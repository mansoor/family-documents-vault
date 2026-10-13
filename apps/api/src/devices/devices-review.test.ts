import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  PAIRING_ALPHABET,
  type DeviceMe,
  type DevicePaired,
  type DevicePairingCode,
  type PairedDevice,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../auth/service.js';
import { alertsSent, createHarness, type Harness } from '../test-harness.js';
import { COMPUTERS_STOPPED } from './service.js';

/**
 * The D1 review's findings (0.8.0): an upload that never ends, the
 * emergency controls, a key revoked or a sign-in taken away mid-upload,
 * pairing's timing, rate and lock order, the key's row fixed, last use,
 * empty batches, a day's room, ending a code, and the email's words.
 */

const PDF = (marker: string, pad = 0) =>
  Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n`,
    ),
    Buffer.alloc(pad, 0x20),
    Buffer.from('trailer<</Root 1 0 R>>\n%%EOF\n'),
  ]);

let peers = 0;
const peer = () => ({ remoteAddress: `10.73.${(peers >> 8) & 0xff}.${peers++ & 0xff}` });

/** Until `ok` says so, or `ms` have passed. */
async function until(ok: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await ok()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!testAdminUrl())('the D1 review (0.8.0)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let base: string;
  let owner: Tokens;
  let ahmed: Tokens;
  /** Every query the API runs while a test listens. */
  let heard: string[] | null = null;

  const send = (t: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(t),
      ...(payload === undefined ? {} : { payload: payload as never }),
      ...peer(),
    });
  const fresh = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now()
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
  const trade = (code: string, name = 'Laptop', from = peer()) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { code, device_name: name, platform: 'windows' },
      ...from,
    });
  const pair = async (t: Tokens, name = 'Laptop') => {
    const res = await trade((await newCode(t)).code, name);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<DevicePaired>();
  };
  const keyOf = (d: DevicePaired) => ({ authorization: `Device ${d.device_id}.${d.key}` });
  const upload = (
    d: DevicePaired,
    bytes = PDF('SCAN'),
    name = 'scan.pdf',
    type = 'application/pdf',
  ) => {
    const form = new FormData();
    form.append('file', bytes, { filename: name, contentType: type });
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/device-uploads',
      headers: { ...keyOf(d), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
      ...peer(),
    });
  };
  const me = (d: DevicePaired) =>
    h.app.inject({ url: '/api/v1/devices/me', headers: keyOf(d), ...peer() });
  const codeOf = (r: { json: () => unknown }) =>
    (r.json() as { error?: { code?: string } }).error?.code;
  const uploading = async () =>
    Number(
      (
        await admin.query<{ n: string }>(
          "select count(*) as n from incoming_file where state = 'uploading'",
        )
      ).rows[0]?.n,
    );
  /** Every object a batch's item keeps, on disk: none without its row. */
  const strayObjects = async () => {
    const all: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (p.includes(`${path.sep}batches${path.sep}`)) all.push(p);
      }
    };
    await walk(h.vaultDir);
    const kept = new Set(
      (
        await admin.query<{ storage_key: string }>('select storage_key from incoming_file')
      ).rows.map((r) => r.storage_key),
    );
    return all.filter(
      (p) => ![...kept].some((k) => p.replace(/\\/g, '/').endsWith(k.replace(/\\/g, '/'))),
    );
  };
  /**
   * A multipart upload over a real connection, the file part sent in two
   * pieces: `between` runs once the first is in (a row on its way), and
   * then the rest is sent — or, with `abort`, the connection is cut.
   */
  const rawUpload = (opts: {
    path: string;
    headers: Record<string, string>;
    between: () => Promise<void>;
    abort?: boolean;
  }): Promise<{ status: number; body: string } | 'cut'> => {
    const boundary = `b${randomUUID().replace(/-/g, '')}`;
    const file = PDF('RAW', 200_000);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="raw.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const half = 100_000;
    return new Promise((resolve, reject) => {
      const req = request(`${base}${opts.path}`, {
        method: 'POST',
        headers: {
          ...opts.headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(head.length + file.length + tail.length),
        },
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', (e) => (opts.abort ? resolve('cut') : reject(e)));
      req.write(Buffer.concat([head, file.subarray(0, half)]));
      void opts
        .between()
        .then(() => {
          if (opts.abort) {
            req.destroy();
            resolve('cut');
            return;
          }
          req.end(Buffer.concat([file.subarray(half), tail]));
        })
        .catch(reject);
    });
  };
  const principalOf = async (t: Tokens): Promise<Principal> => ({
    accountId: (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [t.member_id],
      )
    ).rows[0]?.account_id as string,
    sessionId: '',
    householdId: t.household_id,
    memberId: t.member_id,
    role: t.role,
    seesAdults: true,
  });

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      deviceDailyBytes: 3000,
      log: (e) => {
        if (e.level === 'query') heard?.push(e.query.sql);
      },
    });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-r@example.test', role: 'adult' });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const at = h.app.server.address();
    if (!at || typeof at === 'string') throw new Error('not listening');
    base = `http://127.0.0.1:${at.port}`;
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  // ------------------------------------------------------------------ F1

  it('F1: a second relative_path is refused in words, at once, and leaves nothing', async () => {
    const d = await pair(ahmed, 'Twice');
    const form = new FormData();
    form.append('relative_path', 'a/one.pdf');
    form.append('relative_path', 'a/two.pdf');
    form.append('file', PDF('TWICE'), { filename: 'twice.pdf', contentType: 'application/pdf' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/device-uploads',
      headers: { ...keyOf(d), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
      ...peer(),
    });
    expect(res.statusCode).toBe(422);
    expect(codeOf(res)).toBe('validation_failed');
    expect(await uploading()).toBe(0);
    expect(await strayObjects()).toEqual([]);
  });

  it('F1: a stream already ended, or ended part way, is refused and leaves no row and no object', async () => {
    const p = await principalOf(ahmed);
    const batch = (await send(ahmed, 'POST', '/api/v1/batches', { name: 'Streams' })).json<{
      id: string;
    }>().id;
    const gone = new Readable({ read() {} });
    gone.destroy();
    const part = new Readable({ read() {} });
    part.push(PDF('PART', 50_000).subarray(0, 20_000));
    setTimeout(() => part.destroy(), 50);
    for (const stream of [gone, part]) {
      await expect(
        h.batches.addItem(
          p,
          batch,
          {
            filename: 'x.pdf',
            mime: 'application/pdf',
            stream,
            idempotencyKey: randomUUID(),
            truncated: () => false,
            finished: async () => undefined,
          },
          {},
        ),
      ).rejects.toMatchObject({ code: 'upload_incomplete' });
    }
    expect(await uploading()).toBe(0);
    expect(await strayObjects()).toEqual([]);
  });

  it('F1: a sender gone part way — a computer, or a batch’s own route — leaves no row and no object', async () => {
    const d = await pair(ahmed, 'Gone');
    const cut = await rawUpload({
      path: '/api/v1/device-uploads',
      headers: { ...keyOf(d), 'idempotency-key': randomUUID() },
      between: async () => {
        expect(await until(async () => (await uploading()) === 1)).toBe(true);
      },
      abort: true,
    });
    expect(cut).toBe('cut');
    expect(await until(async () => (await uploading()) === 0)).toBe(true);
    const batch = (await send(ahmed, 'POST', '/api/v1/batches', { name: 'Cut' })).json<{
      id: string;
    }>().id;
    await rawUpload({
      path: `/api/v1/batches/${batch}/items`,
      headers: { ...h.as(ahmed), 'idempotency-key': randomUUID() },
      between: async () => {
        expect(await until(async () => (await uploading()) === 1)).toBe(true);
      },
      abort: true,
    });
    expect(await until(async () => (await uploading()) === 0)).toBe(true);
    expect(await until(async () => (await strayObjects()).length === 0)).toBe(true);
  }, 30_000);

  // ------------------------------------------------------------------ F3

  it('F3: a key revoked while its file arrives lands nothing', async () => {
    const d = await pair(ahmed, 'Revoked mid-way');
    const res = await rawUpload({
      path: '/api/v1/device-uploads',
      headers: { ...keyOf(d), 'idempotency-key': randomUUID() },
      between: async () => {
        expect(await until(async () => (await uploading()) === 1)).toBe(true);
        await fresh(ahmed);
        expect(
          (await send(ahmed, 'DELETE', `/api/v1/paired-devices/${d.device_id}`)).statusCode,
        ).toBe(204);
      },
    });
    expect(res).toMatchObject({ status: 401 });
    expect(
      (JSON.parse((res as { body: string }).body) as { error: { code: string } }).error.code,
    ).toBe('device_revoked');
    expect(await uploading()).toBe(0);
    const landed = await admin.query(
      `select 1 from incoming_file f join intake_batch b on b.id = f.batch_id where b.device_id = $1`,
      [d.device_id],
    );
    expect(landed.rowCount).toBe(0);
    expect(await strayObjects()).toEqual([]);
  }, 30_000);

  it('F3: a sign-in taken away while a file arrives lands nothing', async () => {
    await h.decider(owner);
    const sami = await h.join(owner, { name: 'Sami', email: 'sami-r@example.test', role: 'adult' });
    const batch = (await send(sami, 'POST', '/api/v1/batches', { name: 'Mid-way' })).json<{
      id: string;
    }>().id;
    const res = await rawUpload({
      path: `/api/v1/batches/${batch}/items`,
      headers: { ...h.as(sami), 'idempotency-key': randomUUID() },
      between: async () => {
        expect(await until(async () => (await uploading()) === 1)).toBe(true);
        await h.decider(owner);
        expect(
          (await send(owner, 'DELETE', `/api/v1/members/${sami.member_id}/sign-in`)).statusCode,
        ).toBe(204);
      },
    });
    expect(res).toMatchObject({ status: 403 });
    expect(await uploading()).toBe(0);
    const kept = await admin.query(
      "select 1 from incoming_file where batch_id = $1 and state = 'received'",
      [batch],
    );
    expect(kept.rowCount).toBe(0);
    expect(await strayObjects()).toEqual([]);
  }, 30_000);

  // ------------------------------------------------------------------ F2

  it('F2: signed out everywhere, or a password stopped by an owner: every computer stops, with a line, and they are told', async () => {
    await h.decider(owner);
    const lina = await h.join(owner, { name: 'Lina', email: 'lina-r@example.test', role: 'adult' });
    const linas = await pair(lina, 'Lina laptop');
    await h.decider(owner);
    const out = await send(owner, 'DELETE', `/api/v1/members/${lina.member_id}/sessions`);
    expect(out.statusCode, out.body).toBe(200);
    expect(codeOf(await me(linas))).toBe('device_revoked');
    const told = alertsSent(h).filter((a) => String(a.subject).includes('signed you out'));
    expect(String(told.at(-1)?.body)).toContain(COMPUTERS_STOPPED);

    await h.decider(owner);
    const omar = await h.join(owner, { name: 'Omar', email: 'omar-r@example.test', role: 'adult' });
    const omars = await pair(omar, 'Omar laptop');
    await h.decider(owner);
    const stopped = await send(owner, 'POST', `/api/v1/members/${omar.member_id}/password-reset`, {
      stop_now: true,
    });
    expect(stopped.statusCode, stopped.body).toBeLessThan(300);
    expect(codeOf(await me(omars))).toBe('device_revoked');
    const rows = await admin.query<{ id: string; revoked_reason: string }>(
      'select id, revoked_reason from upload_device where id = any($1)',
      [[linas.device_id, omars.device_id]],
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.revoked_reason]))).toEqual({
      [linas.device_id]: 'signed_out',
      [omars.device_id]: 'signed_out',
    });
    const lines = await admin.query<{ object_id: string; detail: { reason: string } }>(
      "select object_id, detail from audit_event where action = 'computer.revoked' and object_id = any($1)",
      [[lina.member_id, omar.member_id]],
    );
    expect(lines.rows.map((l) => l.detail.reason).sort()).toEqual(['signed_out', 'signed_out']);
    // The reset's link, by email: spent, it stops nothing more, and says so.
    const link = alertsSent(h)
      .map((a) => a.url)
      .filter((u): u is string => typeof u === 'string' && u.includes('/reset#'))
      .at(-1);
    expect(link).toBeTruthy();
    expect(String(alertsSent(h).find((a) => a.url === link)?.body)).toContain(COMPUTERS_STOPPED);
  }, 60_000);

  it('F2: a password changed, or reset with a link, stops every computer, with a line, and says so', async () => {
    await h.decider(owner);
    const kim = await h.join(owner, { name: 'Kim', email: 'kim-r@example.test', role: 'adult' });
    const first = await pair(kim, 'Kim laptop');
    const changed = await send(kim, 'POST', '/api/v1/auth/password/change', {
      current_password: 'another correct horse',
      new_password: 'a brand new long password',
    });
    expect(changed.statusCode, changed.body).toBe(204);
    expect(codeOf(await me(first))).toBe('device_revoked');
    const toldChange = alertsSent(h).filter((a) => a.subject === 'Your vault password was changed');
    expect(String(toldChange.at(-1)?.body)).toContain(COMPUTERS_STOPPED);

    // Reset with a link: the forgotten-password path, spent by nobody signed in.
    const again = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'kim-r@example.test', password: 'a brand new long password' },
        ...peer(),
      })
    ).json<Tokens>();
    const second = await pair(again, 'Kim desktop');
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email: 'kim-r@example.test' },
      ...peer(),
    });
    const link = alertsSent(h)
      .map((a) => a.url)
      .filter((u): u is string => typeof u === 'string' && u.includes('/reset#'))
      .at(-1) as string;
    const token = link.slice(link.indexOf('#') + 1);
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/v1/password-resets/complete',
      payload: { token, password: 'and another long password' },
      ...peer(),
    });
    expect(reset.statusCode, reset.body).toBeLessThan(300);
    expect(codeOf(await me(second))).toBe('device_revoked');
    const toldReset = alertsSent(h).filter((a) => a.subject === 'Your vault password was reset');
    expect(String(toldReset.at(-1)?.body)).toContain(COMPUTERS_STOPPED);
    const lines = await admin.query<{ detail: { name: string; reason: string } }>(
      "select detail from audit_event where action = 'computer.revoked' and object_id = $1 order by id",
      [kim.member_id],
    );
    expect(lines.rows.map((l) => l.detail)).toEqual([
      { name: 'Kim laptop', platform: 'windows', reason: 'password_changed' },
      { name: 'Kim desktop', platform: 'windows', reason: 'password_changed' },
    ]);
    // And the line reads as a sentence, to Kim.
    const now = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'kim-r@example.test', password: 'and another long password' },
        ...peer(),
      })
    ).json<Tokens>();
    const log = (await send(now, 'GET', '/api/v1/audit?limit=100')).body;
    expect(log).toContain(
      'changed their password, so their computer “Kim laptop” can no longer send scans',
    );
  }, 60_000);

  // ------------------------------------------------------------------ F4, F5

  it('F4: a first half that names no code does the work one that does would', async () => {
    const live = await newCode(ahmed);
    const wrongLive = `${live.code.slice(0, 5)}${[...PAIRING_ALPHABET].find((c) => c !== live.code[5])}${live.code.slice(6)}`;
    const nobody = `${[...PAIRING_ALPHABET].find((c) => c !== live.code[0])}${live.code.slice(1)}`;
    const work = async (code: string) => {
      heard = [];
      expect((await trade(code)).statusCode).toBe(401);
      const said = heard;
      heard = null;
      return {
        held: said.filter((q) => /from "device_pairing".*for update/is.test(q)).length,
        counted: said.filter((q) => /^update "device_pairing"/i.test(q)).length,
      };
    };
    expect(await work(nobody)).toEqual(await work(wrongLive));
    expect((await work(nobody)).held).toBeGreaterThan(0);
  });

  it('F4: the pairing limit counts an IPv6 /64 as one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await trade('AAAA-AAAA', 'Guess', {
        remoteAddress: `2001:db8:77:5::${(i + 1).toString(16)}`,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
    // Another /64 is another address.
    expect(
      (await trade('AAAA-AAAA', 'Guess', { remoteAddress: '2001:db8:77:6::1' })).statusCode,
    ).toBe(401);
  });

  it('F5: pairing holds the person before the code, as every change to a person does', async () => {
    const { code } = await newCode(ahmed);
    heard = [];
    expect((await trade(code, 'Ordered')).statusCode).toBe(201);
    const said = heard;
    heard = null;
    const person = said.findIndex((q) => /from "account_household".*for share/is.test(q));
    const theCode = said.findIndex((q) => /from "device_pairing".*for update/is.test(q));
    expect(person).toBeGreaterThan(-1);
    expect(theCode).toBeGreaterThan(person);
  });

  // ------------------------------------------------------------------ F6

  it('F6: a revoked key never changes, and a key’s hash and whose it is never change, whoever asks', async () => {
    const d = await pair(ahmed, 'Fixed');
    const other = await admin.query<{ account_id: string; member_id: string }>(
      'select account_id, member_id from account_household where member_id = $1',
      [owner.member_id],
    );
    const theirs = other.rows[0] as { account_id: string; member_id: string };
    // As the owning role, with no caller named: the vault's own rights.
    const tryAs = (set: string, ...values: unknown[]) =>
      admin.query(`update upload_device set ${set} where id = $1`, [d.device_id, ...values]).then(
        () => 'changed',
        (e: { code?: string }) => e.code,
      );
    expect(await tryAs('key_hash = $2', Buffer.alloc(32))).toBe('42501');
    expect(await tryAs('account_id = $2', theirs.account_id)).toBe('42501');
    expect(await tryAs('member_id = $2', theirs.member_id)).toBe('42501');
    expect(await tryAs("name = 'Renamed'")).toBe('42501');
    // When it last sent something, and its revocation, do change — once.
    expect(await tryAs('last_used_at = now()')).toBe('changed');
    expect(await tryAs("revoked_at = now(), revoked_reason = 'owner'")).toBe('changed');
    expect(await tryAs('revoked_at = null, revoked_reason = null')).toBe('42501');
    expect(await tryAs("revoked_reason = 'member'")).toBe('42501');
    expect(await tryAs('last_used_at = now()')).toBe('42501');
  });

  // ------------------------------------------------------------------ F8

  it('F8: last used is when it last sent something, never when it asked', async () => {
    const d = await pair(ahmed, 'Last sent');
    expect((await me(d)).statusCode).toBe(200);
    const after = async () =>
      (
        await admin.query<{ last_used_at: Date | null }>(
          'select last_used_at from upload_device where id = $1',
          [d.device_id],
        )
      ).rows[0]?.last_used_at ?? null;
    expect(await after()).toBeNull();
    expect((await upload(d)).statusCode).toBe(201);
    expect(await after()).toBeInstanceOf(Date);
  });

  it('F8: a first file refused leaves no empty batch for the day', async () => {
    const d = await pair(ahmed, 'Refused first');
    const res = await upload(d, Buffer.from('just words'), 'notes.txt', 'text/plain');
    expect(res.statusCode).toBe(415);
    const batches = await admin.query('select 1 from intake_batch where device_id = $1', [
      d.device_id,
    ]);
    expect(batches.rowCount).toBe(0);
  });

  it('F8: a day’s room for a computer, refused once full as device_day_full', async () => {
    const d = await pair(ahmed, 'Daily room');
    expect(d.key.length).toBe(43);
    expect((await me(d)).json<DeviceMe>().limits.daily_bytes).toBe(3000);
    expect((await upload(d, PDF('ONE', 1500))).statusCode).toBe(201);
    // Past the room: refused as it arrives, and nothing kept.
    const over = await upload(d, PDF('TWO', 1500));
    expect(over.statusCode).toBe(422);
    expect(codeOf(over)).toBe('device_day_full');
    expect(await uploading()).toBe(0);
    // Within it still: taken.
    expect((await upload(d, PDF('SMALL'))).statusCode).toBe(201);
    // Full: refused before a byte is kept.
    await admin.query(
      `update incoming_file f set byte_size = 3000 from intake_batch b
        where b.id = f.batch_id and b.device_id = $1`,
      [d.device_id],
    );
    const full = await upload(d, PDF('THREE'));
    expect(codeOf(full)).toBe('device_day_full');
  });

  it('F8: a code is ended when its dialog closes, and the email says which computer, and when', async () => {
    const { code } = await newCode(ahmed);
    expect((await send(ahmed, 'DELETE', '/api/v1/device-pairings')).statusCode).toBe(204);
    expect((await trade(code)).statusCode).toBe(401);
    // A viewer has no code to end.
    await h.decider(owner);
    const vic = await h.join(owner, { name: 'Vic', email: 'vic-r@example.test', role: 'viewer' });
    expect((await send(vic, 'DELETE', '/api/v1/device-pairings')).statusCode).toBe(403);
    const before = alertsSent(h).length;
    const d = await pair(ahmed, 'Emailed');
    const told = alertsSent(h).slice(before);
    expect(String(told[0]?.body)).toMatch(
      /A computer was added to your sign-in: Emailed \(Windows\), on \w+day \d+ \w+ at \d\d:\d\d \(UTC\)\./,
    );
    const list = (await send(ahmed, 'GET', '/api/v1/paired-devices')).json<{
      items: PairedDevice[];
    }>();
    expect(list.items.some((x) => x.id === d.device_id)).toBe(true);
  });
});
