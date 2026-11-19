import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../api.js';
import type { AppScope } from '@fdv/shared';
import { createAppClient, parseConnectionString, toBase64 } from '../apps.js';
import { ApiRequestError } from '../errors.js';
import { createHttp, type FetchLike } from '../http.js';
import { multipartBody } from '../multipart.js';
import { createFakeVault } from './fake.js';

/**
 * The fake vault's connected app reading (0.9.0, APP2), beyond what the
 * contract scenario asks of both vaults: what an integrator builds against
 * — its own documents and their external ids, the first read of the feed in
 * pages, a cursor too old, the download's ranges, headers and caps.
 */

/**
 * An app's client with an API key an owner generated for it (APP6): every
 * permission the app has, for 30 days.
 */
async function keyed(
  api: ReturnType<typeof createApi>,
  token: string,
  made: { id: string; scopes: AppScope[] },
  fetch: FetchLike,
) {
  const key = await api.connectedApps.generateKey(token, made.id, {
    permissions: made.scopes,
    expires_in_days: 30,
  });
  return createAppClient({
    url: 'https://fake.example',
    clientId: key.client_id,
    secret: key.secret,
    fetch,
  });
}
const PDF = new TextEncoder().encode('%PDF-1.4\n% fake app reads\n%%EOF\n');

async function refusal(p: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiRequestError);
    return e as ApiRequestError;
  }
  throw new Error('expected a refusal');
}

