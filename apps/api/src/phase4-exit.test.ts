import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DeviceRow, DocumentView, OfflineSet, Tokens } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './test-harness.js';

/**
 * The Phase 4 exit (4.18): the routes a phone uses, attacked together
 * rather than one iteration at a time — a capture tried a hundred ways at
 * once, a second adult on every phone route after the first adult's
 * private documents, a lost phone signed out, a thief with a refresh
 * token, and push addresses aimed at the vault's own network.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const BOUNDARY = 'fdv-exit-boundary';
const HEAD = Buffer.from(
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="slow.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
);
const TAIL = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);

const OWNER = { email: 'owner@example.test', password: 'correct horse battery' };
const LEE = { email: 'lee-exit@example.test', password: 'lee correct horse battery' };
/** The first adult's private Essential: its title must reach nobody else. */
const SECRET = 'Anna Example sealed will';
const APP = 'FamilyDocumentVault/0.2.0 (Android 15; Google Pixel 8a)';

/** A small seeded generator: a failure names its seed, and FDV_EXIT_SEED runs it again. */
function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!testAdminUrl())('the Phase 4 exit', () => {
  let h: Harness;
  let owner: Tokens;
  let admin: ReturnType<typeof createPool>;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.84.${Math.floor(++nth / 200)}.${nth % 200}` });

  const signIn = async (
    who: { email: string; password: string },
    installation: string | null = randomUUID(),
  ): Promise<Tokens> => {
    const res = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: {
        'user-agent': APP,
        ...(installation ? { 'x-fdv-installation': installation } : {}),
      },
      payload: who,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };

  const capture = (who: Tokens, key: string) => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': key },
      payload: form.getBuffer(),
    });
  };

  /** A capture whose bytes arrive only when told: finished, or its connection gone. */
  const held = (who: Tokens, key: string) => {
    const body = new PassThrough();
    body.write(HEAD);
    body.write(PDF.subarray(0, 10));
    const response = h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': key,
      },
      payload: body,
    });
    return {
      response,
      finish: () => {
        body.write(PDF.subarray(10));
        body.end(TAIL);
      },
      drop: () => body.destroy(new Error('the connection went')),
    };
  };

  const uploadStatus = (who: Tokens, key: string) =>
    h.app.inject({ url: `/api/v1/uploads/${key}`, headers: h.as(who) });

  const documentCount = async (who: Tokens) =>
    Number(
      (
        await admin.query<{ n: string }>(
          'select count(*) as n from document where household_id = $1',
          [who.household_id],
        )
      ).rows[0]?.n,
    );

  /** Temporary objects still in the vault: a failed try leaves none. */
  const incoming = async (): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (full.split(path.sep).includes('incoming')) found.push(full);
      }
    };
    await walk(h.vaultDir);
    return found;
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    // The second adult, who signs in on a phone of their own in the tests.
    await h.join(owner, {
      name: 'Lee',
      email: LEE.email,
      role: 'adult',
      password: LEE.password,
    });
    admin = createPool(h.adminUrl, 2);
    h.dns.set('ntfy.example.test', ['93.184.216.34']);
    h.dns.set('router.example.test', ['192.168.1.1']);
    h.dns.set('metadata.example.test', ['169.254.169.254']);
    h.dns.set('rebind.example.test', ['93.184.216.34', '127.0.0.1']);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('100 randomised retries and overlaps of one capture make one document', async () => {
    const seed = Number(process.env.FDV_EXIT_SEED ?? Date.now() % 1_000_000);
    const rand = seeded(seed);
    const key = randomUUID();
    const before = await documentCount(owner);
    const made = new Set<string>();
    const seen: number[] = [];
    for (let wave = 0; wave < 10; wave += 1) {
      const tries = Array.from({ length: 10 }, async () => {
        if (rand() < 0.4) return capture(owner, key);
        const t = held(owner, key);
        const drop = rand() < 0.4;
        const after = Math.floor(rand() * 40);
        setTimeout(() => (drop ? t.drop() : t.finish()), after);
        return t.response.catch(() => null);
      });
      for (const res of await Promise.all(tries)) {
        if (!res) continue;
        seen.push(res.statusCode);
        if (res.statusCode === 201) made.add(res.json<{ document_id: string }>().document_id);
        // Every answer is one a phone can act on: made, or on its way, or try again.
        expect([201, 400, 409, 413, 422], `seed ${seed}`).toContain(res.statusCode);
      }
    }
    // Once no try is running, the same capture is answered with what it made.
    await expect
      .poll(async () => {
        const s = await uploadStatus(owner, key);
        return s.statusCode === 200 ? s.json<{ state: string }>().state : 'none';
      })
      .not.toBe('in_progress');
    const last = await capture(owner, key);
    expect(last.statusCode, `seed ${seed}`).toBe(201);
    made.add(last.json<{ document_id: string }>().document_id);
    expect([...made], `seed ${seed}; answers ${seen.join(',')}`).toHaveLength(1);
    expect(await documentCount(owner), `seed ${seed}`).toBe(before + 1);
    expect(await incoming(), `seed ${seed}`).toEqual([]);
  }, 180_000);

  it("no phone route — capture replay, /uploads, /pages, /offline/*, /devices, offline opens — gives the second adult anything of the first adult's private documents", async () => {
    // The first adult's private Essential, drawn, captured under a key, on a phone that keeps it.
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: {
        title: SECRET,
        type_key: 'will',
        owner_member_id: owner.member_id,
        visibility: 'private',
        is_essential: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const docId = created.json<DocumentView>().id;
    const versionKey = randomUUID();
    const form = new FormData();
    form.append('file', PDF, { filename: 'will.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docId}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': versionKey },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    const versionId = up.json<{ id: string }>().id;
    // A scan filed Only me from the phone, its details sent with the file (4.3b).
    const captureKey = randomUUID();
    const scan = new FormData();
    scan.append(
      'metadata',
      JSON.stringify({
        title: `${SECRET} (scan)`,
        type_key: 'will',
        owner_member_id: owner.member_id,
        visibility: 'private',
      }),
    );
    scan.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const captured = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: { ...h.as(owner), ...scan.getHeaders(), 'idempotency-key': captureKey },
      payload: scan.getBuffer(),
    });
    expect(captured.statusCode, captured.body).toBe(201);
    const capturedDoc = captured.json<{ document_id: string; version_id: string }>();
    const filed = await admin.query<{ visibility: string }>(
      'select visibility from document where id = any($1)',
      [[docId, capturedDoc.document_id]],
    );
    expect(filed.rows.map((r) => r.visibility)).toEqual(['private', 'private']);
    const ownerPhone = await signIn(OWNER);
    const ownerGrant = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/offline/grant',
      headers: h.as(ownerPhone),
      payload: { password: OWNER.password, include_private: true },
    });
    expect(ownerGrant.statusCode, ownerGrant.body).toBe(200);
    const ownerDevice = await h.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: h.as(ownerPhone),
      payload: {
        kind: 'unified_push',
        endpoint: `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`,
        keys: { p256dh: 'owner-p256dh', auth: 'owner-auth' },
      },
    });
    expect(ownerDevice.statusCode, ownerDevice.body).toBe(201);
    const ownerDeviceId = ownerDevice.json<{ id: string }>().id;

    // The second adult, on their own phone, asks for all of it.
    const leePhone = await signIn(LEE);
    const leeGrant = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/offline/grant',
      headers: h.as(leePhone),
      payload: { password: LEE.password, include_private: true },
    });
    expect(leeGrant.statusCode, leeGrant.body).toBe(200);
    const ids = [docId, versionId, capturedDoc.document_id, capturedDoc.version_id, ownerDeviceId];
    const answers: { what: string; status: number; body: string }[] = [];
    const ask = async (what: string, res: { statusCode: number; body: string }) => {
      answers.push({ what, status: res.statusCode, body: res.body });
      return res;
    };

    // Capture replay, with the first adult's keys.
    for (const key of [captureKey, versionKey]) {
      const r = await ask(`capture ${key}`, await capture(leePhone, key));
      expect([201, 409]).toContain(r.statusCode);
      if (r.statusCode === 201) expect(r.body).not.toContain(capturedDoc.document_id);
    }
    // Upload status, by the first adult's keys.
    for (const key of [captureKey, versionKey]) {
      expect((await ask(`uploads ${key}`, await uploadStatus(leePhone, key))).statusCode).toBe(404);
    }
    // The pages, online and for the phone's copy.
    for (const v of [versionId, capturedDoc.version_id]) {
      for (const url of [`/api/v1/versions/${v}/pages/1`, `/api/v1/offline/pages/${v}/1`]) {
        const r = await ask(url, await h.app.inject({ url, headers: h.as(leePhone) }));
        expect(r.statusCode, url).toBe(404);
      }
    }
    // What the second adult's phone may keep.
    const set = await ask(
      'offline essentials',
      await h.app.inject({ url: '/api/v1/offline/essentials', headers: h.as(leePhone) }),
    );
    expect(set.statusCode).toBe(200);
    expect(JSON.parse(set.body) as OfflineSet).toMatchObject({
      grant: expect.anything() as unknown,
    });
    // Devices: not listed, not tested.
    const devices = await ask(
      'devices',
      await h.app.inject({ url: '/api/v1/devices', headers: h.as(leePhone) }),
    );
    expect(
      (JSON.parse(devices.body) as { items: DeviceRow[] }).items.map((d) => d.id),
    ).not.toContain(ownerDeviceId);
    const test = await ask(
      'device test',
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/devices/${ownerDeviceId}/test`,
        headers: h.as(leePhone),
      }),
    );
    expect(test.statusCode).toBe(404);
    // Offline opens of the first adult's version: not recorded as anything of theirs.
    const opens = await ask(
      'offline opens',
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/offline/opens',
        headers: h.as(leePhone),
        payload: {
          events: [
            {
              id: randomUUID(),
              version_id: versionId,
              opened_at: new Date().toISOString(),
              mode: 'view',
              online: false,
            },
          ],
        },
      }),
    );
    expect(opens.statusCode, opens.body).toBeLessThan(500);
    expect(JSON.parse(opens.body) as { accepted?: number }).not.toMatchObject({ accepted: 1 });
    // The activity log as the second adult sees it.
    await ask('audit', await h.app.inject({ url: '/api/v1/audit', headers: h.as(leePhone) }));

    // Nothing anywhere carries the title, or an id of the first adult's.
    for (const a of answers) {
      expect(a.body, a.what).not.toContain(SECRET);
      for (const id of ids) expect(a.body, `${a.what} leaks ${id}`).not.toContain(id);
    }
  }, 120_000);

  it('revoking a phone ends its grant, its devices and its session together', async () => {
    const phone = await signIn(OWNER);
    const granted = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/offline/grant',
      headers: h.as(phone),
      payload: { password: OWNER.password },
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const endpoint = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
    const registered = await h.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: h.as(phone),
      payload: { kind: 'unified_push', endpoint, keys: { p256dh: 'p', auth: 'a' } },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const sid = (
      JSON.parse(
        Buffer.from(phone.access_token.split('.')[1] as string, 'base64url').toString(),
      ) as {
        sid: string;
      }
    ).sid;

    const revoked = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${sid}`,
      headers: h.as(owner),
    });
    expect(revoked.statusCode).toBe(204);

    // The session: its token no longer works, and says why.
    const after = await h.app.inject({ url: '/api/v1/offline/essentials', headers: h.as(phone) });
    expect(after.statusCode).toBe(401);
    // Its grant and its devices went with it, in the same transaction.
    // (The grant is the session's: it ends with it, and the owner's list of
    // devices — the one that says which keep Essentials — no longer has it.)
    const session = await admin.query<{ revoked_at: Date | null }>(
      'select revoked_at from session where id = $1',
      [sid],
    );
    expect(session.rows[0]?.revoked_at).not.toBeNull();
    const listed = await h.app.inject({ url: '/api/v1/auth/sessions', headers: h.as(owner) });
    expect(listed.json<{ items: { id: string }[] }>().items.map((s) => s.id)).not.toContain(sid);
    const rows = await admin.query('select 1 from device where endpoint = $1', [endpoint]);
    expect(rows.rows).toEqual([]);
    // And the phone is told, so it can remove what it kept.
    const told = h.jobs
      .filter((j) => j.name === 'push.send')
      .map((j) => j.data as { message: { type: string }; targets: { endpoint: string }[] })
      .filter((d) => d.targets.some((t) => t.endpoint === endpoint));
    expect(told.map((d) => d.message)).toEqual([{ v: 1, type: 'session_ended' }]);
    // Its refresh token is no good either.
    const refreshed = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: phone.refresh_token },
    });
    expect(refreshed.statusCode).toBe(401);
  });

  it('a thief replaying a refresh token loses the session', async () => {
    const installation = randomUUID();
    const phone = await signIn(OWNER, installation);
    const refresh = (token: string, from: string | null) =>
      h.app.inject({
        ...peer(),
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { 'user-agent': APP, ...(from ? { 'x-fdv-installation': from } : {}) },
        payload: { refresh_token: token },
      });
    const first = await refresh(phone.refresh_token, installation);
    expect(first.statusCode).toBe(200);
    const next = first.json<Tokens>();
    // The spent token, from anywhere but the phone that spent it: the session ends.
    const thief = await refresh(phone.refresh_token, randomUUID());
    expect(thief.statusCode).toBe(401);
    // For the thief and for the phone alike.
    expect((await refresh(next.refresh_token, installation)).statusCode).toBe(401);
    const denied = await h.app.inject({ url: '/api/v1/me', headers: h.as(next) });
    expect(denied.statusCode).toBe(401);
    expect(denied.json<{ error: { reason?: string } }>().error.reason).toBe('reused');
  });

  it("push endpoints cannot point inside the server's network", async () => {
    const phone = await signIn(OWNER);
    const refused = [
      'http://ntfy.example.test/up1',
      'https://127.0.0.1/up2',
      'https://localhost/up3',
      'https://[::1]/up4',
      'https://10.0.0.5:8443/up5',
      'https://192.168.1.1/up6',
      'https://169.254.169.254/latest/meta-data',
      'https://router.example.test/up7',
      'https://metadata.example.test/up8',
      // A name with a public and a private address: refused, whichever is used.
      'https://rebind.example.test/up9',
      // IPv4 written other ways, which the URL parser turns back into 127.0.0.1.
      'https://2130706433/up10',
      'https://0x7f.0.0.1/up11',
      'https://0177.0.0.1/up12',
      // IPv4 inside IPv6.
      'https://[::ffff:127.0.0.1]/up13',
      'https://[::ffff:a9fe:a9fe]/up14',
      'https://[64:ff9b::a00:5]/up15',
      'https://[fd00:ec2::254]/up16',
      'https://[fe80::1]/up17',
    ];
    for (const endpoint of refused) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: h.as(phone),
        payload: { kind: 'unified_push', endpoint, keys: { p256dh: 'p', auth: 'a' } },
      });
      expect(res.statusCode, endpoint).toBe(422);
    }
    const kept = await admin.query<{ endpoint: string }>(
      'select endpoint from device where endpoint = any($1)',
      [refused],
    );
    expect(kept.rows).toEqual([]);
    // A public distributor is fine.
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: h.as(phone),
      payload: {
        kind: 'unified_push',
        endpoint: 'https://ntfy.example.test/upPublic1',
        keys: { p256dh: 'p', auth: 'a' },
      },
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});
