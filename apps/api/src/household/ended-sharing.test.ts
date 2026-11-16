import { randomUUID } from 'node:crypto';
import { appendAudit, createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  type ActivityLine,
  type CollectionDetail,
  type DocumentView,
  type EndedSharing,
} from '@fdv/shared';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import type { CreatedShare } from '../documents/shares.js';
import { createHarness, type Harness } from '../test-harness.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * Ended links and requests removed after a while (0.9.0, RQ; the owner's
 * ask of 16 Nov 2026): how long they are kept is the household's, read by
 * everybody and changed by an owner alone; and once the worker has removed
 * one, the activity log still shows its lines to exactly those it showed
 * them to before — by the tombstone it leaves (0106).
 */
describe.skipIf(!testAdminUrl())('ended links and requests (RQ)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let other: Tokens;
  let teen: Tokens;
  const PASSWORD = 'a long enough password 0123';

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Ada',
      email: 'ada-rq@example.test',
      role: 'adult',
      password: PASSWORD,
    });
    other = await h.join(owner, {
      name: 'Omar',
      email: 'omar-rq@example.test',
      role: 'adult',
      password: PASSWORD,
    });
    teen = await h.join(owner, {
      name: 'Tara',
      email: 'tara-rq@example.test',
      role: 'teen',
      password: PASSWORD,
    });
  });
  afterAll(() => h.close());

  const call = (
    who: Tokens,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) => h.app.inject({ method, url, headers: h.as(who), ...(payload ? { payload } : {}) });
  const setting = async (who: Tokens) => {
    const r = await call(who, 'GET', '/api/v1/household/ended-sharing');
    expect(r.statusCode, r.body).toBe(200);
    return r.json<EndedSharing>();
  };
  const choose = (who: Tokens, days: unknown) =>
    call(who, 'PUT', '/api/v1/household/ended-sharing', { remove_after_days: days });
  const admin = async <T extends object>(q: string, params: unknown[] = []) => {
    const pool = createPool(h.adminUrl, 1);
    try {
      return (await pool.query<T>(q, params)).rows;
    } finally {
      await pool.end();
    }
  };
  /** The activity log's lines, as `who` is shown them. */
  const lines = async (who: Tokens) => {
    const r = await call(who, 'GET', '/api/v1/audit?limit=100');
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{ items: ActivityLine[] }>().items;
  };
  /** The lines `who` is shown of those written about a request or a link, as their words. */
  const about = async (who: Tokens, id: string) => {
    const written = await admin<{ id: string }>(
      `select id from audit_event
        where household_id = $1 and (object_id = $2 or detail->>'share_id' = $2::text)`,
      [owner.household_id, id],
    );
    const ids = written.map((w) => Number(w.id));
    expect(ids.length).toBeGreaterThan(0);
    return (await lines(who)).filter((l) => ids.includes(l.id)).map((l) => l.text);
  };

  it('is 90 days unless an owner chose otherwise; every role reads it, an owner alone changes it', async () => {
    expect(await setting(owner)).toEqual({ remove_after_days: 90, can_change: true });
    expect(await setting(adult)).toEqual({ remove_after_days: 90, can_change: false });

    const refused = await choose(adult, 30);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { message: string } }>().error.message).toBe(
      'Only an owner can change how long ended links and requests are kept.',
    );
    expect((await choose(owner, 45)).statusCode).toBe(422);
    expect((await choose(owner, '90')).statusCode).toBe(422);

    const chosen = await choose(owner, 30);
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json<EndedSharing>()).toEqual({ remove_after_days: 30, can_change: true });
    const never = await choose(owner, null);
    expect(never.json<EndedSharing>().remove_after_days).toBeNull();
    // The same again changes nothing, and writes no line.
    await choose(owner, null);
    const changes = (await lines(adult)).filter((l) =>
      l.text.includes('changed ended links and requests'),
    );
    expect(changes.map((l) => l.text)).toEqual([
      'Owner changed ended links and requests from removed after 30 days to never removed',
      'Owner changed ended links and requests from removed after 90 days to removed after 30 days',
    ]);
    await choose(owner, 90);
  });

  it('the database holds it to owners too', async () => {
    await expect(
      withSystem(h.db, owner.household_id, async (trx) => {
        // As an adult would, past the API.
        await sql`select set_config('app.actor', 'account', true),
                         set_config('app.role', 'adult', true)`.execute(trx);
        await trx
          .updateTable('household')
          .set({ ended_sharing_days: 365 })
          .where('id', '=', owner.household_id)
          .execute();
      }),
    ).rejects.toThrow(/only an owner chooses how long ended links and requests are kept/);
    expect((await setting(owner)).remove_after_days).toBe(90);
  });

  /** As the worker removes a request (jobs/ended-sharing.ts), in one transaction. */
  const removeRequest = (id: string) =>
    admin(
      `with t as (
         insert into upload_request_tombstone
                (id, household_id, requester_member_id, review_by, moved_to_owners_at)
         select id, household_id, requester_member_id, review_by, moved_to_owners_at
           from upload_request where id = $1 returning id)
       delete from upload_request where id in (select id from t)`,
      [id],
    );
  const ask = async (who: Tokens, review_by: 'me' | 'adults') => {
    const r = await call(who, 'POST', '/api/v1/upload-requests', {
      title: 'Your payslips',
      recipient_label: 'Jane, accountant',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      review_by,
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json<{ request: { id: string } }>().request.id;
    expect((await call(who, 'DELETE', `/api/v1/upload-requests/${id}`)).statusCode).toBe(204);
    return id;
  };

  it("a removed request's lines stay, for its reviewers alone, as before", async () => {
    const mine = await ask(adult, 'me');
    const anyAdult = await ask(adult, 'adults');
    const before = {
      adult: await about(adult, mine),
      anyAdult: await about(other, anyAdult),
    };
    expect(before.adult).toHaveLength(2);
    expect(await about(other, mine)).toEqual([]);
    expect(await about(owner, mine)).toEqual([]);
    expect(before.anyAdult).toHaveLength(2);

    await removeRequest(mine);
    await removeRequest(anyAdult);
    expect(
      await admin('select 1 from upload_request where id = any($1::uuid[])', [[mine, anyAdult]]),
    ).toEqual([]);
    // The same lines, to the same people: the request's tombstone says whose.
    expect(await about(adult, mine)).toEqual(before.adult);
    expect(await about(other, mine)).toEqual([]);
    expect(await about(owner, mine)).toEqual([]);
    expect(await about(other, anyAdult)).toEqual(before.anyAdult);
    expect(await about(owner, anyAdult)).toEqual(before.anyAdult);
  });

  it("a removed collection's link keeps its lines for whoever could see everything it gave", async () => {
    await withSystem(h.db, owner.household_id, (trx) =>
      trx.updateTable('session').set({ verified_at: new Date() }).execute(),
    );
    /** A document of the owner's, with a file. */
    const make = async (title: string, visibility: 'household' | 'private') => {
      const created = await call(owner, 'POST', '/api/v1/documents', {
        title,
        type_key: 'utility_bill',
        visibility,
        owner_member_id: owner.member_id,
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json<DocumentView>().id;
      const form = new FormData();
      form.append('file', PDF, { filename: `${title}.pdf`, contentType: 'application/pdf' });
      const up = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${id}/versions`,
        headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
      expect(up.statusCode, up.body).toBeLessThan(300);
      return id;
    };
    const share = async (name: string, docs: string[]) => {
      const c = await call(owner, 'POST', '/api/v1/collections', { name, audience: 'everyone' });
      expect(c.statusCode, c.body).toBe(201);
      const id = c.json<CollectionDetail>().id;
      const put = await call(owner, 'POST', `/api/v1/collections/${id}/items`, {
        document_ids: docs,
      });
      expect(put.statusCode, put.body).toBe(200);
      const s = await call(owner, 'POST', `/api/v1/collections/${id}/shares`, {
        document_ids: docs,
        recipient_label: 'the valuer',
      });
      expect(s.statusCode, s.body).toBe(201);
      const link = s.json<CreatedShare>().share.id;
      // What the other end did through it, as the link writes it
      // (ShareService.recordLine): lines about each document, naming whom
      // the link went to — kept from whoever was not told of the link.
      for (const action of ['share.downloaded', 'share.viewed']) {
        for (const doc of docs) {
          await withSystem(h.db, owner.household_id, (trx) =>
            appendAudit(trx, {
              householdId: owner.household_id,
              actorLabel: 'shared link (the valuer)',
              action,
              objectType: 'document',
              objectId: doc,
              detail: { share_id: link, user_agent: null },
            }),
          );
        }
      }
      expect((await call(owner, 'DELETE', `/api/v1/shares/${link}`)).statusCode).toBe(204);
      return link;
    };
    const everybodys = await share('For the valuer', [await make('Water bill', 'household')]);
    const ownersOnly = await share('For the bank', [await make('Private letter', 'private')]);
    const shown = (who: Tokens, link: string) => about(who, link);
    /** Every reader's lines about both links: exactly these, before and after. */
    const everybody = async () => ({
      owner: await shown(owner, everybodys),
      adult: await shown(adult, everybodys),
      teen: await shown(teen, everybodys),
      ownersOnlyAdult: await shown(adult, ownersOnly),
      ownersOnlyOwner: await shown(owner, ownersOnly),
      ownersOnlyTeen: await shown(teen, ownersOnly),
    });
    const before = await everybody();
    expect(before.owner.length).toBeGreaterThan(0);
    // The downloads and looks through it, naming whom it went to, among them.
    expect(before.owner.filter((l) => l.includes('the valuer')).length).toBeGreaterThanOrEqual(2);
    expect(before.adult).toEqual(before.owner);
    expect(before.ownersOnlyAdult).toEqual([]);
    expect(before.ownersOnlyOwner.length).toBeGreaterThan(0);
    // A teen is told of no collection's link, nor what went through one,
    // though they see the document itself.
    expect(before.teen).toEqual([]);
    expect(before.ownersOnlyTeen).toEqual([]);

    // As the worker removes them: a tombstone, then the link.
    for (const link of [everybodys, ownersOnly]) {
      await admin(
        `with t as (
           insert into share_link_tombstone (id, household_id, created_by, collection_id, document_ids)
           select l.id, l.household_id, l.created_by, l.collection_id,
                  array(select i.document_id from share_link_item i
                         where i.share_id = l.id and i.kind in ('ticked', 'followed'))
             from share_link l where l.id = $1 returning id)
         delete from share_link where id in (select id from t)`,
        [link],
      );
    }
    // The same lines, to exactly the same people: a teen still none (the
    // review of 0106 — the tombstone is read as the link was), the adult
    // still nothing of a link made with a paper they cannot see.
    expect(await everybody()).toEqual(before);
  });
});
