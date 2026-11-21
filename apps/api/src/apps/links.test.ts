import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  type ActivityLine,
  type AppChanges,
  type AppDeleted,
  type AppIntakeState,
  type AppLinkMinted,
  type AppLinkSession,
  type AppMe,
  type ConnectedAppView,
  type DocumentView,
  type Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_API_HEADERS } from '../app.js';
import { alertsSent, appKeyFor, basicFor, createHarness, type Harness } from '../test-harness.js';
import { crossSite, sameNetwork, trashBody } from './links.js';

/**
 * A connected app's links and deletes (0.9.0, APP3): a link opens once,
 * within two minutes, for a session of ten in that browser at that address,
 * the app's read rule asked again every time; a delete lets go of, or moves
 * to the Trash, the app's own document and nothing else.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

interface TestApp {
  appId: string;
  keyId: string;
  clientId: string;
  secret: string;
}

let peers = 0;
const peer = () => `10.74.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
let browsers = 0;
/** A browser's own address: each opens its links from one. */
const browser = () => `203.0.113.${++browsers & 0xff}`;
const codeOf = (r: { json: () => unknown }) =>
  (r.json() as { error?: { code?: string } }).error?.code;
const ALL = ['documents.send', 'documents.read', 'documents.links', 'documents.delete'];

