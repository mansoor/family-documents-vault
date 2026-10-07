import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendAudit, createPool, verifyAuditChain, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  PREVIEW_MAX_PAGES,
  type ActivityLine,
  type DocumentView,
  type OfflineSet,
  type VersionView,
} from '@fdv/shared';
import { LocalAdapter, StorageError } from '@fdv/storage';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { CreatedShare, ShareView } from './shares.js';

type Pool = ReturnType<typeof createPool>;
/** A connection of a pool's own, as its connect() gives one. */
const connectTo = (pool: Pool) => pool.connect();
type Client = Awaited<ReturnType<typeof connectTo>>;

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

type Who = 'owner' | 'second' | 'adult' | 'teen' | 'viewer';

/**
 * Removing a document for good (5.24, D1).
 *
 * Nothing empties the Trash by itself. An owner removes a document in it:
 * at once one they filed or that is theirs, anybody else's only once its
 * filer has been told and has had a day to bring it back. What it owned
 * goes from storage first, then its rows, then a line in the log with no
 * title; and the log keeps showing its lines to whoever could see it, by
 * its tombstone, and to nobody else.
 */
describe.skipIf(!testAdminUrl())('removing a document for good (5.24)', () => {
  let h: Harness;
  const t = {} as Record<Who, Tokens>;
  const accounts = {} as Record<Who, string>;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const code = (r: LightMyRequestResponse) =>
    json<{ error?: { code: string } }>(r).error?.code ?? `${r.statusCode}`;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.24.${Math.floor(++nth / 200)}.${nth % 200}` });

  const call = (
    who: Who,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => h.app.inject({ method, url, headers: h.as(t[who]), ...(payload ? { payload } : {}) });

  /** A file, as a new version of a document. */
  const upload = async (who: Who, id: string, name = 'scan') => {
    const form = new FormData();
    form.append('file', PDF, { filename: `${name}.pdf`, contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(t[who]), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBeLessThan(300);
    return json<VersionView>(up);
  };

  /** A document filed by `who`, theirs, with a file unless told otherwise. */
  const make = async (
    who: Who,
    title: string,
    opts: {
      visibility?: 'household' | 'adults' | 'private';
      file?: boolean;
      essential?: boolean;
    } = {},
  ) => {
    const created = await call(who, 'POST', '/api/v1/documents', {
      title,
      type_key: 'utility_bill',
      visibility: opts.visibility ?? 'household',
      owner_member_id: t[who].member_id,
      ...(opts.essential ? { is_essential: true } : {}),
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = json<DocumentView>(created).id;
    if (opts.file !== false) await upload(who, id, title);
    return id;
  };
  const trash = async (who: Who, id: string) => {
    const r = await call(who, 'DELETE', `/api/v1/documents/${id}`);
    expect(r.statusCode, r.body).toBe(204);
  };
  const purge = (who: Who, id: string) => call(who, 'POST', `/api/v1/documents/${id}/purge`);
  const restore = (who: Who, id: string) => call(who, 'POST', `/api/v1/documents/${id}/restore`);

  /** Whether `who` confirmed it's them in the last five minutes. */
  const fresh = (who: Who, yes: boolean) =>
    withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (yes ? 0 : 10 * 60_000)) })
        .where('account_id', '=', accounts[who])
        .execute(),
    );
  /** As if the request had been made `hours` ago: the clock moved on. */
  const askedAgo = (id: string, hours: number) =>
    withAdmin((c) =>
      c.query(
        `update document set purge_requested_at = now() - make_interval(hours => $2)
          where id = $1 and purge_requested_at is not null`,
        [id, hours],
      ),
    );

  const trashOf = async (who: Who, query = '') => {
    const r = await call(who, 'GET', `/api/v1/documents?deleted=true${query}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: DocumentView[] }>(r).items;
  };
  const activity = async (who: Who) =>
    json<{ items: ActivityLine[] }>(await call(who, 'GET', '/api/v1/audit?limit=100')).items.map(
      (l) => ({ id: l.id, text: l.text }),
    );
  const alertsTo = (account: string) =>
    h.jobs
      .filter((j) => j.name === 'alert.send')
      .map((j) => j.data as { account_ids: string[]; subject: string; body: string })
      .filter((a) => a.account_ids.includes(account));

  const withAdmin = async <T>(fn: (c: Pool) => Promise<T>) => {
    const admin = createPool(h.adminUrl, 1);
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  };
  /** How many rows of each table still name the document. */
  const leftOf = (id: string) =>
    withAdmin(async (c) => {
      const tables = [
        'document',
        'document_version',
        'document_text',
        'document_text_sealed',
        'reminder',
        'private_notice',
        'upload_idempotency',
        'share_link',
        'share_link_item',
        'share_page',
        'share_page_failure',
        'share_session_use',
        'doc_collection_item',
      ];
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const column = table === 'document' ? 'id' : 'document_id';
        const r = await c.query<{ n: number }>(
          `select count(*)::int as n from ${table} where ${column} = $1`,
          [id],
        );
        counts[table] = r.rows[0]?.n ?? -1;
      }
      const links = await c.query<{ n: number }>(
        'select count(*)::int as n from document_link where a = $1 or b = $1',
        [id],
      );
      counts.document_link = links.rows[0]?.n ?? -1;
      return counts;
    });
  /** Every file under a folder of the vault, recursively; none if it is not there. */
  const filesUnder = async (dir: string): Promise<string[]> => {
    const all = await readdir(path.join(h.vaultDir, dir), { recursive: true }).catch(
      () => [] as string[],
    );
    const files: string[] = [];
    for (const f of all) {
      const full = path.join(h.vaultDir, dir, f);
      const isDir = await readdir(full).then(
        () => true,
        () => false,
      );
      if (!isDir) files.push(f.split(path.sep).join('/'));
    }
    return files.sort();
  };
  /** A file where the worker would put one, whatever it holds. */
  const putFile = async (key: string) => {
    const full = path.join(h.vaultDir, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, 'ciphertext as the worker writes it');
  };
  const versionsOf = (id: string) =>
    withAdmin(
      async (c) =>
        (
          await c.query<{ id: string; storage_key: string }>(
            'select id, storage_key from document_version where document_id = $1 order by version_no',
            [id],
          )
        ).rows,
    );

  beforeAll(async () => {
    // Many calls from one address: more than 300 a minute on a fast runner.
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    t.owner = await h.setup();
    t.second = await h.join(t.owner, { name: 'Sam', email: 'sam@example.test', role: 'owner' });
    t.adult = await h.join(t.owner, { name: 'Alex', email: 'alex@example.test', role: 'adult' });
    t.teen = await h.join(t.owner, { name: 'Tia', email: 'tia@example.test', role: 'teen' });
    t.viewer = await h.join(t.owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    for (const who of ['owner', 'second', 'adult', 'teen', 'viewer'] as const) {
      accounts[who] = json<{ account_id: string }>(
        await h.app.inject({ url: '/api/v1/me', headers: h.as(t[who]) }),
      ).account_id;
    }
  }, 180_000);
  afterAll(() => h.close());

  it('removed: gone from the database and from storage, thumbnail and previews included', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Mistaken upload');
    await upload('owner', id, 'second copy');
    const versions = await versionsOf(id);
    expect(versions).toHaveLength(2);
    // What the worker makes of each version: a thumbnail and its pages.
    for (const v of versions) {
      await putFile(`${v.storage_key}.thumb.enc`);
      await putFile(`${v.storage_key}.p1.enc`);
      await putFile(`${v.storage_key}.p2.enc`);
    }
    const newest = versions[1] as { id: string; storage_key: string };
    await withAdmin((c) =>
      c.query(
        `update document_version
            set thumbnail_key = storage_key || '.thumb.enc', preview_state = 'ready', preview_pages = 2
          where document_id = $1`,
        [id],
      ),
    );
    // A link to view, and the pages it drew of the newest version.
    const viewed = await call('owner', 'POST', `/api/v1/documents/${id}/share`, {
      permission: 'view',
      recipient_label: 'the letting agent',
    });
    expect(viewed.statusCode, viewed.body).toBe(201);
    const link = json<CreatedShare>(viewed).share.id;
    for (const n of [1, 2]) {
      const key = `${newest.storage_key}.share-${link}.p${n}.enc`;
      await putFile(key);
      await withAdmin((c) =>
        c.query(
          `insert into share_page (household_id, share_id, document_id, version_id, n, storage_key)
           values ($1, $2, $3, $4, $5, $6)`,
          [t.owner.household_id, link, id, newest.id, n, key],
        ),
      );
    }
    // A page of the older version a drawing for the link left behind as it
    // died, which no row names.
    await putFile(`${versions[0]?.storage_key}.share-${link}.p3.enc`);
    // In a collection, and a reminder of its own.
    const collection = await call('owner', 'POST', '/api/v1/collections', {
      name: 'To sort',
      audience: 'everyone',
    });
    const collectionId = json<{ id: string }>(collection).id;
    expect(
      (
        await call('owner', 'POST', `/api/v1/collections/${collectionId}/items`, {
          document_ids: [id],
        })
      ).statusCode,
    ).toBe(200);
    const reminded = await call('owner', 'POST', '/api/v1/reminders', {
      document_id: id,
      fire_at: '2030-01-01',
      note: 'Check it',
    });
    expect(reminded.statusCode, reminded.body).toBe(201);

    const folder = `${t.owner.household_id}/${id}`;
    expect((await filesUnder(folder)).length).toBeGreaterThanOrEqual(2 * 4 + 3);
    await trash('owner', id);
    const removed = await purge('owner', id);
    expect(removed.statusCode, removed.body).toBe(204);

    // Nothing in storage: the files, thumbnails, previews and the link's
    // pages, the one no row named included; and nothing left to delete.
    expect(await filesUnder(folder)).toEqual([]);
    expect(
      await withAdmin(
        async (c) =>
          (await c.query('select 1 from purge_leftover where removed_document = $1', [id]))
            .rowCount,
      ),
    ).toBe(0);
    // Nothing in the database names it.
    const left = await leftOf(id);
    expect(Object.entries(left).filter(([, n]) => n !== 0)).toEqual([]);
    // But who could see it, kept for the activity log.
    const tombstone = await withAdmin(
      async (c) =>
        (
          await c.query<Record<string, unknown>>(
            'select visibility, owner_member_id, link_ids, household_id from document_tombstone where id = $1',
            [id],
          )
        ).rows,
    );
    expect(tombstone).toEqual([
      {
        visibility: 'household',
        owner_member_id: t.owner.member_id,
        link_ids: [],
        household_id: t.owner.household_id,
      },
    ]);
    // Its line carries no title: removed, nameless.
    const line = await withAdmin(
      async (c) =>
        (
          await c.query<{ detail: Record<string, unknown>; object_id: string }>(
            `select detail, object_id from audit_event where action = 'document.purged'
            and object_id = $1`,
            [id],
          )
        ).rows,
    );
    expect(line).toHaveLength(1);
    expect(JSON.stringify(line[0]?.detail)).not.toContain('Mistaken');
    expect((await activity('owner'))[0]?.text).toBe('Owner removed a document for good');

    // It is not there for anything any more.
    expect((await call('owner', 'GET', `/api/v1/documents/${id}`)).statusCode).toBe(404);
    expect(code(await restore('owner', id))).toBe('not_found');
    expect(code(await purge('owner', id))).toBe('not_found');
    // The collection it was in carries on without it.
    const after = await call('owner', 'GET', `/api/v1/collections/${collectionId}`);
    expect(json<{ item_count: number }>(after).item_count).toBe(0);
  });

  it('after an Only me document is removed, another adult and a teen see no new lines, and no old line gains words', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Divorce papers', { visibility: 'private' });
    const shared = await call('owner', 'POST', `/api/v1/documents/${id}/share`, {
      recipient_label: 'the divorce lawyer',
    });
    expect(shared.statusCode, shared.body).toBe(201);
    await trash('owner', id);
    const before = { adult: await activity('adult'), teen: await activity('teen') };
    expect(JSON.stringify(before)).not.toContain('divorce');

    expect((await purge('owner', id)).statusCode).toBe(204);
    // Exactly the lines they had: none new, none changed, none of it.
    expect(await activity('adult')).toEqual(before.adult);
    expect(await activity('teen')).toEqual(before.teen);
    // And no other owner either: it was only the one owner's to see.
    expect(JSON.stringify(await activity('second'))).not.toContain('divorce');
  });

  it('whoever could see a removed document still sees its lines and its removal, as its tombstone says; without it nobody would', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Old lease', { visibility: 'private' });
    expect(
      (
        await call('owner', 'POST', `/api/v1/documents/${id}/share`, {
          recipient_label: 'the old landlord',
        })
      ).statusCode,
    ).toBe(201);
    await trash('owner', id);
    expect((await purge('owner', id)).statusCode).toBe(204);
    // Its lines in the log, by their ids: created, its file, its link, the
    // Trash, and its removal.
    const lines = await withAdmin(async (c) =>
      (
        await c.query<{ id: string; action: string }>(
          'select id, action from audit_event where object_id = $1 order by id desc',
          [id],
        )
      ).rows.map((r) => ({ id: Number(r.id), action: r.action })),
    );
    expect(lines.map((l) => l.action)).toEqual([
      'document.purged',
      'document.deleted',
      'share.created',
      'document.version_added',
      'document.created',
    ]);
    const shownTo = async (who: Who) => {
      const shown = new Map((await activity(who)).map((l) => [l.id, l.text]));
      return lines.map((l) => shown.get(l.id) ?? null);
    };
    // Its owner is shown each, with no title to name it by.
    expect(await shownTo('owner')).toEqual([
      'Owner removed a document for good',
      'Owner moved a document to the Trash',
      'Owner made a link to a document for the old landlord',
      'Owner uploaded a new copy of a document',
      'Owner added a document',
    ]);
    // Nobody else, an owner included.
    expect(await shownTo('second')).toEqual([null, null, null, null, null]);
    // Without the tombstone the rule has nothing to see it through: nobody
    // is shown them, not even its owner — it fails closed. (Taken away here
    // as the database's owner; the vault itself may not, 0045.)
    await withAdmin((c) => c.query('delete from document_tombstone where id = $1', [id]));
    expect(await shownTo('owner')).toEqual([null, null, null, null, null]);
  });

  it('a line about a document with neither a row nor a tombstone is shown to nobody', async () => {
    const nothing = randomUUID();
    await withSystem(h.db, t.owner.household_id, (trx) =>
      appendAudit(trx, {
        householdId: t.owner.household_id,
        actorAccountId: accounts.owner,
        action: 'document.created',
        objectType: 'document',
        objectId: nothing,
        detail: { title: 'Never was' },
      }),
    );
    const [line] = await withAdmin(async (c) =>
      (
        await c.query<{ id: string }>('select id from audit_event where object_id = $1', [nothing])
      ).rows.map((r) => Number(r.id)),
    );
    expect(line).toBeGreaterThan(0);
    for (const who of ['owner', 'second', 'adult', 'teen'] as const) {
      expect(
        (await activity(who)).map((l) => l.id),
        who,
      ).not.toContain(line);
    }
  });

  it("an owner's request to remove another adult's document tells its creator at once, and removing it before 24 hours is refused", async () => {
    await fresh('owner', true);
    const id = await make('adult', 'Alex payslip');
    await trash('adult', id);
    const alertsBefore = h.jobs.length;
    const asked = await purge('owner', id);
    expect(asked.statusCode, asked.body).toBe(202);
    const doc = json<DocumentView>(asked);
    expect(doc.id).toBe(id);
    expect(doc.purge_requested_at).not.toBeNull();
    expect(
      Date.parse(doc.purge_allowed_from ?? '') - Date.parse(doc.purge_requested_at ?? ''),
    ).toBe(24 * 3_600_000);
    // Its creator, told at once — by the alerts the vault sends now, which
    // name nothing of the document — and the other owner.
    const told = h.jobs.slice(alertsBefore).filter((j) => j.name === 'alert.send');
    const toCreator = told
      .map((j) => j.data as { account_ids: string[]; subject: string; body: string })
      .find((a) => a.account_ids.includes(accounts.adult));
    expect(toCreator?.subject).toBe('An owner asked to remove one of your documents for good');
    expect(toCreator?.body).toMatch(/Bring it back to keep it/);
    expect(toCreator?.body).not.toContain('payslip');
    expect(alertsTo(accounts.second).length).toBeGreaterThan(0);
    expect(told.some((j) => (j.data.account_ids as string[]).includes(accounts.owner))).toBe(false);
    // And in the vault: its creator's Trash says so, and their notice list has it.
    const theirs = (await trashOf('adult')).find((d) => d.id === id);
    expect(theirs).toMatchObject({
      filed_by_me: true,
      purge_requested_at: doc.purge_requested_at,
      purge_allowed_from: doc.purge_allowed_from,
    });
    expect((await trashOf('adult', '&purge_requested=true')).map((d) => d.id)).toEqual([id]);
    expect((await trashOf('adult', '&purge_requested=false')).map((d) => d.id)).not.toContain(id);
    expect((await activity('adult'))[0]?.text).toBe(
      'Owner asked to remove “Alex payslip” for good',
    );

    // Removing it before the day is out: refused, saying from when, and
    // nothing is asked first.
    await fresh('owner', false);
    const early = await purge('owner', id);
    expect(early.statusCode, early.body).toBe(409);
    expect(code(early)).toBe('purge_not_yet');
    expect(json<{ error: { detail: string } }>(early).error.detail).toBe(doc.purge_allowed_from);
    await fresh('owner', true);
    expect(code(await purge('owner', id))).toBe('purge_not_yet');
    expect(code(await purge('second', id))).toBe('purge_not_yet');
    // An hour short of the day: still refused.
    await askedAgo(id, 23);
    expect(code(await purge('owner', id))).toBe('purge_not_yet');
    // The day over: any owner removes it.
    await askedAgo(id, 24);
    await fresh('second', true);
    const removed = await purge('second', id);
    expect(removed.statusCode, removed.body).toBe(204);
    expect(Object.values(await leftOf(id)).every((n) => n === 0)).toBe(true);
  });

  it('a document trashed before the upgrade cannot be removed by another owner until 24 hours after the creator is told', async () => {
    await fresh('owner', true);
    const id = await make('adult', 'Long in the Trash');
    // In the Trash for two months, as the upgrade finds it: nobody asked.
    await withAdmin((c) =>
      c.query(`update document set deleted_at = now() - interval '60 days' where id = $1`, [id]),
    );
    const asked = await purge('owner', id);
    expect(asked.statusCode, asked.body).toBe(202);
    // The day counts from the asking, not from the Trash.
    const at = Date.parse(json<DocumentView>(asked).purge_requested_at ?? '');
    expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
    expect(code(await purge('owner', id))).toBe('purge_not_yet');
    await askedAgo(id, 25);
    expect((await purge('owner', id)).statusCode).toBe(204);
  });

  it('Bring it back cancels a request to remove', async () => {
    await fresh('owner', true);
    const id = await make('adult', 'Alex car insurance');
    await trash('adult', id);
    expect((await purge('owner', id)).statusCode).toBe(202);
    await askedAgo(id, 30);
    // Its creator brings it back: the request goes with it.
    const back = await restore('adult', id);
    expect(back.statusCode, back.body).toBe(200);
    expect(json<DocumentView>(back)).toMatchObject({
      deleted_at: null,
      purge_requested_at: null,
      purge_allowed_from: null,
    });
    expect((await activity('owner'))[0]?.text).toBe(
      'Alex took “Alex car insurance” out of the Trash, so it will not be removed for good',
    );
    // In the Trash again, an owner asks again, and waits again: the old
    // request, a day and more old, counts for nothing.
    await trash('adult', id);
    expect((await trashOf('owner')).find((d) => d.id === id)?.purge_requested_at).toBeNull();
    const again = await purge('owner', id);
    expect(again.statusCode, again.body).toBe(202);
    expect(code(await purge('owner', id))).toBe('purge_not_yet');
    // The database holds it to that too: a request only in the Trash.
    await expect(
      withAdmin((c) => c.query('update document set deleted_at = null where id = $1', [id])),
    ).rejects.toThrow(/document_purge_request_in_trash/);
  });

  it('an adult and a teen cannot remove anything for good', async () => {
    const ids = {
      adult: await make('adult', 'Adult own'),
      teen: await make('teen', 'Teen own'),
    };
    for (const who of ['adult', 'teen'] as const) {
      await trash(who, ids[who]);
      await fresh(who, true);
      const refused = await purge(who, ids[who]);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(code(refused)).toBe('forbidden');
      expect(json<{ error: { message: string } }>(refused).error.message).toBe(
        'Only an owner can remove a document for good.',
      );
    }
    // Nor a viewer, of anything.
    expect(code(await purge('viewer', ids.adult))).toBe('forbidden');
    // All still there, unasked.
    for (const id of Object.values(ids)) {
      expect((await leftOf(id)).document).toBe(1);
    }
    expect((await trashOf('adult')).find((d) => d.id === ids.adult)?.purge_requested_at).toBeNull();
    // And the database refuses an adult's request even put to it directly.
    await expect(
      withAdmin(async (c) => {
        await c.query('begin');
        try {
          await c.query(
            `select set_config('app.actor', 'account', true), set_config('app.role', 'adult', true),
                    set_config('app.account_id', $1, true)`,
            [accounts.adult],
          );
          await c.query(
            'update document set purge_requested_at = now(), purge_requested_by = $2 where id = $1',
            [ids.adult, accounts.adult],
          );
        } finally {
          await c.query('rollback');
        }
      }),
    ).rejects.toThrow(/only an owner asks/);
  });

  it('the audit chain still verifies after a removal', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Chained');
    await trash('owner', id);
    expect((await purge('owner', id)).statusCode).toBe(204);
    const theirs = await make('adult', 'Chained, theirs');
    await trash('adult', theirs);
    expect((await purge('owner', theirs)).statusCode).toBe(202);
    await askedAgo(theirs, 25);
    expect((await purge('owner', theirs)).statusCode).toBe(204);
    const verified = await withSystem(h.db, t.owner.household_id, (trx) =>
      verifyAuditChain(trx, t.owner.household_id),
    );
    expect(verified).toMatchObject({ ok: true });
    expect(verified.checked).toBeGreaterThan(10);
  });

  it('removing for good asks to confirm it is you, after who may and after the document is found', async () => {
    const id = await make('owner', 'Asked first');
    await fresh('owner', false);
    // Not in the Trash, or not there at all: said so, never a question first.
    expect(code(await purge('owner', id))).toBe('not_in_trash');
    expect(code(await purge('owner', randomUUID()))).toBe('not_found');
    expect(code(await purge('owner', 'not-an-id'))).toBe('not_found');
    // Somebody else's Only me document is not there for an owner either.
    const hidden = await make('adult', 'Alex only', { visibility: 'private' });
    await trash('adult', hidden);
    expect(code(await purge('owner', hidden))).toBe('not_found');
    await fresh('adult', false);
    expect(code(await purge('adult', id))).toBe('forbidden');

    await trash('owner', id);
    const asked = await purge('owner', id);
    expect(asked.statusCode).toBe(403);
    expect(
      json<{ error: { code: string; action: string; message: string } }>(asked).error,
    ).toMatchObject({
      code: 'step_up_required',
      action: 'remove_for_good',
      message: 'Please confirm it is you to remove a document for good.',
    });
    expect((await leftOf(id)).document).toBe(1);
    // Asking about somebody else's asks too.
    const theirs = await make('adult', 'Alex receipt');
    await trash('adult', theirs);
    expect(code(await purge('owner', theirs))).toBe('step_up_required');
    expect((await trashOf('owner')).find((d) => d.id === theirs)?.purge_requested_at).toBeNull();
    await fresh('owner', true);
    expect((await purge('owner', id)).statusCode).toBe(204);
  });

  it("a collection's link made with a document a reader could not see stays unknown to them once it is removed", async () => {
    await fresh('owner', true);
    const lease = await make('owner', 'Shared lease');
    const will = await make('owner', 'Shared will');
    const made = await call('owner', 'POST', '/api/v1/collections', {
      name: 'For the solicitor',
      audience: 'everyone',
    });
    const collectionId = json<{ id: string }>(made).id;
    await call('owner', 'POST', `/api/v1/collections/${collectionId}/items`, {
      document_ids: [lease, will],
    });
    const link = await call('owner', 'POST', `/api/v1/collections/${collectionId}/shares`, {
      document_ids: [lease, will],
      recipient_label: 'Jane Solicitor',
    });
    expect(link.statusCode, link.body).toBe(201);
    const linkId = json<CreatedShare>(link).share.id;
    const knows = async (who: Who) =>
      json<{ items: ShareView[] }>(await call(who, 'GET', '/api/v1/shares')).items.some(
        (s) => s.id === linkId,
      );
    const sees = async (who: Who) =>
      (await activity(who)).some((l) => l.text.includes('Jane Solicitor'));
    expect(await knows('adult')).toBe(true);
    // The will made Only me, its owner keeping their link (5.41): the adult
    // may no longer know of the link.
    const narrowed = await call('owner', 'POST', `/api/v1/documents/${will}/visibility`, {
      visibility: 'private',
      own_links: 'keep',
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(await knows('adult')).toBe(false);
    expect(await sees('adult')).toBe(false);
    // Removed for good: the adult still may not.
    await trash('owner', will);
    expect((await purge('owner', will)).statusCode).toBe(204);
    expect(await knows('adult')).toBe(false);
    expect(await sees('adult')).toBe(false);
    expect(code(await call('adult', 'DELETE', `/api/v1/shares/${linkId}`))).toBe('not_found');
    const sharedOutside = json<{ shared_outside: { with: string[] } | null }>(
      await call('adult', 'GET', `/api/v1/collections/${collectionId}`),
    ).shared_outside;
    expect(sharedOutside?.with ?? []).not.toContain('Jane Solicitor');
    // Its owner, who made it, still does.
    expect(await knows('owner')).toBe(true);
    expect(await sees('owner')).toBe(true);
    const tomb = await withAdmin(
      async (c) =>
        (
          await c.query<{ link_ids: string[] }>(
            'select link_ids from document_tombstone where id = $1',
            [will],
          )
        ).rows,
    );
    expect(tomb).toEqual([{ link_ids: [linkId] }]);
  });

  it("a removed Essential leaves the phone's offline set, and what the phone says of it later is dropped", async () => {
    await fresh('owner', true);
    const phone = json<Tokens>(
      await h.app.inject({
        ...peer(),
        method: 'POST',
        url: '/api/v1/auth/password',
        headers: { 'x-fdv-installation': randomUUID() },
        payload: { email: 'owner@example.test', password: 'correct horse battery' },
      }),
    );
    const granted = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/offline/grant',
      headers: h.as(phone),
      payload: { password: 'correct horse battery' },
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const id = await make('owner', 'Passport, Essential', { essential: true });
    const version = (await versionsOf(id))[0]?.id as string;
    const set = async () =>
      json<OfflineSet>(
        await h.app.inject({ url: '/api/v1/offline/essentials', headers: h.as(phone) }),
      ).items.map((i) => i.document.id);
    expect(await set()).toContain(id);
    await trash('owner', id);
    expect((await purge('owner', id)).statusCode).toBe(204);
    // Not in the set: the phone removes its copy at its next sync (4.10).
    expect(await set()).not.toContain(id);
    // What the phone did with its copy while it had no connection, said
    // after: about a document that is not there, so not written down.
    const opens = await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/opens',
      headers: h.as(phone),
      payload: {
        events: [
          {
            id: randomUUID(),
            version_id: version,
            opened_at: new Date().toISOString(),
            mode: 'view',
            online: false,
          },
        ],
      },
    });
    expect(opens.statusCode, opens.body).toBe(200);
    expect(json<{ dropped: number }>(opens).dropped).toBe(1);
    const page = await h.app.inject({
      url: `/api/v1/offline/pages/${version}/1`,
      headers: h.as(phone),
    });
    expect(page.statusCode).toBe(404);
  });

  it('a document whose file a restore found removed for good says so, rather than failing', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Back without its file');
    const version = (await versionsOf(id))[0]?.id as string;
    const made = await call('owner', 'POST', `/api/v1/documents/${id}/share`, {});
    const link = json<CreatedShare>(made);
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: link.link_token },
      ...peer(),
    });
    const cookie = opened.cookies.find((c) => c.name === 'fdv_share')?.value as string;
    // What a restore marks (restore.ts) on a version whose file is gone.
    await withAdmin((c) =>
      c.query('update document_version set file_removed_at = now() where document_id = $1', [id]),
    );
    const linesBefore = (await activity('owner')).length;

    const doc = json<DocumentView>(await call('owner', 'GET', `/api/v1/documents/${id}`));
    expect(doc.file_removed).toBe(true);
    const versions = json<{ items: VersionView[] }>(
      await call('owner', 'GET', `/api/v1/documents/${id}/versions`),
    ).items;
    expect(versions.map((v) => v.file_removed)).toEqual([true]);
    for (const url of [
      `/api/v1/versions/${version}/content`,
      `/api/v1/versions/${version}/thumbnail`,
      `/api/v1/versions/${version}/pages/1`,
    ]) {
      const r = await call('owner', 'GET', url);
      expect(r.statusCode, url).toBe(410);
      expect(json<{ error: { code: string; message: string } }>(r).error, url).toEqual(
        expect.objectContaining({
          code: 'file_removed',
          message: 'The file was removed for good.',
        }),
      );
    }
    // Through a link, too: and nothing counted.
    const shared = await h.app.inject({
      url: `/api/v1/shared/items/${id}/content`,
      cookies: { fdv_share: cookie },
      ...peer(),
    });
    expect(shared.statusCode, shared.body).toBe(410);
    expect(code(shared)).toBe('file_removed');
    const used = await withAdmin(
      async (c) =>
        (
          await c.query<{ n: number }>('select downloads_used as n from share_link where id = $1', [
            link.share.id,
          ])
        ).rows[0]?.n,
    );
    expect(used).toBe(0);
    // No download is written down that could not happen.
    expect((await activity('owner')).length).toBe(linesBefore);
    // And no new link is made to it, alone or in a collection: it would
    // open on nothing (the review, W524-7).
    const refusedLink = await call('owner', 'POST', `/api/v1/documents/${id}/share`, {});
    expect(refusedLink.statusCode, refusedLink.body).toBe(422);
    expect(code(refusedLink)).toBe('file_removed');
    const other = await make('owner', 'Still has its file');
    const box = json<{ id: string }>(
      await call('owner', 'POST', '/api/v1/collections', {
        name: 'For the solicitor',
        audience: 'everyone',
      }),
    ).id;
    expect(
      (
        await call('owner', 'POST', `/api/v1/collections/${box}/items`, {
          document_ids: [id, other],
        })
      ).statusCode,
    ).toBe(200);
    const offered = json<{
      items: { document_id: string; ticked: boolean; lock: string | null; reason: string | null }[];
    }>(await call('owner', 'GET', `/api/v1/collections/${box}/share-preview`)).items;
    expect(offered.find((i) => i.document_id === id)).toMatchObject({
      ticked: false,
      lock: 'no_file',
      reason: 'The file was removed for good, so there is nothing to send.',
    });
    expect(offered.find((i) => i.document_id === other)).toMatchObject({
      ticked: true,
      lock: null,
    });
    const boxed = await call('owner', 'POST', `/api/v1/collections/${box}/shares`, {
      document_ids: [id, other],
    });
    expect(boxed.statusCode, boxed.body).toBe(422);
    expect(code(boxed)).toBe('file_removed');
    expect(
      (await call('owner', 'POST', `/api/v1/collections/${box}/shares`, { document_ids: [other] }))
        .statusCode,
    ).toBe(201);
    // Any other document is as it was.
    expect(
      json<DocumentView>(await call('owner', 'GET', `/api/v1/documents/${other}`)).file_removed,
    ).toBe(false);
  });

  describe('racing a removal is never a deadlock', () => {
    const dbName = () => new URL(h.adminUrl).pathname.slice(1);
    const deadlocksSoFar = async (admin: ReturnType<typeof createPool>) =>
      (
        await admin.query<{ n: number }>(
          'select deadlocks::int as n from pg_stat_database where datname = $1',
          [dbName()],
        )
      ).rows[0]?.n as number;
    /** Waits until `n` statements in the test's database wait on a lock. */
    const lockWaiters = async (admin: ReturnType<typeof createPool>, n: number) => {
      for (let i = 0; i < 200; i += 1) {
        const r = await admin.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = $1 and wait_event_type = 'Lock'`,
          [dbName()],
        );
        if ((r.rows[0]?.n ?? 0) >= n) return;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`fewer than ${n} statements waiting on a lock`);
    };
    const holdTheLog = (c: { query: (q: string, v?: unknown[]) => Promise<unknown> }) =>
      c.query(`select pg_advisory_xact_lock(hashtext('audit:' || $1::uuid::text))`, [
        t.owner.household_id,
      ]);
    /** Two connections of the database's own, and the deadlocks so far. */
    const holding = async <T>(fn: (c: { holder: Client; admin: Pool }) => Promise<T>) => {
      const admin = createPool(h.adminUrl, 3);
      const holder = await connectTo(admin);
      const before = await deadlocksSoFar(admin);
      try {
        const out = await fn({ holder, admin });
        // A deadlock is found a second after it forms (deadlock_timeout).
        await new Promise((res) => setTimeout(res, 1500));
        expect(await deadlocksSoFar(admin)).toBe(before);
        return out;
      } finally {
        await holder.query('rollback').catch(() => undefined);
        holder.release();
        await admin.end();
      }
    };
    const collectionWith = async (id: string, permission: 'view' | 'download') => {
      const made = await call('owner', 'POST', '/api/v1/collections', {
        name: `Holding ${id.slice(0, 8)}`,
        audience: 'everyone',
      });
      const collectionId = json<{ id: string }>(made).id;
      await call('owner', 'POST', `/api/v1/collections/${collectionId}/items`, {
        document_ids: [id],
      });
      const link = await call('owner', 'POST', `/api/v1/collections/${collectionId}/shares`, {
        document_ids: [id],
        permission,
      });
      expect(link.statusCode, link.body).toBe(201);
      return { collectionId, link: json<CreatedShare>(link) };
    };
    /** A link opened in a browser: its session's id. */
    const sessionOf = async (link: CreatedShare) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/unlock',
        payload: { token: link.link_token },
        ...peer(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return withAdmin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              'select id from share_session where share_id = $1 order by created_at desc limit 1',
              [link.share.id],
            )
          ).rows[0]?.id as string,
      );
    };

    it("the share-pages worker keeping a collection's link's pages of it", async () => {
      await fresh('owner', true);
      const id = await make('owner', 'Pages kept as it goes');
      const { link } = await collectionWith(id, 'view');
      const version = (await versionsOf(id))[0] as { id: string; storage_key: string };
      const page = (n: number, key: string) =>
        [t.owner.household_id, link.share.id, id, version.id, n, key] as unknown[];
      await withAdmin((c) =>
        c.query(
          `insert into share_page (household_id, share_id, document_id, version_id, n, storage_key)
           values ($1, $2, $3, $4, $5, $6)`,
          page(1, 'drawn/before'),
        ),
      );
      await trash('owner', id);
      await holding(async ({ holder, admin }) => {
        // What keeps a link's pages: the link held, then the document's
        // pages it had taken away...
        await holder.query('begin');
        await holder.query('select id from share_link where id = $1 for no key update', [
          link.share.id,
        ]);
        await holder.query('delete from share_page where share_id = $1 and document_id = $2', [
          link.share.id,
          id,
        ]);
        const removing = purge('owner', id);
        await lockWaiters(admin, 1);
        // ...and the new ones written, which name the document: never
        // waiting on the removal, which waits on these.
        await holder.query(
          `insert into share_page (household_id, share_id, document_id, version_id, n, storage_key)
           values ($1, $2, $3, $4, $5, $6)`,
          page(1, 'drawn/as/it/went'),
        );
        await holder.query('commit');
        const removed = await removing;
        expect(removed.statusCode, removed.body).toBe(204);
      });
      expect((await leftOf(id)).share_page).toBe(0);
    });

    it("the share-pages worker keeping the document's own link's pages", async () => {
      await fresh('owner', true);
      const id = await make('owner', 'Own link pages kept as it goes');
      const made = await call('owner', 'POST', `/api/v1/documents/${id}/share`, {
        permission: 'view',
      });
      expect(made.statusCode, made.body).toBe(201);
      const link = json<CreatedShare>(made).share.id;
      const version = (await versionsOf(id))[0] as { id: string };
      const page = (key: string) => [t.owner.household_id, link, id, version.id, 1, key];
      const insertPage = `insert into share_page (household_id, share_id, document_id, version_id, n, storage_key)
                          values ($1, $2, $3, $4, $5, $6)`;
      await withAdmin((c) => c.query(insertPage, page('drawn/before')));
      await trash('owner', id);
      await holding(async ({ holder, admin }) => {
        // The worker holds the link first...
        await holder.query('begin');
        await holder.query('select id from share_link where id = $1 for no key update', [link]);
        const removing = purge('owner', id);
        await lockWaiters(admin, 1);
        // ...then the pages it replaces, then names the document.
        await holder.query('delete from share_page where share_id = $1 and document_id = $2', [
          link,
          id,
        ]);
        await holder.query(insertPage, page('drawn/as/it/went'));
        await holder.query('commit');
        const removed = await removing;
        expect(removed.statusCode, removed.body).toBe(204);
      });
      expect((await leftOf(id)).share_page).toBe(0);
    });

    it("a download through a collection's link", async () => {
      await fresh('owner', true);
      const id = await make('owner', 'Downloaded as it goes');
      const { link } = await collectionWith(id, 'download');
      const session = await sessionOf(link);
      await trash('owner', id);
      await holding(async ({ holder, admin }) => {
        // A request in its session: the session, then what it has had,
        // which names the document...
        await holder.query('begin');
        await holder.query('update share_session set last_seen_at = now() where id = $1', [
          session,
        ]);
        await holder.query(
          `insert into share_session_use (household_id, session_id, share_id, document_id, kind)
           values ($1, $2, $3, $4, 'downloaded')`,
          [t.owner.household_id, session, link.share.id, id],
        );
        const removing = purge('owner', id);
        await lockWaiters(admin, 1);
        // ...then its link's count, then the log: none of it waits on the removal.
        await holder.query(
          'update share_link set downloads_used = downloads_used + 1 where id = $1',
          [link.share.id],
        );
        await holdTheLog(holder);
        await holder.query('commit');
        expect((await removing).statusCode).toBe(204);
      });
      expect((await leftOf(id)).share_session_use).toBe(0);
    });

    it("a download through the document's own link", async () => {
      await fresh('owner', true);
      const id = await make('owner', 'Its own link, as it goes');
      const made = await call('owner', 'POST', `/api/v1/documents/${id}/share`, {});
      expect(made.statusCode, made.body).toBe(201);
      const link = json<CreatedShare>(made);
      const session = await sessionOf(link);
      await trash('owner', id);
      await holding(async ({ holder, admin }) => {
        await holder.query('begin');
        await holder.query('update share_session set last_seen_at = now() where id = $1', [
          session,
        ]);
        await holder.query(
          `insert into share_session_use (household_id, session_id, share_id, document_id, kind)
           values ($1, $2, $3, $4, 'downloaded')`,
          [t.owner.household_id, session, link.share.id, id],
        );
        const removing = purge('owner', id);
        await lockWaiters(admin, 1);
        await holder.query(
          'update share_link set downloads_used = downloads_used + 1 where id = $1',
          [link.share.id],
        );
        await holdTheLog(holder);
        await holder.query('commit');
        expect((await removing).statusCode).toBe(204);
      });
      expect((await leftOf(id)).share_link).toBe(0);
    });

    it('Bring it back, before it and after it', async () => {
      await fresh('owner', true);
      // Brought back first: the removal finds it out of the Trash.
      const first = await make('owner', 'Brought back first');
      await trash('owner', first);
      await holding(async ({ holder, admin }) => {
        await holder.query('begin');
        await holdTheLog(holder);
        const bringing = restore('owner', first);
        await lockWaiters(admin, 1);
        const removing = purge('owner', first);
        await lockWaiters(admin, 2);
        await holder.query('commit');
        const [back, removed] = await Promise.all([bringing, removing]);
        expect(back.statusCode, back.body).toBe(200);
        expect(removed.statusCode, removed.body).toBe(409);
        expect(code(removed)).toBe('not_in_trash');
      });
      expect((await leftOf(first)).document).toBe(1);

      // Removed first: bringing it back finds nothing, and says so.
      const second = await make('owner', 'Removed first');
      await trash('owner', second);
      await holding(async ({ holder, admin }) => {
        await holder.query('begin');
        await holdTheLog(holder);
        const removing = purge('owner', second);
        await lockWaiters(admin, 1);
        const bringing = restore('owner', second);
        await lockWaiters(admin, 2);
        await holder.query('commit');
        const [removed, back] = await Promise.all([removing, bringing]);
        expect(removed.statusCode, removed.body).toBe(204);
        expect(back.statusCode, back.body).toBe(404);
        expect(code(back)).toBe('not_found');
      });
    });

    it("a collection's link being made with it left out", async () => {
      await fresh('owner', true);
      const id = await make('owner', 'Left out as it goes');
      const other = await make('owner', 'Ticked');
      const made = await call('owner', 'POST', '/api/v1/collections', {
        name: 'Left out of the link',
        audience: 'everyone',
      });
      const collectionId = json<{ id: string }>(made).id;
      await call('owner', 'POST', `/api/v1/collections/${collectionId}/items`, {
        document_ids: [other],
      });
      await trash('owner', id);
      await holding(async ({ holder, admin }) => {
        // The removal, held up at the log with all it holds.
        await holder.query('begin');
        await holdTheLog(holder);
        const removing = purge('owner', id);
        await lockWaiters(admin, 1);
        // A link made meanwhile that names it, as left out: it holds the
        // documents it names, in id order, and waits on this one.
        const sharing = call('owner', 'POST', `/api/v1/collections/${collectionId}/shares`, {
          document_ids: [other],
          follow_collection: true,
          left_out_ids: [id],
        });
        await lockWaiters(admin, 2);
        await holder.query('commit');
        const [removed, shared] = await Promise.all([removing, sharing]);
        expect(removed.statusCode, removed.body).toBe(204);
        // Made, naming only what is there: never a fault.
        expect(shared.statusCode, shared.body).toBe(201);
      });
      expect((await leftOf(id)).share_link_item).toBe(0);
    });

    it('whatever holds the document and then the log — an edit, a new version — is waited for', async () => {
      await fresh('owner', true);
      for (const how of ['for update', 'for no key update', 'for key share']) {
        const id = await make('owner', `Held ${how}`);
        await trash('owner', id);
        await holding(async ({ holder, admin }) => {
          await holder.query('begin');
          await holder.query(`select id from document where id = $1 ${how}`, [id]);
          const removing = purge('owner', id);
          await lockWaiters(admin, 1);
          await holdTheLog(holder);
          await holder.query('commit');
          expect((await removing).statusCode, how).toBe(204);
        });
      }
    });
  });

  it('an upload of a new version that never finished goes with it', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Half uploaded');
    const temp = `${t.owner.household_id}/${id}/incoming/${randomUUID()}.${randomUUID()}.enc`;
    await putFile(temp);
    const vault = await withAdmin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            'select vault_id as id from document_version where document_id = $1',
            [id],
          )
        ).rows[0]?.id,
    );
    await withAdmin((c) =>
      c.query(
        `insert into upload_idempotency
           (idempotency_key, household_id, document_id, account_id, state, request_kind,
            claim_nonce, claimed_at, temp_key, temp_vault_id)
         values ($1, $2, $3, $4, 'pending', 'version', $5, now() - interval '2 hours', $6, $7)`,
        [randomUUID(), t.owner.household_id, id, accounts.owner, randomUUID(), temp, vault],
      ),
    );
    await trash('owner', id);
    expect((await purge('owner', id)).statusCode).toBe(204);
    expect(await filesUnder(`${t.owner.household_id}/${id}`)).toEqual([]);
  });

  /** The objects a removal wrote down and has not deleted yet (purge_leftover). */
  const leftoversOf = (id: string) =>
    withAdmin(async (c) =>
      (
        await c.query<{ object_key: string }>(
          'select object_key from purge_leftover where removed_document = $1 order by object_key',
          [id],
        )
      ).rows.map((r) => r.object_key),
    );

  it('handed to an owner, an adult’s filing is still asked about and its filer told; theirs, its filer gone or unknown, goes at once (the review, M524-1)', async () => {
    await fresh('owner', true);
    const child = json<{ id: string }>(
      await call('owner', 'POST', '/api/v1/members', { display_name: 'Kit' }),
    ).id;
    // Filed by Alex: one of the household's, and one of the child's, who
    // signs in nowhere — both of which an owner may hand to themselves.
    const filed = async (title: string, owner: string | null) => {
      const r = await call('adult', 'POST', '/api/v1/documents', {
        title,
        type_key: 'utility_bill',
        visibility: 'household',
        owner_member_id: owner,
      });
      expect(r.statusCode, r.body).toBe(201);
      return json<DocumentView>(r).id;
    };
    for (const id of [await filed('Council tax', null), await filed('Kit passport', child)]) {
      const now = json<DocumentView>(await call('owner', 'GET', `/api/v1/documents/${id}`));
      const handed = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/documents/${id}`,
        headers: { ...h.as(t.owner), 'if-match': now.etag },
        payload: { owner_member_id: t.owner.member_id },
      });
      expect(handed.statusCode, handed.body).toBe(200);
      expect(json<DocumentView>(handed).owner_member_id).toBe(t.owner.member_id);
      await trash('owner', id);
      expect((await trashOf('owner')).find((d) => d.id === id)?.purge_at_once).toBe(false);
      const told = alertsTo(accounts.adult).length;
      const asked = await purge('owner', id);
      expect(asked.statusCode, asked.body).toBe(202);
      expect(alertsTo(accounts.adult)).toHaveLength(told + 1);
      expect((await leftOf(id)).document).toBe(1);
    }

    // The owner's own, filed by somebody whose sign-in has since been
    // removed: nobody is left to tell, and it goes at once.
    const lee = await h.join(t.owner, { name: 'Lee', email: 'lee@example.test', role: 'adult' });
    const left = await call('owner', 'POST', '/api/v1/documents', {
      title: 'Filed by Lee',
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: t.owner.member_id,
    });
    const leftId = json<DocumentView>(left).id;
    const leeAccount = json<{ account_id: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(lee) }),
    ).account_id;
    await withAdmin((c) =>
      c.query('update document set created_by = $2 where id = $1', [leftId, leeAccount]),
    );
    await trash('owner', leftId);
    expect((await trashOf('owner')).find((d) => d.id === leftId)?.purge_at_once).toBe(false);
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${lee.member_id}/sign-in`,
      headers: h.as(t.owner),
    });
    expect(gone.statusCode, gone.body).toBe(204);
    expect((await trashOf('owner')).find((d) => d.id === leftId)?.purge_at_once).toBe(true);
    expect((await purge('owner', leftId)).statusCode).toBe(204);

    // And the owner's own that nobody is named as filing: at once.
    const unknown = await make('owner', 'Filed by nobody', { file: false });
    await withAdmin((c) =>
      c.query('update document set created_by = null where id = $1', [unknown]),
    );
    await trash('owner', unknown);
    expect((await trashOf('owner')).find((d) => d.id === unknown)?.purge_at_once).toBe(true);
    expect((await purge('owner', unknown)).statusCode).toBe(204);
    // What they filed themselves, as before: at once; and it says so.
    const mine = await make('owner', 'Filed by me', { file: false });
    await trash('owner', mine);
    expect((await trashOf('owner')).find((d) => d.id === mine)?.purge_at_once).toBe(true);
    // An adult's Trash never offers it.
    expect((await trashOf('adult')).every((d) => d.purge_at_once === false)).toBe(true);
  });

  it('a filer who cannot bring it back is told who can (the review, W524-3)', async () => {
    await fresh('owner', true);
    // A teen's own: theirs to bring back.
    const own = await make('teen', 'Tia own');
    await trash('teen', own);
    let told = alertsTo(accounts.teen).length;
    expect((await purge('owner', own)).statusCode).toBe(202);
    const toOwn = alertsTo(accounts.teen).slice(told);
    expect(toOwn).toHaveLength(1);
    expect(toOwn[0]?.body).toMatch(/Bring it back to keep it: it is in the Trash\./);
    // A teen's filing that is the household's now: not theirs to bring back.
    const filed = await make('teen', 'Tia filed', { file: false });
    await withAdmin((c) =>
      c.query('update document set owner_member_id = null where id = $1', [filed]),
    );
    await trash('owner', filed);
    told = alertsTo(accounts.teen).length;
    expect((await purge('owner', filed)).statusCode).toBe(202);
    const toTeen = alertsTo(accounts.teen).slice(told);
    expect(toTeen).toHaveLength(1);
    expect(toTeen[0]?.body).toMatch(
      /To keep it, ask an owner or another adult to bring it back from the Trash\./,
    );
    expect(toTeen[0]?.body).not.toMatch(/Bring it back to keep it/);
    // And the other owners are told what is so: whoever added it is told
    // if they still sign in here.
    const toOwners = alertsTo(accounts.second).at(-1);
    expect(toOwners?.body).toMatch(/Whoever added it is told too, if they still sign in here\./);
    // The Trash is its own place since the web's R1, not in Settings.
    expect(toOwners?.body).toMatch(/Bringing it back from the Trash within \d+ hours keeps it\./);
    for (const told of [...toOwn, ...toTeen, toOwners]) {
      expect(told?.body).not.toMatch(/Settings/);
    }
  });

  it('storage failing part-way leaves no document to bring back: what was not deleted is written down, and the worker asked to finish it (the review, M524-2)', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Storage failing part-way');
    const key = (await versionsOf(id))[0]?.storage_key as string;
    await putFile(`${key}.p1.enc`);
    // Where its thumbnail would be, something that cannot be deleted as a
    // file is: the place holding it fails, part-way through.
    await putFile(`${key}.thumb.enc/held`);
    await trash('owner', id);
    const jobsBefore = h.jobs.length;

    const removed = await purge('owner', id);
    expect(removed.statusCode, removed.body).toBe(204);
    // The document is gone, every row of it: nothing half there to bring back.
    expect(Object.entries(await leftOf(id)).filter(([, n]) => n !== 0)).toEqual([]);
    expect(code(await restore('owner', id))).toBe('not_found');
    expect((await call('owner', 'GET', `/api/v1/documents/${id}`)).statusCode).toBe(404);
    // Its file deleted; the one that failed, and all after it, written down
    // for the worker, which is asked to finish them — one job a household.
    const rel = key.split('/').slice(2).join('/');
    expect(await filesUnder(`${t.owner.household_id}/${id}`)).toEqual([
      `${rel}.p1.enc`,
      `${rel}.thumb.enc/held`,
    ]);
    const left = await leftoversOf(id);
    expect(left).toContain(`${key}.thumb.enc`);
    expect(left).toContain(`${key}.p1.enc`);
    expect(left).not.toContain(key);
    expect(left).toHaveLength(1 + PREVIEW_MAX_PAGES);
    expect(h.jobs.slice(jobsBefore).filter((j) => j.name === 'purge.leftovers')).toEqual([
      {
        name: 'purge.leftovers',
        data: { household_id: t.owner.household_id },
        options: { singletonKey: `purge.leftovers:${t.owner.household_id}` },
      },
    ]);
    // A removal that met no trouble leaves nothing written down.
    const clean = await make('owner', 'Nothing in the way');
    await trash('owner', clean);
    expect((await purge('owner', clean)).statusCode).toBe(204);
    expect(await leftoversOf(clean)).toEqual([]);
  });

  it('storage out of reach is tried once, not once a file, and the owner is answered at once (the 5.24 check, N524R-3)', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Kept somewhere switched off');
    await upload('owner', id, 'second copy');
    await trash('owner', id);
    // Every delete fails as a place out of reach does, after a while.
    const deletes = vi.spyOn(LocalAdapter.prototype, 'delete').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new StorageError('unreachable', "We can't reach where your files are kept.");
    });
    try {
      const started = Date.now();
      const removed = await purge('owner', id);
      expect(removed.statusCode, removed.body).toBe(204);
      // One try for the one place, though it held two files, their
      // thumbnails and their pages; not one a file.
      expect(deletes).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeLessThan(5_000);
      // Every one of them is the worker's now.
      expect(await leftoversOf(id)).toHaveLength(2 * (2 + PREVIEW_MAX_PAGES));
    } finally {
      deletes.mockRestore();
    }
  });

  it('a file a restore marked removed for good, found there after all, is unmarked and never removed with it (the review, D524-02)', async () => {
    await fresh('owner', true);
    const id = await make('owner', 'Found after all');
    const key = (await versionsOf(id))[0]?.storage_key as string;
    const folder = `${t.owner.household_id}/${id}`;
    await withAdmin((c) =>
      c.query('update document_version set file_removed_at = now() where document_id = $1', [id]),
    );
    await trash('owner', id);
    const found = await purge('owner', id);
    expect(found.statusCode, found.body).toBe(409);
    expect(code(found)).toBe('file_found');
    // Kept, the file and the document, and no longer said to be removed.
    expect(await filesUnder(folder)).toEqual([key.split('/').slice(2).join('/')]);
    expect((await leftOf(id)).document).toBe(1);
    expect((await trashOf('owner')).find((d) => d.id === id)?.file_removed).toBe(false);
    // Asked again, now that the owner has seen it: removed.
    expect((await purge('owner', id)).statusCode).toBe(204);
    expect(await filesUnder(folder)).toEqual([]);

    // One whose file truly is gone stays marked, and is removed.
    const gone = await make('owner', 'Truly gone');
    await withAdmin((c) =>
      c.query('update document_version set file_removed_at = now() where document_id = $1', [gone]),
    );
    await rm(path.join(h.vaultDir, `${t.owner.household_id}/${gone}`), {
      recursive: true,
      force: true,
    });
    await trash('owner', gone);
    expect((await purge('owner', gone)).statusCode).toBe(204);
  });
});
