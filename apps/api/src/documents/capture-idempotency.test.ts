import { createPool } from '@fdv/db';
import type { Tokens } from '@fdv/shared';
import FormData from 'form-data';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Iteration 4.3: an upload is reserve-then-commit on its Idempotency-Key.
 * A retry never makes a second document, overlapping tries are told the
 * first is on its way, a failed try leaves nothing behind, and a key says
 * nothing about what it made to anyone but the account that made it.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const BOUNDARY = 'fdv-capture-test-boundary';
const HEAD = Buffer.from(
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="slow.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
);
const TAIL = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);

describe('uploads you can retry', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let admin: ReturnType<typeof createPool>;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const capture = (who: Tokens, key: string, bytes: Buffer = PDF) => {
    const form = new FormData();
    form.append('file', bytes, { filename: 'scan.pdf', contentType: 'application/pdf' });
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': key },
      payload: form.getBuffer(),
    });
  };

  const addVersion = (who: Tokens, documentId: string, key: string) => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'renewed.pdf', contentType: 'application/pdf' });
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': key },
      payload: form.getBuffer(),
    });
  };

  /** An upload (a capture, by default) whose bytes arrive only when the test says so. */
  const heldCapture = (who: Tokens, key: string, url = '/api/v1/capture') => {
    const body = new PassThrough();
    body.write(HEAD);
    body.write(PDF.subarray(0, 10));
    const response = h.app.inject({
      method: 'POST',
      url,
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

  const status = (who: Tokens, key: string) =>
    h.app.inject({ method: 'GET', url: `/api/v1/uploads/${key}`, headers: h.as(who) });

  /** Until the held try has claimed its key. */
  const claimed = async (who: Tokens, key: string) => {
    for (let i = 0; i < 100; i += 1) {
      const r = await status(who, key);
      if (r.statusCode === 200 && json<{ state: string }>(r).state === 'in_progress') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the first try never claimed its key');
  };

  const documentCount = async () =>
    Number(
      (
        await admin.query<{ n: string }>(
          'select count(*) as n from document where household_id = $1',
          [owner.household_id],
        )
      ).rows[0]?.n,
    );

  /** Every temporary object still in the vault: a failed try leaves none. */
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
    adult = await h.join(owner, {
      name: 'Alex',
      email: `alex-${randomUUID()}@example.test`,
      role: 'adult',
    });
    admin = createPool(h.adminUrl, 2);
  }, 120_000);
  // Closing waits for every upload still in flight: under load, longer than the default 10 s.
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  }, 30_000);

  it('a capture retried with the same key returns the first document and makes nothing new', async () => {
    const key = randomUUID();
    const before = await documentCount();
    const first = await capture(owner, key);
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const made = json<{ document_id: string; version_id: string }>(first);
    for (let i = 0; i < 2; i += 1) {
      const again = await capture(owner, key);
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(json<{ document_id: string; version_id: string }>(again)).toMatchObject(made);
    }
    expect(await documentCount()).toBe(before + 1);
    const versions = await h.app.inject({
      method: 'GET',
      url: `/api/v1/documents/${made.document_id}/versions`,
      headers: h.as(owner),
    });
    expect(json<{ items: unknown[] }>(versions).items).toHaveLength(1);
  });

  it('two captures racing on one key make one document; the other is told upload_in_progress with Retry-After', async () => {
    const key = randomUUID();
    const before = await documentCount();
    const slow = heldCapture(owner, key);
    await claimed(owner, key);

    const second = await capture(owner, key);
    expect(second.statusCode).toBe(409);
    expect(second.headers['retry-after']).toBe('5');
    expect(json<{ error: { code: string; retriable: boolean } }>(second).error).toMatchObject({
      code: 'upload_in_progress',
      retriable: true,
    });

    slow.finish();
    const first = await slow.response;
    expect(first.statusCode).toBe(201);
    const made = json<{ document_id: string }>(first);
    const third = await capture(owner, key);
    expect(third.headers['idempotent-replayed']).toBe('true');
    expect(json<{ document_id: string }>(third).document_id).toBe(made.document_id);
    expect(await documentCount()).toBe(before + 1);
  });

  it('a capture whose upload fails leaves no document behind and the key works again', async () => {
    const before = await documentCount();

    // The connection goes halfway through.
    const key = randomUUID();
    const dropped = heldCapture(owner, key);
    await claimed(owner, key);
    dropped.drop();
    await dropped.response.catch(() => undefined);
    await expect.poll(async () => (await status(owner, key)).statusCode).toBe(404);
    expect(await documentCount()).toBe(before);

    // Too big: cut off at the limit, and not kept as if it were the file.
    const big = randomUUID();
    const tooBig = await capture(owner, big, Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024)]));
    expect(tooBig.statusCode).toBe(413);
    expect(await documentCount()).toBe(before);
    expect((await status(owner, big)).statusCode).toBe(404);
    expect(await incoming()).toEqual([]);

    // The same keys work again, once each.
    for (const k of [key, big]) {
      const retry = await capture(owner, k);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
    }
    expect(await documentCount()).toBe(before + 2);
    expect(await incoming()).toEqual([]);
  });

  it("another adult replaying the owner's key gets 409 and no ids", async () => {
    const key = randomUUID();
    const made = json<{ document_id: string; version_id: string }>(await capture(owner, key));
    const res = await capture(adult, key);
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('idempotency_key_reused');
    expect(res.body).not.toContain(made.document_id);
    expect(res.body).not.toContain(made.version_id);
  });

  it("a key used for one document cannot fetch another document's version", async () => {
    const newDoc = async (title: string) =>
      json<{ id: string }>(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: h.as(owner),
          payload: { title },
        }),
      ).id;
    const a = await newDoc('Water bill, March');
    const b = await newDoc('Water bill, April');
    const key = randomUUID();
    const onA = await addVersion(owner, a, key);
    expect(onA.statusCode).toBe(201);
    const version = json<{ id: string }>(onA).id;

    const again = await addVersion(owner, a, key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(json<{ id: string }>(again).id).toBe(version);

    for (const res of [await addVersion(owner, b, key), await capture(owner, key)]) {
      expect(res.statusCode).toBe(409);
      expect(json<{ error: { code: string } }>(res).error.code).toBe('idempotency_key_reused');
      expect(res.body).not.toContain(version);
      expect(res.body).not.toContain(a);
    }
  });

  it("GET /uploads/{key} reports done, in progress and unknown, and never someone else's key", async () => {
    const done = randomUUID();
    const made = json<{ document_id: string; version_id: string }>(await capture(owner, done));
    const d = await status(owner, done);
    expect(d.statusCode).toBe(200);
    expect(json(d)).toEqual({
      state: 'done',
      document_id: made.document_id,
      version_id: made.version_id,
    });

    const running = randomUUID();
    const slow = heldCapture(owner, running);
    await claimed(owner, running);
    const r = json<{ state: string; since: string }>(await status(owner, running));
    expect(r.state).toBe('in_progress');
    expect(Number.isNaN(Date.parse(r.since))).toBe(false);
    // Somebody else asking about it, or about the finished one: not known.
    expect((await status(adult, running)).statusCode).toBe(404);
    expect((await status(adult, done)).statusCode).toBe(404);
    slow.finish();
    await slow.response;

    expect((await status(owner, randomUUID())).statusCode).toBe(404);
    expect((await status(owner, 'not-a-key')).statusCode).toBe(404);
  });

  it('a new version that finishes after its document was made private is refused, and nothing is left half-changed', async () => {
    const doc = json<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: {
          title: 'Council tax',
          owner_member_id: owner.member_id,
          visibility: 'household',
        },
      }),
    ).id;
    const visibility = (to: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc}/visibility`,
        headers: h.as(owner),
        payload: { visibility: to },
      });
    const key = randomUUID();
    const slow = heldCapture(owner, key, `/api/v1/documents/${doc}/versions`);
    await claimed(owner, key);
    expect((await visibility('private')).statusCode).toBe(200);

    slow.finish();
    const res = await slow.response;
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { code: string; retriable: boolean } }>(res).error).toMatchObject({
      code: 'document_changed',
      retriable: true,
    });
    expect((await status(owner, key)).statusCode).toBe(404);
    expect(await incoming()).toEqual([]);

    // Every version it has is wrapped for who can see it: it can go back.
    expect((await visibility('household')).statusCode).toBe(200);
    const again = await addVersion(owner, doc, key);
    expect(again.statusCode).toBe(201);
    expect((await visibility('private')).statusCode).toBe(200);
    expect((await visibility('household')).statusCode).toBe(200);
  });

  it('keys are UUIDs written the usual way', async () => {
    for (const key of ['12345', `{${randomUUID()}}`, randomUUID().replace(/-/g, '')]) {
      const res = await capture(owner, key);
      expect(res.statusCode).toBe(422);
    }
  });

  it('a claim older than 15 minutes is taken over; a fresher one is not', async () => {
    const me = json<{ account_id: string }>(
      await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: h.as(owner) }),
    );
    const claim = (key: string, minutesAgo: number) =>
      admin.query(
        `insert into upload_idempotency
           (idempotency_key, household_id, account_id, state, request_kind, claim_nonce, claimed_at)
         values ($1, $2, $3, 'pending', 'capture', $4, now() - make_interval(mins => $5))`,
        [key, owner.household_id, me.account_id, randomUUID(), minutesAgo],
      );
    const stale = randomUUID();
    const fresh = randomUUID();
    await claim(stale, 16);
    await claim(fresh, 1);

    const before = await documentCount();
    expect((await capture(owner, stale)).statusCode).toBe(201);
    expect(await documentCount()).toBe(before + 1);

    const busy = await capture(owner, fresh);
    expect(busy.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(busy).error.code).toBe('upload_in_progress');
    // And not by somebody else, however old.
    expect((await capture(adult, stale)).statusCode).toBe(409);
  });
});