describe('the address a link session is bound to', () => {
  it('IPv4 exactly, IPv6 by its /64, an IPv4 written as IPv6 as itself', () => {
    expect(sameNetwork('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(sameNetwork('203.0.113.7', '203.0.113.8')).toBe(false);
    expect(sameNetwork('::ffff:203.0.113.7', '203.0.113.7')).toBe(true);
    expect(sameNetwork('2001:db8:1:2::1', '2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(true);
    expect(sameNetwork('2001:db8:1:2::1', '2001:db8:1:3::1')).toBe(false);
    expect(sameNetwork('2001:db8::1', '2001:0db8:0000:0000:ffff::2')).toBe(true);
    expect(sameNetwork('203.0.113.7', '2001:db8::1')).toBe(false);
    expect(sameNetwork(null, '203.0.113.7')).toBe(false);
    expect(sameNetwork(null, null)).toBe(false);
  });
});

describe('the open’s other-site check, and what a move to the Trash says (0.9.0-dev.68)', () => {
  it('another host in Origin, else Referer, is another site; none, or null, proves nothing', () => {
    const own = ['vault.example:8080', 'https://share.example'];
    expect(crossSite({}, own)).toBe(false);
    expect(crossSite({ origin: 'null' }, own)).toBe(false);
    expect(crossSite({ origin: 'https://vault.example' }, own)).toBe(false);
    expect(crossSite({ origin: 'https://share.example' }, own)).toBe(false);
    expect(crossSite({ referer: 'https://VAULT.example/api/v1/app-links/x' }, own)).toBe(false);
    expect(crossSite({ origin: 'https://evil.example' }, own)).toBe(true);
    expect(crossSite({ origin: 'null', referer: 'https://evil.example/' }, own)).toBe(true);
    expect(crossSite({ origin: 'https://vault.example.evil.example' }, own)).toBe(true);
    expect(crossSite({ origin: 'garbage' }, own)).toBe(true);
  });

  it('Sec-Fetch-Site cross-site or same-site is another page; same-origin, none or absent pass on', () => {
    const own = ['vault.example'];
    expect(crossSite({ secFetchSite: 'cross-site' }, own)).toBe(true);
    expect(crossSite({ secFetchSite: 'same-site' }, own)).toBe(true);
    expect(crossSite({ secFetchSite: 'Cross-Site', origin: 'https://vault.example' }, own)).toBe(
      true,
    );
    expect(crossSite({ secFetchSite: 'same-origin', origin: 'https://vault.example' }, own)).toBe(
      false,
    );
    expect(crossSite({ secFetchSite: 'none' }, own)).toBe(false);
    // Same-origin by its own word, but naming another host: still refused.
    expect(crossSite({ secFetchSite: 'same-origin', origin: 'https://evil.example' }, own)).toBe(
      true,
    );
  });

  it('names the app always, and the document only when it may be named', () => {
    expect(trashBody('Acme Money', { named: 'Water bill', theirs: true })).toMatch(
      /^Acme Money moved your document “Water bill” to the Trash\. /,
    );
    expect(trashBody('Acme Money', { named: 'Water bill', theirs: false })).toMatch(
      /^Acme Money moved “Water bill” to the Trash\. /,
    );
    expect(trashBody('Acme Money', { named: null, theirs: true })).toMatch(
      /^Acme Money moved one of your documents to the Trash\. /,
    );
    expect(trashBody('Acme Money', { named: null, theirs: false })).toMatch(
      /^Acme Money moved a document to the Trash\. /,
    );
  });
});

describe.skipIf(!testAdminUrl())('connected apps: links and deletes (0.9.0, APP3)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;

  const send = (t: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(t),
      ...(payload === undefined ? {} : { payload: payload as never }),
      remoteAddress: peer(),
    });

  async function connect(input: Record<string, unknown> = {}, name = 'Linker') {
    await h.decider(owner);
    const res = await send(owner, 'POST', '/api/v1/connected-apps', {
      name,
      member_id: owner.member_id,
      allowed_kinds: ['utility_bill'],
      scopes: ALL,
      ...input,
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json<ConnectedAppView>();
    const key = await appKeyFor(h, owner, view);
    return { appId: view.id, ...key, view };
  }

  async function call(
    a: TestApp,
    target: string,
    method: 'GET' | 'DELETE' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<LightMyRequestResponse> {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const signed = basicFor(a);
    return h.app.inject({
      method,
      url: target,
      headers: {
        ...signed,
        ...(bytes ? { 'content-type': 'application/json' } : {}),
      },
      ...(bytes ? { payload: bytes } : {}),
      remoteAddress: '127.0.0.1',
    });
  }

  const mint = async (a: TestApp, id: string, mode: string) =>
    call(a, `/api/v1/apps/documents/${id}/links`, 'POST', { mode });
  const minted = async (a: TestApp, id: string, mode = 'view') => {
    const r = await mint(a, id, mode);
    expect(r.statusCode, r.body).toBe(201);
    return r.json<AppLinkMinted>();
  };
  const pathOf = (url: string) => new URL(url).pathname;
  const browse = (
    url: string,
    from: string,
    cookie?: string,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method: 'GET',
      url,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      remoteAddress: from,
    });
  /**
   * A link's open, as its page sends it (0.9.0-dev.68): a POST to the
   * link's own address, from its own page — no Origin worth the name, as a
   * page with no referrer sends, unless a test says otherwise.
   */
  const press = (url: string, from: string, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', ...headers },
      payload: '',
      remoteAddress: from,
    });
  /** A link opened by a browser: its page first, then the open; the session's cookie. */
  const open = async (link: AppLinkMinted, from: string) => {
    const page = await browse(pathOf(link.url), from);
    expect(page.statusCode, page.body).toBe(200);
    const r = await press(pathOf(link.url), from);
    expect(r.statusCode, r.body).toBe(303);
    const set = String(r.headers['set-cookie'] ?? '');
    return { r, cookie: set.split(';')[0] as string, set };
  };
  const accountOf = async (t: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [t.member_id],
      )
    ).rows[0]?.account_id;
  const lines = async () =>
    (await send(owner, 'GET', '/api/v1/audit?limit=100'))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);

  async function make(body: Record<string, unknown>): Promise<string> {
    const created = await send(owner, 'POST', '/api/v1/documents', {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: owner.member_id,
      issued: {
        date: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10),
        precision: 'day',
      },
      ...body,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<DocumentView>().id;
    await addVersion(id, String(body.title));
    return id;
  }
  async function addVersion(id: string, marker: string) {
    const form = new FormData();
    form.append('file', PDF(marker), { filename: `${marker}.pdf`, contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
      remoteAddress: peer(),
    });
    expect(up.statusCode, up.body).toBeLessThan(300);
  }
  /**
   * What an app sent, filed as this document, as filing it leaves it: the
   * document made by the send (or, `asVersion`, a family paper the send was
   * filed into), its current version the app's file.
   */
  const fileAsOwn = (appId: string, externalId: string, documentId: string, asVersion = false) =>
    admin.query(
      `insert into connected_app_intake (household_id, app_id, member_id, external_id, state,
                                         document_id, version_id, made_document, decided_at)
       values ($1, $2, $3, $4, 'filed', $5,
               (select id from document_version where document_id = $5
                 order by version_no desc limit 1), $6, now())`,
      [owner.household_id, appId, owner.member_id, externalId, documentId, !asVersion],
    );

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 50_000, publicApps: 'on' });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  // ---------------------------------------------------------------- links

  it('a view link opens once, within two minutes, for ten in that browser; its cookie is Lax and its own path’s', async () => {
    const a = await connect();
    const doc = await make({ title: 'Linked bill one' });
    await fileAsOwn(a.appId, 'link-1', doc);
    const link = await minted(a, doc);
    expect(link.mode).toBe('view');
    expect(link.session_minutes).toBe(10);
    expect(pathOf(link.url)).toMatch(/^\/api\/v1\/app-links\/[A-Za-z0-9_-]{43}$/);
    const left = Date.parse(link.open_by) - Date.now();
    expect(left).toBeGreaterThan(100_000);
    expect(left).toBeLessThanOrEqual(121_000);
    // Only its hash is kept.
    const token = pathOf(link.url).split('/').pop() as string;
    const kept = await admin.query<{ token_hash: Buffer }>(
      'select token_hash from connected_app_link where app_id = $1',
      [a.appId],
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]?.token_hash.toString('base64url')).not.toBe(token);

    const from = browser();
    const { r, set, cookie } = await open(link, from);
    expect(r.headers.location).toBe('/a');
    expect(set).toMatch(/^__Secure-fdv_app_link=[A-Za-z0-9_-]{43}; /);
    expect(set).toMatch(/Max-Age=600/);
    expect(set).toMatch(/Path=\/api\/v1\/app-links\/session(;|$)/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    // The public routes' headers, on the redirect as on everything here.
    for (const [k, v] of Object.entries(PUBLIC_API_HEADERS)) expect(r.headers[k]).toBe(v);
    // Once: again is "used", from the same browser or any other.
    const again = await press(pathOf(link.url), from);
    expect([again.statusCode, again.headers.location]).toEqual([303, '/a#used']);
    expect(again.headers['set-cookie']).toBeUndefined();
    // The session: what the page shows.
    const s = await browse('/api/v1/app-links/session', from, cookie);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json<AppLinkSession>()).toMatchObject({
      app: 'Linker',
      mode: 'view',
      title: 'Linked bill one',
    });
    // Not drawn yet: the page says so, and asks again; a page is "pending".
    expect(['drawing', 'ready']).toContain(s.json<AppLinkSession>().pages.state);
    const ends = Date.parse(s.json<AppLinkSession>().ends_at) - Date.now();
    expect(ends).toBeGreaterThan(9 * 60_000);
    expect(ends).toBeLessThanOrEqual(10 * 60_000 + 1000);
    const page = await browse('/api/v1/app-links/session/pages/1', from, cookie);
    expect([page.statusCode, codeOf(page)]).toEqual([404, 'preview_pending']);
    for (const [k, v] of Object.entries(PUBLIC_API_HEADERS)) expect(page.headers[k]).toBe(v);
    // A view link gives no file.
    const file = await browse('/api/v1/app-links/session/file', from, cookie);
    expect(file.statusCode).toBe(404);
    // From another network: refused, and nothing given.
    const there = await browse('/api/v1/app-links/session', '198.51.100.9', cookie);
    expect([there.statusCode, codeOf(there)]).toEqual([403, 'link_other_address']);
    // Without the cookie, or with a made-up one: over.
    const none = await browse('/api/v1/app-links/session', from);
    expect([none.statusCode, codeOf(none)]).toEqual([410, 'link_ended']);
    const made = await browse(
      '/api/v1/app-links/session',
      from,
      `__Secure-fdv_app_link=${'A'.repeat(43)}`,
    );
    expect([made.statusCode, codeOf(made)]).toEqual([410, 'link_ended']);
    // Its open is one line, "via" the app; the token is in no line.
    expect(await lines()).toContain('Owner via Linker opened “Linked bill one”');
    const audit = await admin.query<{ n: string }>(
      `select count(*) as n from audit_event where detail::text like '%' || $1 || '%'`,
      [token],
    );
    expect(Number(audit.rows[0]?.n)).toBe(0);
    // The session ends with its ten minutes.
    await admin.query(
      `update connected_app_link set session_until = now() - interval '1 second' where app_id = $1`,
      [a.appId],
    );
    const over = await browse('/api/v1/app-links/session', from, cookie);
    expect([over.statusCode, codeOf(over)]).toEqual([410, 'link_ended']);
  });

  it('a link’s address is a page that consumes nothing: a preview’s GETs leave it; its POST opens it, once, within two minutes (0.9.0-dev.68)', async () => {
    const a = await connect({}, 'Previewed');
    const doc = await make({ title: 'Previewed bill' });
    await fileAsOwn(a.appId, 'link-preview', doc);
    const link = await minted(a, doc);
    const url = pathOf(link.url);
    const token = url.split('/').pop() as string;
    const from = browser();
    // A chat's or a mail scanner's preview: GET, twice, and HEAD — nothing used.
    for (const method of ['GET', 'GET', 'HEAD'] as const) {
      const r = await h.app.inject({ method, url, remoteAddress: browser() });
      expect(r.statusCode, method).toBe(200);
      expect(r.headers['set-cookie'], method).toBeUndefined();
    }
    const still = await admin.query<{ opened_at: Date | null }>(
      'select opened_at from connected_app_link where app_id = $1',
      [a.appId],
    );
    expect(still.rows[0]?.opened_at).toBeNull();
    expect(await lines()).not.toContain('Owner via Previewed opened “Previewed bill”');

    // The page: no-store, never indexed, framed or sniffed; a referrer only
    // to the vault itself, so its own POST carries its Origin; and a strict
    // policy with no script at all, its one style by its nonce.
    const page = await browse(url, from);
    expect(page.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['x-frame-options']).toBe('DENY');
    const csp = String(page.headers['content-security-policy']);
    const nonce = /style-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1] ?? '';
    expect(nonce.length).toBeGreaterThanOrEqual(22);
    expect(csp).toBe(
      `default-src 'none'; style-src 'nonce-${nonce}'; ` +
        "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    // Nothing on it submits by itself: no script, no handler, no refresh.
    expect(page.body).not.toMatch(/<script|\bon[a-z]+=|\.submit\(|http-equiv/i);
    expect(page.body).toContain(`<style nonce="${nonce}">`);
    expect(page.body).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
    // A clear Open button, a plain form POST to the same address, and the
    // words: open the document; the link works once.
    expect(page.body).toContain('<h1>Open the document</h1>');
    expect(page.body).toContain('This link works once');
    expect(page.body).toContain(`<form method="post" action="/api/v1/app-links/${token}">`);
    expect(page.body).toMatch(/<button type="submit">Open<\/button>/);
    // A fresh nonce each time.
    const second = await browse(url, from);
    expect(String(second.headers['content-security-policy'])).not.toContain(nonce);

    // From anywhere but its own page: refused, and nothing used.
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site', origin: 'http://localhost' },
      { origin: 'https://evil.example' },
      { origin: 'null', referer: 'https://evil.example/x' },
      { origin: 'not a url' },
    ]) {
      const r = await press(url, from, headers);
      expect([r.statusCode, codeOf(r)], JSON.stringify(headers)).toEqual([403, 'forbidden']);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const unused = await admin.query<{ opened_at: Date | null }>(
      'select opened_at from connected_app_link where app_id = $1',
      [a.appId],
    );
    expect(unused.rows[0]?.opened_at).toBeNull();
    // The POST its own page sends opens it: same-origin, its Origin the vault's.
    const opened = await press(url, from, {
      'sec-fetch-site': 'same-origin',
      origin: 'http://localhost:8080',
      referer: `http://localhost:8080${url}`,
    });
    expect([opened.statusCode, opened.headers.location]).toEqual([303, '/a']);
    expect(String(opened.headers['set-cookie'])).toMatch(/^__Secure-fdv_app_link=/);
    for (const [k, v] of Object.entries(PUBLIC_API_HEADERS)) expect(opened.headers[k]).toBe(v);
    expect(await lines()).toContain('Owner via Previewed opened “Previewed bill”');
    // A second POST is "used"; the page, asked again, is still only a page.
    const again = await press(url, from);
    expect([again.statusCode, again.headers.location]).toEqual([303, '/a#used']);
    expect(again.headers['set-cookie']).toBeUndefined();
    expect((await browse(url, from)).statusCode).toBe(200);
    // The session says the day it was opened, for the page's watermark.
    const cookie = String(opened.headers['set-cookie']).split(';')[0] as string;
    const s = await browse('/api/v1/app-links/session', from, cookie);
    expect(s.json<AppLinkSession>().opened_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Two minutes: a link's page still shows after them, but its POST is "ended".
    const late = await minted(a, doc);
    await admin.query(
      `update connected_app_link set open_by = now() - interval '1 second'
        where app_id = $1 and opened_at is null`,
      [a.appId],
    );
    expect((await browse(pathOf(late.url), from)).statusCode).toBe(200);
    const over = await press(pathOf(late.url), from);
    expect([over.statusCode, over.headers.location]).toEqual([303, '/a#ended']);
  });

  it('only the open takes a form: another route sent one is refused as before', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a%40b.c&password=x',
      remoteAddress: browser(),
    });
    expect(r.statusCode).toBe(415);
  });

  it('opened too late, made up, or for a document no longer readable: the page says it ended, never why', async () => {
    const a = await connect({}, 'Late');
    const doc = await make({ title: 'Linked bill two' });
    await fileAsOwn(a.appId, 'link-2', doc);
    const late = await minted(a, doc);
    await admin.query(
      `update connected_app_link set open_by = now() - interval '1 second' where app_id = $1`,
      [a.appId],
    );
    const r = await press(pathOf(late.url), browser());
    expect([r.statusCode, r.headers.location]).toEqual([303, '/a#ended']);
    expect(r.headers['set-cookie']).toBeUndefined();
    const fake = await press(`/api/v1/app-links/${'B'.repeat(43)}`, browser());
    expect([fake.statusCode, fake.headers.location]).toEqual([303, '/a#ended']);
    const odd = await press('/api/v1/app-links/not-a-token', browser());
    expect([odd.statusCode, odd.headers.location]).toEqual([303, '/a#ended']);
    // Its page is the same for a made-up token as for a good one; one the
    // vault could not have made is "ended" at once.
    expect((await browse(`/api/v1/app-links/${'B'.repeat(43)}`, browser())).statusCode).toBe(200);
    const oddPage = await browse('/api/v1/app-links/not-a-token', browser());
    expect([oddPage.statusCode, oddPage.headers.location]).toEqual([303, '/a#ended']);

    // Opened, then the document made Only me: the session ends at its next request.
    const link = await minted(a, doc);
    const from = browser();
    const { cookie } = await open(link, from);
    expect((await browse('/api/v1/app-links/session', from, cookie)).statusCode).toBe(200);
    await h.decider(owner);
    const made = await send(owner, 'PATCH', `/api/v1/documents/${doc}`, { visibility: 'private' });
    expect(made.statusCode, made.body).toBe(200);
    const after = await browse('/api/v1/app-links/session', from, cookie);
    expect([after.statusCode, codeOf(after)]).toEqual([410, 'link_ended']);
    // And minted for it now: the same 404 as a document that is not there.
    const no = await mint(a, doc, 'view');
    expect([no.statusCode, codeOf(no)]).toEqual([404, 'not_found']);
    const nothing = await mint(a, randomUUID(), 'view');
    expect([nothing.statusCode, codeOf(nothing)]).toEqual([404, 'not_found']);
  });

  it('an app paused, removed, or its scope taken away: every session of it ends', async () => {
    const a = await connect({}, 'Paused');
    const doc = await make({ title: 'Linked bill three' });
    await fileAsOwn(a.appId, 'link-3', doc);
    const from = browser();
    const { cookie } = await open(await minted(a, doc), from);
    await h.decider(owner);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { scopes: ['documents.read'] });
    expect((await browse('/api/v1/app-links/session', from, cookie)).statusCode).toBe(410);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { scopes: ALL });
    expect((await browse('/api/v1/app-links/session', from, cookie)).statusCode).toBe(200);
    await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/pause`);
    expect((await browse('/api/v1/app-links/session', from, cookie)).statusCode).toBe(410);
    await h.decider(owner);
    await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/resume`);
    expect((await browse('/api/v1/app-links/session', from, cookie)).statusCode).toBe(200);
    await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}`);
    expect((await browse('/api/v1/app-links/session', from, cookie)).statusCode).toBe(410);
  });

  it('a key revoked, or past its expiry, ends what it opened: its unopened links and its sessions; another key’s go on (APP6)', async () => {
    const a = await connect({}, 'Keyed links');
    const doc = await make({ title: 'Linked bill keyed' });
    await fileAsOwn(a.appId, 'link-key', doc);
    await h.decider(owner);
    const other = { ...a, ...(await appKeyFor(h, owner, { id: a.appId, scopes: ALL })) };
    const from = browser();
    const { cookie } = await open(await minted(a, doc), from);
    const unopened = await minted(a, doc);
    const theirs = await open(await minted(other, doc), from);
    expect((await browse('/api/v1/app-links/session', from, cookie)).statusCode).toBe(200);
    // Revoked: the session it opened ends at its next request, and a link it
    // minted opens as ended; the other key's session is untouched.
    await h.decider(owner);
    const gone = await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}`);
    expect(gone.statusCode).toBe(204);
    expect((await browse('/api/v1/app-links/session', from, cookie)).statusCode).toBe(410);
    const late = await press(pathOf(unopened.url), from);
    expect([late.statusCode, late.headers.location]).toEqual([303, '/a#ended']);
    expect((await browse('/api/v1/app-links/session', from, theirs.cookie)).statusCode).toBe(200);
    // Past its expiry, as the database's clock has it: the same.
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(
        `update connected_app_key set created_at = now() - interval '2 days',
                expires_at = now() - interval '1 second' where id = $1`,
        [other.keyId],
      );
      await c.query('commit');
    } finally {
      c.release();
    }
    expect((await browse('/api/v1/app-links/session', from, theirs.cookie)).statusCode).toBe(410);
    const kept = await admin.query<{ key_id: string }>(
      'select key_id from connected_app_link where app_id = $1 order by created_at',
      [a.appId],
    );
    expect(kept.rows.map((r) => r.key_id)).toEqual([a.keyId, a.keyId, other.keyId]);
  });

  it('a link for a file the vault cannot draw is view_unavailable; a download link needs its scope, and gives an attachment', async () => {
    const a = await connect({ scopes: [...ALL, 'documents.download'] }, 'Downloader');
    const doc = await make({ title: 'Linked bill four' });
    await fileAsOwn(a.appId, 'link-4', doc);
    await admin.query(
      `update document_version set preview_state = 'unsupported' where document_id = $1`,
      [doc],
    );
    const view = await mint(a, doc, 'view');
    expect([view.statusCode, codeOf(view)]).toEqual([409, 'view_unavailable']);
    const bad = await mint(a, doc, 'print');
    expect([bad.statusCode, codeOf(bad)]).toEqual([422, 'validation_failed']);
    const link = await minted(a, doc, 'download');
    const from = browser();
    const { r, cookie } = await open(link, from);
    expect(r.headers.location).toBe('/api/v1/app-links/session/file');
    const file = await browse('/api/v1/app-links/session/file', from, cookie);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PDF('Linked bill four'))).toBe(true);
    expect(String(file.headers['content-disposition'])).toMatch(/^attachment/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('no-store');
    const part = await browse('/api/v1/app-links/session/file', from, cookie, {
      range: 'bytes=0-3',
    });
    expect([part.statusCode, part.body]).toEqual([206, '%PDF']);
    // A download link's page has no pages.
    expect((await browse('/api/v1/app-links/session/pages/1', from, cookie)).statusCode).toBe(404);
    expect(await lines()).toContain('Owner via Downloader downloaded “Linked bill four”');
    // From another network, the browser is sent to the page, which says so.
    const there = await browse('/api/v1/app-links/session/file', '198.51.100.10', cookie);
    expect([there.statusCode, there.headers.location]).toEqual([303, '/a#elsewhere']);
    // Without documents.download, no download link.
    await h.decider(owner);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { scopes: ALL });
    const no = await mint(a, doc, 'download');
    expect([no.statusCode, codeOf(no)]).toEqual([403, 'scope_not_granted']);
    const ended = await browse('/api/v1/app-links/session/file', from, cookie);
    expect([ended.statusCode, ended.headers.location]).toEqual([303, '/a#ended']);
  });

  it('the document’s own people see on its Activity what an app read of it, by the app’s name; its list reads stay one line for the owners (0.9.0-dev.77)', async () => {
    const a = await connect({ scopes: [...ALL, 'documents.download'] }, 'Acme Money');
    const teen = await h.join(owner, {
      name: 'Tamsin',
      email: `tamsin-${randomUUID().slice(0, 8)}@example.test`,
      role: 'teen',
    });
    const doc = await make({ title: 'Tamsin’s phone bill', owner_member_id: teen.member_id });
    await fileAsOwn(a.appId, 'read-tamsin', doc);
    // Its list, its details, a link to view (opened), a link to download.
    expect((await call(a, '/api/v1/apps/documents')).statusCode).toBe(200);
    expect((await call(a, `/api/v1/apps/documents/${doc}`)).statusCode).toBe(200);
    const view = await minted(a, doc, 'view');
    await open(view, browser());
    await minted(a, doc, 'download');
    // Each a line on the document's own Activity, for whoever may see it:
    // the teen whose bill it is, who is neither an owner nor the app's person.
    const activity = (await send(teen, 'GET', `/api/v1/documents/${doc}/activity?limit=50`))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
    expect(activity).toEqual(
      expect.arrayContaining([
        'Owner via Acme Money read the details of “Tamsin’s phone bill”',
        'Owner via Acme Money made a link to view “Tamsin’s phone bill”',
        'Owner via Acme Money opened “Tamsin’s phone bill”',
        'Owner via Acme Money made a link to download “Tamsin’s phone bill”',
      ]),
    );
    // The list: one line an hour for the owners and the app's person, never
    // a line on every document it listed.
    expect(activity.join('\n')).not.toContain('looked up documents');
    expect(await lines()).toContain('Owner via Acme Money looked up documents');
    const made = await admin.query<{ n: string }>(
      `select count(*) as n from audit_event
        where action = 'app.link_made' and object_id = $1 and detail->>'app_id' = $2`,
      [doc, a.appId],
    );
    expect(Number(made.rows[0]?.n)).toBe(2);
  });

  it('links an hour are capped as the owner sets; without the scope, none', async () => {
    const a = await connect({ links_per_hour: 2 }, 'Capped');
    const doc = await make({ title: 'Linked bill five' });
    await fileAsOwn(a.appId, 'link-5', doc);
    await minted(a, doc);
    await minted(a, doc);
    const full = await mint(a, doc, 'view');
    expect([full.statusCode, codeOf(full)]).toEqual([429, 'app_links_full']);
    expect(Number(full.headers['retry-after'])).toBeGreaterThan(3500);
    expect((await call(a, '/api/v1/apps/me')).json<AppMe>().limits.links_per_hour).toBe(2);
    const view = (await send(owner, 'GET', '/api/v1/connected-apps'))
      .json<{
        items: ConnectedAppView[];
      }>()
      .items.find((x) => x.id === a.appId);
    expect(view).toMatchObject({ links_per_hour: 2, links_last_hour: 2, links_opened_week: 0 });
    // Out of bounds: refused.
    await h.decider(owner);
    const big = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      links_per_hour: 601,
    });
    expect([big.statusCode, codeOf(big)]).toEqual([422, 'validation_failed']);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      scopes: ['documents.send', 'documents.read'],
    });
    const scope = await mint(a, doc, 'view');
    expect([scope.statusCode, codeOf(scope)]).toEqual([403, 'scope_not_granted']);
  });

  it('a link’s cookie and token are nothing anywhere else; an app’s API key is nothing here', async () => {
    const a = await connect({}, 'Elsewhere');
    const doc = await make({ title: 'Linked bill six' });
    await fileAsOwn(a.appId, 'link-6', doc);
    const from = browser();
    const { cookie } = await open(await minted(a, doc), from);
    for (const url of ['/api/v1/documents', `/api/v1/documents/${doc}`, '/api/v1/apps/me']) {
      const r = await browse(url, from, cookie);
      expect(r.statusCode, url).toBe(401);
    }
    const signed = basicFor(a);
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/v1/app-links/session',
      headers: { ...signed },
      remoteAddress: '127.0.0.1',
    });
    expect([r.statusCode, codeOf(r)]).toEqual([401, 'app_key_not_accepted']);
  });

  it('every byte a download link gives counts against the app’s day; past it, the page says so', async () => {
    const a = await connect({ scopes: [...ALL, 'documents.download'] }, 'Counted');
    const doc = await make({ title: 'Counted bill' });
    await fileAsOwn(a.appId, 'count-1', doc);
    const size = PDF('Counted bill').length;
    const from = browser();
    const { cookie } = await open(await minted(a, doc, 'download'), from);
    const got = await browse('/api/v1/app-links/session/file', from, cookie);
    expect(got.statusCode).toBe(200);
    const part = await browse('/api/v1/app-links/session/file', from, cookie, {
      range: 'bytes=0-3',
    });
    expect(part.statusCode).toBe(206);
    const today = await admin.query<{ n: string }>(
      'select read_bytes_today as n from connected_app where id = $1',
      [a.appId],
    );
    expect(Number(today.rows[0]?.n)).toBe(size + 4);
    // The day full: the browser is sent to the page, which says so; nothing counted.
    await admin.query(
      'update connected_app set daily_read_bytes = $2, read_bytes_today = $2 where id = $1',
      [a.appId, 1024 * 1024],
    );
    const full = await browse('/api/v1/app-links/session/file', from, cookie);
    expect([full.statusCode, full.headers.location]).toEqual([303, '/a#full']);
    // And the app's own download is refused the same.
    const own = await call(a, `/api/v1/apps/documents/${doc}/content`);
    expect([own.statusCode, codeOf(own)]).toEqual([429, 'app_read_day_full']);
  });

  it('a link needs reading too: the links scope alone mints nothing', async () => {
    const a = await connect({ scopes: ['documents.send', 'documents.links'] }, 'Unread');
    const doc = await make({ title: 'Unread bill' });
    await fileAsOwn(a.appId, 'unread-1', doc);
    const r = await mint(a, doc, 'view');
    expect([r.statusCode, codeOf(r)]).toEqual([403, 'scope_not_granted']);
    expect(r.json<{ error: { detail?: string } }>().error.detail).toBe('documents.read');
  });

  it('a cap lowered below the hour’s links: Retry-After is when enough of them are an hour old', async () => {
    const a = await connect({}, 'Lowered');
    const doc = await make({ title: 'Lowered bill' });
    await fileAsOwn(a.appId, 'lower-1', doc);
    for (let i = 0; i < 3; i++) await minted(a, doc);
    // Minted 50, 40 and 10 minutes ago.
    await admin.query(
      `update connected_app_link l set created_at = now() - make_interval(mins => m.mins)
         from (select id, (array[50, 40, 10])[row_number() over (order by created_at, id)] as mins
                 from connected_app_link where app_id = $1) m
        where l.id = m.id`,
      [a.appId],
    );
    await h.decider(owner);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { links_per_hour: 1 });
    const full = await mint(a, doc, 'view');
    expect([full.statusCode, codeOf(full)]).toEqual([429, 'app_links_full']);
    // Three in the hour, one allowed: room once the newest is an hour old,
    // about 50 minutes from now — not the oldest's 10.
    const wait = Number(full.headers['retry-after']);
    expect(wait).toBeGreaterThan(49 * 60);
    expect(wait).toBeLessThanOrEqual(50 * 60 + 5);
    expect(full.json<{ error: { retriable: boolean } }>().error.retriable).toBe(true);
  });

  it('trash, or more links an hour, for an app acting as somebody else waits for them again', async () => {
    const ahmed = await h.join(owner, {
      name: 'Ahmed Links',
      email: 'ahmed-links@example.test',
      role: 'adult',
    });
    const a = await connect({ member_id: ahmed.member_id }, 'Theirs');
    const state = async () =>
      (await send(owner, 'GET', '/api/v1/connected-apps'))
        .json<{ items: ConnectedAppView[] }>()
        .items.find((x) => x.id === a.appId)?.state;
    const approve = () =>
      admin.query(
        "update connected_app set approval = 'approved', approved_at = now() where id = $1",
        [a.appId],
      );
    expect(await state()).toBe('waiting_for_approval');
    await approve();
    expect(await state()).toBe('active');
    await h.decider(owner);
    // Less: nothing asked.
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { links_per_hour: 30 });
    expect(await state()).toBe('active');
    // Moving papers to the Trash: asked again.
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { delete_mode: 'trash' });
    expect(await state()).toBe('waiting_for_approval');
    await approve();
    // Back to letting go: nothing asked.
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { delete_mode: 'unlink' });
    expect(await state()).toBe('active');
    // More links an hour: asked again.
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { links_per_hour: 90 });
    expect(await state()).toBe('waiting_for_approval');
  });

  // -------------------------------------------------------------- deletes

  it('unlink: it lets go, the document stays; its intake reads unavailable; a second delete is 404', async () => {
    const a = await connect({}, 'Unlinker');
    const doc = await make({ title: 'Deleted bill one' });
    await fileAsOwn(a.appId, 'del-1', doc);
    const first = (await call(a, '/api/v1/apps/changes')).json<AppChanges>();
    expect(first.changes.map((c) => (c.change === 'changed' ? c.document.id : ''))).toContain(doc);
    const r = await call(a, `/api/v1/apps/documents/${doc}`, 'DELETE');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<AppDeleted>()).toEqual({ document_id: doc, result: 'unlinked' });
    // Still in the vault, out of the Trash.
    const still = await send(owner, 'GET', `/api/v1/documents/${doc}`);
    expect(still.statusCode).toBe(200);
    expect(still.json<DocumentView>().deleted_at ?? null).toBeNull();
    const status = (await call(a, '/api/v1/apps/intake/del-1')).json<AppIntakeState>();
    expect(status).toMatchObject({ state: 'unavailable', document_id: null, version_id: null });
    // Its feed says it is no longer its own, never why.
    const next = (await call(a, `/api/v1/apps/changes?cursor=${first.cursor}`)).json<AppChanges>();
    expect(next.changes).toEqual([
      { change: 'unavailable', at: expect.any(String) as string, document_id: doc },
    ]);
    const again = await call(a, `/api/v1/apps/documents/${doc}`, 'DELETE');
    expect([again.statusCode, codeOf(again)]).toEqual([404, 'not_found']);
    expect(await lines()).toContain(
      'Owner via Unlinker let go of “Deleted bill one”; it is still in the vault',
    );
  });

  it('unlinked under a grant: the feed says changed, no longer its own', async () => {
    const a = await connect({}, 'Granted');
    const doc = await make({ title: 'Granted own bill' });
    await fileAsOwn(a.appId, 'del-g', doc);
    await h.decider(owner);
    const g = await send(owner, 'PUT', `/api/v1/connected-apps/${a.appId}/grants`, {
      grants: [{ category: 'bills', lookback_months: 12 }],
      confirm_sensitive: true,
    });
    expect(g.statusCode, g.body).toBe(200);
    const first = (await call(a, '/api/v1/apps/changes')).json<AppChanges>();
    const before = first.changes.find((c) => c.change === 'changed' && c.document.id === doc);
    expect(before).toMatchObject({ document: { own: true, external_id: 'del-g' } });
    const r = await call(a, `/api/v1/apps/documents/${doc}`, 'DELETE');
    expect(r.json<AppDeleted>()).toEqual({ document_id: doc, result: 'unlinked' });
    const next = (await call(a, `/api/v1/apps/changes?cursor=${first.cursor}`)).json<AppChanges>();
    expect(next.changes).toHaveLength(1);
    expect(next.changes[0]).toMatchObject({
      change: 'changed',
      document: { id: doc, own: false, external_id: null },
    });
  });

  it('trash: its own moves to the Trash as its person would; never one it reads by a grant, nor one the family gave a newer file', async () => {
    const a = await connect({ delete_mode: 'trash' }, 'Trasher');
    expect((await call(a, '/api/v1/apps/me')).json<AppMe>().delete_mode).toBe('trash');
    const own = await make({ title: 'Trashed bill one' });
    await fileAsOwn(a.appId, 'del-2', own);
    const granted = await make({ title: 'Granted bill' });
    const newer = await make({ title: 'Newer bill' });
    await fileAsOwn(a.appId, 'del-3', newer);
    await addVersion(newer, 'a family file');
    // A family paper the app's file was filed into, as a new version: the family's.
    const into = await make({ title: 'Family paper' });
    await addVersion(into, 'the app’s file, filed into it');
    await fileAsOwn(a.appId, 'del-3b', into, true);
    await h.decider(owner);
    const g = await send(owner, 'PUT', `/api/v1/connected-apps/${a.appId}/grants`, {
      grants: [{ category: 'bills', lookback_months: 12 }],
      confirm_sensitive: true,
    });
    expect(g.statusCode, g.body).toBe(200);
    for (const id of [granted, newer, into, randomUUID()]) {
      const r = await call(a, `/api/v1/apps/documents/${id}`, 'DELETE');
      expect([r.statusCode, codeOf(r)], id).toEqual([404, 'not_found']);
    }
    const r = await call(a, `/api/v1/apps/documents/${own}`, 'DELETE');
    expect(r.json<AppDeleted>()).toEqual({ document_id: own, result: 'trashed' });
    const row = await admin.query<{ deleted_at: Date | null; updated_by: string }>(
      'select deleted_at, updated_by from document where id = $1',
      [own],
    );
    expect(row.rows[0]?.deleted_at).not.toBeNull();
    // As its person: the account the app acts as.
    const person = await admin.query<{ account_id: string }>(
      'select account_id from connected_app where id = $1',
      [a.appId],
    );
    expect(row.rows[0]?.updated_by).toBe(person.rows[0]?.account_id);
    expect(await lines()).toContain('Owner via Trasher moved “Trashed bill one” to the Trash');
    // Its person and the owners are told (0.9.0-dev.68): here one person, an
    // owner and the document's, told it was theirs, named as the household's
    // wording (Sensitive documents only) lets it be.
    const told = alertsSent(h).filter((m) => m.subject === 'Trasher moved a document to the Trash');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ account_ids: [await accountOf(owner)], email_only: true });
    expect(String(told[0]?.body)).toMatch(
      /^Trasher moved your document “Trashed bill one” to the Trash\. /,
    );
    // In the Trash: the app reads it no more.
    const gone = await call(a, `/api/v1/apps/documents/${own}`);
    expect(gone.statusCode).toBe(404);
    // Taken out of the Trash by the family: it is theirs, read only by the grant.
    const back = await send(owner, 'POST', `/api/v1/documents/${own}/restore`);
    expect(back.statusCode, back.body).toBe(200);
    const read = await call(a, `/api/v1/apps/documents/${own}`);
    expect(read.json<{ own: boolean; external_id: string | null }>()).toMatchObject({
      own: false,
      external_id: null,
    });
    // Without the scope, refused.
    await h.decider(owner);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      scopes: ['documents.send', 'documents.read'],
    });
    const scope = await call(a, `/api/v1/apps/documents/${own}`, 'DELETE');
    expect([scope.statusCode, codeOf(scope)]).toEqual([403, 'scope_not_granted']);
  });

  it('a move to the Trash is told without the title where the family’s wording hides it, to its person and every owner; a let-go is not told (0.9.0-dev.68)', async () => {
    const a = await connect({ delete_mode: 'trash' }, 'Quiet trasher');
    // Another owner, who is not the document's person.
    const second = await h.join(owner, {
      name: 'Second Owner',
      email: `second-${randomUUID().slice(0, 8)}@example.test`,
      role: 'owner',
    });
    const own = await make({ title: 'Hidden bill title' });
    await fileAsOwn(a.appId, 'del-quiet', own);
    await admin.query(`update household set neutral_wording = 'all' where id = $1`, [
      owner.household_id,
    ]);
    try {
      const before = alertsSent(h).length;
      const r = await call(a, `/api/v1/apps/documents/${own}`, 'DELETE');
      expect(r.json<AppDeleted>()).toEqual({ document_id: own, result: 'trashed' });
      const told = alertsSent(h)
        .slice(before)
        .filter((m) => m.subject === 'Quiet trasher moved a document to the Trash');
      expect(JSON.stringify(told)).not.toContain('Hidden bill title');
      const to = (re: RegExp) =>
        told.filter((m) => re.test(String(m.body))).flatMap((m) => m.account_ids as string[]);
      expect(to(/moved one of your documents to the Trash/)).toEqual([await accountOf(owner)]);
      expect(to(/moved a document to the Trash/)).toEqual([await accountOf(second)]);
    } finally {
      await admin.query(`update household set neutral_wording = 'sensitive' where id = $1`, [
        owner.household_id,
      ]);
    }
    // Let go of instead: nothing is told — the document stays where it was.
    const b = await connect({ delete_mode: 'unlink' }, 'Letting go');
    const kept = await make({ title: 'Kept bill' });
    await fileAsOwn(b.appId, 'del-kept', kept);
    const before = alertsSent(h).length;
    const r = await call(b, `/api/v1/apps/documents/${kept}`, 'DELETE');
    expect(r.json<AppDeleted>()).toEqual({ document_id: kept, result: 'unlinked' });
    expect(
      alertsSent(h)
        .slice(before)
        .some((m) => String(m.subject).includes('Letting go')),
    ).toBe(false);
  });

  it('the document’s person is told only if they may see it: a teen of an Adults only paper is not, of an Everyone paper is (0.9.0-dev.68)', async () => {
    const a = await connect({ delete_mode: 'trash' }, 'Teen trasher');
    const teen = await h.join(owner, {
      name: 'Tariq',
      email: `tariq-${randomUUID().slice(0, 8)}@example.test`,
      role: 'teen',
    });
    const teenAccount = (await accountOf(teen)) as string;
    const ownerAccount = await accountOf(owner);
    const hidden = await make({
      title: 'Adults only bill',
      visibility: 'adults',
      owner_member_id: teen.member_id,
    });
    await fileAsOwn(a.appId, 'del-teen-hidden', hidden);
    const seen = await make({ title: 'Everyone bill', owner_member_id: teen.member_id });
    await fileAsOwn(a.appId, 'del-teen-seen', seen);
    const trash = async (id: string) => {
      const before = alertsSent(h).length;
      const r = await call(a, `/api/v1/apps/documents/${id}`, 'DELETE');
      expect(r.json<AppDeleted>()).toEqual({ document_id: id, result: 'trashed' });
      return alertsSent(h)
        .slice(before)
        .filter((m) => m.subject === 'Teen trasher moved a document to the Trash');
    };
    // Adults only: the teen may not see it, so is told nothing, its title
    // least of all; the owners are told, by name.
    const toldHidden = await trash(hidden);
    const hiddenTo = toldHidden.flatMap((m) => m.account_ids as string[]);
    expect(hiddenTo).not.toContain(teenAccount);
    expect(hiddenTo).toContain(ownerAccount);
    expect(String(toldHidden[0]?.body)).toMatch(/^Teen trasher moved “Adults only bill” to the/);
    // Everyone: the teen is told it was theirs.
    const toldSeen = await trash(seen);
    const theirs = toldSeen.filter((m) => (m.account_ids as string[]).includes(teenAccount));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.account_ids).toEqual([teenAccount]);
    expect(String(theirs[0]?.body)).toMatch(
      /^Teen trasher moved your document “Everyone bill” to the Trash\. /,
    );
  });

  it('an app’s Trash emails stop at five a day; the sixth says there are more, to the owners alone (0.9.0-dev.68)', async () => {
    const a = await connect({ delete_mode: 'trash' }, 'Busy trasher');
    const ids: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const id = await make({ title: `Busy bill ${i}` });
      await fileAsOwn(a.appId, `del-busy-${i}`, id);
      ids.push(id);
    }
    const before = alertsSent(h).length;
    for (const id of ids) {
      const r = await call(a, `/api/v1/apps/documents/${id}`, 'DELETE');
      expect(r.json<AppDeleted>()).toEqual({ document_id: id, result: 'trashed' });
    }
    const sent = alertsSent(h)
      .slice(before)
      .filter((m) => String(m.subject).startsWith('Busy trasher'));
    const named = (n: number) => sent.filter((m) => String(m.body).includes(`“Busy bill ${n}”`));
    for (const n of [1, 2, 3, 4, 5]) expect(named(n).length, `bill ${n}`).toBeGreaterThan(0);
    for (const n of [6, 7]) expect(named(n), `bill ${n}`).toEqual([]);
    const more = sent.filter((m) => m.subject === 'Busy trasher moved more documents to the Trash');
    expect(more).toHaveLength(1);
    expect(String(more[0]?.body)).toMatch(/more than 5 documents to the Trash in the last day/);
    const owners = (
      await admin.query<{ account_id: string }>(
        `select account_id from account_household where household_id = $1 and role = 'owner'`,
        [owner.household_id],
      )
    ).rows.map((r) => r.account_id);
    expect([...(more[0]?.account_ids as string[])].sort()).toEqual([...owners].sort());
    // Every one is in the activity log all the same.
    const said = await lines();
    for (const n of [1, 6, 7]) {
      expect(said).toContain(`Owner via Busy trasher moved “Busy bill ${n}” to the Trash`);
    }
  });

  it('an Only me paper of its own, or one marked Sensitive, is untouchable', async () => {
    const a = await connect({ delete_mode: 'trash' }, 'Untouchable');
    const mine = await make({ title: 'Only me bill', visibility: 'private' });
    await fileAsOwn(a.appId, 'del-4', mine);
    const marked = await make({ title: 'Marked bill', sensitive: true });
    await fileAsOwn(a.appId, 'del-5', marked);
    for (const id of [mine, marked]) {
      const r = await call(a, `/api/v1/apps/documents/${id}`, 'DELETE');
      expect([r.statusCode, codeOf(r)], id).toEqual([404, 'not_found']);
      const row = await admin.query<{ deleted_at: Date | null }>(
        'select deleted_at from document where id = $1',
        [id],
      );
      expect(row.rows[0]?.deleted_at).toBeNull();
    }
  });
});
