import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  binding,
  deriveKey,
  KEK_PURPOSE,
  newKey,
  openBound,
  sealBound,
  unwrapKey,
  wrapKey,
  type ScopeRef,
} from '@fdv/crypto';
import {
  createEmptyDatabase,
  createTestDatabase,
  testAdminUrl,
  type TestDatabase,
} from '@fdv/db/testing';
import { openCredentials, sealCredentials } from '@fdv/storage';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDatabase } from './backup.js';
import { openPassword } from './notify.js';
import { backupKeyFor } from './restore-keys.js';
import { restoreBackup, RestoreIncomplete, type RestoreTarget } from './restore.js';
import { sealPassword } from './seal-test-helper.js';

/**
 * A backup made before the master key was rotated (README, "Rotating the
 * master key"). Its file is encrypted under the old key's backup key, and
 * what it holds — scope keys, the two-step sign-in secret, an S3 vault's
 * credentials, the mail password — is sealed under the old key. Until the
 * fix, rotating made every such backup unreadable.
 */

const OLD = 'the-old-master-key-with-at-least-32-bytes-000';
const NEW = 'the-new-master-key-with-at-least-32-bytes-111';
const S3 = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'the-bucket-secret-key' };
const TOTP = 'JBSWY3DPEHPK3PXP';
const MAIL = 'the household mail password';
const quiet = () => undefined;
const backupKey = (secret: string) => deriveKey(secret, 'database-backup');

/** pg_dump and psql of the server's major version: see restore.test.ts. */
async function matchingPgBin(): Promise<string | null> {
  const url = testAdminUrl();
  if (!url) return null;
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  let major: number;
  try {
    const { rows } = await pool.query<{ v: string }>(
      "select current_setting('server_version_num') as v",
    );
    major = Math.floor(Number(rows[0]?.v) / 10000);
  } finally {
    await pool.end();
  }
  const candidates = [
    process.env.FDV_TEST_PG_BIN,
    '',
    `/usr/lib/postgresql/${major}/bin`,
    `/usr/libexec/postgresql${major}`,
  ].filter((d): d is string => d !== undefined);
  for (const dir of candidates) {
    const tool = (name: string) => (dir ? path.join(dir, name) : name);
    try {
      const dump = execFileSync(tool('pg_dump'), ['--version'], { encoding: 'utf8' });
      execFileSync(tool('psql'), ['--version'], { stdio: 'ignore' });
      if (Number(/(\d+)/.exec(dump.replace(/^[^)]*\)/, ''))?.[1]) === major) return dir;
    } catch {
      // not here
    }
  }
  return null;
}
const PG_BIN = await matchingPgBin().catch(() => null);
const MUST_RESTORE = process.env.CI === 'true';

