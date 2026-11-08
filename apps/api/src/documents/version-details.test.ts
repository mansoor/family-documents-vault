import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  renewalOffers,
  type DetailSuggestions,
  type DocumentView,
  type RenewalResult,
  type VersionView,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Each version's own details (0.9.0; the owner's report of 7 Nov 2026: a
 * renewed licence added from the phone kept its old dates, and nothing
 * offered the new ones). A version a newer one replaces keeps its dates,
 * number, issuer and kind's details, frozen — an Only me one's sealed as
 * the document's are; the new version starts from them, unconfirmed; GET
 * …/suggestions gives what its pages read of them as `renewal`; and POST
 * …/renewal makes the chosen ones its own as a renewal (reminders made
 * again, as S1), with an Undo.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const day = (date: string) => ({ date, precision: 'day' as const });
/** Days from the real today: a fixed date broke a test on 1 Nov 2026. */
const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const printed = (iso: string) => {
  const [y, m, d] = iso.split('-');
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  return `${d} ${months[Number(m) - 1]} ${y}`;
};

/** A renewed passport's data page, as OCR reads it. Made up. */
const renewedPage = (issued: string, expires: string, number: string) =>
  [
    'PASSPORT',
    'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND',
    'Passport No.',
    number,
    'Surname',
    'KHAN',
    'Given names',
    'SARAH',
    'Date of issue',
    printed(issued),
    'Date of expiry',
    printed(expires),
    'Authority',
    'HMPO',
  ].join('\n');

const json = <T>(r: { json: () => unknown }) => r.json() as T;
const code = (r: { json: () => unknown }) => json<{ error: { code: string } }>(r).error.code;

