import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createApi, createHttp, type FetchLike } from '@fdv/client';
import { contractScenarios, type ContractContext } from '@fdv/client/testing';
import {
  EncryptStream,
  EnvKeyProvider,
  memberPhotoBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, it } from 'vitest';
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
  };

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(() => h.close());

  for (const s of contractScenarios) it(s.name, () => s.run(api, ctx));
});