describe('the fake vault: what a connected app reads (APP2)', () => {
  it('its own, the feed in pages, a cursor too old, and a download’s ranges and caps', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const t = await api.setup({
      household_name: 'The fake family',
      display_name: 'Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    const token = t.access_token;
    const made = await api.connectedApps.create(token, {
      name: 'Reader',
      member_id: t.member_id,
      allowed_kinds: ['utility_bill'],
      scopes: ['documents.send', 'documents.read', 'documents.download'],
    });
    const app = await keyed(api, token, made, vault.fetch);
    const day = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
    const file = async (key: string, title: string, extra: Record<string, unknown> = {}) => {
      const form = multipartBody([
        {
          name: 'metadata',
          value: JSON.stringify({
            type_key: 'utility_bill',
            title,
            owner_member_id: t.member_id,
            issued: { date: day, precision: 'day' },
            visibility: 'household',
            extra,
          }),
        },
        { name: 'file', filename: `${title}.pdf`, contentType: 'application/pdf', bytes: PDF },
      ]);
      return (
        await api.capture(
          token,
          { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
          key,
        )
      ).document_id;
    };

    // Its own: sent, then filed — nothing granted, and still it reads it.
    await app.send({
      externalId: 'own-1',
      hints: { kind: 'utility_bill' },
      file: { bytes: PDF, filename: 'bill.pdf', contentType: 'application/pdf' },
    });
    const own = await file('a1b2c3d4-0000-4000-8000-000000000001', 'Own bill', {
      amount: '2,450.10 USD',
    });
    vault.fileAppIntake(made.id, 'own-1', own);
    const doc = await app.document(own);
    expect(doc).toMatchObject({
      own: true,
      external_id: 'own-1',
      amount: { text: '2,450.10 USD', value: '2450.10', currency: 'USD' },
    });
    expect(doc.version?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.status.value).toBeTruthy();
    expect(Date.parse(doc.updated_at)).toBeGreaterThan(Date.parse('2020-01-01'));
    expect(await app.status('own-1')).toMatchObject({ state: 'filed', document_id: own });

    // Granted: more bills; the first read of the feed comes in pages.
    await api.connectedApps.setGrants(token, made.id, {
      grants: [{ category: 'bills', lookback_months: 12 }],
    });
    const others = [
      await file('a1b2c3d4-0000-4000-8000-000000000002', 'Bill two'),
      await file('a1b2c3d4-0000-4000-8000-000000000003', 'Bill three'),
    ];
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await app.changes({ limit: 1, ...(cursor ? { cursor } : {}) });
      expect(page.changes.length).toBeLessThanOrEqual(1);
      for (const c of page.changes) if (c.change === 'changed') seen.push(c.document.id);
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(seen.sort()).toEqual([own, ...others].sort());
    // In the Trash: unavailable, and its send says so too.
    await api.deleteDocument(token, own);
    const after = await app.changes({ cursor: cursor as string });
    expect(after.changes).toEqual([
      { change: 'unavailable', at: expect.any(String) as string, document_id: own },
    ]);
    expect(await app.status('own-1')).toMatchObject({ state: 'unavailable', document_id: null });
    // Lines let go past a cursor: too old.
    const app0 = vault.state.connectedApps?.find((a) => a.id === made.id);
    if (!app0) throw new Error('no app');
    app0.feed_pruned_to = 1_000;
    const old = await refusal(app.changes({ cursor: after.cursor }));
    expect([old.status, old.code]).toEqual([410, 'cursor_expired']);
    app0.feed_pruned_to = 0;

    // A download: headers, a suffix range, one past the end, and its caps.
    const bill = others[0] as string;
    const got = await app.download(bill);
    expect(got.status).toBe(200);
    expect(got.contentDisposition?.startsWith('attachment')).toBe(true);
    const tail = await app.download(bill, { range: { start: 0, end: 3 } });
    expect([tail.status, new TextDecoder().decode(tail.bytes)]).toEqual([206, '%PDF']);
    const raw = await vault.fetch(`https://fake.example/api/v1/apps/documents/${bill}/content`, {
      method: 'GET',
      headers: {},
    });
    expect(raw.status).toBe(401);
    const past = await refusal(app.download(bill, { range: { start: PDF.length + 10 } }));
    expect([past.status, past.code]).toEqual([416, 'range_not_satisfiable']);
    app0.daily_read_bytes = PDF.length - 1;
    const big = await refusal(app.download(bill));
    expect([big.status, big.code]).toEqual([413, 'larger_than_daily_read']);
    app0.daily_read_bytes = PDF.length * 2 + 3;
    const full = await refusal(app.download(bill));
    expect([full.status, full.code]).toEqual([429, 'app_read_day_full']);

    // A kind kept as an Essential is never granted.
    const ess = vault.state.types.find((x) => x.usually_essential);
    if (ess) {
      const no = await refusal(
        api.connectedApps.setGrants(token, made.id, {
          grants: [{ kind: ess.key, lookback_months: 12 }],
        }),
      );
      expect([no.status, no.code]).toEqual([422, 'validation_failed']);
    }
  });
});

describe('the fake vault: a connected app’s links and deletes (APP3)', () => {
  it('a link opens once, its session reads the rule again; a delete lets go, or trashes, its own alone', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const t = await api.setup({
      household_name: 'The fake family',
      display_name: 'Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    const token = t.access_token;
    const made = await api.connectedApps.create(token, {
      name: 'Linker',
      member_id: t.member_id,
      allowed_kinds: ['utility_bill'],
      scopes: ['documents.send', 'documents.read', 'documents.links', 'documents.delete'],
    });
    expect(made).toMatchObject({ delete_mode: 'unlink', links_per_hour: 60 });
    const app = await keyed(api, token, made, vault.fetch);
    const day = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
    const file = async (key: string, title: string) => {
      const form = multipartBody([
        {
          name: 'metadata',
          value: JSON.stringify({
            type_key: 'utility_bill',
            title,
            owner_member_id: t.member_id,
            issued: { date: day, precision: 'day' },
            visibility: 'household',
          }),
        },
        { name: 'file', filename: `${title}.pdf`, contentType: 'application/pdf', bytes: PDF },
      ]);
      return (
        await api.capture(
          token,
          { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
          key,
        )
      ).document_id;
    };
    const send = async (externalId: string, title: string, key: string) => {
      await app.send({
        externalId,
        hints: { kind: 'utility_bill' },
        file: { bytes: PDF, filename: 'bill.pdf', contentType: 'application/pdf' },
      });
      const id = await file(key, title);
      vault.fileAppIntake(made.id, externalId, id);
      return id;
    };
    const own = await send('own-1', 'Own bill', 'b1b2c3d4-0000-4000-8000-000000000001');
    expect((await app.me()).delete_mode).toBe('unlink');

    // A link: opened once, within its time, for a session in that browser.
    const minted = await app.link(own, 'view');
    expect(minted).toMatchObject({ mode: 'view', session_minutes: 10 });
    const path = minted.url.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const get = (p: string, cookie?: string) =>
      vault.fetch(`https://fake.example${p}`, {
        method: 'GET',
        headers: cookie ? { cookie } : {},
      });
    // Its address is a page that opens nothing (0.9.0-dev.68): asked twice,
    // still there; the POST that page sends opens it.
    const open = (p: string, headers: Record<string, string> = {}) =>
      vault.fetch(`https://fake.example${p}`, { method: 'POST', headers });
    for (let i = 0; i < 2; i++) {
      const page = await get(path);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      expect(page.headers.get('set-cookie')).toBeNull();
    }
    // Nothing on the page submits by itself: one click on Open is the open.
    const body = await (await get(path)).text();
    expect(body).not.toMatch(/<script/i);
    expect(body).toContain('This link works once');
    expect(body).toMatch(/<button type="submit">Open<\/button>/);
    for (const headers of [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      expect((await open(path, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    const opened = await open(path, { 'sec-fetch-site': 'same-origin' });
    expect([opened.status, opened.headers.get('location')]).toEqual([303, '/a']);
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(opened.headers.get('set-cookie')).toMatch(
      /^__Secure-fdv_app_link=[A-Za-z0-9_-]{43}; .*Path=\/api\/v1\/app-links\/session; HttpOnly; Secure; SameSite=Lax$/,
    );
    const again = await open(path);
    expect([again.status, again.headers.get('location')]).toEqual([303, '/a#used']);
    const session = await get('/api/v1/app-links/session', cookie);
    const said = (await session.json()) as { opened_on?: unknown };
    expect(said).toMatchObject({ app: 'Linker', mode: 'view', title: 'Own bill' });
    // The day it was opened, for the page's watermark (0.9.0-dev.68).
    expect(String(said.opened_on)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await get('/api/v1/app-links/session/pages/1', cookie)).status).toBe(200);
    expect((await get('/api/v1/app-links/session')).status).toBe(410);
    // A link remembers the key that minted it (APP6): that key revoked, its
    // session ends at its next request, and a link not yet opened with it.
    const other = await api.connectedApps.generateKey(token, made.id, {
      permissions: made.scopes,
      expires_in_days: 30,
    });
    const otherApp = createAppClient({
      url: 'https://fake.example',
      clientId: other.client_id,
      secret: other.secret,
      fetch: vault.fetch,
    });
    const viaOther = await otherApp.link(own, 'view');
    const unopened = await otherApp.link(own, 'view');
    const otherOpened = await open(viaOther.url.replace(/^[a-z]+:\/\/[^/]+/i, ''));
    const otherCookie = (otherOpened.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect((await get('/api/v1/app-links/session', otherCookie)).status).toBe(200);
    await api.connectedApps.revokeKey(token, made.id, other.key.id);
    expect((await get('/api/v1/app-links/session', otherCookie)).status).toBe(410);
    expect(
      (await open(unopened.url.replace(/^[a-z]+:\/\/[^/]+/i, ''))).headers.get('location'),
    ).toBe('/a#ended');
    // The other key's links end; this key's go on.
    expect((await get('/api/v1/app-links/session', cookie)).status).toBe(200);
    // A download link needs its scope too.
    const noDownload = await refusal(app.link(own, 'download'));
    expect([noDownload.status, noDownload.code]).toEqual([403, 'scope_not_granted']);
    // Too late: ended.
    const late = await app.link(own, 'view');
    const link = vault.state.connectedApps
      ?.find((a) => a.id === made.id)
      ?.links?.find((l) => late.url.endsWith(l.token));
    if (!link) throw new Error('no link');
    link.open_by = Date.now() - 1;
    expect((await open(late.url.replace(/^[a-z]+:\/\/[^/]+/i, ''))).headers.get('location')).toBe(
      '/a#ended',
    );

    // A delete: unlinked, still in the vault; a second time, not its own.
    expect(await app.delete(own)).toEqual({ document_id: own, result: 'unlinked' });
    expect(await app.status('own-1')).toMatchObject({ state: 'unavailable', document_id: null });
    expect((await get('/api/v1/app-links/session', cookie)).status).toBe(410);
    const twice = await refusal(app.delete(own));
    expect([twice.status, twice.code]).toEqual([404, 'not_found']);
    // Granted, not its own: 404.
    await api.connectedApps.setGrants(token, made.id, {
      grants: [{ category: 'bills', lookback_months: 12 }],
    });
    expect((await app.document(own)).own).toBe(false);
    const granted = await refusal(app.delete(own));
    expect([granted.status, granted.code]).toEqual([404, 'not_found']);
    // To the Trash, when the owner says.
    await api.connectedApps.update(token, made.id, { delete_mode: 'trash' });
    const second = await send('own-2', 'Second bill', 'b1b2c3d4-0000-4000-8000-000000000002');
    expect(await app.delete(second)).toEqual({ document_id: second, result: 'trashed' });
    const gone = await refusal(app.document(second));
    expect([gone.status, gone.code]).toEqual([404, 'not_found']);
    expect(vault.state.documents.find((d) => d.id === second)?.deleted_at).toBeTruthy();
  });
});

describe('the fake vault: a connected app files automatically (APP4)', () => {
  it('files what is sure and complete with nobody looking, by the vault’s own rule; anything else waits', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const t = await api.setup({
      household_name: 'The fake family',
      display_name: 'Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    const token = t.access_token;
    const made = await api.connectedApps.create(token, {
      name: 'Filer',
      member_id: t.member_id,
      allowed_kinds: ['bank_statement'],
      scopes: ['documents.send', 'documents.read'],
      auto_file: true,
    });
    expect(made.auto_file).toBe(true);
    const app = await keyed(api, token, made, vault.fetch);
    expect((await app.me()).send.auto_file).toBe(true);
    const me = vault.state.members.find((m) => m.id === t.member_id)?.display_name as string;
    const send = (externalId: string, hints: Record<string, unknown>) =>
      app.send({
        externalId,
        hints,
        file: {
          bytes: new TextEncoder().encode(`%PDF-1.4\n% ${externalId}\n%%EOF\n`),
          filename: `${externalId}.pdf`,
          contentType: 'application/pdf',
        },
      });
    const pages = {
      type_key: { value: 'bank_statement', confidence: 0.95, cue: 'kind_words' as const },
      owner_member_id: { value: t.member_id, confidence: 0.95, cue: 'name_on_page' as const },
    };
    await send('auto-1', {
      kind: 'bank_statement',
      person: { name: me },
      title: 'Northgate, October',
    });
    expect(await vault.readAppFile(made.id, 'auto-1', pages)).toBe('filed');
    const filed = await app.status('auto-1');
    expect(filed).toMatchObject({ state: 'filed' });
    const doc = await app.document(filed.document_id as string);
    expect(doc).toMatchObject({ own: true, title: 'Northgate, October' });
    expect(doc.kind.key).toBe('bank_statement');

    // The app's hint alone: it waits.
    await send('auto-2', { kind: 'bank_statement', person: { name: me } });
    expect(await vault.readAppFile(made.id, 'auto-2', {})).toBe('waiting');
    expect((await app.status('auto-2')).state).toBe('waiting');
    // The pages and the app disagree: it waits.
    await send('auto-3', { person: { name: 'Nobody Here' } });
    expect(await vault.readAppFile(made.id, 'auto-3', pages)).toBe('waiting');

    // Switched off: it waits; paused, it waits.
    await api.connectedApps.update(token, made.id, { auto_file: false });
    await send('auto-4', {});
    expect(await vault.readAppFile(made.id, 'auto-4', pages)).toBe('waiting');
    await api.connectedApps.update(token, made.id, { auto_file: true });
    await api.connectedApps.pause(token, made.id);
    expect(await vault.readAppFile(made.id, 'auto-4', pages)).toBe('waiting');
    await api.connectedApps.resume(token, made.id);
    expect(await vault.readAppFile(made.id, 'auto-4', pages)).toBe('filed');
    // Filed already: nothing more.
    expect(await vault.readAppFile(made.id, 'auto-4', pages)).toBe('waiting');
    // A kind the household now keeps as an Essential: it waits.
    const kind = vault.state.types.find((k) => k.key === 'bank_statement');
    if (!kind) throw new Error('the fake has no bank statements');
    kind.usually_essential = true;
    await send('auto-5', {});
    expect(await vault.readAppFile(made.id, 'auto-5', pages)).toBe('waiting');
    kind.usually_essential = false;
    expect(await vault.readAppFile(made.id, 'auto-5', pages)).toBe('filed');
    // A setting that is not on or off is refused.
    const bad = await refusal(
      api.connectedApps.update(token, made.id, { auto_file: 'yes' as unknown as boolean }),
    );
    expect([bad.status, bad.code]).toEqual([422, 'validation_failed']);
  });
});

describe('the fake vault: a connected app’s own sends again, and whose Inbox (APP5)', () => {
  const setUp = async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const t = await api.setup({
      household_name: 'The fake family',
      display_name: 'Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    vault.state.members.push(
      {
        id: '00000000-0000-4000-8000-0000000000a1',
        display_name: 'Ahmed Khan',
        role: 'adult',
        is_me: false,
      },
      {
        id: '00000000-0000-4000-8000-0000000000a2',
        display_name: 'Sara Khan',
        role: 'adult',
        is_me: false,
      },
      {
        id: '00000000-0000-4000-8000-0000000000a3',
        display_name: 'Sara Patel',
        role: 'adult',
        is_me: false,
      },
      {
        id: '00000000-0000-4000-8000-0000000000a4',
        display_name: 'Tariq Khan',
        role: 'teen',
        is_me: false,
      },
      {
        id: '00000000-0000-4000-8000-0000000000a5',
        display_name: 'Mina Khan',
        role: null,
        is_me: false,
      },
      {
        id: '00000000-0000-4000-8000-0000000000a6',
        display_name: 'Gita Guest',
        role: 'adult',
        is_me: false,
        kind: 'guest',
      },
    );
    const made = await api.connectedApps.create(t.access_token, {
      name: 'Router',
      member_id: t.member_id,
      allowed_kinds: ['bank_statement', 'utility_bill'],
      scopes: ['documents.send', 'documents.read', 'documents.download'],
    });
    const app = await keyed(api, t.access_token, made, vault.fetch);
    const send = (externalId: string, hints: Record<string, unknown>, bytes = PDF) =>
      app.send({
        externalId,
        hints,
        file: { bytes, filename: `${externalId}.pdf`, contentType: 'application/pdf' },
      });
    const inbox = (externalId: string) =>
      vault.state.connectedApps?.find((a) => a.id === made.id)?.intake.get(externalId)
        ?.inbox_member_id;
    return { vault, api, t, made, app, send, inbox };
  };

  it('sends each paper to the Inbox of the person it is about, by the vault’s rule', async () => {
    const { t, made, send, inbox, api, vault, app } = await setUp();
    expect(made.route_to_person).toBe(true);
    await send('by-id', {
      kind: 'bank_statement',
      person: { member_id: '00000000-0000-4000-8000-0000000000a1' },
    });
    expect(inbox('by-id')).toBe('00000000-0000-4000-8000-0000000000a1');
    await send('by-name', { kind: 'bank_statement', person: { name: 'sara khan' } });
    expect(inbox('by-name')).toBe('00000000-0000-4000-8000-0000000000a2');
    for (const [id, hints] of [
      ['two-saras', { kind: 'bank_statement', person: { name: 'Sara' } }],
      [
        'teen',
        { kind: 'bank_statement', person: { member_id: '00000000-0000-4000-8000-0000000000a4' } },
      ],
      [
        'child',
        { kind: 'bank_statement', person: { member_id: '00000000-0000-4000-8000-0000000000a5' } },
      ],
      [
        'guest',
        { kind: 'bank_statement', person: { member_id: '00000000-0000-4000-8000-0000000000a6' } },
      ],
      ['household', { kind: 'bank_statement', person: { household: true } }],
      [
        'bill',
        { kind: 'utility_bill', person: { member_id: '00000000-0000-4000-8000-0000000000a1' } },
      ],
      ['nobody', { kind: 'bank_statement' }],
    ] as const) {
      await send(id, hints);
      expect([id, inbox(id)]).toEqual([id, t.member_id]);
    }
    // Never told whose Inbox: the state is as ever.
    expect(JSON.stringify(await app.status('by-id'))).not.toContain(
      '00000000-0000-4000-8000-0000000000a1',
    );
    // Switched off: its own person's Inbox.
    await api.connectedApps.update(t.access_token, made.id, { route_to_person: false });
    await send('off', {
      kind: 'bank_statement',
      person: { member_id: '00000000-0000-4000-8000-0000000000a1' },
    });
    expect(inbox('off')).toBe(t.member_id);
    // Filed automatically as the person it went to.
    await api.connectedApps.update(t.access_token, made.id, {
      route_to_person: true,
      auto_file: true,
    });
    await send('auto', {
      kind: 'bank_statement',
      person: { member_id: '00000000-0000-4000-8000-0000000000a1' },
      title: 'A',
    });
    expect(
      await vault.readAppFile(made.id, 'auto', {
        type_key: { value: 'bank_statement', confidence: 0.95, cue: 'kind_words' },
        owner_member_id: {
          value: '00000000-0000-4000-8000-0000000000a1',
          confidence: 0.95,
          cue: 'name_on_page',
        },
      }),
    ).toBe('filed');
    const doc = vault.state.documents.find((d) => d.title === 'A');
    expect(doc?.filed_by).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(doc?.owner_member_id).toBe('00000000-0000-4000-8000-0000000000a1');
  });

  it('the exact file a send became, again: filed, a newer family file after it, never Only me or in the Trash', async () => {
    const { vault, api, t, made, app, send } = await setUp();
    await send('again-1', { kind: 'bank_statement' });
    expect((await app.status('again-1')).content_available).toBe(false);
    const missing = await refusal(app.sentFile('again-1'));
    expect([missing.status, missing.code]).toEqual([404, 'not_found']);
    const form = multipartBody([
      {
        name: 'metadata',
        value: JSON.stringify({
          type_key: 'bank_statement',
          title: 'Again',
          owner_member_id: t.member_id,
          visibility: 'household',
        }),
      },
      { name: 'file', filename: 'again.pdf', contentType: 'application/pdf', bytes: PDF },
    ]);
    const doc = (
      await api.capture(
        t.access_token,
        { kind: 'bytes', bytes: form.bytes, contentType: form.contentType },
        'b1b2c3d4-0000-4000-8000-000000000001',
      )
    ).document_id;
    vault.fileAppIntake(made.id, 'again-1', doc);
    expect(await app.status('again-1')).toMatchObject({ state: 'filed', content_available: true });
    const got = await app.sentFile('again-1');
    expect(got.status).toBe(200);
    expect(got.bytes).toEqual(PDF);
    // Without the download scope: never said available, as the route refuses it.
    await api.connectedApps.update(t.access_token, made.id, {
      scopes: ['documents.send', 'documents.read'],
    });
    expect((await app.status('again-1')).content_available).toBe(false);
    await api.connectedApps.update(t.access_token, made.id, {
      scopes: ['documents.send', 'documents.read', 'documents.download'],
    });
    // A newer file from the family: still its own to read (the owner's
    // decision, 18 Nov 2026), and still its file.
    const first = [...vault.state.captures.values()].find((c) => c.document_id === doc);
    vault.state.captures.set('newer', {
      ...(first as NonNullable<typeof first>),
      version_id: 'v-newer',
      version_no: 2,
      bytes: new TextEncoder().encode('%PDF-1.4\n% newer\n%%EOF\n'),
    });
    expect(await app.status('again-1')).toMatchObject({
      state: 'filed',
      document_id: doc,
      content_available: true,
    });
    expect((await app.sentFile('again-1')).bytes).toEqual(PDF);
    expect((await app.sentFile('again-1', { ifNoneMatch: got.etag as string })).status).toBe(304);
    // Only me: never.
    const d = vault.state.documents.find((x) => x.id === doc);
    if (!d) throw new Error('no document');
    d.visibility = 'private';
    expect((await refusal(app.sentFile('again-1'))).status).toBe(404);
    expect((await app.status('again-1')).content_available).toBe(false);
    d.visibility = 'household';
    // In the Trash: never.
    await api.deleteDocument(t.access_token, doc);
    expect((await refusal(app.sentFile('again-1'))).status).toBe(404);
    // Another app's external id: never.
    await api.connectedApps.remove(t.access_token, made.id);
    const other = await api.connectedApps.create(t.access_token, {
      name: 'Other',
      member_id: t.member_id,
      allowed_kinds: ['bank_statement'],
      scopes: ['documents.send', 'documents.download'],
    });
    const otherApp = await keyed(api, t.access_token, other, vault.fetch);
    expect((await refusal(otherApp.sentFile('again-1'))).status).toBe(404);
  });
});

describe('the fake vault: API keys an owner generates (APP6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const setUp = async (actsAsAdult = false) => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const t = await api.setup({
      household_name: 'The fake family',
      display_name: 'Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    const adult = '00000000-0000-4000-8000-0000000000b1';
    vault.state.members.push({
      id: adult,
      display_name: 'Ahmed Khan',
      role: 'adult',
      is_me: false,
    });
    vault.state.signIns.push({
      member_id: adult,
      email: 'ahmed@example.test',
      password: 'ahmed has a long password',
    });
    const made = await api.connectedApps.create(t.access_token, {
      name: 'Acme Money',
      member_id: actsAsAdult ? adult : t.member_id,
      allowed_kinds: ['utility_bill'],
      scopes: ['documents.send', 'documents.read'],
    });
    const client = (clientId: string, secret: string) =>
      createAppClient({ url: 'https://fake.example', clientId, secret, fetch: vault.fetch });
    return { vault, api, t, made, client };
  };
  const code = async (p: Promise<unknown>) => {
    const e = await refusal(p);
    return [e.status, e.code];
  };

  it('connects with no key; a key is shown once, kept as a hash, and listed with its state', async () => {
    const { vault, api, t, made, client } = await setUp();
    expect(made.keys).toEqual([]);
    expect(made.connection_string).toBe('');
    const key = await api.connectedApps.generateKey(t.access_token, made.id, {
      name: '  Acme Money, live  ',
      permissions: ['documents.read', 'documents.send'],
      expires_in_days: 90,
    });
    expect(key.key).toMatchObject({
      name: 'Acme Money, live',
      permissions: ['documents.send', 'documents.read'],
      state: 'live',
      last_used_at: null,
    });
    // Its secret is nowhere in the fake's keeping: only a hash of it.
    const kept = vault.state.connectedApps?.[0]?.keys[0];
    expect(kept?.secret_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(kept)).not.toContain(key.secret);
    const listed = (await api.connectedApps.list(t.access_token)).items[0];
    expect(listed?.keys).toEqual([key.key]);
    expect(parseConnectionString(listed?.connection_string as string)).toEqual({
      url: 'https://fake.example',
      client_id: key.client_id,
      instance_id: null,
    });
    // Used: its last use is said.
    expect((await client(key.client_id, key.secret).me()).key.last_used_at).toEqual(
      expect.any(String),
    );
    const after = (await api.connectedApps.list(t.access_token)).items[0];
    expect(after?.keys[0]?.last_used_at).toEqual(expect.any(String));
    // A name too long, an unknown field: refused.
    expect(
      await code(
        api.connectedApps.generateKey(t.access_token, made.id, {
          name: 'x'.repeat(61),
          permissions: ['documents.send'],
          expires_in_days: 30,
        }),
      ),
    ).toEqual([422, 'validation_failed']);
  });

  it('a key expires at its moment by the clock, never before; an expired one frees its place', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    const { vault, api, t, made, client } = await setUp();
    const short = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send'],
      expires_in_days: 1,
    });
    expect(short.key.expires_at).toBe('2026-11-02T12:00:00.000Z');
    const never = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send'],
      expires_in_days: null,
    });
    const app = client(short.client_id, short.secret);
    vi.setSystemTime(new Date('2026-11-02T11:59:59Z'));
    expect((await app.me()).key.expires_at).toBe('2026-11-02T12:00:00.000Z');
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    expect(await code(app.me())).toEqual([401, 'app_key_expired']);
    // Years later, the one that never expires still works.
    vi.setSystemTime(new Date('2036-11-02T12:00:00Z'));
    expect((await client(never.client_id, never.secret).me()).key.expires_at).toBeNull();
    // The expired key no longer counts: there is room for another.
    const next = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send'],
      expires_in_days: 3650,
    });
    expect(next.key.state).toBe('live');
    expect(
      (await api.connectedApps.list(t.access_token)).items[0]?.keys.map((k) => k.state),
    ).toEqual(['expired', 'live', 'live']);
    // The test hook does the same, at once.
    vault.expireAppKey(next.client_id);
    expect(await code(client(next.client_id, next.secret).me())).toEqual([401, 'app_key_expired']);
    expect(() => vault.expireAppKey('fdvc_nobodyhasthisclientid')).toThrow();
  });

  it('an owner’s alone, with a second step; for an app acting as somebody else it asks them again', async () => {
    const { vault, api, t, made, client } = await setUp(true);
    const ahmed = await api.signIn('ahmed@example.test', 'ahmed has a long password');
    if (!('access_token' in ahmed)) throw new Error('expected a session');
    await api.connectedApps.approve(ahmed.access_token, made.id);
    const body = { permissions: ['documents.send' as const], expires_in_days: 30 };
    // The person it acts as sees the app, but generates and revokes no key.
    expect(await code(api.connectedApps.generateKey(ahmed.access_token, made.id, body))).toEqual([
      403,
      'forbidden',
    ]);
    // Without two-step sign-in, an owner neither generates nor revokes.
    vault.state.ownerTwoStep = false;
    expect(await code(api.connectedApps.generateKey(t.access_token, made.id, body))).toEqual([
      403,
      'totp_required_for_owner',
    ]);
    vault.state.ownerTwoStep = true;
    const key = await api.connectedApps.generateKey(t.access_token, made.id, body);
    // A key for somebody else's app: it waits for them again.
    const app = client(key.client_id, key.secret);
    expect((await app.me()).state).toBe('waiting_for_approval');
    expect(await code(app.status('nothing-sent'))).toEqual([403, 'app_not_approved']);
    await api.connectedApps.approve(ahmed.access_token, made.id);
    expect((await app.me()).state).toBe('active');
    // A new key that may do no more than a live one (a rotation): not asked
    // again (18 Nov 2026). One that may do more: asked again.
    const rotated = await api.connectedApps.generateKey(t.access_token, made.id, body);
    expect((await app.me()).state).toBe('active');
    await api.connectedApps.revokeKey(t.access_token, made.id, rotated.key.id);
    const wider = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send', 'documents.read'],
      expires_in_days: 30,
    });
    expect((await app.me()).state).toBe('waiting_for_approval');
    await api.connectedApps.revokeKey(t.access_token, made.id, wider.key.id);
    await api.connectedApps.approve(ahmed.access_token, made.id);
    expect((await app.me()).state).toBe('active');
    expect(
      await code(api.connectedApps.revokeKey(ahmed.access_token, made.id, key.key.id)),
    ).toEqual([403, 'forbidden']);
    vault.state.ownerTwoStep = false;
    expect(await code(api.connectedApps.revokeKey(t.access_token, made.id, key.key.id))).toEqual([
      403,
      'totp_required_for_owner',
    ]);
    vault.state.ownerTwoStep = true;
    // Not an id; no such app; no such key.
    const nowhere = '00000000-0000-4000-8000-00000000ffff';
    expect(await code(api.connectedApps.revokeKey(t.access_token, made.id, 'nope'))).toEqual([
      422,
      'validation_failed',
    ]);
    expect(await code(api.connectedApps.generateKey(t.access_token, nowhere, body))).toEqual([
      404,
      'not_found',
    ]);
    expect(await code(api.connectedApps.revokeKey(t.access_token, made.id, nowhere))).toEqual([
      404,
      'not_found',
    ]);
    // Revoked: the next request refused; revoked again, nothing changes.
    await api.connectedApps.revokeKey(t.access_token, made.id, key.key.id);
    expect(await code(app.me())).toEqual([401, 'app_key_revoked']);
    await api.connectedApps.revokeKey(t.access_token, made.id, key.key.id);
    expect(await code(app.me())).toEqual([401, 'app_key_revoked']);
  });

  it('a request’s key: Basic alone, failed tries limited a minute, revoked or removed, and only on app routes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T12:00:10Z'));
    const { vault, api, t, made, client } = await setUp();
    const key = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send'],
      expires_in_days: 30,
    });
    const raw = (headers: Record<string, string>, path = '/api/v1/apps/me') =>
      vault.fetch(`https://fake.example${path}`, { method: 'GET', headers });
    const basic = `Basic ${toBase64(new TextEncoder().encode(`${key.client_id}:${key.secret}`))}`;
    const codeOf = async (r: Awaited<ReturnType<typeof raw>>) =>
      [r.status, ((await r.json()) as { error: { code: string } }).error.code] as const;
    // Nothing, a bearer token, a cookie beside the key: the key is asked for.
    expect(await codeOf(await raw({}))).toEqual([401, 'app_key_required']);
    expect(await codeOf(await raw({ authorization: `Bearer ${t.access_token}` }))).toEqual([
      401,
      'app_key_required',
    ]);
    expect(await codeOf(await raw({ authorization: basic, cookie: 'x=1' }))).toEqual([
      401,
      'app_key_required',
    ]);
    expect((await raw({ authorization: basic })).status).toBe(200);
    // Its key is no sign-in: refused on the family's routes.
    expect(await codeOf(await raw({ authorization: basic }, '/api/v1/documents'))).toEqual([
      401,
      'app_key_not_accepted',
    ]);
    // A wrong secret, an unknown client ID, what is not base64: all one refusal.
    const wrong = client(key.client_id, `fdvs_${'A'.repeat(43)}`);
    const unknown = client(`fdvc_${'B'.repeat(22)}`, key.secret);
    expect(await code(wrong.me())).toEqual([401, 'app_key_invalid']);
    expect(await code(unknown.me())).toEqual([401, 'app_key_invalid']);
    expect(await codeOf(await raw({ authorization: 'Basic !!!' }))).toEqual([
      401,
      'app_key_required',
    ]);
    // Basic that is no app's (a proxy's in front of the vault, "foo:bar"):
    // no key on an app route, and untouched on any other.
    expect(await codeOf(await raw({ authorization: 'Basic Zm9vOmJhcg==' }))).toEqual([
      401,
      'app_key_required',
    ]);
    expect(
      (await raw({ authorization: 'Basic Zm9vOmJhcg==' }, '/api/v1/capabilities')).status,
    ).toBe(200);
    expect(
      await codeOf(await raw({ authorization: 'Basic Zm9vOmJhcg==' }, '/api/v1/documents')),
    ).not.toEqual([401, 'app_key_not_accepted']);
    // An app's client ID not as the vault writes them: a key that is not right.
    const short = `Basic ${toBase64(new TextEncoder().encode(`fdvc_short:${key.secret}`))}`;
    expect(await codeOf(await raw({ authorization: short }))).toEqual([401, 'app_key_invalid']);
    // Ten failed tries a minute; the eleventh waits, even with the right key.
    for (let i = 0; i < 7; i++) await refusal(wrong.me());
    const limited = await raw({ authorization: basic });
    expect(await codeOf(limited)).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers.get('retry-after'))).toBe(50);
    vi.setSystemTime(new Date('2026-11-01T12:01:00Z'));
    expect((await raw({ authorization: basic })).status).toBe(200);
    // A key revoked, or expired, is refused but never counted as a guess:
    // its secret is right.
    const second = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send'],
      expires_in_days: 30,
    });
    await api.connectedApps.revokeKey(t.access_token, made.id, second.key.id);
    const revoked = client(second.client_id, second.secret);
    for (let i = 0; i < 11; i++) {
      expect(await code(revoked.me())).toEqual([401, 'app_key_revoked']);
    }
    const third = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send'],
      expires_in_days: 30,
    });
    vault.expireAppKey(third.client_id);
    const expired = client(third.client_id, third.secret);
    for (let i = 0; i < 11; i++) {
      expect(await code(expired.me())).toEqual([401, 'app_key_expired']);
    }
    expect((await raw({ authorization: basic })).status).toBe(200);
    expect(
      (await api.connectedApps.list(t.access_token)).items
        .find((x) => x.id === made.id)
        ?.keys.find((k) => k.id === second.key.id)?.revoked_reason,
    ).toBe('owner');
    // Removed: every key ends with the app.
    await api.connectedApps.remove(t.access_token, made.id);
    expect(await code(client(key.client_id, key.secret).me())).toEqual([401, 'app_revoked']);
  });

  it('what a key may do: its own permissions among the app’s, as the app is narrowed too', async () => {
    const { api, t, made, client } = await setUp();
    const full = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send', 'documents.read'],
      expires_in_days: 30,
    });
    const sendOnly = await api.connectedApps.generateKey(t.access_token, made.id, {
      permissions: ['documents.send'],
      expires_in_days: 30,
    });
    const reader = client(full.client_id, full.secret);
    const sender = client(sendOnly.client_id, sendOnly.secret);
    expect((await reader.list()).items).toEqual([]);
    expect(await code(sender.list())).toEqual([403, 'scope_not_granted']);
    expect((await sender.me()).scopes).toEqual(['documents.send']);
    // Never more than the app may: refused as it is asked for.
    expect(
      await code(
        api.connectedApps.generateKey(t.access_token, made.id, {
          permissions: ['documents.delete'],
          expires_in_days: 30,
        }),
      ),
    ).toEqual([422, 'validation_failed']);
    // Two live at most.
    expect(
      await code(
        api.connectedApps.generateKey(t.access_token, made.id, {
          permissions: ['documents.send'],
          expires_in_days: 30,
        }),
      ),
    ).toEqual([409, 'key_limit']);
    // The app narrowed: its keys with it, whatever they say.
    await api.connectedApps.update(t.access_token, made.id, { scopes: ['documents.send'] });
    expect(await code(reader.list())).toEqual([403, 'scope_not_granted']);
    expect((await reader.me()).scopes).toEqual(['documents.send']);
    expect((await reader.me()).key.permissions).toEqual(['documents.send', 'documents.read']);
  });
});