describe.skipIf(!testAdminUrl() || (PG_BIN === null && !MUST_RESTORE))(
  'restoring a backup made before a rotation',
  () => {
    const made: TestDatabase[] = [];
    let dir: string;
    type Vault = { db: TestDatabase; household: string; account: string; vault: string };
    /** A vault whose keys and secrets are all under OLD. */
    let old: Vault;

    const db = async (fromTemplate: boolean) => {
      const t = fromTemplate ? await createTestDatabase() : await createEmptyDatabase();
      made.push(t);
      return t;
    };
    const query = async <T extends object>(url: string, text: string, values: unknown[] = []) => {
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      try {
        return (await pool.query<T>(text, values)).rows;
      } finally {
        await pool.end();
      }
    };

    /** A household with its three scope keys and each sealed secret, under `secret`. */
    async function vaultUnder(secret: string): Promise<Vault> {
      const t = await db(true);
      const boss = new PgBoss({
        connectionString: t.adminUrl,
        schema: 'pgboss',
        migrate: true,
        supervise: false,
        schedule: false,
      });
      await boss.start();
      await boss.stop({ graceful: false });
      const household = randomUUID();
      await query(t.adminUrl, "insert into household (id, name) values ($1, 'Rotated')", [
        household,
      ]);
      const [member] = await query<{ id: string }>(
        t.adminUrl,
        "insert into member (household_id, display_name) values ($1, 'One') returning id",
        [household],
      );
      const refs: ScopeRef[] = [
        { householdId: household, kind: 'household' },
        { householdId: household, kind: 'adults' },
        { householdId: household, kind: 'member', memberId: member?.id ?? null },
      ];
      for (const ref of refs) {
        await query(
          t.adminUrl,
          'insert into scope_key (household_id, kind, member_id, key_wrapped) values ($1, $2, $3, $4)',
          [
            household,
            ref.kind,
            ref.memberId ?? null,
            wrapKey(newKey(), deriveKey(secret, KEK_PURPOSE), binding(ref)),
          ],
        );
      }
      const [account] = await query<{ id: string }>(
        t.adminUrl,
        'insert into account (email) values ($1) returning id',
        [`${household}@example.test`],
      );
      const accountId = account?.id as string;
      await query(t.adminUrl, 'update account set totp_secret = $1 where id = $2', [
        sealBound(deriveKey(secret, 'totp-secrets'), Buffer.from(TOTP), `totp:${accountId}`),
        accountId,
      ]);
      const [vault] = await query<{ id: string }>(
        t.adminUrl,
        "insert into vault (household_id, kind, label, bucket) values ($1, 's3', 'B', 'b') returning id",
        [household],
      );
      const vaultId = vault?.id as string;
      await query(t.adminUrl, 'update vault set credentials_encrypted = $1 where id = $2', [
        sealCredentials(deriveKey(secret, 'vault-credentials'), S3, vaultId),
        vaultId,
      ]);
      await query(
        t.adminUrl,
        `insert into smtp_settings (household_id, host, username, password_encrypted, from_email)
         values ($1, 'smtp.example.test', 'vault', $2, 'vault@example.test')`,
        [household, sealPassword(deriveKey(secret, 'smtp-credentials'), MAIL, household)],
      );
      return { db: t, household, account: accountId, vault: vaultId };
    }

    const backup = async (from: TestDatabase, key: Buffer) =>
      (
        await backupDatabase({
          adminUrl: from.adminUrl,
          backupKey: key,
          dir: await mkdtemp(path.join(dir, 'b-')),
          retainDays: 30,
          log: quiet,
        })
      ).file;

    /** Opens every key and secret of the restored household under `secret`, as the vault does. */
    async function opensUnder(t: TestDatabase, secret: string, v: Vault = old) {
      const keys = await query<{
        household_id: string;
        kind: ScopeRef['kind'];
        member_id: string | null;
        key_wrapped: Buffer;
      }>(t.adminUrl, 'select household_id, kind, member_id, key_wrapped from scope_key');
      for (const k of keys) {
        const ref = { householdId: k.household_id, kind: k.kind, memberId: k.member_id };
        unwrapKey(k.key_wrapped, deriveKey(secret, KEK_PURPOSE), binding(ref));
      }
      const [a] = await query<{ s: Buffer }>(
        t.adminUrl,
        'select totp_secret as s from account where id = $1',
        [v.account],
      );
      const [c] = await query<{ c: Buffer }>(
        t.adminUrl,
        'select credentials_encrypted as c from vault where id = $1',
        [v.vault],
      );
      const [m] = await query<{ p: Buffer }>(
        t.adminUrl,
        'select password_encrypted as p from smtp_settings where household_id = $1',
        [v.household],
      );
      return {
        scopeKeys: keys.length,
        totp: openBound(
          deriveKey(secret, 'totp-secrets'),
          a?.s as Buffer,
          `totp:${v.account}`,
        ).toString(),
        s3: openCredentials(deriveKey(secret, 'vault-credentials'), c?.c as Buffer, v.vault),
        mail: openPassword(deriveKey(secret, 'smtp-credentials'), m?.p as Buffer, v.household),
      };
    }
    const everything = { scopeKeys: 3, totp: TOTP, s3: S3, mail: MAIL };

    /** A restore as the command line runs it, in a vault whose master key is NEW. */
    const restore = (file: string, into: TestDatabase, master: RestoreTarget['master']) =>
      restoreBackup(
        file,
        backupKey(NEW),
        { adminUrl: into.adminUrl, appUrl: into.appUrl, master },
        quiet,
      );

    beforeAll(async () => {
      if (PG_BIN === null) {
        throw new Error("pg_dump and psql of the test server's major version are needed here");
      }
      if (PG_BIN) process.env.PATH = `${PG_BIN}${path.delimiter}${process.env.PATH ?? ''}`;
      dir = await mkdtemp(path.join(tmpdir(), 'fdv-rotated-'));
      old = await vaultUnder(OLD);
    }, 120_000);
    afterAll(async () => {
      for (const t of made) await t.drop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('comes back under the current key, given the key it was made with', async () => {
      const file = await backup(old.db, backupKey(OLD));
      expect((await backupKeyFor(file, backupKey(NEW), OLD)).equals(backupKey(OLD))).toBe(true);

      const t = await db(false);
      const report = await restore(file, t, { current: NEW, previous: OLD });
      expect(report).toMatchObject({
        households: 1,
        rekeyed: {
          rewrapped: 3,
          resealed: { totpSecrets: 1, vaultCredentials: 1, smtpPasswords: 1 },
        },
      });
      expect(await opensUnder(t, NEW)).toEqual(everything);
      await expect(opensUnder(t, OLD)).rejects.toThrow();
    }, 120_000);

    it('without that key restores nothing, and never leaves a vault half under each', async () => {
      const file = await backup(old.db, backupKey(OLD));
      const empty = await db(false);
      await expect(restore(file, empty, { current: NEW })).rejects.toThrow(/could not be read/);
      const [tables] = await query<{ n: number }>(
        empty.adminUrl,
        "select count(*)::int as n from pg_tables where schemaname = 'public'",
      );
      expect(tables?.n).toBe(0);

      // A file that opens with this vault's key, holding keys under another:
      // loaded, then refused whole — every key still as the backup had it.
      const mismatched = await backup(old.db, backupKey(NEW));
      const t = await db(false);
      const refused = restore(mismatched, t, { current: NEW });
      await expect(refused).rejects.toBeInstanceOf(RestoreIncomplete);
      await expect(refused).rejects.toThrow(/FDV_MASTER_KEY_PREVIOUS/);
      expect(await opensUnder(t, OLD)).toEqual(everything);
    }, 120_000);

    it('a backup taken between the rotation and the restart comes back as it is', async () => {
      // The nightly backup ran with the old key in the worker while the
      // database was already on the new one.
      const rotated = await vaultUnder(NEW);
      const file = await backup(rotated.db, backupKey(OLD));
      const t = await db(false);
      const report = await restore(file, t, { current: NEW, previous: OLD });
      expect(report.rekeyed).toBeNull();
      expect(await opensUnder(t, NEW, rotated)).toEqual(everything);
    }, 120_000);
  },
);
