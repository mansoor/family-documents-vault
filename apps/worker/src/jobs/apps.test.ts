import { randomUUID } from 'node:crypto';
import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool, withSystem } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CHANGES_KEEP_DAYS, APP_LINKS_KEEP_DAYS, sweepApps } from './apps.js';

/**
 * The connected apps' hourly sweep (0.9.0, APP2): an app's changes feed
 * keeps 90 days of lines; what is let go is noted on the app first, so a
 * cursor from before it is answered as too old, never as nothing new. A
 * removed app's feed goes at once.
 */
describe.skipIf(!testAdminUrl())("the connected apps' sweep: the changes feed (APP2)", () => {
  let vault: TestDatabase;
  let admin: pg.Pool;
  let live: string;
  let gone: string;
  let hh: string;

  beforeAll(async () => {
    vault = await createTestDatabase();
    admin = new pg.Pool({ connectionString: vault.adminUrl, max: 1 });
    hh = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Swept')", [hh]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'One') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      'insert into account (email) values ($1) returning id',
      [`sweep-${hh}@example.test`],
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, hh, m.rows[0]?.id],
    );
    const app = async (name: string) =>
      (
        await admin.query<{ id: string }>(
          `insert into connected_app (household_id, name, account_id, member_id, created_by, approval, approved_at)
           values ($1, $2, $3, $4, $3, 'approved', now()) returning id`,
          [hh, name, a.rows[0]?.id, m.rows[0]?.id],
        )
      ).rows[0]?.id as string;
    live = await app('Live');
    gone = await app('Gone');
    for (const id of [live, gone]) {
      // Two lines long ago, one now; and what it was told of two documents.
      for (const days of [APP_CHANGES_KEEP_DAYS + 5, APP_CHANGES_KEEP_DAYS + 1, 0]) {
        await admin.query(
          `insert into connected_app_change (household_id, app_id, document_id, change, at)
           values ($1, $2, $3, 'changed', now() - make_interval(days => $4))`,
          [hh, id, randomUUID(), days],
        );
      }
      await admin.query(
        `insert into connected_app_seen (household_id, app_id, document_id, fingerprint, available, changed_at)
         values ($1, $2, $3, $4, false, now() - make_interval(days => $5)),
                ($1, $2, $6, $4, true, now() - make_interval(days => $5))`,
        [hh, id, randomUUID(), Buffer.alloc(32), APP_CHANGES_KEEP_DAYS + 1, randomUUID()],
      );
    }
    await admin.query(
      "update connected_app set revoked_at = now(), revoked_reason = 'owner' where id = $1",
      [gone],
    );
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await vault?.drop();
  });

  it('keeps 90 days of a feed, says where it was cut, and lets a removed app’s go', async () => {
    const before = await admin.query<{ seq: string }>(
      'select seq from connected_app_change where app_id = $1 order by seq',
      [live],
    );
    const swept = await sweepApps(admin);
    expect(swept.changes).toBe(2 + 3);
    const left = await admin.query<{ app_id: string; seq: string }>(
      'select app_id, seq from connected_app_change order by seq',
    );
    expect(left.rows).toEqual([{ app_id: live, seq: before.rows[2]?.seq }]);
    const app = await admin.query<{ cut: string }>(
      'select changes_pruned_to as cut from connected_app where id = $1',
      [live],
    );
    // The last line let go: a cursor before it is too old.
    expect(app.rows[0]?.cut).toBe(before.rows[1]?.seq);
    // What it was told of a document gone for 90 days is let go; of one it still reads, kept.
    const seen = await admin.query<{ app_id: string; available: boolean }>(
      'select app_id, available from connected_app_seen order by app_id',
    );
    expect(seen.rows).toEqual([{ app_id: live, available: true }]);
    // Swept again: nothing more.
    expect((await sweepApps(admin)).changes).toBe(0);
  });
});

/**
 * The sweep and an app's links (APP3): kept 8 days after they were minted,
 * so Settings can say how many were opened this week; a removed app's go
 * at once.
 */
describe.skipIf(!testAdminUrl())("the connected apps' sweep: links (APP3)", () => {
  let vault: TestDatabase;
  let admin: pg.Pool;
  const hh = randomUUID();
  const keys = new ScopeKeys(new EnvKeyProvider('apps-sweep-test-master-key-with-32-bytes'));
  let live = '';
  let gone = '';

  beforeAll(async () => {
    vault = await createTestDatabase();
    admin = new pg.Pool({ connectionString: vault.adminUrl, max: 2 });
    const db = createDb(createPool(vault.appUrl, 2));
    await admin.query("insert into household (id, name) values ($1, 'Linked')", [hh]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'One') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      'insert into account (email) values ($1) returning id',
      [`links-${hh}@example.test`],
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, hh, m.rows[0]?.id],
    );
    let storage = '';
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      storage = (
        await trx
          .insertInto('vault')
          .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    await db.destroy();
    const scope = (
      await admin.query<{ id: string }>(
        "select id from scope_key where household_id = $1 and kind = 'household'",
        [hh],
      )
    ).rows[0]?.id as string;
    const doc = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title) values ($1, 'Linked') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const version = (
      await admin.query<{ id: string }>(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
         values ($1, $2, 1, 'a.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4, '\\x00', $5)
         returning id`,
        [hh, doc, `${hh}/${doc}/1/${randomUUID()}.enc`, storage, scope],
      )
    ).rows[0]?.id as string;
    const app = async (name: string) =>
      (
        await admin.query<{ id: string }>(
          `insert into connected_app (household_id, name, account_id, member_id, created_by, approval, approved_at)
           values ($1, $2, $3, $4, $3, 'approved', now()) returning id`,
          [hh, name, a.rows[0]?.id, m.rows[0]?.id],
        )
      ).rows[0]?.id as string;
    live = await app('Live');
    gone = await app('Gone');
    // Each: a link minted long ago, one a day short of that, and one now.
    for (const id of [live, gone]) {
      for (const days of [APP_LINKS_KEEP_DAYS + 1, APP_LINKS_KEEP_DAYS - 1, 0]) {
        await admin.query(
          `insert into connected_app_link (household_id, app_id, document_id, version_id, mode,
                                           token_hash, created_at, open_by)
           values ($1, $2, $3, $4, 'view', gen_random_bytes(32),
                   now() - make_interval(days => $5), now() - make_interval(days => $5))`,
          [hh, id, doc, version, days],
        );
      }
    }
    await admin.query(
      "update connected_app set revoked_at = now(), revoked_reason = 'owner' where id = $1",
      [gone],
    );
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await vault?.drop();
  });

  it('keeps a link 8 days, and lets a removed app’s go at once', async () => {
    const swept = await sweepApps(admin);
    expect(swept.links).toBe(1 + 3);
    const left = await admin.query<{ app_id: string; n: number }>(
      'select app_id, count(*)::int as n from connected_app_link group by app_id',
    );
    expect(left.rows).toEqual([{ app_id: live, n: 2 }]);
    expect((await sweepApps(admin)).links).toBe(0);
  });
});