describe.skipIf(!testAdminUrl())('each version’s own details (0.9.0)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let sarah: Tokens;
  let teen: Tokens;
  let viewer: Tokens;

  const call = (who: Tokens, method: string, url: string, payload?: unknown, etag?: string) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: { ...h.as(who), ...(etag ? { 'if-match': etag } : {}) },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });
  const read = async (who: Tokens, id: string) => {
    const r = await call(who, 'GET', `/api/v1/documents/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentView>(r);
  };
  const versions = async (who: Tokens, id: string) => {
    const r = await call(who, 'GET', `/api/v1/documents/${id}/versions`);
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: VersionView[] }>(r).items;
  };
  const create = async (who: Tokens, body: Record<string, unknown>) => {
    const r = await call(who, 'POST', '/api/v1/documents', body);
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r);
  };
  const addVersion = async (who: Tokens, id: string) => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<VersionView>(r);
  };
  /** The pages read, as the worker leaves them. */
  const readPages = async (docId: string, versionId: string, words: string) => {
    await admin.query(
      'insert into document_text (version_id, household_id, document_id, content) values ($1, $2, $3, $4)',
      [versionId, owner.household_id, docId, words],
    );
    await admin.query("update document_version set ocr_status = 'done' where id = $1", [versionId]);
  };
  const suggestions = async (who: Tokens, id: string) => {
    const r = await call(who, 'GET', `/api/v1/documents/${id}/suggestions`);
    expect(r.statusCode, r.body).toBe(200);
    return json<DetailSuggestions>(r);
  };
  const derived = async (docId: string) =>
    (
      await admin.query<Record<string, unknown>>(
        `select to_char(fire_at, 'YYYY-MM-DD') as fire_at, lead_days, status,
                to_char(snoozed_until, 'YYYY-MM-DD') as snoozed_until, acknowledged_by
           from reminder where document_id = $1 and kind = 'derived' order by fire_at`,
        [docId],
      )
    ).rows;

  /** Sarah's passport, renewed: version 1 with the old dates, version 2 read off its pages. */
  const renewed = async (opts: { who?: Tokens; sameAsPages?: boolean } = {}) => {
    const who = opts.who ?? sarah;
    const oldIssued = inDays(-3650 + 30);
    const oldExpires = inDays(30);
    const newIssued = inDays(-5);
    const newExpires = inDays(3650 - 5);
    const doc = await create(who, {
      type_key: 'passport',
      title: 'Sarah’s passport',
      owner_member_id: sarah.member_id,
      issued: day(opts.sameAsPages ? newIssued : oldIssued),
      expires: day(opts.sameAsPages ? newExpires : oldExpires),
      identifier: opts.sameAsPages ? '612345678' : '533401872',
      issued_by: 'United Kingdom',
    });
    const first = await addVersion(who, doc.id);
    const second = await addVersion(who, doc.id);
    await readPages(doc.id, second.id, renewedPage(newIssued, newExpires, '612345678'));
    return {
      doc: await read(who, doc.id),
      first,
      second,
      oldIssued,
      oldExpires,
      newIssued,
      newExpires,
    };
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup({ household_name: 'The Khan family' });
    sarah = await h.join(owner, { name: 'Sarah', email: 'sarah-nv@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tariq', email: 'tariq-nv@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Uma', email: 'uma-nv@example.test', role: 'viewer' });
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('a new version freezes the one it replaces with its own details, and starts from them, unconfirmed', async () => {
    const { doc, first, second, oldIssued, oldExpires } = await renewed();
    expect(doc.details_unconfirmed).toBe(true);
    expect(doc.expires).toEqual(day(oldExpires));
    const [now, before] = await versions(sarah, doc.id);
    expect(now?.id).toBe(second.id);
    expect(now?.details).toBeNull();
    expect(now?.details_kept).toBe(true);
    expect(now?.details_unconfirmed).toBe(true);
    expect(before?.id).toBe(first.id);
    expect(before?.details).toMatchObject({
      issued: day(oldIssued),
      expires: day(oldExpires),
      identifier: '533401872',
      issued_by: 'United Kingdom',
      extra: {},
    });
    // The first version had no version before it: never unconfirmed.
    expect(before?.details_unconfirmed).toBe(false);
  });

  it('a version replaced before 0.9.0 says its details were never kept, and nothing is guessed', async () => {
    const { doc, first } = await renewed();
    // As a vault upgraded from before 0.9.0 has it.
    await admin.query(
      `update document_version set details_kept_at = null, issued_on = null, issued_precision = null,
              expires_on = null, expires_precision = null, identifier = null, issued_by = null
        where id = $1`,
      [first.id],
    );
    const [, before] = await versions(sarah, doc.id);
    expect(before?.details).toBeNull();
    expect(before?.details_kept).toBe(false);
  });

  it('the suggestions give a renewal’s read for a version after the first — not for a first version', async () => {
    const { doc, second, newIssued, newExpires } = await renewed();
    const s = await suggestions(sarah, doc.id);
    expect(s.state).toBe('ready');
    expect(s.version_id).toBe(second.id);
    // The chips' proposal is still only for empty fields.
    expect(s.proposal.expires).toBeUndefined();
    expect(s.renewal?.issued?.value).toEqual(day(newIssued));
    expect(s.renewal?.expires?.value).toEqual(day(newExpires));
    expect(s.renewal?.identifier?.value).toBe('612345678');
    expect(renewalOffers(doc, s.renewal).map((o) => o.field)).toEqual([
      'issued',
      'expires',
      'identifier',
    ]);

    // One version only: nothing to renew.
    const single = await create(sarah, {
      type_key: 'passport',
      owner_member_id: sarah.member_id,
      expires: day(inDays(30)),
    });
    const v = await addVersion(sarah, single.id);
    await readPages(single.id, v.id, renewedPage(inDays(-5), inDays(3645), '612345678'));
    expect((await suggestions(sarah, single.id)).renewal).toBeUndefined();
  });

  it('the same dates on the pages offer nothing', async () => {
    const { doc } = await renewed({ sameAsPages: true });
    const s = await suggestions(sarah, doc.id);
    expect(renewalOffers(doc, s.renewal)).toEqual([]);
  });

  it('Use these makes them the version’s own, as a renewal; Undo puts the dates and the reminders back as they were', async () => {
    const { doc, second, oldIssued, oldExpires, newIssued, newExpires } = await renewed();
    // One of its reminders acknowledged meanwhile: Undo puts it back so.
    const due = (
      await admin.query<{ id: string }>(
        "select id from reminder where document_id = $1 and kind = 'derived' and status in ('scheduled','due') order by fire_at limit 1",
        [doc.id],
      )
    ).rows[0];
    if (due) {
      const acked = await call(sarah, 'POST', `/api/v1/reminders/${due.id}/acknowledge`, {});
      expect(acked.statusCode, acked.body).toBe(200);
    }
    const now = await read(sarah, doc.id);
    const before = await derived(doc.id);

    const used = await call(
      sarah,
      'POST',
      `/api/v1/documents/${doc.id}/renewal`,
      {
        version_id: second.id,
        issued: day(newIssued),
        expires: day(newExpires),
        identifier: '612345678',
      },
      now.etag,
    );
    expect(used.statusCode, used.body).toBe(200);
    const done = json<RenewalResult>(used);
    expect(done.document.expires).toEqual(day(newExpires));
    expect(done.document.issued).toEqual(day(newIssued));
    expect(done.document.identifier).toBe('612345678');
    expect(done.document.details_unconfirmed).toBe(false);
    expect(used.headers.etag).toBe(done.document.etag);
    // Undo for five minutes, on the database's clock.
    const until = Date.parse(done.undo_until ?? '');
    expect(until - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 5_000);
    // The reminders made again from the new expiry, as an edit makes them.
    const after = await derived(doc.id);
    expect(after.map((r) => r.fire_at)).not.toEqual(before.map((r) => r.fire_at));
    expect(after.every((r) => String(r.fire_at) > inDays(365))).toBe(true);
    // The older version keeps its own.
    const [, older] = await versions(sarah, doc.id);
    expect(older?.details?.expires).toEqual(day(oldExpires));

    const undo = await call(sarah, 'POST', `/api/v1/documents/${doc.id}/renewal/undo`, {
      version_id: second.id,
    });
    expect(undo.statusCode, undo.body).toBe(200);
    const back = json<DocumentView>(undo);
    expect(back.expires).toEqual(day(oldExpires));
    expect(back.issued).toEqual(day(oldIssued));
    expect(back.identifier).toBe('533401872');
    expect(back.details_unconfirmed).toBe(true);
    expect(await derived(doc.id)).toEqual(before);
    // Once is enough.
    const again = await call(sarah, 'POST', `/api/v1/documents/${doc.id}/renewal/undo`, {
      version_id: second.id,
    });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('renewal_not_undoable');
  });

  it('a field left out stays as it was', async () => {
    const { doc, second, oldIssued, newExpires } = await renewed();
    const used = await call(
      sarah,
      'POST',
      `/api/v1/documents/${doc.id}/renewal`,
      { version_id: second.id, expires: day(newExpires) },
      doc.etag,
    );
    expect(used.statusCode, used.body).toBe(200);
    const d = json<RenewalResult>(used).document;
    expect(d.expires).toEqual(day(newExpires));
    expect(d.issued).toEqual(day(oldIssued));
    expect(d.identifier).toBe('533401872');
  });

  it('nothing is saved on a document changed since, without If-Match, or once another version is newest', async () => {
    const { doc, second, oldExpires, newExpires } = await renewed();
    const body = { version_id: second.id, expires: day(newExpires) };
    const bare = await call(sarah, 'POST', `/api/v1/documents/${doc.id}/renewal`, body);
    expect(bare.statusCode).toBe(428);
    const edited = await call(
      sarah,
      'PATCH',
      `/api/v1/documents/${doc.id}`,
      { tags: ['travel'] },
      doc.etag,
    );
    expect(edited.statusCode, edited.body).toBe(200);
    const stale = await call(sarah, 'POST', `/api/v1/documents/${doc.id}/renewal`, body, doc.etag);
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('conflict');
    expect((await read(sarah, doc.id)).expires).toEqual(day(oldExpires));

    const third = await addVersion(sarah, doc.id);
    const fresh = await read(sarah, doc.id);
    const older = await call(
      sarah,
      'POST',
      `/api/v1/documents/${doc.id}/renewal`,
      body,
      fresh.etag,
    );
    expect(older.statusCode).toBe(409);
    expect(code(older)).toBe('version_changed');
    expect((await read(sarah, doc.id)).expires).toEqual(day(oldExpires));
    expect(third.version_no).toBe(3);
  });

  it('Undo keeps what was changed since, and is only for whoever chose them', async () => {
    const { doc, second, newExpires } = await renewed();
    const used = json<RenewalResult>(
      await call(
        sarah,
        'POST',
        `/api/v1/documents/${doc.id}/renewal`,
        { version_id: second.id, expires: day(newExpires) },
        doc.etag,
      ),
    );
    const other = await call(owner, 'POST', `/api/v1/documents/${doc.id}/renewal/undo`, {
      version_id: second.id,
    });
    expect(other.statusCode).toBe(409);
    expect(code(other)).toBe('renewal_not_undoable');
    const edited = await call(
      sarah,
      'PATCH',
      `/api/v1/documents/${doc.id}`,
      { notes: 'Renewed at the post office' },
      used.document.etag,
    );
    expect(edited.statusCode, edited.body).toBe(200);
    const undo = await call(sarah, 'POST', `/api/v1/documents/${doc.id}/renewal/undo`, {
      version_id: second.id,
    });
    expect(undo.statusCode).toBe(409);
    expect(code(undo)).toBe('renewal_kept');
    expect((await read(sarah, doc.id)).expires).toEqual(day(newExpires));
  });

  it('the whole Edit card confirms the newest version’s details; a one-field change (a chip) never does', async () => {
    const { doc, newExpires } = await renewed();
    // A chip filling one field, or a detail changed on its own: still the version before's.
    const chip = await call(
      sarah,
      'PATCH',
      `/api/v1/documents/${doc.id}`,
      { physical_location: 'The blue folder' },
      doc.etag,
    );
    expect(chip.statusCode, chip.body).toBe(200);
    const one = await call(
      sarah,
      'PATCH',
      `/api/v1/documents/${doc.id}`,
      { issued_by: 'HM Passport Office' },
      json<DocumentView>(chip).etag,
    );
    expect(one.statusCode, one.body).toBe(200);
    expect(json<DocumentView>(one).details_unconfirmed).toBe(true);
    expect(
      renewalOffers(json<DocumentView>(one), (await suggestions(sarah, doc.id)).renewal),
    ).not.toEqual([]);
    // The Edit card, saved whole: confirmed.
    const edited = await call(
      sarah,
      'PATCH',
      `/api/v1/documents/${doc.id}`,
      { expires: day(newExpires), confirm_details: true },
      json<DocumentView>(one).etag,
    );
    expect(edited.statusCode, edited.body).toBe(200);
    expect(json<DocumentView>(edited).details_unconfirmed).toBe(false);
    // The flag is the card's alone: never a field of the document, nor in the activity.
    expect(json<Record<string, unknown>>(edited)).not.toHaveProperty('confirm_details');
    const lines = await admin.query<{ detail: { fields?: string[] } }>(
      `select detail from audit_event where object_id = $1 and action = 'document.updated'
        order by id desc limit 1`,
      [doc.id],
    );
    expect(lines.rows[0]?.detail.fields).toEqual(['expires']);
  });

  it('a second Use these while the first may still be undone is refused, and the first Undo puts back the original', async () => {
    const { doc, second, oldExpires, newExpires } = await renewed();
    const first = await call(
      sarah,
      'POST',
      `/api/v1/documents/${doc.id}/renewal`,
      { version_id: second.id, expires: day(newExpires) },
      doc.etag,
    );
    expect(first.statusCode, first.body).toBe(200);
    const again = await call(
      sarah,
      'POST',
      `/api/v1/documents/${doc.id}/renewal`,
      { version_id: second.id, expires: day(inDays(4000)) },
      json<RenewalResult>(first).document.etag,
    );
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('renewal_undo_open');
    expect((await read(sarah, doc.id)).expires).toEqual(day(newExpires));
    const undo = await call(sarah, 'POST', `/api/v1/documents/${doc.id}/renewal/undo`, {
      version_id: second.id,
    });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(json<DocumentView>(undo).expires).toEqual(day(oldExpires));
  });

  it('a viewer, and a teen who may not change it, are offered nothing and can use nothing', async () => {
    const { doc, second, newExpires } = await renewed();
    for (const who of [viewer, teen]) {
      const s = await call(who, 'GET', `/api/v1/documents/${doc.id}/suggestions`);
      expect(s.statusCode).toBe(403);
      const used = await call(
        who,
        'POST',
        `/api/v1/documents/${doc.id}/renewal`,
        { version_id: second.id, expires: day(newExpires) },
        doc.etag,
      );
      expect(used.statusCode).toBe(403);
    }
    // A viewer still reads the history, an older version's details with it.
    const seen = await versions(viewer, doc.id);
    expect(seen[1]?.details?.identifier).toBe('533401872');
  });

  it('an Only me document’s older version keeps its kind’s details sealed, opened for its owner alone, and moving with the document', async () => {
    const doc = await create(sarah, {
      type_key: 'drivers_licence',
      title: 'Sarah’s licence',
      owner_member_id: sarah.member_id,
      visibility: 'private',
      expires: day(inDays(20)),
      identifier: 'KHAN9-123',
      extra: { class: 'B', state: 'Yorkshire' },
    });
    const first = await addVersion(sarah, doc.id);
    await addVersion(sarah, doc.id);
    const sealed = async () =>
      (
        await admin.query<{ extra: Record<string, unknown>; sealed: boolean }>(
          'select extra, extra_sealed is not null as sealed from document_version where id = $1',
          [first.id],
        )
      ).rows[0];
    expect(await sealed()).toEqual({ extra: {}, sealed: true });
    const [, older] = await versions(sarah, doc.id);
    expect(older?.details?.extra).toEqual({ class: 'B', state: 'Yorkshire' });
    // Nobody else sees the document at all.
    expect((await call(owner, 'GET', `/api/v1/documents/${doc.id}/versions`)).statusCode).toBe(404);

    // Seen by the family again: its older version's details plain, as the document's.
    await h.decider(sarah);
    const out = await call(sarah, 'PATCH', `/api/v1/documents/${doc.id}`, {
      visibility: 'household',
    });
    expect(out.statusCode, out.body).toBe(200);
    expect(await sealed()).toEqual({ extra: { class: 'B', state: 'Yorkshire' }, sealed: false });
    expect((await versions(owner, doc.id))[1]?.details?.extra).toEqual({
      class: 'B',
      state: 'Yorkshire',
    });
    // And Only me again: sealed again.
    const back = await call(sarah, 'PATCH', `/api/v1/documents/${doc.id}`, {
      visibility: 'private',
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await sealed()).toEqual({ extra: {}, sealed: true });
    expect((await versions(sarah, doc.id))[1]?.details?.extra).toEqual({
      class: 'B',
      state: 'Yorkshire',
    });
    // Brought back plain, as a restore can before private.seal reaches it:
    // given whole to its owner, the plain over the sealed.
    await admin.query(
      `update document_version set extra = '{"class": "C1"}'::jsonb, extra_sealed = null where id = $1`,
      [first.id],
    );
    expect((await versions(sarah, doc.id))[1]?.details?.extra).toEqual({ class: 'C1' });
  });
});
