import { createHash } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  APP_BASIC_DEPRECATION,
  APP_BUSY_DAY_MIN,
  APP_TOKEN_SECONDS,
  APP_KEY_NETWORKS_MAX,
  APP_REQUESTS_PER_MINUTE,
  APP_TOKENS_PER_ADDRESS_PER_MINUTE,
  APP_TOKENS_PER_KEY_PER_MINUTE,
  type AppAccessToken,
  type ConnectedAppKeyMade,
  type ConnectedAppView,
  type Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorForLog } from '../log-redaction.js';
import { alertsSent, appKeyFor, basicFor, createHarness, type Harness } from '../test-harness.js';
import { networkOf, newAccessToken, presentsAppToken, readAppCredentials } from './keys.js';

/**
 * Connected apps hardened before going live (0.9.0-dev.72): an API key
 * traded at `POST /api/v1/apps/token` for a short-lived access token (OAuth
 * 2.0 client credentials), sent as Bearer everywhere else and bound to its
 * key; the key as Basic there still taken, deprecated; a new key lasting 90
 * days unless said; and the owners told of a key used from a new network,
 * and of a day far past an app's usual.
 */

/** The connected apps' clock, ahead of the real one by this much: a test moves it. */
let clockOffset = 0;

interface Keyed {
  appId: string;
  keyId: string;
  clientId: string;
  secret: string;
}

