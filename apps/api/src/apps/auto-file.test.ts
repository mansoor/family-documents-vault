import { randomUUID } from 'node:crypto';
import { multipartBody } from '@fdv/client';
import {
  EnvKeyProvider,
  itemProposalsBinding,
  itemTextBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  APP_FILE_READY_JOB,
  type ActivityLine,
  type AppIntakeState,
  type AppMe,
  type BatchUndoResult,
  type ConnectedAppView,
  type DetailProposal,
  type Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appKeyFor, basicFor, createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { autoFileOn, consumeFileReady, type FileReadyQueue } from './auto-file.js';

/**
 * Connected apps file automatically (0.9.0, APP4): the worker, having read
 * an item such an app sent, sends `apps.file_ready`; the API files it, as
 * the app's person, only when everything is sure and complete and the app
 * still files automatically — asked again in the filing's own transaction.
 * Anything else waits for review, as it always did.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

interface TestApp {
  appId: string;
  keyId: string;
  clientId: string;
  secret: string;
  view: ConnectedAppView;
}

let peers = 0;
const peer = () => `10.75.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

describe('whether an app files automatically now', () => {
  it('its own switch, or a backfill’s while the window lasts', () => {
    const now = Date.UTC(2026, 10, 17, 12);
    const off = { auto_file: false, backfill_auto_file: false, backfill_until: null };
    expect(autoFileOn(off, now)).toBe(false);
    expect(autoFileOn({ ...off, auto_file: true }, now)).toBe(true);
    const until = new Date(now + 864e5);
    expect(autoFileOn({ ...off, backfill_auto_file: true, backfill_until: until }, now)).toBe(true);
    expect(
      autoFileOn({ ...off, backfill_auto_file: true, backfill_until: new Date(now - 1) }, now),
    ).toBe(false);
  });
});

describe('the API’s one consumer', () => {
  it('waits for the worker to make the queue, works it one job at a time, and stops', async () => {
    let there = false;
    const worked: Array<(jobs: Array<{ data: unknown }>) => Promise<void>> = [];
    const queue: FileReadyQueue = {
      getQueue: vi.fn(async () => (there ? { name: APP_FILE_READY_JOB } : null)),
      work: vi.fn(async (_name: string, _opts: unknown, handler: (typeof worked)[number]) => {
        worked.push(handler);
        return 'w-1';
      }),
      offWork: vi.fn(async () => undefined),
    };
    const fileReady = vi.fn(async () => 'filed' as const);
    const log = vi.fn();
    const c = consumeFileReady(queue, { fileReady }, log, { retryMs: 5 });
    await vi.waitFor(() =>
      expect(vi.mocked(queue.getQueue).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(queue.work).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'info',
      'waiting for the worker to make the queue apps.file_ready',
    );
    there = true;
    await c.started;
    expect(queue.work).toHaveBeenCalledWith(
      APP_FILE_READY_JOB,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      expect.any(Function),
    );
    await worked[0]?.([{ data: { household_id: 'h', item_id: 'i' } }]);
    expect(fileReady).toHaveBeenCalledWith({ household_id: 'h', item_id: 'i' });
    await c.stop();
    expect(queue.offWork).toHaveBeenCalledWith(APP_FILE_READY_JOB);
  });

  it('a start that fails is tried again, as the queue is looked for', async () => {
    let fails = 1;
    const queue: FileReadyQueue = {
      getQueue: vi.fn(async () => ({ name: APP_FILE_READY_JOB })),
      work: vi.fn(async () => {
        if (fails-- > 0) throw new Error('the database a moment away');
        return 'w-1';
      }),
      offWork: vi.fn(async () => undefined),
    };
    const log = vi.fn();
    const c = consumeFileReady(queue, { fileReady: vi.fn() }, log, { retryMs: 5 });
    await c.started;
    expect(queue.work).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      'warn',
      'could not start filing apps’ items automatically; trying again',
      { err: 'the database a moment away' },
    );
    await c.stop();
    expect(queue.offWork).toHaveBeenCalledWith(APP_FILE_READY_JOB);
  });

  it('stopped while it waits for the queue: it never starts', async () => {
    const queue: FileReadyQueue = {
      getQueue: vi.fn(async () => null),
      work: vi.fn(async () => 'w'),
      offWork: vi.fn(async () => undefined),
    };
    const c = consumeFileReady(queue, { fileReady: vi.fn() }, vi.fn(), { retryMs: 60_000 });
    await vi.waitFor(() => expect(queue.getQueue).toHaveBeenCalledTimes(1));
    await c.stop();
    expect(queue.work).not.toHaveBeenCalled();
    expect(queue.offWork).not.toHaveBeenCalled();
  });
});

describe.skipIf(!testAdminUrl())('connected apps file automatically (0.9.0, APP4)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let ahmed: Tokens;

  const send = (t: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(t),
      ...(payload === undefined ? {} : { payload: payload as never }),
      remoteAddress: peer(),
    });

  async function connect(
    input: Record<string, unknown> = {},
    name = 'Acme Money',
  ): Promise<TestApp> {
    await h.decider(owner);
    const res = await send(owner, 'POST', '/api/v1/connected-apps', {
      name,
      member_id: owner.member_id,
      allowed_kinds: ['bank_statement', 'utility_bill'],
      auto_file: true,
      ...input,
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json<ConnectedAppView>();
    const key = await appKeyFor(h, owner, view);
    return { appId: view.id, ...key, view };
  }

  async function call(
    a: TestApp,
    method: 'GET' | 'POST' | 'DELETE',
    target: string,
    body?: { bytes: Uint8Array; contentType: string },
  ): Promise<LightMyRequestResponse> {
    const signed = basicFor(a);
    return h.app.inject({
      method,
      url: target,
      headers: { ...signed, ...(body ? { 'content-type': body.contentType } : {}) },
      ...(body ? { payload: Buffer.from(body.bytes) } : {}),
      remoteAddress: '127.0.0.1',
    });
  }

  /** A file the app sends: the item it became in its person's Inbox. */
  async function sent(
    a: TestApp,
    externalId: string,
    hints: Record<string, unknown> = { kind: 'bank_statement', title: `Statement ${externalId}` },
    bytes = PDF(externalId),
  ): Promise<string> {
    const body = multipartBody([
      { name: 'metadata', value: JSON.stringify({ external_id: externalId, hints }) },
      { name: 'file', filename: 'statement.pdf', contentType: 'application/pdf', bytes },
    ]);
    const r = await call(a, 'POST', '/api/v1/apps/intake', body);
    expect(r.statusCode, r.body).toBe(201);
    const row = await admin.query<{ id: string }>(
      `select incoming_file_id as id from connected_app_intake where app_id = $1 and external_id = $2`,
      [a.appId, externalId],
    );
    return row.rows[0]?.id as string;
  }

  /** Its pages read, as the worker writes it: this proposal, sealed under the item's own key. */
  async function read(item: string, proposal: DetailProposal) {
    await withSystem(h.db, owner.household_id, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', item)
        .executeTakeFirstOrThrow();
      const fileKey = unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${item}`,
      );
      await trx
        .updateTable('incoming_file')
        .set({
          read_state: 'read',
          text_sealed: sealBytes(fileKey, Buffer.from('its words'), itemTextBinding(item)),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal })),
            itemProposalsBinding(item),
          ),
        })
        .where('id', '=', item)
        .execute();
    });
  }

  /** What the pages of a bank statement of the owner's say, surely. */
  const SURE = (): DetailProposal => ({
    type_key: { value: 'bank_statement', confidence: 0.95, cue: 'kind_words' },
    owner_member_id: { value: owner.member_id, confidence: 0.95, cue: 'name_on_page' },
    issued: {
      value: { date: '2026-10-31', precision: 'day' },
      confidence: 0.9,
      cue: 'issue_label',
    },
  });

  const job = (item: string) =>
    h.apps.autoFile.fileReady({ household_id: owner.household_id, item_id: item });
  const status = async (a: TestApp, id: string) => {
    const r = await call(a, 'GET', `/api/v1/apps/intake/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<AppIntakeState>();
  };
  const lines = async () =>
    (await send(owner, 'GET', '/api/v1/audit?limit=100'))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
  const batchOf = async (item: string) =>
    (
      await admin.query<{ batch_id: string }>('select batch_id from incoming_file where id = $1', [
        item,
      ])
    ).rows[0]?.batch_id as string;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 50_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed Khan', email: 'ahmed@example.test', role: 'adult' });
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('files an item when everything is sure and complete: filed with nobody looking, said so, and taken back by Undo', async () => {
    const a = await connect();
    expect(a.view.auto_file).toBe(true);
    const me = (await call(a, 'GET', '/api/v1/apps/me')).json<AppMe>();
    expect(me.send.auto_file).toBe(true);
    const item = await sent(a, 'sure-1', {
      kind: 'bank_statement',
      person: { member_id: owner.member_id },
      title: 'Northgate, October',
      account_last4: '4421',
    });
    await read(item, SURE());
    expect(await job(item)).toBe('filed');
    const s = await status(a, 'sure-1');
    expect(s).toMatchObject({ state: 'filed' });
    expect(s.document_id).toMatch(/^[0-9a-f-]{36}$/);
    const doc = await admin.query<{ title: string; type_key: string; created_by: string }>(
      'select title, type_key, created_by from document where id = $1',
      [s.document_id],
    );
    expect(doc.rows[0]).toMatchObject({ title: 'Northgate, October', type_key: 'bank_statement' });
    // As its person: their account filed it, and its line says from the app, naming nobody.
    const by = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [owner.member_id],
    );
    expect(doc.rows[0]?.created_by).toBe(by.rows[0]?.account_id);
    // A bank statement is sensitive by default: never named.
    const said = await lines();
    expect(said).toContain('Filed automatically from Acme Money: a sensitive document');
    expect(said.filter((l) => /^Owner (added a|uploaded)/.test(l))).toEqual([]);
    // Its pages and words, read for search once it is filed, as any accept's.
    expect(h.jobs.some((j) => j.name === 'version.process')).toBe(true);

    // Taken back by its person within the minutes Accept all Ready gives.
    const undone = await send(
      owner,
      'POST',
      `/api/v1/batches/${await batchOf(item)}/accept-ready/undo`,
      {
        item_ids: [item],
      },
    );
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json<BatchUndoResult>().restored, undone.body).toEqual([item]);
    expect(await status(a, 'sure-1')).toMatchObject({ state: 'waiting', document_id: null });
    // Never filed automatically again: they chose to look at it.
    await read(item, SURE());
    expect(await job(item)).toBe('held');
    expect((await status(a, 'sure-1')).state).toBe('waiting');
  });

  it('one condition not so, and it waits: a hint alone, a clash, a duplicate, a kind it may not send', async () => {
    const a = await connect({}, 'Waits');
    // The kind and the person by the app's hints alone: Ready, never sure enough.
    const hinted = await sent(a, 'w-hint', {
      kind: 'bank_statement',
      person: { member_id: owner.member_id },
    });
    await read(hinted, { issued: SURE().issued } as DetailProposal);
    expect(await job(hinted)).toBe('not_sure');
    // The pages and the app disagree.
    const clash = await sent(a, 'w-clash', { kind: 'utility_bill' });
    await read(clash, SURE());
    expect(await job(clash)).toBe('not_sure');
    // The same file as a document here already: a duplicate.
    const first = await sent(a, 'w-dup-1', { kind: 'bank_statement' }, PDF('same'));
    await read(first, SURE());
    expect(await job(first)).toBe('filed');
    const again = await sent(a, 'w-dup-2', { kind: 'bank_statement' }, PDF('same'));
    await read(again, SURE());
    expect(await job(again)).toBe('not_sure');
    // A kind the pages read that the app may not send.
    const receipt = await sent(a, 'w-kind', {});
    await read(receipt, {
      ...SURE(),
      type_key: { value: 'warranty', confidence: 0.95, cue: 'kind_words' },
    });
    expect(await job(receipt)).toBe('not_sure');
    // Not read yet.
    const unread = await sent(a, 'w-unread');
    expect(await job(unread)).toBe('not_sure');
    for (const id of ['w-hint', 'w-clash', 'w-dup-2', 'w-kind', 'w-unread']) {
      expect((await status(a, id)).state, id).toBe('waiting');
    }
  });

  it('the app no longer filing automatically: switched off between the read and the job, paused, waiting, removed, or its sending taken away', async () => {
    const a = await connect({}, 'Switches');
    const item = await sent(a, 'sw-1');
    await read(item, SURE());
    // Switched off by an owner since the worker read it.
    expect(
      (await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { auto_file: false }))
        .statusCode,
    ).toBe(200);
    expect(await job(item)).toBe('off');
    expect(
      (await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { auto_file: true }))
        .statusCode,
    ).toBe(200);
    // Paused.
    await h.decider(owner);
    expect((await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/pause`)).statusCode).toBe(
      200,
    );
    expect(await job(item)).toBe('off');
    await admin.query('update connected_app set paused_reason = null where id = $1', [a.appId]);
    // Its sending taken away.
    await admin.query(`update connected_app set scopes = '{documents.read}' where id = $1`, [
      a.appId,
    ]);
    expect(await job(item)).toBe('off');
    await admin.query(`update connected_app set scopes = '{documents.send}' where id = $1`, [
      a.appId,
    ]);
    // Waiting for its person again.
    await admin.query(
      `update connected_app set approval = 'waiting', approved_at = null where id = $1`,
      [a.appId],
    );
    expect(await job(item)).toBe('off');
    await admin.query(
      `update connected_app set approval = 'approved', approved_at = now() where id = $1`,
      [a.appId],
    );
    // On again: filed.
    expect(await job(item)).toBe('filed');
    // Removed: what it sends is no longer filed by itself.
    const later = await sent(a, 'sw-2');
    await read(later, SURE());
    await h.decider(owner);
    expect((await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}`)).statusCode).toBe(204);
    expect(await job(later)).toBe('off');
    const left = await admin.query<{ state: string }>(
      'select state from incoming_file where id = $1',
      [later],
    );
    expect(left.rows[0]?.state).toBe('received');
  });

  it('asked again in the filing’s own transaction: switched off after the job found it on, it waits', async () => {
    const a = await connect({}, 'Racing');
    const item = await sent(a, 'race-1');
    await read(item, SURE());
    const acc = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [owner.member_id],
    );
    const p = {
      accountId: acc.rows[0]?.account_id as string,
      sessionId: '',
      householdId: owner.household_id,
      memberId: owner.member_id,
      role: 'owner' as const,
      seesAdults: true,
    };
    const appOn = (
      h.apps.autoFile as unknown as {
        appOn: (trx: unknown, appId: string, householdId: string) => Promise<boolean>;
      }
    ).appOn.bind(h.apps.autoFile);
    // An owner switches it off once the job has found the app on, before
    // the filing holds the app: the filing asks again under that hold.
    const out = await h.batches.fileFromApp(
      p,
      item,
      { id: a.appId, name: 'Racing' },
      async (trx) => {
        await admin.query('update connected_app set auto_file = false where id = $1', [a.appId]);
        return appOn(trx, a.appId, owner.household_id);
      },
      { ip: null },
    );
    expect(out).toEqual({ filed: false, why: 'off' });
    expect((await status(a, 'race-1')).state).toBe('waiting');
    // And a pause that comes while the filing holds the app waits for it.
    await admin.query('update connected_app set auto_file = true where id = $1', [a.appId]);
    const pause: { done?: Promise<unknown> } = {};
    const filed = await h.batches.fileFromApp(
      p,
      item,
      { id: a.appId, name: 'Racing' },
      async (trx) => {
        const on = await appOn(trx, a.appId, owner.household_id);
        const paused = admin.query(
          `update connected_app set paused_reason = 'owner' where id = $1`,
          [a.appId],
        );
        pause.done = paused;
        // Not yet: it waits for this filing's hold on the app.
        const settled = await Promise.race([
          paused.then(() => 'done'),
          new Promise((r) => setTimeout(() => r('waiting'), 300)),
        ]);
        expect(settled).toBe('waiting');
        return on;
      },
      { ip: null },
    );
    expect(filed.filed).toBe(true);
    await pause.done;
    const kept = await admin.query<{ state: string }>(
      `select state from connected_app_intake where app_id = $1 and external_id = 'race-1'`,
      [a.appId],
    );
    expect(kept.rows[0]?.state).toBe('filed');
  });

  it('a job for an item filed, withdrawn, or made up is nothing to do; two at once file it once', async () => {
    const a = await connect({}, 'Twice');
    const item = await sent(a, 'tw-1');
    await read(item, SURE());
    const both = await Promise.all([job(item), job(item)]);
    expect(both.sort()).toEqual(['filed', 'gone']);
    const docs = await admin.query<{ n: string }>(
      `select count(*) as n from document where id = (select document_id from incoming_file where id = $1)`,
      [item],
    );
    expect(Number(docs.rows[0]?.n)).toBe(1);
    expect(await job(item)).toBe('gone');
    // Withdrawn by the app before the job ran.
    const gone = await sent(a, 'tw-2');
    await read(gone, SURE());
    expect((await call(a, 'DELETE', '/api/v1/apps/intake/tw-2')).statusCode).toBe(200);
    expect(await job(gone)).toBe('gone');
    // Nothing of the household's, or nothing at all.
    expect(
      await h.apps.autoFile.fileReady({
        household_id: owner.household_id,
        item_id: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBe('gone');
    expect(await h.apps.autoFile.fileReady({ household_id: 'x', item_id: item })).toBe('malformed');
  });

  it('for a backfill’s window alone: files while it lasts, and not after', async () => {
    const until = new Date(Date.now() + 5 * 864e5).toISOString();
    const a = await connect(
      {
        auto_file: false,
        backfill: { until, files_per_day: 300, bytes_per_day: 1024 ** 3, auto_file: true },
      },
      'Backfill',
    );
    expect(a.view.auto_file).toBe(false);
    expect(a.view.backfill).toMatchObject({ auto_file: true });
    expect((await call(a, 'GET', '/api/v1/apps/me')).json<AppMe>()).toMatchObject({
      send: { auto_file: false },
      backfill: { auto_file: true },
    });
    const item = await sent(a, 'bf-1');
    await read(item, SURE());
    expect(await job(item)).toBe('filed');
    const late = await sent(a, 'bf-2');
    await read(late, SURE());
    await admin.query(
      `update connected_app set backfill_until = now() - interval '1 second' where id = $1`,
      [a.appId],
    );
    expect(await job(late)).toBe('off');
    expect((await status(a, 'bf-2')).state).toBe('waiting');
  });

  it('a file arriving while another of the same batch is filed: both finish, neither deadlocks', async () => {
    const a = await connect({}, 'Busy');
    const first = await sent(a, 'busy-1');
    await read(first, SURE());
    const acc = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [owner.member_id],
    );
    const p = {
      accountId: acc.rows[0]?.account_id as string,
      sessionId: '',
      householdId: owner.household_id,
      memberId: owner.member_id,
      role: 'owner' as const,
      seesAdults: true,
    };
    const appOn = (
      h.apps.autoFile as unknown as {
        appOn: (trx: unknown, appId: string, householdId: string) => Promise<boolean>;
      }
    ).appOn.bind(h.apps.autoFile);
    // The next file of the batch is sent while the filing holds the app: it
    // waits for the filing, which takes the batch and the item after.
    const arriving: { send?: Promise<string> } = {};
    const filed = await h.batches.fileFromApp(
      p,
      first,
      { id: a.appId, name: 'Busy' },
      async (trx) => {
        const on = await appOn(trx, a.appId, owner.household_id);
        arriving.send = sent(a, 'busy-2');
        await new Promise((r) => setTimeout(r, 300));
        return on;
      },
      { ip: null },
    );
    expect(filed.filed).toBe(true);
    const second = await arriving.send;
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    // A send's own order, held by hand: the app, then (once the filing waits)
    // the batch for update. The filing waits on the app before it takes the
    // batch, so the send's batch is free, and nothing deadlocks (40P01).
    const third = await sent(a, 'busy-order');
    await read(third, SURE());
    const tx = await admin.connect();
    try {
      await tx.query('begin');
      await tx.query('select id from connected_app where id = $1 for no key update', [a.appId]);
      const filing = job(third);
      await new Promise((r) => setTimeout(r, 300));
      await tx.query('select id from intake_batch where id = $1 for update', [
        await batchOf(third),
      ]);
      await tx.query('commit');
      expect(await filing).toBe('filed');
    } finally {
      tx.release();
    }
    // And many at once, sends and filings of one batch: every one finishes.
    await read(second as string, SURE());
    const more = await Promise.all([
      job(second as string),
      sent(a, 'busy-3'),
      sent(a, 'busy-4'),
      sent(a, 'busy-5'),
    ]);
    expect(more[0]).toBe('filed');
    const fourth = more[1];
    await read(fourth, SURE());
    const again = await Promise.all([job(fourth), sent(a, 'busy-6'), job(more[2])]);
    expect(again[0]).toBe('filed');
    expect(again[2]).toBe('not_sure');
  });

  it('a grown-up child’s own sensitive paper starts as Only me, filed automatically or by Accept all Ready (H1a)', async () => {
    await admin.query(
      `update member set relationship = 'son', date_of_birth = current_date - interval '20 years'
        where id = $1`,
      [ahmed.member_id],
    );
    const a = await connect({ member_id: ahmed.member_id, auto_file: true }, 'Ahmed’s filer');
    await h.decider(ahmed);
    expect(
      (await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`)).statusCode,
    ).toBe(200);
    const his = (): DetailProposal => ({
      ...SURE(),
      owner_member_id: { value: ahmed.member_id, confidence: 0.95, cue: 'name_on_page' },
    });
    const auto = await sent(a, 'son-1', { kind: 'bank_statement', title: 'His statement' });
    await read(auto, his());
    expect(await job(auto)).toBe('filed');
    const visOf = async (item: string) =>
      (
        await admin.query<{ visibility: string; owner_member_id: string }>(
          `select d.visibility, d.owner_member_id from document d
             join incoming_file f on f.document_id = d.id where f.id = $1`,
          [item],
        )
      ).rows[0];
    expect(await visOf(auto)).toEqual({ visibility: 'private', owner_member_id: ahmed.member_id });
    // The same paper through Accept all Ready, with the app no longer filing.
    expect(
      (await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { auto_file: false }))
        .statusCode,
    ).toBe(200);
    const ready = await sent(a, 'son-2', { kind: 'bank_statement', title: 'His other one' });
    await read(ready, his());
    expect(await job(ready)).toBe('off');
    const accepted = await send(
      ahmed,
      'POST',
      `/api/v1/batches/${await batchOf(ready)}/accept-ready`,
      { item_ids: [ready] },
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await visOf(ready)).toEqual({ visibility: 'private', owner_member_id: ahmed.member_id });
    await admin.query('update member set relationship = null, date_of_birth = null where id = $1', [
      ahmed.member_id,
    ]);
  });

  it('a person suspended here is never filed for, whatever they are in another household', async () => {
    const a = await connect({ member_id: ahmed.member_id, auto_file: true }, 'Two homes');
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    const item = await sent(a, 'away-1', { kind: 'bank_statement' });
    await read(item, {
      ...SURE(),
      owner_member_id: { value: ahmed.member_id, confidence: 0.95, cue: 'name_on_page' },
    });
    // Ahmed is an owner of another household too, and paused here.
    const acc = (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [ahmed.member_id],
      )
    ).rows[0]?.account_id as string;
    const other = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Elsewhere')", [other]);
    const there = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'Ahmed') returning id",
      [other],
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [acc, other, there.rows[0]?.id],
    );
    await admin.query(
      `update account_household set suspended_at = now(), suspend_reason = 'restored'
        where account_id = $1 and household_id = $2`,
      [acc, owner.household_id],
    );
    try {
      expect(await job(item)).toBe('off');
      // And in the filing's own transaction, too.
      const appOn = (
        h.apps.autoFile as unknown as {
          appOn: (trx: unknown, appId: string, householdId: string) => Promise<boolean>;
        }
      ).appOn.bind(h.apps.autoFile);
      const out = await h.batches.fileFromApp(
        {
          accountId: acc,
          sessionId: '',
          householdId: owner.household_id,
          memberId: ahmed.member_id,
          role: 'adult',
          seesAdults: true,
        },
        item,
        { id: a.appId, name: 'Two homes' },
        (trx) => appOn(trx, a.appId, owner.household_id),
        { ip: null },
      );
      expect(out).toEqual({ filed: false, why: 'off' });
      const kept = await admin.query<{ state: string }>(
        `select state from connected_app_intake where app_id = $1 and external_id = 'away-1'`,
        [a.appId],
      );
      expect(kept.rows[0]?.state).toBe('waiting');
    } finally {
      await admin.query(
        `update account_household set suspended_at = null, suspend_reason = null
          where account_id = $1 and household_id = $2`,
        [acc, owner.household_id],
      );
    }
  });

  it('switching it on widens what an app acting as another adult may do: it waits for them again; off does not', async () => {
    await h.decider(owner);
    const made = await send(owner, 'POST', '/api/v1/connected-apps', {
      name: 'Ahmed’s',
      member_id: ahmed.member_id,
      allowed_kinds: ['bank_statement'],
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<ConnectedAppView>().id;
    await h.decider(ahmed);
    expect((await send(ahmed, 'POST', `/api/v1/connected-apps/${id}/approve`)).statusCode).toBe(
      200,
    );
    const patch = async (body: Record<string, unknown>) => {
      await h.decider(owner);
      const r = await send(owner, 'PATCH', `/api/v1/connected-apps/${id}`, body);
      expect(r.statusCode, r.body).toBe(200);
      return r.json<ConnectedAppView>();
    };
    expect((await patch({ auto_file: true })).state).toBe('waiting_for_approval');
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${id}/approve`);
    expect((await patch({ auto_file: false })).state).toBe('active');
    // A backfill that files by itself widens too, even with the same window.
    const until = new Date(Date.now() + 3 * 864e5).toISOString();
    const window = { until, files_per_day: 200, bytes_per_day: 1024 ** 3 };
    expect((await patch({ backfill: window })).state).toBe('waiting_for_approval');
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${id}/approve`);
    expect((await patch({ backfill: { ...window, auto_file: true } })).state).toBe(
      'waiting_for_approval',
    );
    // Said as anything else an owner turned on: not a boolean of anything else.
    const bad = await send(owner, 'PATCH', `/api/v1/connected-apps/${id}`, { auto_file: 'yes' });
    expect(bad.statusCode).toBe(422);
  });
});
