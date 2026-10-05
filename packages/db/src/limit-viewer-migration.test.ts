import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0055 (5.33, its review): a collection deleted, or for anybody
 * narrower than Everyone, is named in no grant. What 5.32 left naming one
 * is removed as 0055 runs, and from then on one deleted, or made for
 * fewer, leaves every grant as it changes.
 */
describe.skipIf(!testAdminUrl())(
  'migration 0055: only live collections for Everyone are granted',
  () => {
    let tdb: TestDatabase;
    let admin: pg.Pool;
    let dir: string;
    const hh = randomUUID();
    const viewer = randomUUID();
    const account = randomUUID();
    /** For Everyone and live; for Everyone and deleted; for Teens and up. */
    const made = { live: randomUUID(), deleted: randomUUID(), teens: randomUUID() };

    const granted = async () =>
      (
        await admin.query<{ collection_id: string }>(
          'select collection_id from access_restriction_collection order by collection_id',
        )
      ).rows.map((r) => r.collection_id);

    beforeAll(async () => {
      tdb = await createEmptyDatabase();
      admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
      // 0.5.34's schema: the restriction (0054), no 0055.
      dir = await mkdtemp(path.join(tmpdir(), 'fdv-0054-'));
      for (const m of await listMigrations()) {
        if (m.version <= 54) await copyFile(m.file, path.join(dir, path.basename(m.file)));
      }
      await migrateUp(admin, dir);
      await admin.query("insert into household (id, name) values ($1, 'Granted')", [hh]);
      await admin.query(
        `insert into member (id, household_id, display_name) values ($1, $2, 'Val')`,
        [viewer, hh],
      );
      await admin.query(`insert into account (id, email) values ($1, $2)`, [
        account,
        `val-${hh}@example.test`,
      ]);
      await admin.query(
        `insert into account_household (account_id, household_id, member_id, role)
       values ($1, $2, $3, 'viewer')`,
        [account, hh, viewer],
      );
      await admin.query(
        `insert into doc_collection (id, household_id, name, audience, deleted_at)
       values ($1, $4, 'Live', 'everyone', null),
              ($2, $4, 'Deleted', 'everyone', now()),
              ($3, $4, 'Teens', 'teens', null)`,
        [made.live, made.deleted, made.teens, hh],
      );
      await admin.query(
        'insert into access_restriction (member_id, household_id) values ($1, $2)',
        [viewer, hh],
      );
      for (const c of Object.values(made)) {
        await admin.query(
          `insert into access_restriction_collection (restricted_member_id, household_id, collection_id)
         values ($1, $2, $3)`,
          [viewer, hh, c],
        );
      }
      expect(await granted()).toHaveLength(3);
      // And now 0055, as an upgrade runs it.
      for (const m of await listMigrations()) {
        if (m.version > 54) await copyFile(m.file, path.join(dir, path.basename(m.file)));
      }
      await migrateUp(admin, dir);
    }, 120_000);

    afterAll(async () => {
      await admin?.end();
      await tdb?.drop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('what 5.32 left naming a deleted collection, or one not for Everyone, goes as 0055 runs', async () => {
      expect(await granted()).toEqual([made.live]);
    });

    it('a collection deleted from then on leaves every grant as it is deleted, and brought back is not given again', async () => {
      await admin.query('update doc_collection set deleted_at = now() where id = $1', [made.live]);
      expect(await granted()).toEqual([]);
      await admin.query('update doc_collection set deleted_at = null where id = $1', [made.live]);
      expect(await granted()).toEqual([]);
    });
  },
);
