import { randomUUID } from 'node:crypto';
import {
  createDb,
  createPool,
  regenerateDerived,
  withPrincipal,
  withSystem,
  type Db,
  type Role,
} from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  EXPIRY_ALWAYS_REQUIRED,
  PRIVATE_BY_DEFAULT,
  TYPE_IN_USE,
  UNSEEN_DOCUMENTS,
  type ActivityLine,
  type DocumentAttributeView,
  type DocumentTypeImpact,
  type DocumentTypeView,
  type DocumentView,
  type SuggestionView,
} from '@fdv/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { forgetTypes, typeLookup } from './service.js';

/**
 * Kinds of document, managed (5.11), through the API as each role: the
 * owner, an adult (Sam), a teen and a viewer, each a real sign-in on the
 * application role. What the database keeps is read as its owner only to
 * check what the API said.
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const BOUNDARY = 'fdv-document-types-boundary';
const REFUSAL = 'Only an adult can change the kinds of document the family keeps.';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!testAdminUrl())('kinds of document, managed', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  /** A child with no sign-in of their own. */
  let aisha: string;
  let admin: ReturnType<typeof createPool>;
  /** The application role, as the worker is: types.regenerate runs on it. */
  let app: Db;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const error = (r: { json: () => unknown }) =>
    json<{ error: { code: string; message: string; detail?: string; action?: string } }>(r).error;
  const call = (
    who: Tokens,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { ...h.as(who), ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const ok = async <T>(r: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const res = await r;
    expect(res.statusCode, res.body).toBeLessThan(300);
    return json<T>(res);
  };

  /** A kind of the household's own, made by the owner. */
  const kind = (body: Record<string, unknown>) =>
    ok<DocumentTypeView>(
      call(owner, 'POST', '/api/v1/document-types', { category: 'other', ...body }),
    );
  const file = (who: Tokens, body: Record<string, unknown>) =>
    ok<DocumentView>(call(who, 'POST', '/api/v1/documents', body));
  const types = async (who: Tokens, all = false) =>
    (
      await ok<{ items: DocumentTypeView[] }>(
        call(who, 'GET', `/api/v1/document-types${all ? '?all=true' : ''}`),
      )
    ).items;
  const typeOf = async (key: string) => (await types(owner, true)).find((t) => t.key === key);
  const activity = async (who: Tokens) =>
    (await ok<{ items: ActivityLine[] }>(call(who, 'GET', '/api/v1/audit'))).items;

  /** A capture with the card's details, sent before the file. */
  const capture = (who: Tokens, metadata: unknown) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`,
        ),
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        PDF,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });

  const reminders = async (documentId: string) =>
    (
      await admin.query<{ lead_days: number; status: string }>(
        `select lead_days, status from reminder
          where document_id = $1 and kind = 'derived' order by lead_days desc`,
        [documentId],
      )
    ).rows;

  /**
   * The worker's job for every one the API asked for so far, as it runs:
   * each document of the type, in a transaction of its own as the vault,
   * reminded by the function the API uses (apps/worker/src/jobs/types.ts;
   * its own run is in the worker's actor.test.ts).
   */
  const runRegenerate = async () => {
    const asked = h.jobs.filter((j) => j.name === 'types.regenerate');
    h.jobs.splice(0, h.jobs.length, ...h.jobs.filter((j) => j.name !== 'types.regenerate'));
    for (const j of asked) {
      const { household_id, type_key } = j.data as { household_id: string; type_key: string };
      const docs = await withSystem(app, household_id, (trx) =>
        trx.selectFrom('document').select('id').where('type_key', '=', type_key).execute(),
      );
      for (const d of docs) {
        await withSystem(app, household_id, (trx) =>
          regenerateDerived(trx, household_id, d.id, { aheadOnly: true }),
        );
      }
    }
    return asked;
  };

  /** The session's last credential, long enough ago to be asked again. */
  const goStale = () =>
    admin.query(
      "update session set verified_at = now() - interval '1 hour' where household_id = $1",
      [owner.household_id],
    );

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, { name: 'Sam', email: 'sam-types@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Kid', email: 'kid-types@example.test', role: 'teen' });
    viewer = await h.join(owner, {
      name: 'Accountant',
      email: 'acc-types@example.test',
      role: 'viewer',
    });
    aisha = (
      await ok<{ id: string }>(
        call(owner, 'POST', '/api/v1/members', {
          display_name: 'Aisha',
          date_of_birth: '2016-05-01',
        }),
      )
    ).id;
    admin = createPool(h.adminUrl, 2);
    app = createDb(createPool(h.appUrl, 2));
  }, 120_000);

  afterAll(async () => {
    await app?.destroy();
    await admin?.end();
    await h?.close();
  });

  it('without types.manage: refused, with the sentence', async () => {
    const mine = await kind({ label: 'Season ticket' });
    const before = await typeOf(mine.key);
    for (const who of [teen, viewer]) {
      const tries = [
        call(who, 'POST', '/api/v1/document-types', { label: 'Smuggled', category: 'other' }),
        call(who, 'PATCH', `/api/v1/document-types/${mine.key}`, { label: 'Changed' }),
        call(who, 'PATCH', '/api/v1/document-types/passport', { hidden: true }),
        call(who, 'POST', `/api/v1/document-types/${mine.key}/archive`),
        call(who, 'POST', `/api/v1/document-types/${mine.key}/restore`),
        call(who, 'DELETE', `/api/v1/document-types/${mine.key}`),
        call(who, 'GET', `/api/v1/document-types/${mine.key}/impact`),
        call(who, 'POST', '/api/v1/document-attributes', { label: 'Smuggled', kind: 'text' }),
        // Refused before the body is read: a bad one is not what they are told.
        call(who, 'POST', '/api/v1/document-types', { nonsense: true }),
      ];
      for (const r of await Promise.all(tries)) {
        expect(r.statusCode, r.body).toBe(403);
        expect(error(r)).toMatchObject({ code: 'forbidden', message: REFUSAL });
      }
    }
    // Nothing changed, and nothing was made.
    expect(await typeOf(mine.key)).toEqual(before);
    expect((await typeOf('passport'))?.hidden).toBe(false);
    expect((await types(owner, true)).map((t) => t.label)).not.toContain('Smuggled');
    // An adult may, as an owner may.
    const bySam = await call(sam, 'PATCH', `/api/v1/document-types/${mine.key}`, {
      label: 'Season ticket (rail)',
    });
    expect(bySam.statusCode, bySam.body).toBe(200);
  });

  it('a key never changes when the label does', async () => {
    const pension = await kind({
      label: 'Pension statement',
      category: 'financial',
      short_label: 'Pension',
      issuer_noun: 'pension statement',
    });
    expect(pension.key).toMatch(/^h_[a-z2-7]{10}$/);
    expect(pension).toMatchObject({ builtin: false, hidden: false, category: 'financial' });
    const doc = await file(owner, { type_key: pension.key, title: 'Acme pension' });

    const renamed = await ok<DocumentTypeView>(
      call(owner, 'PATCH', `/api/v1/document-types/${pension.key}`, {
        label: 'Workplace pension',
        short_label: 'Workplace pension',
      }),
    );
    expect(renamed).toMatchObject({ key: pension.key, label: 'Workplace pension' });
    expect((await typeOf(pension.key))?.label).toBe('Workplace pension');
    // What was filed under it is under it still, by the same key.
    expect(
      (await ok<DocumentView>(call(owner, 'GET', `/api/v1/documents/${doc.id}`))).type_key,
    ).toBe(pension.key);
    // A key is not something an edit can send…
    const keyed = await call(owner, 'PATCH', `/api/v1/document-types/${pension.key}`, {
      key: 'h_aaaaaaaaaa',
    });
    expect(keyed.statusCode).toBe(422);
    // …nor can a built-in be renamed: it keeps its name, and says what to do.
    const builtin = await call(owner, 'PATCH', '/api/v1/document-types/passport', {
      label: 'Travel document',
    });
    expect(builtin.statusCode).toBe(422);
    expect(error(builtin).message).toMatch(/keeps its name/);
    // The database holds the key as well: 0031's trigger.
    await expect(
      admin.query("update document_type set key = 'h_bbbbbbbbbb' where key = $1", [pension.key]),
    ).rejects.toThrow(/keeps its key/);
    // Said in the log, by the name it had then.
    const lines = (await activity(owner)).map((l) => l.text);
    expect(lines).toContain('Owner added a kind of document, “Pension statement”');
    expect(lines).toContain('Owner changed “Workplace pension”');
  });

  it('a type in use can be archived, not deleted', async () => {
    const plot = await kind({ label: 'Allotment tenancy', category: 'property' });
    const doc = await file(owner, { type_key: plot.key, title: 'Plot 14' });

    const refused = await call(owner, 'DELETE', `/api/v1/document-types/${plot.key}`);
    expect(refused.statusCode).toBe(409);
    expect(error(refused)).toMatchObject({ code: 'type_in_use', message: TYPE_IN_USE });
    const archived = await ok<DocumentTypeView>(
      call(owner, 'POST', `/api/v1/document-types/${plot.key}/archive`),
    );
    expect(archived.hidden).toBe(true);
    // Archived, still in use: still not deleted — nor from the Trash.
    expect((await call(owner, 'DELETE', `/api/v1/document-types/${plot.key}`)).statusCode).toBe(
      409,
    );
    expect((await call(owner, 'DELETE', `/api/v1/documents/${doc.id}`)).statusCode).toBe(204);
    const trashed = await call(owner, 'DELETE', `/api/v1/document-types/${plot.key}`);
    expect(trashed.statusCode).toBe(409);
    expect(error(trashed).message).toBe(TYPE_IN_USE);
    expect(await typeOf(plot.key)).toBeDefined();

    // One nothing is filed under goes, and says so.
    const spare = await kind({ label: 'Spare kind' });
    const gone = await call(owner, 'DELETE', `/api/v1/document-types/${spare.key}`);
    expect(gone.statusCode, gone.body).toBe(204);
    expect(await typeOf(spare.key)).toBeUndefined();
    expect((await call(owner, 'DELETE', `/api/v1/document-types/${spare.key}`)).statusCode).toBe(
      404,
    );
    expect((await activity(owner)).map((l) => l.text)).toContain('Owner deleted “Spare kind”');
    // A built-in is hidden, never deleted.
    const builtin = await call(owner, 'DELETE', '/api/v1/document-types/warranty');
    expect(builtin.statusCode).toBe(422);
    expect(error(builtin).message).toMatch(/Hide it instead/);
  });

  it('archiving keeps documents and history', async () => {
    const lease = await kind({
      label: 'Garage lease',
      category: 'property',
      core: { identifier: { label: 'Lease number', required: true } },
    });
    const doc = await file(owner, {
      type_key: lease.key,
      title: 'Garage on Mill Lane',
      owner_member_id: owner.member_id,
    });
    expect(doc.status).toEqual({ value: 'needs_info', label: 'Needs a lease number' });
    await ok(call(owner, 'PATCH', `/api/v1/documents/${doc.id}`, { notes: 'Key with Sam' }));
    const before = await ok<DocumentView>(call(owner, 'GET', `/api/v1/documents/${doc.id}`));

    await ok(call(owner, 'POST', `/api/v1/document-types/${lease.key}/archive`));
    // The document is exactly as it was: its kind, its details, its status.
    const after = await ok<DocumentView>(call(owner, 'GET', `/api/v1/documents/${doc.id}`));
    expect(after).toEqual(before);
    // No longer offered, but listed while a document uses it — marked hidden.
    expect((await types(owner)).find((t) => t.key === lease.key)).toMatchObject({
      hidden: true,
      label: 'Garage lease',
    });
    // A phone's scan queued before it was archived is still taken.
    const queued = await capture(owner, { type_key: lease.key, title: 'Second garage' });
    expect(queued.statusCode, queued.body).toBe(201);
    // Its history keeps every line, the family's to read.
    const lines = (await activity(teen)).map((l) => l.text);
    expect(lines).toContain('Owner added a kind of document, “Garage lease”');
    expect(lines).toContain('Owner archived “Garage lease”');
    expect(lines).toContain('Owner added “Garage on Mill Lane”');
    // A viewer reads no log at all.
    expect((await call(viewer, 'GET', '/api/v1/audit')).statusCode).toBe(403);

    const back = await ok<DocumentTypeView>(
      call(owner, 'POST', `/api/v1/document-types/${lease.key}/restore`),
    );
    expect(back.hidden).toBe(false);
    expect((await activity(owner)).map((l) => l.text)).toContain(
      'Owner brought back “Garage lease”',
    );
    // A built-in, hidden and offered again, says so in its own words.
    await ok(call(owner, 'POST', '/api/v1/document-types/pet_record/archive'));
    await ok(call(owner, 'POST', '/api/v1/document-types/pet_record/restore'));
    const said = (await activity(owner)).map((l) => l.text);
    expect(said).toContain('Owner stopped offering “Pet records”');
    expect(said).toContain('Owner offered “Pet records” again');
  });

  it("new lead times regenerate that type's reminders", async () => {
    const permit = await kind({
      label: 'Parking permit',
      category: 'property',
      core: { expires: { shown: true } },
      reminder_leads: [30],
    });
    expect(permit).toMatchObject({ expiry_driver: 'expires_on', reminder_leads: [30] });
    const mine = await file(owner, {
      type_key: permit.key,
      title: 'Permit, zone B',
      owner_member_id: owner.member_id,
      expires: { date: inDays(200), precision: 'day' },
    });
    // Sam's, Only me: the owner cannot see it, and it is reminded all the same.
    const sams = await file(sam, {
      type_key: permit.key,
      title: "Sam's permit",
      owner_member_id: sam.member_id,
      visibility: 'private',
      expires: { date: inDays(100), precision: 'day' },
    });
    expect(await reminders(mine.id)).toEqual([{ lead_days: 30, status: 'scheduled' }]);
    // Somebody dealt with Sam's already; a reminder that stays as it was keeps that.
    await admin.query(
      "update reminder set status = 'acknowledged' where document_id = $1 and lead_days = 30",
      [sams.id],
    );

    const changed = await ok<DocumentTypeView>(
      call(owner, 'PATCH', `/api/v1/document-types/${permit.key}`, { reminder_leads: [30, 150] }),
    );
    expect(changed.reminder_leads).toEqual([150, 30]);
    const asked = await runRegenerate();
    expect(asked).toEqual([
      {
        name: 'types.regenerate',
        data: { household_id: owner.household_id, type_key: permit.key },
        options: { singletonKey: `types.regenerate:${owner.household_id}:${permit.key}` },
      },
    ]);
    expect(await reminders(mine.id)).toEqual([
      { lead_days: 150, status: 'scheduled' },
      { lead_days: 30, status: 'scheduled' },
    ]);
    // 150 days before a date 100 days off has passed: a change to the kind
    // reminds of what is ahead, not of a day gone by (the 5.11 review).
    expect(await reminders(sams.id)).toEqual([{ lead_days: 30, status: 'acknowledged' }]);
    // Its own edit still does, as when it was filed: due now.
    await ok(
      call(sam, 'PATCH', `/api/v1/documents/${sams.id}`, {
        expires: { date: inDays(101), precision: 'day' },
      }),
    );
    expect(await reminders(sams.id)).toEqual([
      { lead_days: 150, status: 'due' },
      { lead_days: 30, status: 'scheduled' },
    ]);

    // Expires switched off: nothing to remind of, and its date kept.
    await ok(
      call(owner, 'PATCH', `/api/v1/document-types/${permit.key}`, {
        core: { expires: { shown: false } },
      }),
    );
    expect((await runRegenerate()).length).toBe(1);
    expect(await reminders(mine.id)).toEqual([]);
    expect(await reminders(sams.id)).toEqual([]);
    expect(
      (await ok<DocumentView>(call(owner, 'GET', `/api/v1/documents/${mine.id}`))).expires?.date,
    ).toBe(inDays(200));
    // Anything else changed asks for nothing.
    await ok(call(owner, 'PATCH', `/api/v1/document-types/${permit.key}`, { label: 'Permit' }));
    expect(await runRegenerate()).toEqual([]);

    // A built-in's lead times, changed by the household, the same.
    const passport = await file(owner, {
      type_key: 'passport',
      title: 'Passport',
      owner_member_id: owner.member_id,
      identifier: '563914782',
      expires: { date: inDays(400), precision: 'day' },
    });
    expect((await reminders(passport.id)).map((r) => r.lead_days)).toEqual([270, 180]);
    await ok(call(owner, 'PATCH', '/api/v1/document-types/passport', { reminder_leads: [60] }));
    await runRegenerate();
    expect((await reminders(passport.id)).map((r) => r.lead_days)).toEqual([60]);
  });

  it('a stale If-Match is 409', async () => {
    const card = await kind({ label: 'Library card' });
    expect(card.etag).toMatch(/^"[0-9a-f]{16}"$/);
    const listed = await typeOf(card.key);
    expect(listed?.etag).toBe(card.etag);

    const first = await call(
      owner,
      'PATCH',
      `/api/v1/document-types/${card.key}`,
      { label: 'Library card (town)' },
      { 'if-match': card.etag as string },
    );
    expect(first.statusCode, first.body).toBe(200);
    const newer = json<DocumentTypeView>(first);
    expect(first.headers.etag).toBe(newer.etag);
    expect(newer.etag).not.toBe(card.etag);

    // Sam, from the list he loaded before the owner's change.
    const stale = await call(
      sam,
      'PATCH',
      `/api/v1/document-types/${card.key}`,
      { label: 'Library card (city)' },
      { 'if-match': card.etag as string },
    );
    expect(stale.statusCode).toBe(409);
    expect(error(stale)).toMatchObject({
      code: 'conflict',
      message: 'Someone else changed this kind of document. Reload and try again.',
    });
    // The kind as it now is, to reload from.
    expect(JSON.parse(error(stale).detail as string)).toMatchObject({
      label: 'Library card (town)',
      etag: newer.etag,
    });
    expect((await typeOf(card.key))?.label).toBe('Library card (town)');

    // A built-in's too: the household's change is what moves its tag.
    const will = (await typeOf('will')) as DocumentTypeView;
    await ok(
      call(
        owner,
        'PATCH',
        '/api/v1/document-types/will',
        { usually_essential: true },
        {
          'if-match': will.etag as string,
        },
      ),
    );
    const again = await call(
      owner,
      'PATCH',
      '/api/v1/document-types/will',
      { usually_essential: false },
      { 'if-match': will.etag as string },
    );
    expect(again.statusCode).toBe(409);
  });

  it('a hidden built-in is no longer suggested as missing', async () => {
    await ok(call(owner, 'PUT', '/api/v1/profile', { vehicle_count: 1 }));
    const suggested = async () =>
      (await ok<{ items: SuggestionView[] }>(call(owner, 'GET', '/api/v1/suggestions'))).items.map(
        (s) => s.type_key,
      );
    expect(await suggested()).toContain('vehicle_registration');
    await ok(call(sam, 'PATCH', '/api/v1/document-types/vehicle_registration', { hidden: true }));
    expect(await suggested()).not.toContain('vehicle_registration');
    expect((await activity(owner)).map((l) => l.text)).toContain(
      'Sam stopped offering “Vehicle title / registration”',
    );
    await ok(call(sam, 'PATCH', '/api/v1/document-types/vehicle_registration', { hidden: false }));
    expect(await suggested()).toContain('vehicle_registration');
    // A kind of the household's own is archived, not hidden.
    const own = await kind({ label: 'Boat licence' });
    const hid = await call(owner, 'PATCH', `/api/v1/document-types/${own.key}`, { hidden: true });
    expect(hid.statusCode).toBe(422);
  });

  it('an adult cannot widen Will to household; an owner can, with step-up', async () => {
    const will = (await typeOf('will')) as DocumentTypeView;
    expect(will.default_visibility).toBe('adults');

    const bySam = await call(sam, 'PATCH', '/api/v1/document-types/will', {
      default_visibility: 'household',
    });
    expect(bySam.statusCode).toBe(403);
    expect(error(bySam)).toMatchObject({
      code: 'forbidden',
      message: 'Only an owner can let more people see a kind of document from now on.',
    });
    // Narrowing is anybody's who may change kinds: Sam keeps Pet records to the adults.
    const narrowed = await call(sam, 'PATCH', '/api/v1/document-types/pet_record', {
      default_visibility: 'adults',
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);

    // The owner, not having confirmed it is them lately, is asked, and
    // nothing changes until they are.
    await goStale();
    const asked = await call(owner, 'PATCH', '/api/v1/document-types/will', {
      default_visibility: 'household',
    });
    expect(asked.statusCode).toBe(403);
    expect(error(asked)).toMatchObject({
      code: 'step_up_required',
      action: 'widen_type_visibility',
    });
    expect((await typeOf('will'))?.default_visibility).toBe('adults');
    // Narrowing asks nothing, even now.
    const narrowedByOwner = await call(owner, 'PATCH', '/api/v1/document-types/passport', {
      default_visibility: 'adults',
    });
    expect(narrowedByOwner.statusCode, narrowedByOwner.body).toBe(200);

    await ok(call(owner, 'POST', '/api/v1/auth/step-up', { password: 'correct horse battery' }));
    const widened = await ok<DocumentTypeView>(
      call(owner, 'PATCH', '/api/v1/document-types/will', { default_visibility: 'household' }),
    );
    expect(widened.default_visibility).toBe('household');
    // The next will anybody files is the family's to see.
    const filed = await file(sam, { type_key: 'will', title: "Sam's will" });
    expect(filed.visibility).toBe('household');
    // And it is news in the log; the narrowing is not.
    const lines = await activity(owner);
    expect(lines.find((l) => l.text.includes('Will / trust'))).toMatchObject({
      text: 'Owner made new “Will / trust / power of attorney” documents visible to everyone in the family',
      notable: true,
    });
    expect(
      lines.find((l) => l.text.includes('Pet records') && l.text.includes('adults')),
    ).toMatchObject({
      text: 'Sam made new “Pet records” documents visible to the adults only',
      notable: false,
    });
    // Put back, as anybody who may change kinds may: narrowing.
    await ok(call(sam, 'PATCH', '/api/v1/document-types/will', { default_visibility: 'adults' }));
  });

  it('impact counts only what the caller can see', async () => {
    const case_ = await kind({
      label: 'Immigration case',
      category: 'legal',
      core: { identifier: { label: 'Case number', required: true } },
    });
    await file(owner, {
      type_key: case_.key,
      title: 'Family case',
      owner_member_id: owner.member_id,
      identifier: 'IC-1',
    });
    await file(owner, { type_key: case_.key, title: 'Old case', owner_member_id: owner.member_id });
    // Sam's own, Only me, with its number sealed.
    await file(sam, {
      type_key: case_.key,
      title: "Sam's case",
      owner_member_id: sam.member_id,
      visibility: 'private',
      identifier: 'IC-SAM',
      notes: 'Solicitor is Ms Khan',
    });

    const byOwner = await ok<DocumentTypeImpact>(
      call(owner, 'GET', `/api/v1/document-types/${case_.key}/impact`),
    );
    expect(byOwner).toMatchObject({
      key: case_.key,
      documents: 2,
      in_trash: 0,
      unseen: UNSEEN_DOCUMENTS,
    });
    expect(byOwner.core.identifier).toEqual({ with_value: 1, without_value: 1 });
    expect(byOwner.core.notes).toEqual({ with_value: 0, without_value: 2 });
    // Sam sees the family's two and his own: its note counted, unopened.
    const bySam = await ok<DocumentTypeImpact>(
      call(sam, 'GET', `/api/v1/document-types/${case_.key}/impact`),
    );
    expect(bySam).toMatchObject({ documents: 3, unseen: UNSEEN_DOCUMENTS });
    expect(bySam.core.identifier).toEqual({ with_value: 2, without_value: 1 });
    expect(bySam.core.notes).toEqual({ with_value: 1, without_value: 2 });
    // Neither teen nor viewer is told anything.
    for (const who of [teen, viewer]) {
      expect(
        (await call(who, 'GET', `/api/v1/document-types/${case_.key}/impact`)).statusCode,
      ).toBe(403);
    }
    // A kind the caller has none of reads as one nobody has: the sentence, no number.
    const empty = await kind({ label: 'Nothing filed' });
    const none = await ok<DocumentTypeImpact>(
      call(owner, 'GET', `/api/v1/document-types/${empty.key}/impact`),
    );
    expect(none).toMatchObject({
      documents: 0,
      in_trash: 0,
      reminders: 0,
      unseen: UNSEEN_DOCUMENTS,
    });
  });

  it('a delete depends only on the documents the caller can see (5.11 review)', async () => {
    // One kind only Sam's Only me document uses; one the family's does; one nobody's.
    const hidden = await kind({ label: 'Divorce proceedings', category: 'legal' });
    const petition = await file(sam, {
      type_key: hidden.key,
      title: 'Petition',
      owner_member_id: sam.member_id,
      visibility: 'private',
    });
    const seen = await kind({ label: 'Club membership' });
    await file(owner, { type_key: seen.key, title: 'Tennis club' });
    const unused = await kind({ label: 'Not used' });
    // Before: its impact reads to the owner as a kind nobody uses.
    const impact = async (key: string) => ({
      ...(await ok<DocumentTypeImpact>(call(owner, 'GET', `/api/v1/document-types/${key}/impact`))),
      key: 'either',
    });
    expect(await impact(hidden.key)).toEqual(await impact(unused.key));

    // Refused only for a document the owner can see…
    const ofSeen = await call(owner, 'DELETE', `/api/v1/document-types/${seen.key}`);
    expect(ofSeen.statusCode).toBe(409);
    expect(error(ofSeen)).toMatchObject({ code: 'type_in_use', message: TYPE_IN_USE });
    // …and the other two answer alike: deleted, and said so in the log.
    const ofHidden = await call(owner, 'DELETE', `/api/v1/document-types/${hidden.key}`);
    const ofUnused = await call(owner, 'DELETE', `/api/v1/document-types/${unused.key}`);
    expect([ofHidden.statusCode, ofHidden.body]).toEqual([204, '']);
    expect([ofUnused.statusCode, ofUnused.body]).toEqual([204, '']);
    const said = (await activity(owner)).map((l) => l.text);
    expect(said).toContain('Owner deleted “Divorce proceedings”');
    expect(said).toContain('Owner deleted “Not used”');

    // For the owner both are gone: from the lists, and from every change.
    for (const key of [hidden.key, unused.key]) {
      for (const all of [false, true]) {
        expect((await types(owner, all)).map((t) => t.key)).not.toContain(key);
      }
      for (const [method, url, body] of [
        ['PATCH', `/api/v1/document-types/${key}`, { label: 'Back' }],
        ['POST', `/api/v1/document-types/${key}/archive`, undefined],
        ['POST', `/api/v1/document-types/${key}/restore`, undefined],
        ['GET', `/api/v1/document-types/${key}/impact`, undefined],
        ['DELETE', `/api/v1/document-types/${key}`, undefined],
      ] as const) {
        const r = await call(owner, method, url, body);
        expect(r.statusCode, `${method} ${url}`).toBe(404);
        expect(error(r).message).toBe('That kind of document is not on the list.');
      }
      const filed = await call(owner, 'POST', '/api/v1/documents', { type_key: key, title: 'X' });
      expect(filed.statusCode).toBe(422);
      expect(error(filed).message).toBe('That kind of document is not on the list.');
    }
    // Sam's petition keeps its kind: he still finds it in his list, hidden,
    // and his document still reads by it.
    const bySam = (await types(sam)).find((t) => t.key === hidden.key);
    expect(bySam).toMatchObject({ label: 'Divorce proceedings', hidden: true });
    const his = await ok<DocumentView>(call(sam, 'GET', `/api/v1/documents/${petition.id}`));
    expect(his.type_key).toBe(hidden.key);
    // He may edit his document, naming its kind again, but not file a new one
    // under it, nor change the kind: it is deleted, for everybody.
    await ok(
      call(sam, 'PATCH', `/api/v1/documents/${petition.id}`, {
        type_key: hidden.key,
        title: 'Petition (filed)',
      }),
    );
    expect(
      (
        await call(sam, 'POST', '/api/v1/documents', {
          type_key: hidden.key,
          title: 'Another',
          owner_member_id: sam.member_id,
          visibility: 'private',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await call(sam, 'PATCH', `/api/v1/document-types/${hidden.key}`, { label: 'Divorce' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(sam, 'POST', `/api/v1/document-types/${hidden.key}/restore`)).statusCode,
    ).toBe(404);
    expect((await types(owner, true)).map((t) => t.key)).not.toContain(hidden.key);

    // Once no document uses it, it is gone for good.
    const kept = () =>
      admin
        .query('select key from document_type where key = $1', [hidden.key])
        .then((r) => r.rowCount);
    expect(await kept()).toBe(1);
    await ok(call(sam, 'PATCH', `/api/v1/documents/${petition.id}`, { type_key: null }));
    expect(await kept()).toBe(0);
  });

  it("a type private by default never files somebody else's document as their Only me (5.7 review)", async () => {
    const therapy = await kind({ label: 'Therapy notes', category: 'medical' });
    // Narrowing to Only me is anybody's who may change kinds.
    await ok(
      call(sam, 'PATCH', `/api/v1/document-types/${therapy.key}`, {
        default_visibility: 'private',
      }),
    );
    const count = async () =>
      Number(
        (
          await admin.query<{ n: string }>(
            'select count(*) as n from document where type_key = $1',
            [therapy.key],
          )
        ).rows[0]?.n,
      );

    // For Aisha, or for nobody: not Only me, by the kind's default or by asking.
    for (const body of [
      { type_key: therapy.key, title: "Aisha's sessions", owner_member_id: aisha },
      { type_key: therapy.key, title: 'Nobody named' },
    ]) {
      const typed = await call(owner, 'POST', '/api/v1/documents', body);
      expect(typed.statusCode).toBe(422);
      expect(error(typed)).toMatchObject({
        code: 'validation_failed',
        message: PRIVATE_BY_DEFAULT,
      });
      const captured = await capture(owner, body);
      expect(captured.statusCode).toBe(422);
      expect(error(captured).message).toBe(PRIVATE_BY_DEFAULT);
    }
    const asked = await call(owner, 'POST', '/api/v1/documents', {
      type_key: therapy.key,
      title: "Aisha's sessions",
      owner_member_id: aisha,
      visibility: 'private',
    });
    expect(asked.statusCode).toBe(422);
    expect(error(asked).message).toBe(
      'Only the person a document belongs to can make it private to them.',
    );
    expect(await count()).toBe(0);

    // Choosing who sees it is the way round; your own is Only me, as the kind says.
    expect(
      (
        await file(owner, {
          type_key: therapy.key,
          title: "Aisha's sessions",
          owner_member_id: aisha,
          visibility: 'adults',
        })
      ).visibility,
    ).toBe('adults');
    expect(
      (
        await file(owner, {
          type_key: therapy.key,
          title: 'Mine',
          owner_member_id: owner.member_id,
        })
      ).visibility,
    ).toBe('private');
    // A teen's is their own, named or not, by typing or by capture.
    const teens = await file(teen, { type_key: therapy.key, title: 'My sessions' });
    expect(teens).toMatchObject({ visibility: 'private', owner_member_id: teen.member_id });
    const teenCapture = await capture(teen, { type_key: therapy.key, title: 'Scanned' });
    expect(teenCapture.statusCode, teenCapture.body).toBe(201);
  });

  it('an expiry on a type whose Expires is off is kept by a capture and by POST /documents alike (5.7 review)', async () => {
    const lease = await kind({
      label: 'Storage unit',
      category: 'property',
      core: { expires: { shown: true } },
      reminder_leads: [14],
    });
    // Switched off after a phone queued a scan with an expiry date.
    await ok(
      call(owner, 'PATCH', `/api/v1/document-types/${lease.key}`, {
        core: { expires: { shown: false } },
      }),
    );
    await runRegenerate();
    const expires = { date: inDays(60), precision: 'day' };
    const captured = await capture(owner, {
      type_key: lease.key,
      title: 'Unit 9',
      owner_member_id: owner.member_id,
      expires,
    });
    expect(captured.statusCode, captured.body).toBe(201);
    const typed = await file(owner, {
      type_key: lease.key,
      title: 'Unit 10',
      owner_member_id: owner.member_id,
      expires,
    });
    const fromCapture = await ok<DocumentView>(
      call(
        owner,
        'GET',
        `/api/v1/documents/${json<{ document_id: string }>(captured).document_id}`,
      ),
    );
    for (const d of [fromCapture, typed]) {
      // The date is kept, and counts for nothing while the kind does not expire.
      expect(d.expires).toEqual(expires);
      expect(d.status.value).toBe('valid');
      expect(await reminders(d.id)).toEqual([]);
    }
    // Switched on again, it counts.
    await ok(
      call(owner, 'PATCH', `/api/v1/document-types/${lease.key}`, {
        core: { expires: { shown: true } },
      }),
    );
    await runRegenerate();
    expect(await reminders(typed.id)).toEqual([{ lead_days: 14, status: 'scheduled' }]);
    expect(
      (await ok<DocumentView>(call(owner, 'GET', `/api/v1/documents/${typed.id}`))).status.value,
    ).toBe('active');
  });

  it("a viewer reads the built-ins and the kinds of the documents they can see, and no other of the household's own (5.7 review)", async () => {
    const seen = await kind({ label: 'Rental agreement', category: 'property' });
    const unused = await kind({ label: 'Adoption papers', category: 'legal' });
    const adultsOnly = await kind({ label: 'Debt letters', category: 'financial' });
    await file(owner, { type_key: seen.key, title: 'Flat', visibility: 'household' });
    await file(owner, { type_key: adultsOnly.key, title: 'Card debt', visibility: 'adults' });
    const field = await ok<DocumentAttributeView>(
      call(owner, 'POST', '/api/v1/document-attributes', { label: 'Case officer', kind: 'text' }),
    );

    for (const all of [false, true]) {
      const keys = (await types(viewer, all)).map((t) => t.key);
      expect(keys).toContain(seen.key);
      expect(keys).not.toContain(unused.key);
      expect(keys).not.toContain(adultsOnly.key);
      expect(keys).toContain('passport');
    }
    // The library the kinds are made from: the vault's own only.
    const library = (
      await ok<{ items: DocumentAttributeView[] }>(
        call(viewer, 'GET', '/api/v1/document-attributes'),
      )
    ).items;
    expect(library.every((a) => a.builtin)).toBe(true);
    expect(library.map((a) => a.key)).not.toContain(field.key);

    // Whoever files documents is offered them all, as the family always was.
    for (const who of [owner, sam, teen]) {
      const keys = (await types(who)).map((t) => t.key);
      expect(keys).toEqual(expect.arrayContaining([seen.key, unused.key, adultsOnly.key]));
      const fields = (
        await ok<{ items: DocumentAttributeView[] }>(
          call(who, 'GET', '/api/v1/document-attributes'),
        )
      ).items;
      expect(fields.map((a) => a.key)).toContain(field.key);
    }
  });

  it('an edit answers with the kind as it now is, not as its transaction first looked it up (5.7 review)', async () => {
    const rail = await kind({ label: 'Railcard', core: { expires: { shown: true } } });
    // The edit looks the kind up (its If-Match, its default) before it
    // writes; what it answers is read after, and is the new one.
    const changed = await ok<DocumentTypeView>(
      call(owner, 'PATCH', `/api/v1/document-types/${rail.key}`, {
        label: 'Railcard (16-25)',
        reminder_leads: [21],
        usually_essential: true,
      }),
    );
    expect(changed).toMatchObject({
      label: 'Railcard (16-25)',
      reminder_leads: [21],
      usually_essential: true,
    });
    expect(changed.etag).toBe((await typeOf(rail.key))?.etag);

    // The memo itself: kept for its transaction, until a write forgets it.
    const me = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [owner.member_id],
    );
    const principal = {
      householdId: owner.household_id,
      accountId: me.rows[0]?.account_id as string,
      memberId: owner.member_id,
      role: 'owner' as Role,
    };
    const seen = await withPrincipal(app, principal, async (trx) => {
      const first = (await typeLookup(trx)(rail.key))?.label;
      await sql`update document_type set label = 'Railcard (renamed)' where key = ${rail.key}`.execute(
        trx,
      );
      const memo = (await typeLookup(trx)(rail.key))?.label;
      forgetTypes(trx);
      const fresh = (await typeLookup(trx)(rail.key))?.label;
      return { first, memo, fresh };
    });
    expect(seen).toEqual({
      first: 'Railcard (16-25)',
      memo: 'Railcard (16-25)',
      fresh: 'Railcard (renamed)',
    });
  });

  it('a field of the household’s own is made for the library, and a kind asks for it', async () => {
    const size = await ok<DocumentAttributeView>(
      call(sam, 'POST', '/api/v1/document-attributes', {
        label: ' Plot  size ',
        kind: 'choice',
        choices: ['Half', 'Full', 'Half', ' '],
      }),
    );
    expect(size).toMatchObject({
      label: 'Plot size',
      kind: 'choice',
      choices: ['Half', 'Full'],
      builtin: false,
    });
    expect(size.key).toMatch(/^h_[a-z2-7]{10}$/);
    for (const bad of [
      { label: 'Colour', kind: 'choice', choices: [] },
      { label: 'Colour', kind: 'text', choices: ['Red'] },
      { label: '   ', kind: 'text' },
      { label: 'Password', kind: 'secret' },
    ]) {
      expect((await call(sam, 'POST', '/api/v1/document-attributes', bad)).statusCode).toBe(422);
    }
    const plot = await kind({ label: 'Allotment', category: 'property' });
    const asking = await ok<DocumentTypeView>(
      call(sam, 'PATCH', `/api/v1/document-types/${plot.key}`, {
        fields: [
          { key: size.key, required: true },
          { key: 'vin', label: 'Frame number' },
        ],
      }),
    );
    expect(asking.fields).toEqual([
      {
        key: size.key,
        label: 'Plot size',
        kind: 'choice',
        required: true,
        choices: ['Half', 'Full'],
      },
      { key: 'vin', label: 'Frame number', kind: 'text', required: false },
    ]);
    // Its details are checked against it, and a missing one is Needs info.
    const doc = await file(owner, {
      type_key: plot.key,
      title: 'Plot 3',
      owner_member_id: owner.member_id,
    });
    expect(doc.status).toEqual({ value: 'needs_info', label: 'Needs a plot size' });
    const wrong = await call(owner, 'PATCH', `/api/v1/documents/${doc.id}`, {
      extra: { [size.key]: 'Quarter' },
    });
    expect(wrong.statusCode).toBe(422);
    expect(error(wrong)).toMatchObject({ code: 'invalid_extra', detail: size.key });
    // A field is required only where it is shown.
    const unseen = await call(sam, 'PATCH', `/api/v1/document-types/${plot.key}`, {
      core: { physical_location: { shown: false, required: true } },
    });
    expect(unseen.statusCode).toBe(422);
    expect(error(unseen)).toMatchObject({ detail: 'physical_location' });
    const unknown = await call(sam, 'PATCH', `/api/v1/document-types/${plot.key}`, {
      fields: [{ key: 'shoe_size' }],
    });
    expect(unknown.statusCode).toBe(422);
    expect((await activity(teen)).map((l) => l.text)).toContain(
      'Sam added “Plot size” to the fields a kind of document can ask for',
    );
  });

  it('Expires switched on by an edit is reminded 30 days before, as a new kind that expires is (5.11 review)', async () => {
    const gym = await kind({ label: 'Gym membership' });
    expect(gym).toMatchObject({ expiry_driver: null, reminder_leads: [] });
    const soon = await file(owner, {
      type_key: gym.key,
      title: 'Gym, this year',
      owner_member_id: owner.member_id,
      expires: { date: inDays(20), precision: 'day' },
    });
    const later = await file(owner, {
      type_key: gym.key,
      title: 'Gym, next year',
      owner_member_id: owner.member_id,
      expires: { date: inDays(90), precision: 'day' },
    });
    const on = await ok<DocumentTypeView>(
      call(owner, 'PATCH', `/api/v1/document-types/${gym.key}`, {
        core: { expires: { shown: true } },
      }),
    );
    expect(on).toMatchObject({ expiry_driver: 'expires_on', reminder_leads: [30] });
    await runRegenerate();
    expect(await reminders(later.id)).toEqual([{ lead_days: 30, status: 'scheduled' }]);
    expect(
      (await ok<DocumentView>(call(owner, 'GET', `/api/v1/documents/${soon.id}`))).status.value,
    ).toBe('expiring_soon');
    // A built-in the same.
    const birth = await ok<DocumentTypeView>(
      call(owner, 'PATCH', '/api/v1/document-types/birth_certificate', {
        core: { expires: { shown: true } },
      }),
    );
    expect(birth).toMatchObject({ expiry_driver: 'expires_on', reminder_leads: [30] });
    await ok(
      call(owner, 'PATCH', '/api/v1/document-types/birth_certificate', {
        core: { expires: { shown: false } },
      }),
    );
    // Lead times sent with it are the ones kept; switched off, it keeps its own.
    const off = await ok<DocumentTypeView>(
      call(owner, 'PATCH', `/api/v1/document-types/${gym.key}`, {
        core: { expires: { shown: false } },
      }),
    );
    expect(off).toMatchObject({ expiry_driver: null, reminder_leads: [30] });
    const sent = await ok<DocumentTypeView>(
      call(owner, 'PATCH', `/api/v1/document-types/${gym.key}`, {
        core: { expires: { shown: true } },
        reminder_leads: [7],
      }),
    );
    expect(sent.reminder_leads).toEqual([7]);
    await runRegenerate();
  });

  it('an expiry is required of every kind that expires, and the kind says so (5.11 review)', async () => {
    const refused = await call(owner, 'POST', '/api/v1/document-types', {
      label: 'Loyalty card',
      category: 'other',
      core: { expires: { shown: true, required: false } },
    });
    expect(refused.statusCode).toBe(422);
    expect(error(refused)).toMatchObject({
      code: 'validation_failed',
      message: EXPIRY_ALWAYS_REQUIRED,
      detail: 'expires',
    });
    const card = await kind({ label: 'Loyalty card', core: { expires: { shown: true } } });
    expect(card.core?.expires).toMatchObject({ shown: true, required: true });
    const doc = await file(owner, {
      type_key: card.key,
      title: 'Coffee card',
      owner_member_id: owner.member_id,
    });
    expect(doc.status).toEqual({ value: 'needs_info', label: 'Needs an expiry date' });
    // A built-in whose rule said otherwise — a visa's — was required all the same, and says so.
    expect((await typeOf('visa'))?.core?.expires).toMatchObject({ shown: true, required: true });
    const visa = await call(owner, 'PATCH', '/api/v1/document-types/visa', {
      core: { expires: { required: false } },
    });
    expect(visa.statusCode).toBe(422);
    expect(error(visa)).toMatchObject({ message: EXPIRY_ALWAYS_REQUIRED, detail: 'expires' });
    // One that does not expire requires none, and cannot be made to.
    const off = await ok<DocumentTypeView>(
      call(owner, 'PATCH', `/api/v1/document-types/${card.key}`, {
        core: { expires: { shown: false } },
      }),
    );
    expect(off.core?.expires).toMatchObject({ shown: false, required: false });
    const odd = await call(owner, 'PATCH', `/api/v1/document-types/${card.key}`, {
      core: { expires: { required: true } },
    });
    expect(odd.statusCode).toBe(422);
    expect(error(odd)).toMatchObject({
      message: 'A field has to be shown to be required.',
      detail: 'expires',
    });
    // Sent with Expires switched on, `required: true` is what it is anyway.
    const both = await ok<DocumentTypeView>(
      call(owner, 'PATCH', `/api/v1/document-types/${card.key}`, {
        core: { expires: { shown: true, required: true } },
      }),
    );
    expect(both.core?.expires).toMatchObject({ shown: true, required: true });
    for (const t of await types(owner, true)) {
      expect(t.core?.expires.required, t.key).toBe(t.expiry_driver !== null);
    }
    await runRegenerate();
  });

  it('a viewer can name a household detail its kind no longer asks for, and no other (5.11 review)', async () => {
    const officer = await ok<DocumentAttributeView>(
      call(owner, 'POST', '/api/v1/document-attributes', { label: 'Case officer', kind: 'text' }),
    );
    const unused = await ok<DocumentAttributeView>(
      call(owner, 'POST', '/api/v1/document-attributes', { label: 'Solicitor', kind: 'text' }),
    );
    const adultsOnly = await ok<DocumentAttributeView>(
      call(owner, 'POST', '/api/v1/document-attributes', { label: 'Debt amount', kind: 'money' }),
    );
    const tenancy = await kind({
      label: 'Tenancy case',
      category: 'legal',
      fields: [{ key: officer.key }, { key: adultsOnly.key }],
    });
    const doc = await file(owner, {
      type_key: tenancy.key,
      title: 'Flat dispute',
      visibility: 'household',
      extra: { [officer.key]: 'Ms Khan' },
    });
    await file(owner, {
      type_key: tenancy.key,
      title: 'Arrears',
      visibility: 'adults',
      extra: { [adultsOnly.key]: 1200 },
    });
    await ok(call(owner, 'PATCH', `/api/v1/document-types/${tenancy.key}`, { fields: [] }));

    // The viewer's document still has the detail; the kind no longer names it.
    const seen = await ok<DocumentView>(call(viewer, 'GET', `/api/v1/documents/${doc.id}`));
    expect(seen.extra).toEqual({ [officer.key]: 'Ms Khan' });
    expect((await types(viewer)).find((t) => t.key === tenancy.key)?.fields).toEqual([]);
    // The library names it — and not a field on no document the viewer can see.
    const library = (
      await ok<{ items: DocumentAttributeView[] }>(
        call(viewer, 'GET', '/api/v1/document-attributes'),
      )
    ).items;
    expect(library.find((a) => a.key === officer.key)).toMatchObject({
      label: 'Case officer',
      kind: 'text',
      builtin: false,
    });
    expect(library.map((a) => a.key)).not.toContain(unused.key);
    expect(library.map((a) => a.key)).not.toContain(adultsOnly.key);
    // An adult, who files documents, is offered them all.
    const bySam = (
      await ok<{ items: DocumentAttributeView[] }>(call(sam, 'GET', '/api/v1/document-attributes'))
    ).items.map((a) => a.key);
    expect(bySam).toEqual(expect.arrayContaining([officer.key, unused.key, adultsOnly.key]));
  });

  it('a scan queued for a kind deleted since is filed with no kind, not refused for good (5.11 review)', async () => {
    const plot = await ok<DocumentAttributeView>(
      call(owner, 'POST', '/api/v1/document-attributes', { label: 'Plot number', kind: 'text' }),
    );
    const allotment = await kind({
      label: 'Allotment',
      category: 'property',
      fields: [{ key: plot.key }],
    });
    expect(
      (await call(owner, 'DELETE', `/api/v1/document-types/${allotment.key}`)).statusCode,
    ).toBe(204);
    // The phone had it on its list, and queued a scan with its details.
    const queued = await capture(owner, {
      type_key: allotment.key,
      title: 'Plot 9 lease',
      owner_member_id: owner.member_id,
      identifier: 'L-9',
      extra: { [plot.key]: '9', no_such_field: 'x' },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const made = await ok<DocumentView>(
      call(owner, 'GET', `/api/v1/documents/${json<{ document_id: string }>(queued).document_id}`),
    );
    // Everything as sent but its kind; its details as the library has them;
    // and, its kind's default gone with it, for as few people as it can be.
    expect(made).toMatchObject({
      type_key: null,
      title: 'Plot 9 lease',
      owner_member_id: owner.member_id,
      identifier: 'L-9',
      extra: { [plot.key]: '9' },
      visibility: 'private',
    });
    // For Aisha, whose it cannot be Only me: Adults only, unless it says.
    const hers = await capture(owner, {
      type_key: allotment.key,
      title: "Aisha's plot",
      owner_member_id: aisha,
    });
    expect(hers.statusCode, hers.body).toBe(201);
    const filed = await ok<DocumentView>(
      call(owner, 'GET', `/api/v1/documents/${json<{ document_id: string }>(hers).document_id}`),
    );
    expect(filed).toMatchObject({ type_key: null, visibility: 'adults' });
    const said = await capture(owner, {
      type_key: allotment.key,
      title: 'Shared plot',
      visibility: 'household',
    });
    expect(said.statusCode).toBe(201);
    // Typed in, a kind that is not on the list is still refused: the person is there to choose.
    const typed = await call(owner, 'POST', '/api/v1/documents', {
      type_key: allotment.key,
      title: 'Plot 10',
    });
    expect(typed.statusCode).toBe(422);
  });
});