describe.skipIf(!testAdminUrl())(
  'connected apps: access tokens and unusual use (0.9.0-dev.72)',
  () => {
    let h: Harness;
    let admin: ReturnType<typeof createPool>;
    let owner: Tokens;

    const send = (method: string, url: string, payload?: unknown) =>
      h.app.inject({
        method: method as 'GET',
        url,
        headers: h.as(owner),
        ...(payload === undefined ? {} : { payload: payload as never }),
      });

    /** An owner connects an app and generates its key: every permission it has, for 30 days. */
    async function connect(scopes = ['documents.send']): Promise<Keyed> {
      await h.decider(owner);
      const res = await send('POST', '/api/v1/connected-apps', {
        name: 'Acme Money',
        member_id: owner.member_id,
        allowed_kinds: ['bank_statement'],
        scopes,
      });
      expect(res.statusCode, res.body).toBe(201);
      const view = res.json<ConnectedAppView>();
      return { appId: view.id, ...(await appKeyFor(h, owner, view)) };
    }

    /** A request as the app, from a network of its own (as a proxy here says it). */
    const call = (
      method: 'GET' | 'POST',
      url: string,
      authorization: string,
      o: { from?: string; body?: string; type?: string } = {},
    ): Promise<LightMyRequestResponse> =>
      h.app.inject({
        method,
        url,
        headers: {
          authorization,
          'x-forwarded-for': o.from ?? '198.51.100.7',
          ...(o.type ? { 'content-type': o.type } : {}),
        },
        ...(o.body !== undefined ? { payload: o.body } : {}),
        remoteAddress: '127.0.0.1',
      });
    const basic = (k: Keyed) => basicFor(k).authorization;
    const grant = (
      k: Keyed,
      o: { body?: string; type?: string; from?: string; as?: string } = {},
    ) =>
      call('POST', '/api/v1/apps/token', o.as ?? basic(k), {
        body: o.body ?? 'grant_type=client_credentials',
        type: o.type ?? 'application/x-www-form-urlencoded',
        ...(o.from ? { from: o.from } : {}),
      });
    const tokenFor = async (k: Keyed, from?: string) => {
      const res = await grant(k, from ? { from } : {});
      expect(res.statusCode, res.body).toBe(200);
      return res.json<AppAccessToken>().access_token;
    };
    const codeOf = (r: LightMyRequestResponse) =>
      [r.statusCode, r.json<{ error?: { code?: string } }>().error?.code] as const;
    const lines = async () =>
      (await send('GET', '/api/v1/audit?limit=100'))
        .json<{ items: Array<{ text: string }> }>()
        .items.map((l) => l.text);

    beforeAll(async () => {
      h = await createHarness({
        rateLimitPerMinute: 20_000,
        appsNow: () => Date.now() + clockOffset,
      });
      admin = createPool(h.adminUrl, 1);
      owner = await h.setup();
    }, 120_000);
    afterAll(async () => {
      await admin?.end();
      await h?.close();
    });

    it('an access token is fdvt_ and 32 random bytes; Bearer with one is read as an app’s, a sign-in’s is not', () => {
      const t = newAccessToken();
      expect(t).toMatch(/^fdvt_[A-Za-z0-9_-]{43}$/);
      expect(newAccessToken()).not.toBe(t);
      expect(readAppCredentials({ authorization: `Bearer ${t}` })).toEqual({
        kind: 'token',
        token: t,
      });
      expect(readAppCredentials({ authorization: `bearer  ${t}` })).toEqual({
        kind: 'token',
        token: t,
      });
      expect(readAppCredentials({ authorization: 'Bearer fdvt_short' })).toEqual({
        kind: 'malformed',
      });
      expect(readAppCredentials({ authorization: [`Bearer ${t}`, `Bearer ${t}`] })).toEqual({
        kind: 'malformed',
      });
      // A sign-in's token is nobody's app: not a credential here at all.
      expect(readAppCredentials({ authorization: 'Bearer eyJhbGciOi.x.y' })).toEqual({
        kind: 'none',
      });
      expect(presentsAppToken({ authorization: `Bearer ${t}` })).toBe(true);
      expect(presentsAppToken({ authorization: 'Bearer eyJhbGciOi.x.y' })).toBe(false);
      // A network: an IPv4 /24, an IPv6 /64, an IPv4 written as IPv6 as IPv4.
      expect(networkOf('203.0.113.77')).toBe('203.0.113.0/24');
      expect(networkOf('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
      expect(networkOf('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
      // Never in a log's words.
      expect(errorForLog(new Error(`refused ${t} again`)).message).toBe(
        'refused fdvt_[token] again',
      );
      expect(errorForLog(new Error(`Authorization: Bearer ${t}`)).message).toBe(
        'Authorization: Bearer [key]',
      );
    });

    it('the key, as Basic, and the grant, as a form, are answered a token as RFC 6749 says; it is kept as a hash, and taken as Bearer', async () => {
      const k = await connect(['documents.send', 'documents.read']);
      const res = await grant(k);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.pragma).toBe('no-cache');
      // The token route is where the key belongs: no word of deprecation there.
      expect(res.headers.deprecation).toBeUndefined();
      const t = res.json<AppAccessToken>();
      expect(t).toEqual({
        access_token: expect.stringMatching(/^fdvt_[A-Za-z0-9_-]{43}$/) as string,
        token_type: 'Bearer',
        expires_in: APP_TOKEN_SECONDS,
        scope: 'documents.send documents.read',
      });
      expect(APP_TOKEN_SECONDS).toBe(900);
      // Kept as its SHA-256 alone, bound to its key, fifteen minutes long.
      const kept = await admin.query<{ hash: Buffer; key_id: string; secs: number }>(
        `select token_hash as hash, key_id, extract(epoch from expires_at - created_at)::int as secs
         from connected_app_token where app_id = $1`,
        [k.appId],
      );
      expect(kept.rows).toEqual([
        {
          hash: createHash('sha256').update(t.access_token).digest(),
          key_id: k.keyId,
          secs: 900,
        },
      ]);
      const dump = await admin.query<{ t: string }>(
        'select row_to_json(x)::text as t from connected_app_token x',
      );
      expect(dump.rows.map((r) => r.t).join()).not.toContain(t.access_token.slice(5));
      // Bearer: answered, with no Deprecation; the key as Basic: answered, deprecated.
      const viaToken = await call('GET', '/api/v1/apps/me', `Bearer ${t.access_token}`);
      expect(viaToken.statusCode, viaToken.body).toBe(200);
      expect(viaToken.headers.deprecation).toBeUndefined();
      const viaBasic = await call('GET', '/api/v1/apps/me', basic(k));
      expect(viaBasic.statusCode).toBe(200);
      expect(viaBasic.headers.deprecation).toBe(APP_BASIC_DEPRECATION);
      // Refused as Basic: no header (it was never let through).
      const wrong = await call(
        'GET',
        '/api/v1/apps/me',
        basicFor({ clientId: k.clientId, secret: `fdvs_${'A'.repeat(43)}` }).authorization,
      );
      expect(codeOf(wrong)).toEqual([401, 'app_key_invalid']);
      expect(wrong.headers.deprecation).toBeUndefined();
      // And the token is never in the request log's words, nor the activity log.
      expect(JSON.stringify(await lines())).not.toContain(t.access_token);
    });

    it('the token route takes client credentials alone, as a form, with the key alone', async () => {
      const k = await connect();
      const t = await tokenFor(k);
      for (const [why, o, want] of [
        ['no grant', { body: 'scope=documents.send' }, [400, 'invalid_request']],
        [
          'JSON',
          { body: '{"grant_type":"client_credentials"}', type: 'application/json' },
          [400, 'invalid_request'],
        ],
        [
          'the secret in the body too',
          { body: `grant_type=client_credentials&client_secret=${k.secret}` },
          [400, 'invalid_request'],
        ],
        [
          'the grant twice',
          { body: 'grant_type=client_credentials&grant_type=client_credentials' },
          [400, 'invalid_request'],
        ],
        ['another grant', { body: 'grant_type=password' }, [400, 'unsupported_grant_type']],
        ['a token for a token', { as: `Bearer ${t}` }, [401, 'app_key_required']],
        ['a sign-in', { as: `Bearer ${owner.access_token}` }, [401, 'app_key_required']],
      ] as const) {
        expect(codeOf(await grant(k, o)), why).toEqual(want);
      }
      // A GET of it is no route at all; and its key is the app's alone.
      const get = await call('GET', '/api/v1/apps/token', basic(k));
      expect(codeOf(get)).toEqual([401, 'app_key_not_accepted']);
    });

    it('a token is refused once it ends, one the vault never gave is a guess, and either is refused off the app routes', async () => {
      const k = await connect();
      const t = await tokenFor(k);
      expect(codeOf(await call('GET', '/api/v1/apps/me', `Bearer fdvt_${'B'.repeat(43)}`))).toEqual(
        [401, 'app_token_invalid'],
      );
      expect(codeOf(await call('GET', '/api/v1/apps/me', 'Bearer fdvt_short'))).toEqual([
        401,
        'app_token_invalid',
      ]);
      expect(codeOf(await call('GET', '/api/v1/documents', `Bearer ${t}`))).toEqual([
        401,
        'app_key_not_accepted',
      ]);
      expect(codeOf(await call('GET', '/healthz', `Bearer ${t}`))).toEqual([
        401,
        'app_key_not_accepted',
      ]);
      // Fifteen minutes on: ended, and asked for again.
      clockOffset = (APP_TOKEN_SECONDS + 1) * 1000;
      try {
        expect(codeOf(await call('GET', '/api/v1/apps/me', `Bearer ${t}`))).toEqual([
          401,
          'app_token_expired',
        ]);
        const again = await tokenFor(k);
        expect((await call('GET', '/api/v1/apps/me', `Bearer ${again}`)).statusCode).toBe(200);
      } finally {
        clockOffset = 0;
      }
    });

    it('a token ends at once with its key revoked or expired, and its app paused or removed', async () => {
      const k = await connect();
      const t = await tokenFor(k);
      const me = () => call('GET', '/api/v1/apps/me', `Bearer ${t}`);
      const sent = () => call('GET', '/api/v1/apps/intake?external_ids=a', `Bearer ${t}`);
      expect((await sent()).statusCode).toBe(200);
      // Paused: refused but for GET /apps/me, which says so; given tokens still.
      await h.decider(owner);
      expect((await send('POST', `/api/v1/connected-apps/${k.appId}/pause`)).statusCode).toBe(200);
      expect(codeOf(await sent())).toEqual([403, 'app_paused']);
      expect(await me().then((r) => r.json<{ state: string }>().state)).toBe('paused');
      expect((await grant(k)).statusCode).toBe(200);
      await h.decider(owner);
      expect((await send('POST', `/api/v1/connected-apps/${k.appId}/resume`)).statusCode).toBe(200);
      expect((await sent()).statusCode).toBe(200);
      // The key past its expiry: its token with it.
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `update connected_app_key set created_at = now() - interval '2 days',
              expires_at = now() - interval '1 minute' where id = $1`,
        [k.keyId],
      );
      await admin.query('commit');
      expect(codeOf(await me())).toEqual([401, 'app_key_expired']);
      expect(codeOf(await grant(k))).toEqual([401, 'app_key_expired']);
      // Another key, revoked: its token ends at once.
      const other = await appKeyFor(h, owner, { id: k.appId, scopes: ['documents.send'] });
      const k2 = { ...other, appId: k.appId };
      const t2 = await tokenFor(k2);
      await h.decider(owner);
      expect(
        (await send('DELETE', `/api/v1/connected-apps/${k.appId}/keys/${k2.keyId}`)).statusCode,
      ).toBe(204);
      expect(codeOf(await call('GET', '/api/v1/apps/me', `Bearer ${t2}`))).toEqual([
        401,
        'app_key_revoked',
      ]);
      // And the app removed: every token of it.
      const k3 = await connect();
      const t3 = await tokenFor(k3);
      expect((await send('DELETE', `/api/v1/connected-apps/${k3.appId}`)).statusCode).toBe(204);
      expect(codeOf(await call('GET', '/api/v1/apps/me', `Bearer ${t3}`))).toEqual([
        401,
        'app_revoked',
      ]);
    });

    it('a key is given so many tokens a minute', async () => {
      const k = await connect();
      const now = Date.now();
      // Held at the start of a minute, so the count is this minute's.
      clockOffset = Math.ceil(now / 60_000) * 60_000 + 1000 - now;
      try {
        for (let i = 0; i < APP_TOKENS_PER_KEY_PER_MINUTE; i++) {
          expect((await grant(k, { from: `192.0.2.${i + 1}` })).statusCode).toBe(200);
        }
        const used = await admin.query<{ at: Date | null }>(
          'select last_used_at as at from connected_app_key where id = $1',
          [k.keyId],
        );
        const over = await grant(k, { from: '192.0.2.200' });
        expect(codeOf(over)).toEqual([429, 'rate_limited']);
        expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
        // Refused before its use is noted, and counted on the app as a refusal.
        const after = await admin.query<{ at: Date | null; refused: number; last: string }>(
          `select k.last_used_at as at, a.refused_today as refused, a.last_refusal as last
             from connected_app_key k join connected_app a on a.id = k.app_id where k.id = $1`,
          [k.keyId],
        );
        expect(after.rows[0]).toEqual({ at: used.rows[0]?.at, refused: 1, last: 'rate_limited' });
        expect(
          (
            await admin.query(
              'select 1 from connected_app_key_network where key_id = $1 and network = $2',
              [k.keyId, '192.0.2.0/24'],
            )
          ).rowCount,
        ).toBe(1);
        // Its tokens still work.
        expect(await connect().then((x) => tokenFor(x))).toMatch(/^fdvt_/);
      } finally {
        clockOffset = 0;
      }
    });

    it('an address is held to so many tries at the token route before any key is looked at', async () => {
      const k = await connect();
      const now = Date.now();
      clockOffset = Math.ceil(now / 60_000) * 60_000 + 1000 - now;
      try {
        // No key at all: refused for that, and counted on the address.
        for (let i = 0; i < APP_TOKENS_PER_ADDRESS_PER_MINUTE; i++) {
          const res = await call('POST', '/api/v1/apps/token', 'Bearer x', {
            from: '203.0.113.250',
            body: 'grant_type=client_credentials',
            type: 'application/x-www-form-urlencoded',
          });
          expect(codeOf(res)).toEqual([401, 'app_key_required']);
        }
        // Past them, even a good key waits, and nothing of it is looked at or noted.
        const over = await grant(k, { from: '203.0.113.250' });
        expect(codeOf(over)).toEqual([429, 'rate_limited']);
        const app = await admin.query<{ refused: number }>(
          'select refused_today as refused from connected_app where id = $1',
          [k.appId],
        );
        expect(app.rows[0]?.refused).toBe(0);
        // Another address is not held.
        expect((await grant(k, { from: '203.0.114.1' })).statusCode).toBe(200);
      } finally {
        clockOffset = 0;
      }
    });

    it('the token route reads a form alone, said so: not text/plain, not JSON', async () => {
      const k = await connect();
      for (const type of [
        'text/plain',
        'text/plain; charset=utf-8',
        'application/json',
        'application/x-www-form-urlencoded-x',
        'multipart/form-data; boundary=x',
      ]) {
        expect(codeOf(await grant(k, { type })), type).toEqual([400, 'invalid_request']);
      }
      expect(
        (await grant(k, { type: 'application/x-www-form-urlencoded; charset=UTF-8' })).statusCode,
      ).toBe(200);
    });

    it('a request past the app’s rate writes nothing: no use, no network, no day; the first refusal alone is counted', async () => {
      const k = await connect();
      const t = await tokenFor(k);
      const now = Date.now();
      clockOffset = Math.ceil(now / 60_000) * 60_000 + 1000 - now;
      try {
        let n = 0;
        for (; n < APP_REQUESTS_PER_MINUTE; n++) {
          expect((await call('GET', '/api/v1/apps/me', `Bearer ${t}`)).statusCode).toBe(200);
        }
        const state = async () =>
          (
            await admin.query<{
              used: Date | null;
              refused: number;
              requests: number;
              nets: number;
            }>(
              `select k.last_used_at as used, a.refused_today as refused,
                      (select coalesce(sum(requests), 0)::int from connected_app_day d
                        where d.app_id = a.id) as requests,
                      (select count(*)::int from connected_app_key_network n
                        where n.key_id = k.id) as nets
                 from connected_app_key k join connected_app a on a.id = k.app_id
                where k.id = $1`,
              [k.keyId],
            )
          ).rows[0];
        const before = await state();
        // Past it, from a network never seen: refused, and nothing of it written…
        const first = await call('GET', '/api/v1/apps/me', `Bearer ${t}`, { from: '192.0.2.77' });
        expect(codeOf(first)).toEqual([429, 'rate_limited']);
        // …but the minute's first refusal, counted on the app; the next, not even that.
        expect(await state()).toEqual({ ...before, refused: (before?.refused ?? 0) + 1 });
        const again = await call('GET', '/api/v1/apps/me', `Bearer ${t}`, { from: '192.0.2.78' });
        expect(codeOf(again)).toEqual([429, 'rate_limited']);
        expect(await state()).toEqual({ ...before, refused: (before?.refused ?? 0) + 1 });
      } finally {
        clockOffset = 0;
      }
      // 120 requests and more, on a machine others share.
    }, 120_000);

    it('a key keeps 500 networks at most: past them, a new one is neither kept nor told of', async () => {
      const k = await connect();
      const t = await tokenFor(k);
      await admin.query(
        `insert into connected_app_key_network (key_id, household_id, network)
         select $1, household_id, '10.' || (g / 256) || '.' || (g % 256) || '.0/24'
           from connected_app, generate_series(1, $3::int - 1) g where id = $2`,
        [k.keyId, k.appId, APP_KEY_NETWORKS_MAX],
      );
      const count = async () =>
        (
          await admin.query<{ n: number }>(
            'select count(*)::int as n from connected_app_key_network where key_id = $1',
            [k.keyId],
          )
        ).rows[0]?.n;
      expect(await count()).toBe(APP_KEY_NETWORKS_MAX);
      const before = alertsSent(h).length;
      expect(
        (await call('GET', '/api/v1/apps/me', `Bearer ${t}`, { from: '192.0.2.99' })).statusCode,
      ).toBe(200);
      expect(await count()).toBe(APP_KEY_NETWORKS_MAX);
      expect(alertsSent(h).length).toBe(before);
      // One it knows is still noted.
      expect((await call('GET', '/api/v1/apps/me', `Bearer ${t}`)).statusCode).toBe(200);
    });

    it('a new key lasts 90 days unless said; never, only when said', async () => {
      const k = await connect();
      await h.decider(owner);
      // Its first key goes; then one with nothing said, and one that never expires.
      await send('DELETE', `/api/v1/connected-apps/${k.appId}/keys/${k.keyId}`);
      const made = async (body: Record<string, unknown>) => {
        await h.decider(owner);
        const res = await send('POST', `/api/v1/connected-apps/${k.appId}/keys`, {
          permissions: ['documents.send'],
          ...body,
        });
        expect(res.statusCode, res.body).toBe(201);
        return res.json<ConnectedAppKeyMade>();
      };
      const plain = await made({});
      const left = Date.parse(plain.key.expires_at as string) - Date.now();
      expect(left).toBeGreaterThan(89.9 * 864e5);
      expect(left).toBeLessThanOrEqual(90 * 864e5 + 60_000);
      const never = await made({ expires_in_days: null });
      expect(never.key.expires_at).toBeNull();
      // Each live key with what to paste for it: its own client ID, never a secret.
      const view = (await send('GET', '/api/v1/connected-apps'))
        .json<{
          items: ConnectedAppView[];
        }>()
        .items.find((a) => a.id === k.appId);
      const strings = Object.fromEntries(
        (view?.keys ?? []).map((x) => [x.client_id, x.connection_string ?? null]),
      );
      expect(strings[k.clientId]).toBeNull();
      for (const x of [plain, never]) {
        const s = strings[x.client_id] as string;
        const json = JSON.parse(
          Buffer.from(s.slice('fdvapp2.'.length), 'base64url').toString(),
        ) as Record<string, unknown>;
        expect(json).toMatchObject({ client_id: x.client_id });
        expect(s).not.toContain(x.secret);
        expect(json).not.toHaveProperty('secret');
      }
    });

    it('the owners are emailed the first time a key is used from a new network, once a day, and the activity log says so', async () => {
      const k = await connect();
      const before = alertsSent(h).length;
      // Its very first network is no news.
      await tokenFor(k, '203.0.113.10');
      await tokenFor(k, '203.0.113.99');
      expect(alertsSent(h).length).toBe(before);
      // Another network: the owners are told, by email.
      const t = await tokenFor(k, '198.51.100.20');
      const sent = alertsSent(h).slice(before);
      expect(sent).toEqual([
        expect.objectContaining({
          account_ids: [expect.any(String) as string],
          subject: 'Acme Money was used from a new network',
          email_only: true,
        }),
      ]);
      expect(String(sent[0]?.body)).toContain('198.51.100.0/24');
      expect(String(sent[0]?.body)).toContain(k.clientId);
      expect(String(sent[0]?.body)).not.toContain(k.secret);
      expect(await lines()).toContain('An API key of Acme Money was used from a new network');
      // A third network the same day: noted, not told again.
      expect(
        (await call('GET', '/api/v1/apps/me', `Bearer ${t}`, { from: '192.0.2.44' })).statusCode,
      ).toBe(200);
      expect(alertsSent(h).length).toBe(before + 1);
      const seen = await admin.query<{ network: string; told: boolean }>(
        `select network, told_at is not null as told from connected_app_key_network
        where key_id = $1 order by first_seen_at, network`,
        [k.keyId],
      );
      expect(seen.rows).toEqual([
        { network: '203.0.113.0/24', told: false },
        { network: '198.51.100.0/24', told: true },
        { network: '192.0.2.0/24', told: false },
      ]);
      // An IPv6 caller by its /64.
      await call('GET', '/api/v1/apps/me', `Bearer ${t}`, { from: '2001:db8:aa:bb::1' });
      await call('GET', '/api/v1/apps/me', `Bearer ${t}`, { from: '2001:db8:aa:bb::2' });
      const v6 = await admin.query<{ n: number }>(
        `select count(*)::int as n from connected_app_key_network
        where key_id = $1 and network = '2001:db8:aa:bb::/64'`,
        [k.keyId],
      );
      expect(v6.rows[0]?.n).toBe(1);
    });

    it('the owners are emailed when an app’s day goes far past its usual, once a day, and the activity log says so', async () => {
      const k = await connect();
      const t = await tokenFor(k);
      // A week of ten requests a day before today; today, as far as the
      // threshold. Its usual is worked out as the day begins.
      const day = (
        await admin.query<{ today: string }>(
          `select (now() at time zone coalesce(nullif(timezone, ''), 'UTC'))::date::text as today
           from household limit 1`,
        )
      ).rows[0]?.today as string;
      await admin.query(
        `insert into connected_app_day (app_id, household_id, day, requests)
       select $1, household_id, $2::date - g, 10 from connected_app, generate_series(1, 7) g
        where id = $1`,
        [k.appId, day],
      );
      await admin.query('delete from connected_app_day where app_id = $1 and day = $2::date', [
        k.appId,
        day,
      ]);
      const before = alertsSent(h).length;
      expect((await call('GET', '/api/v1/apps/me', `Bearer ${t}`)).statusCode).toBe(200);
      const row = await admin.query<{ requests: number; usual: number }>(
        'select requests, usual from connected_app_day where app_id = $1 and day = $2::date',
        [k.appId, day],
      );
      expect(row.rows[0]).toEqual({ requests: 1, usual: 10 });
      // Past five times its usual but not past 200: nothing.
      await admin.query(
        'update connected_app_day set requests = $3 where app_id = $1 and day = $2::date',
        [k.appId, day, APP_BUSY_DAY_MIN - 1],
      );
      await call('GET', '/api/v1/apps/me', `Bearer ${t}`);
      expect(alertsSent(h).length).toBe(before);
      // Past both: told, once.
      await call('GET', '/api/v1/apps/me', `Bearer ${t}`);
      await call('GET', '/api/v1/apps/me', `Bearer ${t}`);
      const sent = alertsSent(h).slice(before);
      expect(sent).toEqual([
        expect.objectContaining({
          account_ids: [expect.any(String) as string],
          subject: 'Acme Money made many more requests than usual today',
          email_only: true,
        }),
      ]);
      expect(String(sent[0]?.body)).toContain(`${APP_BUSY_DAY_MIN + 1} requests`);
      expect(String(sent[0]?.body)).toContain('about 10');
      expect(await lines()).toContain('Acme Money made many more requests than usual today');
      // An app with no day before today has no usual: never told.
      const fresh = await connect();
      const ft = await tokenFor(fresh);
      await admin.query('update connected_app_day set requests = 5000 where app_id = $1', [
        fresh.appId,
      ]);
      const n = alertsSent(h).length;
      await call('GET', '/api/v1/apps/me', `Bearer ${ft}`);
      expect(alertsSent(h).length).toBe(n);
    });
  },
);