describe('the fake vault: a connected app acting as itself (APP8)', () => {
  it('itself by default, reviewed by the owner; the wrong field for each refused; its own sends’ uploader the app; an auto-filed one too', async () => {
    const vault = createFakeVault();
    const api = createApi(createHttp({ baseUrl: 'https://fake.example', fetch: vault.fetch }));
    const t = await api.setup({
      household_name: 'The fake family',
      display_name: 'Owner',
      email: 'owner@example.test',
      password: 'a long enough password',
    });
    vault.state.ownerTwoStep = true;
    const token = t.access_token;
    const made = await api.connectedApps.create(token, {
      name: 'Acme Money',
      allowed_kinds: ['bank_statement'],
      scopes: ['documents.send'],
      auto_file: true,
    });
    expect(made).toMatchObject({
      acts_as: 'app',
      member_id: null,
      reviewer_member_id: t.member_id,
      state: 'active',
    });
    for (const [body, detail] of [
      [{ acts_as: 'app', member_id: t.member_id }, 'member_id'],
      [{ acts_as: 'person', reviewer_member_id: t.member_id }, 'reviewer_member_id'],
      [{ reviewer_member_id: 'nobody' }, 'reviewer_member_id'],
    ] as const) {
      const r = await refusal(
        api.connectedApps.create(token, { name: 'Wrong', allowed_kinds: [], ...body }),
      );
      expect([r.status, r.detail]).toEqual([422, detail]);
    }
    const app = await keyed(api, token, made, vault.fetch);
    expect((await app.me()).acts_as).toBe('app');
    const sent = await app.send({
      externalId: 'auto-1',
      hints: { kind: 'bank_statement' },
      file: { bytes: PDF, filename: 'statement.pdf', contentType: 'application/pdf' },
    });
    expect(sent.status).toBe(201);
    expect(
      await vault.readAppFile(made.id, 'auto-1', {
        type_key: { value: 'bank_statement', confidence: 0.95, cue: 'kind_words' },
        owner_member_id: { value: t.member_id, confidence: 0.95, cue: 'name_on_page' },
        issued: {
          value: { date: '2026-10-31', precision: 'day' },
          confidence: 0.9,
          cue: 'issue_label',
        },
      }),
    ).toBe('filed');
    const st = await app.status('auto-1');
    const history = (await api.versions(token, st.document_id as string)).items;
    expect(history[0]).toMatchObject({ uploaded_by_name: 'Acme Money', uploaded_by_app: true });
    // No reviewer who can take it: 503 busy, retriable, and nothing kept.
    const sara = 'member-sara';
    vault.state.members.push({ id: sara, display_name: 'Sara', role: 'adult', is_me: false });
    await api.connectedApps.update(token, made.id, { reviewer_member_id: sara });
    const s = vault.state.members.find((m) => m.id === sara);
    if (s) s.role = 'teen';
    const busy = await refusal(
      app.send({
        externalId: 'busy-1',
        hints: { kind: 'bank_statement' },
        file: { bytes: PDF, filename: 'b.pdf', contentType: 'application/pdf' },
      }),
    );
    expect([busy.status, busy.code, busy.retriable]).toEqual([503, 'busy', true]);
    expect((await app.statuses(['busy-1'])).unknown).toEqual(['busy-1']);
  });
});
