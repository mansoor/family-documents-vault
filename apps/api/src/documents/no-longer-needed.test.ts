import { randomUUID } from 'node:crypto';
import { createPool, withPrincipal, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { ActivityLine, DocumentPage, DocumentView, ReminderView } from '@fdv/shared';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * No longer needed (0.9.0, 0082; the owner's ask of 23 Oct 2026): a
 * document kept — read, found, shared and in its collections as ever —
 * whose expiry says nothing any more: an EAD card made unnecessary by a
 * green card. Marked by whoever may change it, as the API and the database
 * both hold; its reminders resolved and none made while it stays so; out of
 * every attention list; replaced by a document named only to whoever may see
 * that one; and needed again, its reminders back as its date warrants.
 */

const DAY = 24 * 60 * 60 * 1000;
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const json = <T>(r: { json: () => unknown }) => r.json() as T;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe.skipIf(!testAdminUrl())('a document no longer needed (0.9.0)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let sarah: Tokens;
  let tariq: Tokens;
  let vera: Tokens;
  let jane: Tokens;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.82.${Math.floor(++nth / 200)}.${nth % 200}` });

  const get = (who: Tokens, url: string) => h.app.inject({ url, headers: h.as(who) });
  const send = (
    who: Tokens,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(who),
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  const made = async (who: Tokens, payload: Record<string, unknown>) => {
    const r = await send(who, 'POST', '/api/v1/documents', payload);
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r);
  };
  const read = async (who: Tokens, id: string) => {
    const r = await get(who, `/api/v1/documents/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentView>(r);
  };
  const mark = (who: Tokens, id: string, body: Record<string, unknown> = {}) =>
    send(who, 'POST', `/api/v1/documents/${id}/no-longer-needed`, body);
  const neededAgain = (who: Tokens, id: string) =>
    send(who, 'DELETE', `/api/v1/documents/${id}/no-longer-needed`);
  const reminders = async (who: Tokens, state = 'all') => {
    const r = await get(who, `/api/v1/reminders?state=${state}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: ReminderView[] }>(r).items;
  };
  /** Each of a document's reminders as the database holds it, by kind, lead and status. */
  const held = async (id: string) =>
    (
      await admin.query<{ kind: string; lead_days: number | null; status: string }>(
        `select kind, lead_days, status from reminder where document_id = $1
          order by kind, lead_days desc nulls last, status`,
        [id],
      )
    ).rows.map((r) => `${r.kind}:${r.lead_days ?? '-'}:${r.status}`);
  const listed = async (who: Tokens, query: string) => {
    const r = await get(who, `/api/v1/documents?${query}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentPage>(r);
  };
  const activity = async (who: Tokens) => {
    const r = await get(who, '/api/v1/audit?limit=100');
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: ActivityLine[] }>(r).items.map((l) => l.text);
  };
  const accountOf = async (t: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [t.member_id],
      )
    ).rows[0]?.account_id as string;
  /** Somebody signed in, writing to the document as SQL: what the database holds to. */
  const asSql = async (t: Tokens, query: ReturnType<typeof sql>) =>
    withPrincipal(
      h.db,
      {
        householdId: t.household_id,
        accountId: await accountOf(t),
        memberId: t.member_id,
        role: t.role,
      },
      async (trx) => {
        await query.execute(trx);
      },
    );

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    sarah = await h.join(owner, { name: 'Sarah', email: 'sarah-nln@example.test', role: 'adult' });
    tariq = await h.join(owner, { name: 'Tariq', email: 'tariq-nln@example.test', role: 'teen' });
    vera = await h.join(owner, { name: 'Vera', email: 'vera-nln@example.test', role: 'viewer' });
    // Jane, an attorney from outside the family, given Sarah's documents (5.34).
    await h.decider(owner);
    const invited = await send(owner, 'POST', '/api/v1/invitations', {
      display_name: 'Jane Smith',
      relationship: 'attorney',
      email: 'jane-nln@example.test',
      role: 'viewer',
      kind: 'guest',
      restriction: { people: [sarah.member_id] },
      access_expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: 'the guest’s own password' },
      ...peer(),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    jane = json<Tokens>(accepted);
  }, 120_000);
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  it('marked: its reminders resolved and none made; out of the reminders, the attention lists and the counts; kept, read, found and collected', async () => {
    // An EAD card: a visa, reminded 120 and 30 days before it expires. With
    // 60 days left, the first is due and the second waits.
    const ead = await made(owner, {
      type_key: 'visa',
      title: 'Sarah’s EAD card',
      owner_member_id: sarah.member_id,
      identifier: 'EAD-NLN-1',
      expires: { date: inDays(60), precision: 'day' },
    });
    expect(ead.status.value).toBe('expiring_soon');
    expect(ead.no_longer_needed).toBeNull();
    const manual = await send(owner, 'POST', '/api/v1/reminders', {
      document_id: ead.id,
      fire_at: inDays(10),
      note: 'Ask about renewing it',
    });
    expect(manual.statusCode, manual.body).toBe(201);
    expect(await held(ead.id)).toEqual([
      'derived:120:due',
      'derived:30:scheduled',
      'manual:-:scheduled',
    ]);
    const green = await made(owner, {
      type_key: 'visa',
      title: 'Sarah’s green card',
      owner_member_id: sarah.member_id,
      identifier: 'GC-NLN-1',
    });

    const r = await mark(owner, ead.id, {
      reason: '  She has her green card now  ',
      replaced_by: green.id,
    });
    expect(r.statusCode, r.body).toBe(200);
    const marked = json<DocumentView>(r);
    expect(marked.status).toEqual({ value: 'no_longer_needed', label: 'No longer needed' });
    expect(marked.no_longer_needed).toMatchObject({
      by_name: 'Owner',
      reason: 'She has her green card now',
      has_reason: true,
      replaced_by: { id: green.id, title: 'Sarah’s green card' },
    });
    expect(r.headers.etag).toBe(marked.etag);
    // Every one of them resolved, its kind's and the one set by hand.
    expect(await held(ead.id)).toEqual([
      'derived:120:resolved',
      'derived:30:resolved',
      'manual:-:resolved',
    ]);
    for (const state of ['all', 'due', 'upcoming']) {
      expect((await reminders(owner, state)).map((x) => x.document_id)).not.toContain(ead.id);
    }

    // Its expiry moved while marked: still nothing reminds of it.
    const moved = await send(owner, 'PATCH', `/api/v1/documents/${ead.id}`, {
      expires: { date: inDays(20), precision: 'day' },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(json<DocumentView>(moved).status.value).toBe('no_longer_needed');
    expect((await held(ead.id)).filter((x) => !x.endsWith(':resolved'))).toEqual([]);
    // Nothing is set to remind of it, nor snoozed again; Done is answered as it is.
    const another = await send(owner, 'POST', '/api/v1/reminders', {
      document_id: ead.id,
      fire_at: inDays(5),
    });
    expect([another.statusCode, json<{ error: { code: string } }>(another).error.code]).toEqual([
      409,
      'no_longer_needed',
    ]);
    const one = (
      await admin.query<{ id: string }>(
        "select id from reminder where document_id = $1 and kind = 'manual'",
        [ead.id],
      )
    ).rows[0]?.id as string;
    const snoozed = await send(owner, 'POST', `/api/v1/reminders/${one}/snooze`, {
      until: inDays(7),
    });
    expect(snoozed.statusCode, snoozed.body).toBe(409);
    const done = await send(owner, 'POST', `/api/v1/reminders/${one}/acknowledge`, {});
    expect(done.statusCode, done.body).toBe(200);
    expect(json<ReminderView>(done).status).toBe('resolved');

    // Out of what asks for attention: Home's and Needs attention's lists
    // read the status, and the table's counts of the expiring and expired.
    const expiring = await listed(owner, 'sort=expiring&limit=50');
    expect(expiring.items.find((d) => d.id === ead.id)?.status.value).toBe('no_longer_needed');
    expect((await listed(owner, 'status=expiring_soon')).items.map((d) => d.id)).not.toContain(
      ead.id,
    );
    expect((await listed(owner, 'status=no_longer_needed')).items.map((d) => d.id)).toEqual([
      ead.id,
    ]);
    expect((await listed(owner, 'sort=status&status=expiring_soon')).total).toBe(0);
    expect((await listed(owner, 'sort=status&status=no_longer_needed')).total).toBe(1);
    // "All": the table lists it, last of the statuses.
    const all = await listed(owner, 'sort=status');
    expect(all.items.at(-1)?.id).toBe(ead.id);

    // Kept: read, found, and put in a collection, as ever.
    expect((await read(sarah, ead.id)).identifier).toBe('EAD-NLN-1');
    const found = await get(owner, `/api/v1/search?q=${encodeURIComponent('EAD-NLN-1')}`);
    expect(found.statusCode, found.body).toBe(200);
    const hit = json<{ items: Array<{ document_id: string; status: { value: string } }> }>(
      found,
    ).items.find((i) => i.document_id === ead.id);
    expect(hit?.status.value).toBe('no_longer_needed');
    const collection = await send(owner, 'POST', '/api/v1/collections', {
      name: 'Immigration papers',
      audience: 'adults',
    });
    expect(collection.statusCode, collection.body).toBe(201);
    const cid = json<{ id: string }>(collection).id;
    const added = await send(owner, 'POST', `/api/v1/collections/${cid}/items`, {
      document_ids: [ead.id],
    });
    expect(added.statusCode, added.body).toBeLessThan(300);

    // Said in the activity log, and never why nor what replaced it.
    expect(await activity(owner)).toContain('Owner marked “Sarah’s EAD card” no longer needed');
    const rows = await admin.query<{ text: string }>(
      `select coalesce(detail::text, '') as text from audit_event
        where household_id = $1 and object_id = $2`,
      [owner.household_id, ead.id],
    );
    for (const row of rows.rows) {
      expect(row.text).not.toContain('green card');
      expect(row.text).not.toContain(green.id);
    }

    // Needed again: its kind's reminders come back from its date as it is
    // now — 20 days left, so the 30-day one is due, once — and the one set
    // by hand waits again for its day.
    const back = await neededAgain(owner, ead.id);
    expect(back.statusCode, back.body).toBe(200);
    const again = json<DocumentView>(back);
    expect(again.no_longer_needed).toBeNull();
    expect(again.status.value).toBe('expiring_soon');
    expect(await held(ead.id)).toEqual(['derived:30:due', 'manual:-:scheduled']);
    expect((await reminders(owner, 'due')).map((x) => x.document_id)).toContain(ead.id);
    expect(await activity(owner)).toContain('Owner marked “Sarah’s EAD card” needed again');
    // Asked again when needed already: answered as it is, nothing changed.
    const twice = await neededAgain(owner, ead.id);
    expect(twice.statusCode, twice.body).toBe(200);
    expect(await held(ead.id)).toEqual(['derived:30:due', 'manual:-:scheduled']);
  });

  it('needed again: what was done with before it was marked stays done', async () => {
    // A passport with 100 days left: its 180-day reminder is due.
    const passport = await made(owner, {
      type_key: 'passport',
      title: 'Owner’s old passport',
      owner_member_id: owner.member_id,
      identifier: 'P-NLN-1',
      expires: { date: inDays(100), precision: 'day' },
    });
    const due = (await reminders(owner, 'due')).find((x) => x.document_id === passport.id);
    expect(due?.lead_days).toBe(180);
    const ack = await send(owner, 'POST', `/api/v1/reminders/${due?.id}/acknowledge`, {});
    expect(ack.statusCode, ack.body).toBe(200);
    expect(await held(passport.id)).toEqual(['derived:180:acknowledged']);
    expect((await mark(owner, passport.id)).statusCode).toBe(200);
    expect(await held(passport.id)).toEqual(['derived:180:acknowledged']);
    expect((await neededAgain(owner, passport.id)).statusCode).toBe(200);
    // Done with before: still done, and no reminder made over it.
    expect(await held(passport.id)).toEqual(['derived:180:acknowledged']);

    // Its date the same as when it was marked: what the marking resolved is
    // open again as it was — not left resolved because nothing moved.
    const visa = await made(owner, {
      type_key: 'visa',
      title: 'Owner’s visa, the same dates',
      owner_member_id: owner.member_id,
      expires: { date: inDays(60), precision: 'day' },
    });
    expect(await held(visa.id)).toEqual(['derived:120:due', 'derived:30:scheduled']);
    expect((await mark(owner, visa.id)).statusCode).toBe(200);
    expect(await held(visa.id)).toEqual(['derived:120:resolved', 'derived:30:resolved']);
    expect((await neededAgain(owner, visa.id)).statusCode).toBe(200);
    expect(await held(visa.id)).toEqual(['derived:120:due', 'derived:30:scheduled']);
  });

  it('needed again: the same reminders — a snooze kept, what was sent not sent again — and at most one due (the review, L2)', async () => {
    const visa = await made(owner, {
      type_key: 'visa',
      title: 'Owner’s snoozed visa',
      owner_member_id: owner.member_id,
      expires: { date: inDays(60), precision: 'day' },
    });
    const rows = async () =>
      (
        await admin.query<{
          id: string;
          lead_days: number;
          status: string;
          snoozed: string | null;
        }>(
          `select id, lead_days, status, to_char(snoozed_until, 'YYYY-MM-DD') as snoozed
             from reminder where document_id = $1 order by lead_days desc`,
          [visa.id],
        )
      ).rows;
    const [due] = await rows();
    expect(due?.lead_days).toBe(120);
    // Sent in a digest (the worker's ledger), then snoozed for a week.
    await admin.query(
      `insert into reminder_delivery (reminder_id, household_id, fire_date, channel)
       values ($1, $2, current_date, 'email')`,
      [due?.id, owner.household_id],
    );
    const snoozed = await send(owner, 'POST', `/api/v1/reminders/${due?.id}/snooze`, {
      until: inDays(7),
    });
    expect(snoozed.statusCode, snoozed.body).toBe(200);
    const before = await rows();
    expect((await mark(owner, visa.id)).statusCode).toBe(200);
    expect((await neededAgain(owner, visa.id)).statusCode).toBe(200);
    // The same rows, as they were: snoozed still, and its ledger kept.
    expect(await rows()).toEqual(before);
    const ledger = await admin.query('select 1 from reminder_delivery where reminder_id = $1', [
      due?.id,
    ]);
    expect(ledger.rowCount).toBe(1);

    // Both its days gone by while it was marked (its date moved, as by the
    // owning role): open again, one is due — the nearest — and the other is
    // done with, still there with its ledger.
    expect((await mark(owner, visa.id)).statusCode).toBe(200);
    const expires = inDays(20);
    await admin.query('update document set expires_on = $2 where id = $1', [visa.id, expires]);
    await admin.query(
      `update reminder set fire_at = $2::date - lead_days, snoozed_until = null
        where document_id = $1`,
      [visa.id, expires],
    );
    expect((await neededAgain(owner, visa.id)).statusCode).toBe(200);
    const after = await rows();
    expect(after.map((r) => [r.id, r.lead_days, r.status])).toEqual([
      [before[0]?.id, 120, 'resolved'],
      [before[1]?.id, 30, 'due'],
    ]);
  });

  it('marking waits for a digest being sent, which holds its reminders until its ledger is written (the review, L3)', async () => {
    const visa = await made(owner, {
      type_key: 'visa',
      title: 'Visa in a digest',
      owner_member_id: owner.member_id,
      expires: { date: inDays(60), precision: 'day' },
    });
    let marked: Awaited<ReturnType<typeof mark>> | null = null;
    let asked: Promise<unknown> = Promise.resolve();
    // The digest's read, as deliverTo makes it: its reminders held FOR KEY SHARE.
    await withSystem(h.db, owner.household_id, async (trx) => {
      const held = await trx
        .selectFrom('reminder')
        .select('id')
        .where('document_id', '=', visa.id)
        .where('status', '=', 'due')
        .forKeyShare()
        .execute();
      expect(held).toHaveLength(1);
      asked = mark(owner, visa.id).then((r) => (marked = r));
      await new Promise((r) => setTimeout(r, 800));
      // Still waiting for the digest's ledger.
      expect(marked).toBeNull();
    });
    await asked;
    expect((marked as { statusCode: number } | null)?.statusCode).toBe(200);
    expect(await held(visa.id)).toEqual(['derived:120:resolved', 'derived:30:resolved']);
  });

  it('asked again while marked: why and what replaced it change, and when and by whom stay', async () => {
    const card = await made(owner, { type_key: 'visa', title: 'Old visa' });
    const first = json<DocumentView>(await mark(owner, card.id, { reason: 'Expired abroad' }));
    const at = first.no_longer_needed?.at;
    const second = await mark(sarah, card.id, { reason: 'Replaced at the embassy' });
    expect(second.statusCode, second.body).toBe(200);
    expect(json<DocumentView>(second).no_longer_needed).toMatchObject({
      at,
      by_name: 'Owner',
      reason: 'Replaced at the embassy',
      replaced_by: null,
    });
    // One edit line, not a second marking.
    const lines = await activity(owner);
    expect(lines.filter((l) => l === 'Owner marked “Old visa” no longer needed')).toHaveLength(1);
    expect(lines).toContain('Sarah edited “Old visa”');
    // Too long a reason, a replacement that is not there, or itself: refused.
    for (const [body, detail] of [
      [{ reason: 'x'.repeat(201) }, 'reason'],
      [{ replaced_by: card.id }, 'replaced_by'],
      [{ replaced_by: randomUUID() }, 'replaced_by'],
      [{ replaced_by: 'not-an-id' }, 'replaced_by'],
    ] as const) {
      const refused = await mark(owner, card.id, body);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(json<{ error: { detail: string } }>(refused).error.detail).toBe(detail);
    }
    // 200 characters, counted as characters, is not too long.
    const full = await mark(owner, card.id, { reason: 'é'.repeat(200) });
    expect(full.statusCode, full.body).toBe(200);
  });

  it('who: whoever may change it — never a viewer or a guest, a teen only their own — at the API', async () => {
    const household = await made(owner, { type_key: 'visa', title: 'Family visa' });
    const teens = await made(tariq, { type_key: 'visa', title: 'Tariq’s visa' });
    const mine = await made(owner, {
      type_key: 'visa',
      title: 'Owner’s private visa',
      owner_member_id: owner.member_id,
      visibility: 'private',
    });
    const forbidden = (r: { statusCode: number }) => r.statusCode;
    // A viewer, and a guest who is given Sarah's documents: refused.
    const sarahs = await made(owner, {
      type_key: 'visa',
      title: 'Sarah’s visa',
      owner_member_id: sarah.member_id,
    });
    expect(forbidden(await mark(vera, household.id))).toBe(403);
    expect(forbidden(await mark(jane, sarahs.id))).toBe(403);
    expect(forbidden(await neededAgain(vera, household.id))).toBe(403);
    // Told so before the body is read: never "your reason is too long".
    expect(forbidden(await mark(vera, household.id, { reason: 'x'.repeat(3000) }))).toBe(403);
    // A teen: their own, never the family's.
    expect(forbidden(await mark(tariq, household.id))).toBe(403);
    expect(forbidden(await mark(tariq, teens.id))).toBe(200);
    expect(forbidden(await neededAgain(tariq, teens.id))).toBe(200);
    // An adult: the family's, and never somebody else's Only me, which is not there.
    expect(forbidden(await mark(sarah, household.id))).toBe(200);
    expect(forbidden(await mark(sarah, mine.id))).toBe(404);
    expect(forbidden(await neededAgain(sarah, mine.id))).toBe(404);
    expect((await read(owner, mine.id)).no_longer_needed).toBeNull();
    // The guest reads Sarah's marked document, and the fact, as anybody who sees it.
    expect(forbidden(await mark(owner, sarahs.id))).toBe(200);
    expect((await read(jane, sarahs.id)).status.value).toBe('no_longer_needed');
    // Nobody's name to a guest, who is not told what the family does.
    expect((await read(jane, sarahs.id)).no_longer_needed?.by_name).toBeNull();
  });

  it('who: the database holds the same rule, as themselves and now, for whatever writes', async () => {
    const doc = await made(owner, { type_key: 'visa', title: 'Held by the database' });
    const others = await made(owner, {
      type_key: 'visa',
      title: 'Owner’s own',
      owner_member_id: owner.member_id,
    });
    const set = (by: string, at = 'now()', id = doc.id) =>
      sql`update document set no_longer_needed_at = ${sql.raw(at)},
                              no_longer_needed_by = ${by}::uuid
           where id = ${id}::uuid`;
    const refused = /only whoever may change a document|by whoever marks it/;
    // A viewer, and a teen on somebody else's.
    await expect(asSql(vera, set(await accountOf(vera)))).rejects.toThrow(refused);
    await expect(asSql(tariq, set(await accountOf(tariq), 'now()', others.id))).rejects.toThrow(
      refused,
    );
    // In another's name, or at another time.
    await expect(asSql(sarah, set(await accountOf(owner)))).rejects.toThrow(refused);
    await expect(
      asSql(sarah, set(await accountOf(sarah), "now() - interval '1 day'")),
    ).rejects.toThrow(refused);
    // As themselves, now: kept.
    await asSql(sarah, set(await accountOf(sarah)));
    // Needed again by a viewer: refused.
    await expect(
      asSql(
        vera,
        sql`update document set no_longer_needed_at = null, no_longer_needed_by = null
             where id = ${doc.id}::uuid`,
      ),
    ).rejects.toThrow(refused);
    // Never filed as no longer needed.
    await expect(
      asSql(
        owner,
        sql`insert into document (household_id, title, no_longer_needed_at, no_longer_needed_by)
            values (${owner.household_id}::uuid, 'Born unneeded', now(), ${await accountOf(owner)}::uuid)`,
      ),
    ).rejects.toThrow(/once it is in the vault/);
    // And nothing reminds of it, whoever writes the reminder.
    await expect(
      admin.query(
        `insert into reminder (household_id, document_id, kind, fire_at, status)
         values ($1, $2, 'manual', current_date + 3, 'scheduled')`,
        [owner.household_id, doc.id],
      ),
    ).rejects.toThrow(/reminded of nothing/);
    // Somebody signed in learns nothing of a document they cannot see:
    // marked or not, the same refusal (the review, I4).
    const privateOf = async (title: string) =>
      made(owner, { title, owner_member_id: owner.member_id, visibility: 'private' });
    const plain = await privateOf('Owner’s private, needed');
    const unneeded = await privateOf('Owner’s private, no longer needed');
    expect((await mark(owner, unneeded.id)).statusCode).toBe(200);
    const said: string[] = [];
    for (const d of [plain, unneeded]) {
      await asSql(
        sarah,
        sql`insert into reminder (household_id, document_id, kind, fire_at, status)
            values (${owner.household_id}::uuid, ${d.id}::uuid, 'manual', current_date + 3, 'scheduled')`,
      ).then(
        () => said.push('made'),
        (e: unknown) => said.push((e as Error).message),
      );
    }
    expect(said).toEqual([
      'a reminder is only for a document its writer can see',
      'a reminder is only for a document its writer can see',
    ]);
  });

  it('replaced by: never names, nor gives the id of, a document the reader may not see — in a view, a list, a search or a line of activity', async () => {
    // Sarah's own Only me green card, and her EAD card the family sees.
    const secret = await made(sarah, {
      type_key: 'visa',
      title: 'Sarah’s secret green card',
      owner_member_id: sarah.member_id,
      visibility: 'private',
    });
    const ead = await made(sarah, {
      type_key: 'visa',
      title: 'Sarah’s first EAD card',
      owner_member_id: sarah.member_id,
      identifier: 'EAD-PRIV-9',
    });
    // Nobody but Sarah may name it as a replacement: to them it is not there.
    const notThere = await mark(owner, ead.id, { replaced_by: secret.id });
    expect(notThere.statusCode, notThere.body).toBe(422);
    expect(json<{ error: { message: string } }>(notThere).error.message).toBe(
      'That document is not in the vault.',
    );
    await expect(
      asSql(
        owner,
        sql`update document set no_longer_needed_at = now(),
                                no_longer_needed_by = ${await accountOf(owner)}::uuid,
                                replaced_by = ${secret.id}::uuid
             where id = ${ead.id}::uuid`,
      ),
    ).rejects.toThrow(/replaced by one its marker can see/);
    // Sarah may.
    const marked = await mark(sarah, ead.id, { replaced_by: secret.id });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(json<DocumentView>(marked).no_longer_needed?.replaced_by).toEqual({
      id: secret.id,
      title: 'Sarah’s secret green card',
    });

    // Anybody else who sees the EAD card: "another document", never its
    // title or its id — on its page, in every list, in a search.
    for (const who of [owner, tariq, vera]) {
      const page = await get(who, `/api/v1/documents/${ead.id}`);
      expect(page.statusCode, page.body).toBe(200);
      expect(json<DocumentView>(page).no_longer_needed?.replaced_by).toEqual({
        id: null,
        title: null,
      });
      for (const query of ['', 'sort=title', 'sort=status', 'status=no_longer_needed']) {
        const list = await get(who, `/api/v1/documents?${query}`);
        expect(list.statusCode, list.body).toBe(200);
        expect(list.body).not.toContain(secret.id);
        expect(list.body).not.toContain('secret green card');
      }
      expect(page.body).not.toContain(secret.id);
      expect(page.body).not.toContain('secret green card');
      const found = await get(who, `/api/v1/search?q=${encodeURIComponent('EAD-PRIV-9')}`);
      expect(found.body).not.toContain(secret.id);
      const log = await get(who, '/api/v1/audit?limit=100');
      expect(log.body).not.toContain(secret.id);
      expect(log.body).not.toContain('secret green card');
    }
    // Nor in the log itself, as the database keeps it.
    const rows = await admin.query<{ text: string }>(
      `select coalesce(detail::text, '') as text from audit_event where household_id = $1`,
      [owner.household_id],
    );
    expect(rows.rows.some((r) => r.text.includes(secret.id))).toBe(false);
    // In the Trash, it is not seen by Sarah either, as a replacement.
    expect((await send(sarah, 'DELETE', `/api/v1/documents/${secret.id}`)).statusCode).toBe(204);
    expect((await read(sarah, ead.id)).no_longer_needed?.replaced_by).toEqual({
      id: null,
      title: null,
    });
  });

  it('asked again by somebody who cannot see what replaced it, or with a field left out, keeps what they did not touch; only null takes it away (the review, M1)', async () => {
    const hidden = await made(sarah, {
      type_key: 'visa',
      title: 'Sarah’s hidden residence card',
      owner_member_id: sarah.member_id,
      visibility: 'private',
    });
    const card = await made(sarah, {
      type_key: 'visa',
      title: 'Sarah’s old work permit',
      owner_member_id: sarah.member_id,
    });
    const first = await mark(sarah, card.id, { reason: 'Sarah’s words', replaced_by: hidden.id });
    expect(first.statusCode, first.body).toBe(200);
    // The owner, who sees "another document", changes only why.
    const owners = await mark(owner, card.id, { reason: 'The owner’s words' });
    expect(owners.statusCode, owners.body).toBe(200);
    expect(json<DocumentView>(owners).no_longer_needed?.replaced_by).toEqual({
      id: null,
      title: null,
    });
    expect((await read(sarah, card.id)).no_longer_needed).toMatchObject({
      reason: 'The owner’s words',
      replaced_by: { id: hidden.id, title: 'Sarah’s hidden residence card' },
    });
    // A page from before, sending nothing of either: both kept.
    expect((await mark(owner, card.id, {})).statusCode).toBe(200);
    expect((await read(sarah, card.id)).no_longer_needed).toMatchObject({
      reason: 'The owner’s words',
      replaced_by: { id: hidden.id },
    });
    // Null, said: taken away.
    expect((await mark(owner, card.id, { reason: null, replaced_by: null })).statusCode).toBe(200);
    expect((await read(sarah, card.id)).no_longer_needed).toMatchObject({
      reason: null,
      has_reason: false,
      replaced_by: null,
    });
  });

  it('an Only me document’s reason is sealed where its notes are, and moves with them', async () => {
    const own = await made(sarah, {
      type_key: 'visa',
      title: 'Sarah’s private EAD',
      owner_member_id: sarah.member_id,
      visibility: 'private',
    });
    const r = await mark(sarah, own.id, { reason: 'Kept for the lawyer' });
    expect(r.statusCode, r.body).toBe(200);
    expect(json<DocumentView>(r).no_longer_needed?.reason).toBe('Kept for the lawyer');
    // Asked again with nothing: the sealed reason is kept, never wiped (M1).
    const again = await mark(sarah, own.id, {});
    expect(json<DocumentView>(again).no_longer_needed?.reason).toBe('Kept for the lawyer');
    const stored = async () =>
      (
        await admin.query<{ plain: string | null; sealed: Buffer | null }>(
          `select no_longer_needed_reason as plain, no_longer_needed_reason_sealed as sealed
             from document where id = $1`,
          [own.id],
        )
      ).rows[0];
    const kept = await stored();
    expect(kept?.plain).toBeNull();
    expect(kept?.sealed?.toString('utf8') ?? '').not.toContain('lawyer');
    // Its owner's own look opens it; a list does not.
    expect((await read(sarah, own.id)).no_longer_needed?.reason).toBe('Kept for the lawyer');
    const inList = (await listed(sarah, 'status=no_longer_needed')).items.find(
      (d) => d.id === own.id,
    );
    expect(inList?.no_longer_needed).toMatchObject({ reason: null, has_reason: true });
    // Made visible to the family: plain, as its notes are; Only me again: sealed.
    const shown = await send(sarah, 'POST', `/api/v1/documents/${own.id}/visibility`, {
      visibility: 'household',
    });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(await stored()).toMatchObject({ plain: 'Kept for the lawyer', sealed: null });
    expect((await read(owner, own.id)).no_longer_needed?.reason).toBe('Kept for the lawyer');
    const hidden = await send(sarah, 'POST', `/api/v1/documents/${own.id}/visibility`, {
      visibility: 'private',
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect((await stored())?.plain).toBeNull();
    expect((await read(sarah, own.id)).no_longer_needed?.reason).toBe('Kept for the lawyer');
    // Never plain on an Only me document, whoever writes it.
    await expect(
      admin.query("update document set no_longer_needed_reason = 'plain' where id = $1", [own.id]),
    ).rejects.toThrow(/document_no_longer_needed_reason_sealed/);
  });

  it('a new version of one no longer needed leaves it so, and reminds of nothing', async () => {
    const ead = await made(owner, {
      type_key: 'visa',
      title: 'EAD with a new scan',
      identifier: 'EAD-V-1',
      expires: { date: inDays(60), precision: 'day' },
    });
    expect((await mark(owner, ead.id)).statusCode).toBe(200);
    const form = new FormData();
    form.append('file', PDF, { filename: 'ead-again.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${ead.id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    const after = await read(owner, ead.id);
    expect(after.versions).toBe(1);
    expect(after.status.value).toBe('no_longer_needed');
    expect((await held(ead.id)).filter((x) => !x.endsWith(':resolved'))).toEqual([]);
  });

  it('a reminder left open on one marked (as a restore leaves it) is in no list of reminders', async () => {
    const left = await made(owner, { type_key: 'visa', title: 'Restored EAD card' });
    const r = await send(owner, 'POST', '/api/v1/reminders', {
      document_id: left.id,
      fire_at: inDays(-1),
    });
    expect(r.statusCode, r.body).toBe(201);
    expect((await reminders(owner, 'due')).map((x) => x.document_id)).toContain(left.id);
    // Marked by the owning role: its reminder still open, as no API leaves one.
    await admin.query('update document set no_longer_needed_at = now() where id = $1', [left.id]);
    expect(await held(left.id)).toEqual(['manual:-:due']);
    for (const state of ['all', 'due', 'upcoming']) {
      expect((await reminders(owner, state)).map((x) => x.document_id)).not.toContain(left.id);
    }
  });

  it('the capability is said', async () => {
    const caps = await h.app.inject({ url: '/api/v1/capabilities' });
    expect(json<{ features: Record<string, unknown> }>(caps).features.no_longer_needed).toBe(true);
  });
});
