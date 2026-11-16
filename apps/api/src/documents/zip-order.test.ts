import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { CollectionDetail, DocumentView, Tokens } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * A ZIP's documents and its log, in the vault's one order (0.9.0, DL; the DL
 * review): every document it gives held first — in one order, by id — and
 * the household's log held after them, once. The other way round, one ZIP
 * holding the log while it waits on a document a restore, a purge or a
 * change of who can see it holds — which wait on the log — is a deadlock,
 * and every write that is logged waits for the whole of it meanwhile.
 */

const PDF = (marker: string) =>
  Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n`);

/** Where in what was run a statement first, and last, matches. */
const first = (sqls: string[], re: RegExp) => sqls.findIndex((q) => re.test(q));
const last = (sqls: string[], re: RegExp) =>
  sqls.length - 1 - [...sqls].reverse().findIndex((q) => re.test(q));

const HOLD = /for key share/i;
/** An answer's body, as what it is. */
const json = <T>(r: { json: () => unknown }) => r.json() as T;
const LOG = /pg_advisory_xact_lock\(hashtext\('audit:'/i;

describe.skipIf(!testAdminUrl())('a ZIP holds the documents first, then the log (DL)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let listening = false;
  const statements: string[] = [];
  const ids: string[] = [];
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.78.${Math.floor(++nth / 200)}.${nth % 200}` });

  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    h.app.inject({ method, url, headers: h.as(owner), ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      log: (e) => {
        if (listening) statements.push(e.query.sql);
      },
    });
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    for (const title of ['One', 'Two', 'Three']) {
      const made = await call('POST', '/api/v1/documents', {
        type_key: 'utility_bill',
        title,
        sensitive: false,
        visibility: 'household',
        owner_member_id: owner.member_id,
      });
      const id = json<DocumentView>(made).id;
      const form = new FormData();
      form.append('file', PDF(title), { filename: 'scan.pdf', contentType: 'application/pdf' });
      const up = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${id}/versions`,
        headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
      expect(up.statusCode, up.body).toBeLessThan(300);
      ids.push(id);
    }
    const note = await call('POST', '/api/v1/documents', {
      type_key: 'note',
      title: 'A note',
      notes: 'words',
    });
    ids.push(json<DocumentView>(note).id);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('signed in: one hold of every document, by id, before the log is held once', async () => {
    statements.length = 0;
    listening = true;
    const r = await call('POST', '/api/v1/documents/download', {
      document_ids: [...ids].reverse(),
    });
    listening = false;
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    const holds = statements.filter((q) => HOLD.test(q));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatch(/order by "id"/i);
    expect(statements.filter((q) => LOG.test(q))).toHaveLength(1);
    expect(last(statements, HOLD)).toBeLessThan(first(statements, LOG));
  });

  it('by a link: each document counted (and so held) before the log is held', async () => {
    await admin.query(
      `update session set verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const made = await call('POST', '/api/v1/collections', { name: 'All', audience: 'everyone' });
    const collection = json<CollectionDetail>(made).id;
    expect(
      (await call('POST', `/api/v1/collections/${collection}/items`, { document_ids: ids }))
        .statusCode,
    ).toBe(200);
    const shared = await call('POST', `/api/v1/collections/${collection}/shares`, {
      document_ids: ids,
    });
    expect(shared.statusCode, shared.body).toBe(201);
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: json<{ link_token: string }>(shared).link_token },
      ...peer(),
    });
    const cookie = opened.cookies.find((c) => c.name === 'fdv_share')?.value as string;
    statements.length = 0;
    listening = true;
    const r = await h.app.inject({
      url: '/api/v1/shared/items/download',
      cookies: { fdv_share: cookie },
      ...peer(),
    });
    listening = false;
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    // A session's use of each document names it (its key held by the
    // database), every one of them before the first line of the log.
    const uses = /insert into "share_session_use"/i;
    expect(statements.filter((q) => uses.test(q))).toHaveLength(ids.length);
    expect(last(statements, uses)).toBeLessThan(first(statements, LOG));
  });
});
