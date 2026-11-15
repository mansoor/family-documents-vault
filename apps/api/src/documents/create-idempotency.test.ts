import { createDb, createPool, withPrincipal, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { NOTE_KIND, type DocumentView, type Tokens } from '@fdv/shared';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import {
  claimCreateKey,
  createKeyLockName,
  createKeyOf,
  createKeyWait,
  keepCreateKey,
  requestFingerprint,
} from './create-once.js';

/**
 * A create made twice is made once (0.9.0-dev.45, `features.idempotent_create`;
 * 0100): POST /api/v1/documents under an Idempotency-Key, through the API as
 * each member of a household, and in the database as the application role.
 *
 * The phone sends a note written offline under its client id; when no
 * answer comes it sends it again under the same key, by itself. The second
 * must make nothing, answer with what the first made as the caller may see
 * it now, and tell nobody else anything.
 */

type Person = 'owner' | 'adult' | 'teen' | 'viewer';

describe.skipIf(!testAdminUrl())('a create made twice is made once', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  const people = {} as Record<Person, Tokens>;
  const accounts = {} as Record<Person, string>;

  let nth = 0;
  const post = (who: Person, body: object, key?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: { ...h.as(people[who]), ...(key !== undefined ? { 'idempotency-key': key } : {}) },
      remoteAddress: `10.98.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      payload: body,
    });
  const call = (who: Person, method: 'GET' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    h.app.inject({
      method,
      url,
      headers: h.as(people[who]),
      remoteAddress: `10.98.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const note = (words: string, extra: object = {}) => ({
    type_key: NOTE_KIND,
    title: null,
    notes: words,
    visibility: 'household',
    ...extra,
  });
  const titled = async (title: string) =>
    (
      await admin.query<{ n: number }>(
        'select count(*)::int as n from document where household_id = $1 and title = $2',
        [people.owner.household_id, title],
      )
    ).rows[0]?.n ?? -1;
  const noted = async (words: string) =>
    (
      await admin.query<{ n: number }>(
        'select count(*)::int as n from document where household_id = $1 and notes = $2',
        [people.owner.household_id, words],
      )
    ).rows[0]?.n ?? -1;
  const keysOf = async (key: string) =>
    (
      await admin.query<{ account_id: string; document_id: string | null }>(
        'select account_id, document_id from create_idempotency where idempotency_key = $1',
        [key],
      )
    ).rows;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    people.owner = await h.setup({ display_name: 'Olive Khan' });
    people.adult = await h.join(people.owner, {
      name: 'Sam Khan',
      email: 'idem-sam@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Tia Khan',
      email: 'idem-tia@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Vic Khan',
      email: 'idem-vic@example.test',
      role: 'viewer',
    });
    for (const who of Object.keys(people) as Person[]) {
      const me = await call(who, 'GET', '/api/v1/me');
      accounts[who] = me.json<{ account_id: string }>().account_id;
    }
  }, 120_000);
  afterAll(async () => {
    createKeyWait.ms = 5_000;
    await admin?.end();
    await h?.close();
  });

  it('says it can', async () => {
    const caps = await call('owner', 'GET', '/api/v1/capabilities');
    expect(
      caps.json<{ features: { idempotent_create?: boolean } }>().features.idempotent_create,
    ).toBe(true);
  });

  it('the same key twice makes one document; the second answer is the first, replayed', async () => {
    const key = randomUUID();
    const body = note('Stopcock under the sink');
    const first = await post('owner', body, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const made = first.json<DocumentView>();
    // The same body, its keys in another order: the same request.
    const again = await post('owner', Object.fromEntries(Object.entries(body).reverse()), key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.headers.etag).toBe(first.headers.etag);
    expect(again.json<DocumentView>()).toEqual(made);
    expect(await noted('Stopcock under the sink')).toBe(1);
    // Kept with the document it made, and nothing of its words.
    const rows = await admin.query<Record<string, unknown>>(
      'select * from create_idempotency where idempotency_key = $1',
      [key],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      account_id: accounts.owner,
      member_id: people.owner.member_id,
      document_id: made.id,
      status: 201,
    });
    expect(JSON.stringify(rows.rows[0])).not.toMatch(/Stopcock|sink/);
    // Changed since: the replay is the document as it is now.
    const changed = await call('owner', 'PATCH', `/api/v1/documents/${made.id}`, {
      notes: 'Stopcock behind the bleach',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const later = await post('owner', body, key);
    expect(later.statusCode).toBe(201);
    expect(later.headers['idempotent-replayed']).toBe('true');
    expect(later.json<DocumentView>().notes).toBe('Stopcock behind the bleach');
    expect(later.json<DocumentView>().id).toBe(made.id);
  });

  it('a create with no key is made each time, as before', async () => {
    const body = { title: 'No key, twice', type_key: 'other', visibility: 'household' };
    expect((await post('owner', body)).statusCode).toBe(201);
    expect((await post('owner', body)).statusCode).toBe(201);
    expect(await titled('No key, twice')).toBe(2);
  });

  it('the same key with a different body is 422 idempotency_key_reused, and makes nothing', async () => {
    const key = randomUUID();
    const first = await post('owner', note('The first words'), key);
    expect(first.statusCode).toBe(201);
    const other = await post('owner', note('Other words'), key);
    expect(other.statusCode).toBe(422);
    expect(other.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_reused');
    expect(other.body).not.toMatch(/The first words/);
    expect(other.body).not.toContain(first.json<DocumentView>().id);
    expect(await noted('Other words')).toBe(0);
    // A field more is a different request too.
    const more = await post('owner', note('The first words', { tags: ['x'] }), key);
    expect(more.statusCode).toBe(422);
  });

  it('a malformed key is 400 invalid_idempotency_key, before anything is made', async () => {
    for (const bad of ['', '   ', 'a'.repeat(256), 'tab\there', 'café']) {
      const r = await post('owner', note(`Malformed ${bad.length}`), bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('invalid_idempotency_key');
    }
    expect(await noted('Malformed 256')).toBe(0);
    // Sent twice, which Node would join into "k1, k2": refused, not joined —
    // two header lines over a real connection, as a client would send them.
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    const twice = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/v1/documents',
          headers: { ...h.as(people.owner), 'content-type': 'application/json' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.setHeader('idempotency-key', [randomUUID(), randomUUID()]);
      req.on('error', reject);
      req.end(JSON.stringify(note('Keyed twice')));
    });
    expect(twice.status, twice.body).toBe(400);
    expect((JSON.parse(twice.body) as { error: { code: string } }).error.code).toBe(
      'invalid_idempotency_key',
    );
    expect(await noted('Keyed twice')).toBe(0);
    // The unit itself: counted as they came, whatever their case.
    expect(() => createKeyOf(['Idempotency-Key', 'a', 'idempotency-key', 'b'])).toThrow(
      /printable ASCII/,
    );
    expect(createKeyOf(['Content-Type', 'x', 'Idempotency-Key', 'a, b'])).toBe('a, b');
    expect(createKeyOf(['Content-Type', 'x'])).toBeUndefined();
    // Any 1 to 255 printable characters will do; a UUID is only usual.
    const long = `${'k'.repeat(250)} ~!@#`;
    expect((await post('owner', note('A long key'), long)).statusCode).toBe(201);
    const short = await post('owner', note('A long key'), long);
    expect(short.headers['idempotent-replayed']).toBe('true');
    expect(await noted('A long key')).toBe(1);
  });

  it('a refused create keeps no key: put right, the same key makes it', async () => {
    const key = randomUUID();
    const refused = await post(
      'owner',
      { title: 'Fixed later', type_key: 'not-a-kind', visibility: 'household' },
      key,
    );
    expect(refused.statusCode).toBe(422);
    expect(await keysOf(key)).toEqual([]);
    // A teen naming somebody else: refused too, and no key.
    const teenKey = randomUUID();
    const teen = await post(
      'teen',
      { title: 'Not hers', type_key: 'other', owner_member_id: people.owner.member_id },
      teenKey,
    );
    expect(teen.statusCode).toBe(403);
    expect(await keysOf(teenKey)).toEqual([]);
    // A viewer may not add: refused before the key is looked at.
    const viewerKey = randomUUID();
    expect((await post('viewer', note('A viewer’s'), viewerKey)).statusCode).toBe(403);
    expect(await keysOf(viewerKey)).toEqual([]);
    const fixed = await post(
      'owner',
      { title: 'Fixed later', type_key: 'other', visibility: 'household' },
      key,
    );
    expect(fixed.statusCode).toBe(201);
    expect(fixed.headers['idempotent-replayed']).toBeUndefined();
    expect(await titled('Fixed later')).toBe(1);
  });

  it('identical requests at once make exactly one document', async () => {
    const key = randomUUID();
    const body = note('Sent five times at once');
    const all = await Promise.all(Array.from({ length: 5 }, () => post('adult', body, key)));
    for (const r of all) expect(r.statusCode, r.body).toBe(201);
    expect(all.filter((r) => r.headers['idempotent-replayed'] === undefined)).toHaveLength(1);
    expect(new Set(all.map((r) => r.json<DocumentView>().id)).size).toBe(1);
    expect(await noted('Sent five times at once')).toBe(1);
    expect(await keysOf(key)).toHaveLength(1);
  });

  it('a first try still being made: the second waits for it, or is told 409 idempotency_in_progress', async () => {
    const key = randomUUID();
    const body = note('Still on its way');
    const fingerprint = requestFingerprint('POST', '/api/v1/documents', body);
    const holding = createPool(h.appUrl, 1);
    const holder = await holding.connect();
    const principal = {
      householdId: people.owner.household_id,
      accountId: accounts.owner,
      memberId: people.owner.member_id,
      role: 'owner' as const,
    };
    /** A first try of `k`, as the vault makes it (its lock, then its claim), left open. */
    const firstTry = async (k: string) => {
      await holder.query('begin');
      await holder.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                set_config('app.role', 'owner', true)`,
        [principal.householdId, principal.accountId, principal.memberId],
      );
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        createKeyLockName(principal, k),
      ]);
      await holder.query(
        `insert into create_idempotency
           (household_id, account_id, member_id, idempotency_key, request_fingerprint)
         values ($1, $2, $3, $4, $5)`,
        [principal.householdId, principal.accountId, principal.memberId, k, fingerprint],
      );
    };
    try {
      await firstTry(key);
      createKeyWait.ms = 300;
      const busy = await post('owner', body, key);
      expect(busy.statusCode).toBe(409);
      const err = busy.json<{ error: { code: string; retriable: boolean } }>().error;
      expect(err).toMatchObject({ code: 'idempotency_in_progress', retriable: true });
      expect(busy.headers['retry-after']).toBe('2');
      // The first try finishes while a second waits: the second is its answer.
      createKeyWait.ms = 10_000;
      const doc = (
        await holder.query<{ id: string }>(
          `insert into document (household_id, type_key, notes, visibility, created_by, updated_by)
           values ($1, 'note', 'Still on its way', 'household', $2, $2) returning id`,
          [principal.householdId, principal.accountId],
        )
      ).rows[0]?.id as string;
      await holder.query(
        'update create_idempotency set document_id = $1 where idempotency_key = $2',
        [doc, key],
      );
      const waiting = post('owner', body, key);
      await new Promise((r) => setTimeout(r, 300));
      await holder.query('commit');
      const answered = await waiting;
      expect(answered.statusCode, answered.body).toBe(201);
      expect(answered.headers['idempotent-replayed']).toBe('true');
      expect(answered.json<DocumentView>().id).toBe(doc);
      expect(await noted('Still on its way')).toBe(1);
      // And a first try that fails lets the waiting one make it.
      const key2 = randomUUID();
      await firstTry(key2);
      const behind = post('owner', note('Made by the second'), key2);
      await new Promise((r) => setTimeout(r, 300));
      await holder.query('rollback');
      const second = await behind;
      expect(second.statusCode, second.body).toBe(201);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(await noted('Made by the second')).toBe(1);
    } finally {
      createKeyWait.ms = 5_000;
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      await holding.end();
    }
  });

  it('a wait on something else (the household held by a change to it) is no 409: the create waits, as any does', async () => {
    const holding = createPool(h.adminUrl, 1);
    const holder = await holding.connect();
    try {
      createKeyWait.ms = 200;
      await holder.query('begin');
      // A time-zone change, say: the household's row held for update.
      await holder.query('select 1 from household where id = $1 for update', [
        people.owner.household_id,
      ]);
      const waiting = post('owner', note('Made after the household change'), randomUUID());
      await new Promise((r) => setTimeout(r, 700));
      await holder.query('commit');
      const made = await waiting;
      expect(made.statusCode, made.body).toBe(201);
      expect(made.headers['idempotent-replayed']).toBeUndefined();
      expect(await noted('Made after the household change')).toBe(1);
    } finally {
      createKeyWait.ms = 5_000;
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      await holding.end();
    }
  });

  it('a key of the same account as somebody else in the household neither replays nor blocks', async () => {
    // Olive's sign-in, as another person before (removed and invited again,
    // say): a key sent then is not hers to replay now, nor in her way.
    const other = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'Olive before') returning id",
      [people.owner.household_id],
    );
    const before = (
      await post('owner', { title: 'MADE-AS-SOMEBODY-ELSE', type_key: 'other' }, randomUUID())
    ).json<DocumentView>();
    const key = randomUUID();
    const body = note('Olive now');
    await admin.query(
      `insert into create_idempotency
         (household_id, account_id, member_id, idempotency_key, request_fingerprint, document_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        people.owner.household_id,
        accounts.owner,
        other.rows[0]?.id,
        key,
        requestFingerprint('POST', '/api/v1/documents', body),
        before.id,
      ],
    );
    const now = await post('owner', body, key);
    expect(now.statusCode, now.body).toBe(201);
    expect(now.headers['idempotent-replayed']).toBeUndefined();
    expect(now.json<DocumentView>().id).not.toBe(before.id);
    expect(await keysOf(key)).toHaveLength(2);
  });

  it('another account with the same key makes its own: no cross-talk', async () => {
    const key = randomUUID();
    const body = note('Same key, two people');
    const olive = await post('owner', body, key);
    const sam = await post('adult', body, key);
    expect(olive.statusCode).toBe(201);
    expect(sam.statusCode).toBe(201);
    expect(sam.headers['idempotent-replayed']).toBeUndefined();
    expect(sam.json<DocumentView>().id).not.toBe(olive.json<DocumentView>().id);
    expect(await noted('Same key, two people')).toBe(2);
    // A different body under somebody else's key is their own first try.
    const tia = await post('teen', note('Tia’s own words'), key);
    expect(tia.statusCode, tia.body).toBe(201);
    expect(tia.headers['idempotent-replayed']).toBeUndefined();
    expect((await keysOf(key)).map((k) => k.account_id).sort()).toEqual(
      [accounts.owner, accounts.adult, accounts.teen].sort(),
    );
  });

  it('a replay after the document was made Only me by its person reveals nothing', async () => {
    const key = randomUUID();
    const body = {
      title: 'SAM-GP-LETTER-IDEM',
      type_key: 'other',
      owner_member_id: people.adult.member_id,
      visibility: 'household',
    };
    const made = await post('owner', body, key);
    expect(made.statusCode).toBe(201);
    const id = made.json<DocumentView>().id;
    const hidden = await call('adult', 'PATCH', `/api/v1/documents/${id}`, {
      visibility: 'private',
    });
    expect(hidden.statusCode, hidden.body).toBeLessThan(300);
    const replay = await post('owner', body, key);
    expect(replay.statusCode).toBe(404);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // A code of its own: a client that reads no headers still knows it was made.
    expect(replay.json<{ error: { code: string } }>().error.code).toBe('created_not_visible');
    expect(replay.body).not.toContain('SAM-GP-LETTER-IDEM');
    expect(replay.body).not.toContain(id);
    expect(JSON.stringify(replay.headers)).not.toContain(id);
    // Exactly as GET says.
    expect((await call('owner', 'GET', `/api/v1/documents/${id}`)).statusCode).toBe(404);
    // Nothing new made either.
    expect(await titled('SAM-GP-LETTER-IDEM')).toBe(1);
  });

  it('a replay after the Trash says what GET says; after removal for good, the key went with it', async () => {
    const key = randomUUID();
    const body = note('Into the Trash');
    const made = (await post('owner', body, key)).json<DocumentView>();
    expect((await call('owner', 'DELETE', `/api/v1/documents/${made.id}`)).statusCode).toBe(204);
    const replay = await post('owner', body, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json<DocumentView>().id).toBe(made.id);
    expect(replay.json<DocumentView>().deleted_at).not.toBeNull();
    expect(await noted('Into the Trash')).toBe(1);
    // Removed for good (as the purge removes it): every row naming it goes,
    // the key too, and a later try under it is a new create.
    await admin.query('delete from document where id = $1', [made.id]);
    expect(await keysOf(key)).toEqual([]);
    const after = await post('owner', body, key);
    expect(after.statusCode).toBe(201);
    expect(after.headers['idempotent-replayed']).toBeUndefined();
    expect(after.json<DocumentView>().id).not.toBe(made.id);
  });

  it('a key lasts 24 hours: then the same key is a new request', async () => {
    const key = randomUUID();
    const first = (await post('owner', note('Kept a day'), key)).json<DocumentView>();
    await admin.query(
      "update create_idempotency set created_at = now() - interval '24 hours 1 second' where idempotency_key = $1",
      [key],
    );
    // Even with another body: the old key is no key.
    const next = await post('owner', note('A day later'), key);
    expect(next.statusCode).toBe(201);
    expect(next.headers['idempotent-replayed']).toBeUndefined();
    expect(next.json<DocumentView>().id).not.toBe(first.id);
    const rows = await keysOf(key);
    expect(rows).toEqual([
      { account_id: accounts.owner, document_id: next.json<DocumentView>().id },
    ]);
  });

  describe('in the database, as the application role', () => {
    let one: Db;
    let elsewhere: string;
    const principal = (who: Person, householdId = people[who].household_id) => ({
      householdId,
      accountId: accounts[who],
      memberId: people[who].member_id,
      role: people[who].role,
    });
    const ownKey = randomUUID();
    let ownDoc = '';
    beforeAll(async () => {
      one = createDb(createPool(h.appUrl, 1));
      ownDoc = (await post('owner', note('Olive’s keyed note'), ownKey)).json<DocumentView>().id;
      await post('adult', note('Sam’s keyed note'), randomUUID());
      // Another household, with Olive's own account in it as somebody else.
      elsewhere = randomUUID();
      await admin.query("insert into household (id, name) values ($1, 'Elsewhere')", [elsewhere]);
      const m = await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Olive elsewhere') returning id",
        [elsewhere],
      );
      await admin.query(
        "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
        [accounts.owner, elsewhere, m.rows[0]?.id],
      );
      elsewhereMember = m.rows[0]?.id as string;
    });
    let elsewhereMember = '';
    afterAll(async () => {
      await one.destroy();
    });

    it('gives each account its own keys alone: an owner reads nobody else’s', async () => {
      for (const who of ['owner', 'adult', 'teen', 'viewer'] as Person[]) {
        const rows = await withPrincipal(one, principal(who), (trx) =>
          trx.selectFrom('create_idempotency').select(['account_id', 'member_id']).execute(),
        );
        expect(
          rows.every(
            (r) => r.account_id === accounts[who] && r.member_id === people[who].member_id,
          ),
          who,
        ).toBe(true);
      }
      const owners = await withPrincipal(one, principal('owner'), (trx) =>
        trx.selectFrom('create_idempotency').select('idempotency_key').execute(),
      );
      expect(owners.map((r) => r.idempotency_key)).toContain(ownKey);
    });

    it('another household: the same account and key are a key of their own there, and see nothing here', async () => {
      const there = {
        householdId: elsewhere,
        accountId: accounts.owner,
        memberId: elsewhereMember,
        role: 'owner' as const,
      };
      const seen = await withPrincipal(one, there, (trx) =>
        trx.selectFrom('create_idempotency').select('idempotency_key').execute(),
      );
      expect(seen).toEqual([]);
      const fingerprint = requestFingerprint(
        'POST',
        '/api/v1/documents',
        note('Olive’s keyed note'),
      );
      const claim = await withPrincipal(one, there, async (trx) => {
        const c = await claimCreateKey(trx, there, { key: ownKey, fingerprint });
        // Rolled back: nothing kept.
        throw Object.assign(new Error('roll back'), { claim: c });
      }).catch((e: { claim?: unknown }) => e.claim);
      expect(claim).toEqual({ kind: 'claimed' });
      // While here, the same key and request are a replay of what it made.
      const here = await withPrincipal(one, principal('owner'), (trx) =>
        claimCreateKey(trx, principal('owner'), { key: ownKey, fingerprint }),
      );
      expect(here).toEqual({ kind: 'replay', documentId: ownDoc, status: 201 });
    });

    it('lets nobody write another’s: not an insert, an update, a delete or an upsert', async () => {
      const hh = people.owner.household_id;
      const row = (who: Person, key: string) => ({
        household_id: hh,
        account_id: accounts[who],
        member_id: people[who].member_id,
        idempotency_key: key,
        request_fingerprint: '0'.repeat(64),
      });
      // Sam writing a key in Olive's name: refused.
      await expect(
        withPrincipal(one, principal('adult'), (trx) =>
          trx.insertInto('create_idempotency').values(row('owner', randomUUID())).execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      // Nor as Olive's account under his own member.
      await expect(
        withPrincipal(one, principal('adult'), (trx) =>
          trx
            .insertInto('create_idempotency')
            .values({ ...row('adult', randomUUID()), account_id: accounts.owner })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      // PG 16: an upsert's conflicting row is held to the update rule too.
      await expect(
        withPrincipal(one, principal('adult'), (trx) =>
          trx
            .insertInto('create_idempotency')
            .values(row('owner', ownKey))
            .onConflict((oc) =>
              oc
                .columns(['household_id', 'account_id', 'member_id', 'idempotency_key'])
                .doUpdateSet({ request_fingerprint: 'f'.repeat(64) })
                .where('create_idempotency.status', '=', 201),
            )
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      // Nor does keepCreateKey reach another's: an update of nothing.
      await withPrincipal(one, principal('adult'), (trx) =>
        keepCreateKey(trx, { ...principal('adult'), accountId: accounts.owner }, ownKey, ownDoc),
      );
      const updated = await withPrincipal(one, principal('owner'), async (trx) =>
        Number(
          (
            await trx
              .updateTable('create_idempotency')
              .set({ status: 200 })
              .where('account_id', '=', accounts.adult)
              .executeTakeFirst()
          ).numUpdatedRows,
        ),
      );
      expect(updated).toBe(0);
      const deleted = await withPrincipal(one, principal('owner'), async (trx) =>
        Number(
          (
            await trx
              .deleteFrom('create_idempotency')
              .where('account_id', '=', accounts.adult)
              .executeTakeFirst()
          ).numDeletedRows,
        ),
      );
      expect(deleted).toBe(0);
      // Into another household: refused.
      await expect(
        withPrincipal(one, principal('owner', elsewhere), (trx) =>
          trx.insertInto('create_idempotency').values(row('owner', randomUUID())).execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      const still = await admin.query<{ fp: string; status: number }>(
        'select request_fingerprint as fp, status from create_idempotency where idempotency_key = $1 and account_id = $2',
        [ownKey, accounts.owner],
      );
      expect(still.rows[0]?.status).toBe(201);
      expect(still.rows[0]?.fp).not.toBe('f'.repeat(64));
    });

    it('a share link, an upload link, a signed-out page and a caller who says nothing are given none', async () => {
      const total = await admin.query<{ n: number }>(
        'select count(*)::int as n from create_idempotency',
      );
      expect(total.rows[0]?.n).toBeGreaterThan(0);
      const pool = createPool(h.appUrl, 1);
      try {
        for (const actor of ['', 'anonymous', 'link', 'upload']) {
          const c = await pool.connect();
          try {
            await c.query('begin');
            await c.query(
              `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true)`,
              [people.owner.household_id, actor],
            );
            const n = await c.query<{ n: number }>(
              'select count(*)::int as n from create_idempotency',
            );
            expect(n.rows[0]?.n, actor || 'nobody').toBe(0);
          } finally {
            await c.query('rollback');
            c.release();
          }
        }
      } finally {
        await pool.end();
      }
    });
  });
});
