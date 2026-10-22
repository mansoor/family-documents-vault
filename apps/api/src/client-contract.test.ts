import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createApi, createHttp, type FetchLike } from '@fdv/client';
import { contractScenarios, type ContractContext } from '@fdv/client/testing';
import {
  EncryptStream,
  EnvKeyProvider,
  itemProposalsBinding,
  itemTextBinding,
  memberPhotoBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, remindTurned13, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { Tokens } from '@fdv/shared';
import { LocalAdapter } from '@fdv/storage';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFor } from './auth/totp.js';
import { createHarness, TEST_MASTER, type Harness } from './test-harness.js';

/**
 * The contract every client relies on, against the real API.
 *
 * `@fdv/client` is the one client — the web app's today, the phone's
 * next — and `@fdv/client/testing` holds the scenarios it relies on. The
 * same scenarios run against the in-memory fake the phone app is tested
 * with (`packages/client/src/testing/fake.test.ts`), so if the server and
 * the fake ever disagree about refresh rotation, a refused password or a
 * retried capture, one of the two runs goes red.
 */
describe.skipIf(!testAdminUrl())('the client contract, against the real API', () => {
  let h: Harness;
  let peer = 0;

  /** fetch, as the client sees it, answered by Fastify's inject. */
  const viaInject: FetchLike = async (url, init) => {
    const res = await h.app.inject({
      method: init.method as 'GET',
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      headers: init.headers,
      ...(init.body instanceof Uint8Array
        ? { payload: Buffer.from(init.body) }
        : typeof init.body === 'string'
          ? { payload: init.body }
          : {}),
      // Sign-in is rate-limited per address; each call is its own peer.
      remoteAddress: `10.66.${++peer >> 8}.${peer & 0xff}`,
    });
    return {
      ok: res.statusCode < 400,
      status: res.statusCode,
      headers: {
        get: (name) => {
          const v = res.headers[name.toLowerCase()];
          return v === undefined ? null : String(v);
        },
      },
      json: async () => res.json(),
      text: async () => res.body,
      arrayBuffer: async () =>
        res.rawPayload.buffer.slice(
          res.rawPayload.byteOffset,
          res.rawPayload.byteOffset + res.rawPayload.byteLength,
        ) as ArrayBuffer,
    };
  };

  const api = createApi(createHttp({ baseUrl: 'http://vault.test', fetch: viaInject }));
  const ctx: ContractContext = {
    email: 'contract@example.test',
    password: 'a long enough password',
    // The household's own setting on a built-in (0031), written as the
    // editor writes it (0.5.10), by the owner the scenarios signed in as.
    hideType: async (_householdId, key) => {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/document-types/${key}`,
        headers: { authorization: `Bearer ${ctx.tokens?.access_token ?? ''}` },
        payload: { hidden: true },
        remoteAddress: `10.66.${++peer >> 8}.${peer & 0xff}`,
      });
      if (res.statusCode !== 200) throw new Error(`hiding ${key}: ${res.body}`);
    },
    // What the worker commits once a photo's square is made (5.17c,
    // jobs/member-photo.ts), with a square made elsewhere: the worker is not
    // here, and its own tests make real ones.
    makePhotos: async () => {
      const householdId = ctx.tokens?.household_id as string;
      const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
      const square = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
      const uploads = await withSystem(h.db, householdId, async (trx) => {
        const scope = await keys.unwrap(trx, { householdId, kind: 'household' });
        const on = await trx
          .selectFrom('member_photo')
          .select(['id', 'member_id', 'source_key'])
          .where('state', '=', 'processing')
          .execute();
        for (const p of on) {
          await trx
            .deleteFrom('member_photo')
            .where('member_id', '=', p.member_id)
            .where('state', '=', 'ready')
            .execute();
          await trx
            .updateTable('member_photo')
            .set({
              state: 'ready',
              sealed: sealBytes(
                scope.key,
                square,
                memberPhotoBinding(householdId, p.member_id, p.id),
              ),
              ready_at: new Date(),
              source_key: null,
              source_vault_id: null,
              source_key_wrapped: null,
            })
            .where('id', '=', p.id)
            .execute();
        }
        return on.map((p) => p.source_key);
      });
      for (const key of uploads) if (key) await new LocalAdapter(h.vaultDir).delete(key);
    },
    // Somebody outside the family, sending files through the request's link
    // on its page (5.21), then what the worker does once they press Finish
    // (5.23, jobs/incoming.ts): no scan (A42), and one page drawn — made
    // elsewhere — under each file's own key. The worker is not here.
    sendFiles: async (made, files) => {
      const householdId = ctx.tokens?.household_id as string;
      const from = () => `10.67.${++peer >> 8}.${peer & 0xff}`;
      const open = await h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/unlock',
        payload: { token: made.link_token },
        remoteAddress: from(),
      });
      if (open.statusCode !== 200) throw new Error(`opening the request: ${open.body}`);
      const set = open.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
      const cookies = { [set?.name as string]: set?.value as string };
      for (const f of files) {
        const form = new FormData();
        form.append('file', Buffer.from(f.bytes), { filename: f.name, contentType: f.contentType });
        const sent = await h.app.inject({
          method: 'POST',
          url: '/api/v1/drop/files',
          headers: form.getHeaders(),
          cookies,
          payload: form.getBuffer(),
          remoteAddress: from(),
        });
        if (sent.statusCode !== 201) throw new Error(`sending ${f.name}: ${sent.body}`);
      }
      const done = await h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/finish',
        cookies,
        payload: {},
        remoteAddress: from(),
      });
      if (done.statusCode !== 200) throw new Error(`finishing: ${done.body}`);
      const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
      const page = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
      await withSystem(h.db, householdId, async (trx) => {
        const waiting = await trx
          .selectFrom('incoming_file')
          .select(['id', 'storage_key', 'file_key_wrapped', 'wrapped_by_scope'])
          .where('request_id', '=', made.request.id)
          .where('scan_state', '=', 'pending')
          .execute();
        for (const f of waiting) {
          const fileKey = unwrapKey(
            f.file_key_wrapped,
            await keys.unwrapById(trx, f.wrapped_by_scope),
            `incoming:${f.id}`,
          );
          const enc = new EncryptStream(fileKey);
          await Promise.all([
            new LocalAdapter(h.vaultDir).put(`${f.storage_key}.p1.enc`, enc),
            pipeline(Readable.from([page]), enc),
          ]);
          await trx
            .updateTable('incoming_file')
            .set({ scan_state: 'unscanned', preview_state: 'ready', preview_pages: 1 })
            .where('id', '=', f.id)
            .execute();
        }
      });
    },
    // What the worker writes once it has read a batch's items (I2,
    // jobs/read-item.ts): each one's words and what they propose, sealed
    // under the item's own key — or why it could not read them. The worker
    // is not here, and its own tests read real pages.
    readBatchItems: async (_batchId, reads) => {
      const householdId = ctx.tokens?.household_id as string;
      const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
      await withSystem(h.db, householdId, async (trx) => {
        for (const [id, read] of Object.entries(reads)) {
          if ('failure' in read) {
            await trx
              .updateTable('incoming_file')
              .set({ read_state: 'failed', read_failure: read.failure })
              .where('id', '=', id)
              .execute();
            continue;
          }
          const f = await trx
            .selectFrom('incoming_file')
            .select(['file_key_wrapped', 'wrapped_by_scope'])
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          const fileKey = unwrapKey(
            f.file_key_wrapped,
            await keys.unwrapById(trx, f.wrapped_by_scope),
            `incoming:${id}`,
          );
          await trx
            .updateTable('incoming_file')
            .set({
              read_state: 'read',
              text_sealed: sealBytes(fileKey, Buffer.from('its words'), itemTextBinding(id)),
              proposals_sealed: sealBytes(
                fileKey,
                Buffer.from(
                  JSON.stringify({
                    v: 1,
                    proposal: read.proposal,
                    ...(read.paper ? { paper: read.paper } : {}),
                  }),
                ),
                itemProposalsBinding(id),
              ),
            })
            .where('id', '=', id)
            .execute();
        }
      });
    },
    // Somebody joining as anybody does (5.28): invited by the owner, who is
    // asked to confirm it is them first (change_people), and accepting.
    addSignIn: async (token, who) => {
      await api.stepUp(token, { password: ctx.password });
      return (await h.join({ access_token: token } as Tokens, who)).member_id;
    },
    // An authenticator, turned on from the session the password just opened,
    // and its code given for what an owner power asks (A54).
    ownerTwoStep: async (token) => {
      const { secret } = await api.totpEnrol(token);
      await api.totpConfirm(token, codeFor(secret));
      await api.stepUp(token, { code: codeFor(secret) });
    },
    // Somebody's 13th birthday (after 0.7.0): in the vault a year already, as
    // the owning role writes it, and the reminders' tick for it, as the
    // worker runs it — the worker is not here.
    turnThirteen: async (memberId) => {
      const householdId = ctx.tokens?.household_id as string;
      const admin = createPool(h.adminUrl, 1);
      try {
        await admin.query(
          "update member set created_at = now() - interval '1 year' where id = $1",
          [memberId],
        );
        const { rows } = await admin.query<{ timezone: string }>(
          'select timezone from household where id = $1',
          [householdId],
        );
        await withSystem(h.db, householdId, (trx) =>
          remindTurned13(trx, householdId, rows[0]?.timezone ?? 'UTC', new Date()),
        );
      } finally {
        await admin.end();
      }
    },
    // A guest's sign-in ended a minute ago (5.34), as the owning role: nobody
    // signed in may set an end in the past.
    endGuestAccess: async (memberId) => {
      const admin = createPool(h.adminUrl, 1);
      try {
        await admin.query(
          `update account_household set access_expires_at = now() - interval '1 minute'
            where member_id = $1`,
          [memberId],
        );
      } finally {
        await admin.end();
      }
    },
  };

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(() => h.close());

  // Each a scenario of many calls: more than 15 s on a machine running other suites beside it.
  for (const s of contractScenarios) it(s.name, () => s.run(api, ctx), 60_000);
});

/**
 * Kinds a client was released before (0.8.0, S5: 0072's credit card
 * statement and school report). A client knows kinds only as the vault
 * lists them: run with the phone's older client (scripts/older-client.mjs),
 * this is that client listing them, filing a document of each and reading
 * it back, as it does any other kind.
 */
describe.skipIf(!testAdminUrl())('kinds newer than the client (S5)', () => {
  let h: Harness;
  const fetch: FetchLike = async (url, init) => {
    const res = await h.app.inject({
      method: init.method as 'GET',
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      headers: init.headers,
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    return {
      ok: res.statusCode < 400,
      status: res.statusCode,
      headers: {
        get: (name) => {
          const v = res.headers[name.toLowerCase()];
          return v === undefined ? null : String(v);
        },
      },
      json: async () => res.json(),
      text: async () => res.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  const api = createApi(createHttp({ baseUrl: 'http://vault.test', fetch }));

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(() => h.close());

  it('lists them, files a document of each and reads it back', async () => {
    const tokens = await api.setup({
      household_name: 'The Kinds family',
      display_name: 'Owner',
      email: 'kinds@example.test',
      password: 'a long enough password',
    });
    const token = tokens.access_token;
    const kinds = (await api.documentTypes(token)).items;
    for (const [key, label] of [
      ['credit_card_statement', 'Credit card statement'],
      ['school_report', 'School report'],
    ] as const) {
      expect(kinds.find((k) => k.key === key)?.label).toBe(label);
      const made = await api.createDocument(token, { title: label, type_key: key });
      const read = await api.document(token, made.id);
      expect(read.type_key).toBe(key);
      expect(read.title).toBe(label);
    }
  });
});

/**
 * A note kept on its own (0.9.0, N1): a document with no file, of a kind
 * newer than the client. Run with the phone's older client
 * (scripts/older-client.mjs, at v0.5.0-rc.1 and v0.5.11), this is that
 * client listing it, reading it, looking up its kind, searching for it,
 * changing its words and keeping its Essentials — none of which expects a
 * document to have a file.
 */
describe.skipIf(!testAdminUrl())('a note, newer than the client (N1)', () => {
  let h: Harness;
  const fetch: FetchLike = async (url, init) => {
    const res = await h.app.inject({
      method: init.method as 'GET',
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      headers: init.headers,
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    return {
      ok: res.statusCode < 400,
      status: res.statusCode,
      headers: {
        get: (name) => {
          const v = res.headers[name.toLowerCase()];
          return v === undefined ? null : String(v);
        },
      },
      json: async () => res.json(),
      text: async () => res.body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  const api = createApi(createHttp({ baseUrl: 'http://vault.test', fetch }));

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(() => h.close());

  it('lists it, reads it, finds its kind and its words, changes them, and keeps Essentials as before', async () => {
    const tokens = await api.setup({
      household_name: 'The Notes family',
      display_name: 'Owner',
      email: 'notes-older@example.test',
      password: 'a long enough password',
    });
    const token = tokens.access_token;
    // Made as the web makes it: through the routes every client has.
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type_key: 'note',
        title: 'Where the stopcock is',
        visibility: 'household',
        notes: 'Under the **sink**, quokkanote',
        is_essential: true,
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<{ id: string }>().id;

    const listed = (await api.documents(token)).items.find((d) => d.id === id);
    expect(listed).toMatchObject({ type_key: 'note', title: 'Where the stopcock is' });
    expect(listed?.latest_version_id ?? null).toBeNull();
    const read = await api.document(token, id);
    expect(read.notes).toBe('Under the **sink**, quokkanote');
    expect((await api.versions(token, id)).items).toEqual([]);
    // Its kind, by key, as the client looks every document's up.
    expect((await api.documentTypes(token)).items.find((t) => t.key === 'note')).toMatchObject({
      label: 'Note',
    });
    // Found by its words.
    const hits = await api.search(token, 'quokkanote');
    expect(hits.items.map((i) => i.document_id)).toContain(id);
    // Its words changed, as any document's note.
    const changed = await api.updateDocument(token, id, { notes: 'In the garage' }, read.etag);
    expect(changed.notes).toBe('In the garage');
    // An Essential with no file is not kept on the phone, and nothing fails.
    const kept = await api.offlineEssentials(token);
    expect(kept.items.map((i) => i.document.id)).not.toContain(id);
  });
});
