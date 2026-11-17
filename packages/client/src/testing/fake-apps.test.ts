import { describe, expect, it } from 'vitest';
import { createApi } from '../api.js';
import { createAppClient } from '../apps.js';
import { ApiRequestError } from '../errors.js';
import { createHttp } from '../http.js';
import { multipartBody } from '../multipart.js';
import { createFakeVault } from './fake.js';

/**
 * The fake vault's connected app reading (0.9.0, APP2), beyond what the
 * contract scenario asks of both vaults: what an integrator builds against
 * — its own documents and their external ids, the first read of the feed in
 * pages, a cursor too old, the download's ranges, headers and caps.
 */

/** RFC 8032's first Ed25519 test key (7.1, TEST 1): nobody uses it for real. */
const KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g
-----END PRIVATE KEY-----`;
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
      public_key: 'ed25519:11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      allowed_kinds: ['utility_bill'],
      scopes: ['documents.send', 'documents.read', 'documents.download'],
    });
    const app = createAppClient({
      baseUrl: 'https://fake.example',
      appId: made.id,
      keyId: made.keys[0]?.key_id as string,
      privateKey: KEY,
      fetch: vault.fetch,
    });
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
      public_key: 'ed25519:11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      allowed_kinds: ['utility_bill'],
      scopes: ['documents.send', 'documents.read', 'documents.links', 'documents.delete'],
    });
    expect(made).toMatchObject({ delete_mode: 'unlink', links_per_hour: 60 });
    const app = createAppClient({
      baseUrl: 'https://fake.example',
      appId: made.id,
      keyId: made.keys[0]?.key_id as string,
      privateKey: KEY,
      fetch: vault.fetch,
    });
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
    const opened = await get(path);
    expect([opened.status, opened.headers.get('location')]).toEqual([303, '/a']);
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(opened.headers.get('set-cookie')).toMatch(
      /^__Secure-fdv_app_link=[A-Za-z0-9_-]{43}; .*Path=\/api\/v1\/app-links\/session; HttpOnly; Secure; SameSite=Lax$/,
    );
    const again = await get(path);
    expect([again.status, again.headers.get('location')]).toEqual([303, '/a#used']);
    const session = await get('/api/v1/app-links/session', cookie);
    expect(await session.json()).toMatchObject({ app: 'Linker', mode: 'view', title: 'Own bill' });
    expect((await get('/api/v1/app-links/session/pages/1', cookie)).status).toBe(200);
    expect((await get('/api/v1/app-links/session')).status).toBe(410);
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
    expect((await get(late.url.replace(/^[a-z]+:\/\/[^/]+/i, ''))).headers.get('location')).toBe(
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
      public_key: 'ed25519:11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      allowed_kinds: ['bank_statement'],
      scopes: ['documents.send', 'documents.read'],
      auto_file: true,
    });
    expect(made.auto_file).toBe(true);
    const app = createAppClient({
      baseUrl: 'https://fake.example',
      appId: made.id,
      keyId: made.keys[0]?.key_id as string,
      privateKey: KEY,
      fetch: vault.fetch,
    });
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
      public_key: 'ed25519:11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      allowed_kinds: ['bank_statement', 'utility_bill'],
      scopes: ['documents.send', 'documents.read', 'documents.download'],
    });
    const app = createAppClient({
      baseUrl: 'https://fake.example',
      appId: made.id,
      keyId: made.keys[0]?.key_id as string,
      privateKey: KEY,
      fetch: vault.fetch,
    });
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
    // A newer file from the family: not its own any more, and still its file.
    const first = [...vault.state.captures.values()].find((c) => c.document_id === doc);
    vault.state.captures.set('newer', {
      ...(first as NonNullable<typeof first>),
      version_id: 'v-newer',
      version_no: 2,
      bytes: new TextEncoder().encode('%PDF-1.4\n% newer\n%%EOF\n'),
    });
    expect(await app.status('again-1')).toMatchObject({
      state: 'unavailable',
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
      public_key: 'ed25519:11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      allowed_kinds: ['bank_statement'],
      scopes: ['documents.send', 'documents.download'],
    });
    const otherApp = createAppClient({
      baseUrl: 'https://fake.example',
      appId: other.id,
      keyId: other.keys[0]?.key_id as string,
      privateKey: KEY,
      fetch: vault.fetch,
    });
    expect((await refusal(otherApp.sentFile('again-1'))).status).toBe(404);
  });
});
