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
