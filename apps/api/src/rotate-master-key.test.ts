import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  binding,
  checkMasterKey,
  DecryptStream,
  deriveKey,
  EnvKeyProvider,
  KEK_PURPOSE,
  ScopeKeys,
  unwrapKey,
  wrapKey,
  type ScopeKind,
} from '@fdv/crypto';
import { createDb, createPool } from '@fdv/db';
import { TEST_APP_PASSWORD, TEST_APP_ROLE, testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import { openCredentials, readAll, sealCredentials } from '@fdv/storage';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import { deriveSigningKey } from './auth/tokens.js';
import { codeFor, TotpService } from './auth/totp.js';
import { sealPassword } from './notifications/service.js';
import { openPassword } from './notifications/smtp-password.js';
import {
  newMasterKeyProblem,
  repairMasterKeyCommand,
  rotateMasterKeyCommand,
  type CommandOptions,
} from './rotate-master-key.js';
import { createHarness, TEST_MASTER, type Harness } from './test-harness.js';

/**
 * Rotating the master key (SEC-02). Until 0.5.0 it rewrapped the scope keys
 * and nothing else: every two-step sign-in secret, an S3 vault's
 * credentials and the household's mail password stayed sealed under the
 * old key — no owner could sign in, storage and mail broke — and the
 * sessions carried on, since refresh tokens do not depend on the key.
 *
 * What is sealed here is sealed by the vault's own code, and opened after
 * the rotation by the vault's own code with keys from the new master key,
 * as the restarted vault would. The command runs as the operator runs it,
 * as the owning role; --even-if-connected, since this file's own
 * connections stay open, except where that refusal is the point.
 */

const NEW = 'the-new-master-key-that-is-long-enough-9876543210';
/** A rotation after that one, by the old rotate-master-key: the scope keys alone. */
const NEWER = 'a-newer-master-key-that-is-long-enough-5555555555';
const FOREIGN = 'a-master-key-from-some-other-vault-0123456789';
const S3 = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'the-bucket-secret-key' };
const MAIL_PASSWORD = 'the household mail password';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

describe.skipIf(!testAdminUrl())('rotating the master key', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let accountId: string;
  let totpSecret: string;
  let vaultId: string;

  type Run = { code: number; out: string; err: string };
  const captured = async (
    command: (io: Pick<CommandOptions, 'out' | 'err'>) => Promise<number>,
  ): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await command({ out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const run = (
    next: string | undefined,
    current = TEST_MASTER,
    o: Partial<CommandOptions> = {},
  ): Promise<Run> =>
    captured((io) =>
      rotateMasterKeyCommand({
        current,
        next,
        adminUrl: h.adminUrl,
        evenIfConnected: true,
        ...io,
        ...o,
      }),
    );
  const repair = (current: string, previous: string | undefined): Promise<Run> =>
    captured((io) =>
      repairMasterKeyCommand({
        current,
        previous,
        adminUrl: h.adminUrl,
        evenIfConnected: true,
        ...io,
      }),
    );

  /** Every byte the master key protects, in a fixed order. */
  const sealedBytes = async () => {
    const all: string[] = [];
    for (const [table, column] of [
      ['scope_key', 'key_wrapped'],
      ['account', 'totp_secret'],
      ['vault', 'credentials_encrypted'],
      ['smtp_settings', 'password_encrypted'],
    ]) {
      const { rows } = await admin.query<{ v: string }>(
        `select encode(${column}, 'hex') as v from ${table} where ${column} is not null order by 1`,
      );
      all.push(...rows.map((r) => `${table}:${r.v}`));
    }
    return all;
  };

  /** Until some connection waits on a lock, or five seconds have passed. */
  const waitingOnALock = async () => {
    for (let i = 0; i < 50; i++) {
      const { rows } = await admin.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (rows[0]?.n) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const liveSessions = async () =>
    (
      await admin.query<{ n: number }>(
        'select count(*)::int as n from session where revoked_at is null',
      )
    ).rows[0]?.n;

  const upload = async (visibility: 'household' | 'adults' | 'private') => {
    const doc = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: { title: `A ${visibility} paper`, owner_member_id: owner.member_id, visibility },
      })
    ).json<DocumentView>();
    const form = new FormData();
    form.append('file', Buffer.concat([PDF, randomBytes(4096)]), {
      filename: `${visibility}.pdf`,
      contentType: 'application/pdf',
    });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(201);
  };

  beforeAll(async () => {
    h = await createHarness();
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    accountId = (await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) })).json<{
      account_id: string;
    }>().account_id;

    // Two-step sign-in, as an owner sets it up.
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    totpSecret = enrol.json<{ secret: string }>().secret;
    const confirmed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(totpSecret) },
    });
    expect(confirmed.statusCode).toBe(204);

    // The household's mail server, with a password.
    const smtp = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/smtp',
      headers: h.as(owner),
      payload: {
        provider: 'other',
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        username: 'vault',
        password: MAIL_PASSWORD,
        from_name: 'Family Document Vault',
        from_email: 'vault@example.test',
      },
    });
    expect(smtp.statusCode).toBe(200);

    // An S3 vault, its credentials sealed as VaultService.create seals them.
    vaultId = (
      await admin.query<{ id: string }>(
        `insert into vault (household_id, kind, label, endpoint, bucket)
         values ($1, 's3', 'Bucket', 'https://s3.example.test', 'fdv') returning id`,
        [owner.household_id],
      )
    ).rows[0]?.id as string;
    await admin.query('update vault set credentials_encrypted = $1 where id = $2', [
      sealCredentials(deriveKey(TEST_MASTER, 'vault-credentials'), S3, vaultId),
      vaultId,
    ]);

    // A file under each of the household's scope keys.
    for (const v of ['household', 'adults', 'private'] as const) await upload(v);
  });
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('refuses a new key that is the one in use, or would not survive .env, and changes nothing', async () => {
    expect(newMasterKeyProblem(TEST_MASTER, undefined)).toMatch(/must be set/);
    expect(newMasterKeyProblem(TEST_MASTER, 'too-short-0123456789')).toMatch(/at least 32/);
    for (const bad of [`${NEW}\n`, ` ${NEW}`, `${NEW} x`, `"${NEW}"`, `${NEW}$HOME`, `${NEW}#`]) {
      expect(newMasterKeyProblem(TEST_MASTER, bad)).toMatch(/only letters, digits/);
    }
    expect(newMasterKeyProblem(TEST_MASTER, NEW)).toBeNull();
    // What the README's command makes, and base64 and hex, all do.
    for (const good of [
      randomBytes(32).toString('base64url'),
      randomBytes(32).toString('base64'),
      randomBytes(32).toString('hex'),
    ]) {
      expect(newMasterKeyProblem(TEST_MASTER, good)).toBeNull();
    }

    const before = await sealedBytes();
    const same = await run(TEST_MASTER);
    expect(same.code).toBe(2);
    expect(same.err).toMatch(/already uses.*Nothing was changed/);
    const spaced = await run(`${NEW} `);
    expect(spaced.code).toBe(2);
    expect(await sealedBytes()).toEqual(before);
    expect(await liveSessions()).toBeGreaterThan(0);
  });

  it('refuses without DATABASE_ADMIN_URL, or as the application role, and changes nothing', async () => {
    const before = await sealedBytes();
    const sessions = await liveSessions();
    const none = await run(NEW, TEST_MASTER, { adminUrl: undefined });
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/DATABASE_ADMIN_URL is needed to rotate .*Nothing was changed/);

    // Row-level security hides every household's scope keys, S3 vault and
    // mail settings from the application role, but not the accounts: until
    // this refusal it moved the two-step secrets alone and said it was done.
    const app = new URL(h.adminUrl);
    app.username = TEST_APP_ROLE;
    app.password = TEST_APP_PASSWORD;
    const asApp = await run(NEW, TEST_MASTER, { adminUrl: app.toString() });
    expect(asApp.code).toBe(2);
    expect(asApp.err).toMatch(/row-level security applies to fdv_app_test.*Nothing was changed/);
    expect(asApp.out).toBe('');
    expect(await sealedBytes()).toEqual(before);
    expect(await liveSessions()).toBe(sessions);
  });

  it('refuses while anything else is connected to the database, and changes nothing', async () => {
    const before = await sealedBytes();
    const held = await admin.connect();
    try {
      const running = await run(NEW, TEST_MASTER, { evenIfConnected: false });
      expect(running.code).toBe(2);
      expect(running.err).toMatch(
        /^The vault is still running \(\d+ other connections? to its database\): docker compose stop api worker/,
      );
      expect(running.err).toContain('--even-if-connected');
    } finally {
      held.release();
    }
    expect(await sealedBytes()).toEqual(before);
  });

  it('stops, says nothing was changed, and changes nothing, when something else holds the tables', async () => {
    const before = await sealedBytes();
    const sessions = await liveSessions();
    // Something with an open transaction that has written to account.
    const held = await admin.connect();
    try {
      await held.query('begin');
      await held.query('update account set email = email where id = $1', [accountId]);
      const waited = await run(NEW, TEST_MASTER, { evenIfConnected: true, lockTimeoutSeconds: 1 });
      expect(waited.code).toBe(2);
      expect(waited.err).toBe(
        "Something else is writing to the vault's tables (waited 1 s). Nothing was changed: " +
          'stop what is connected (docker compose stop api worker) and run this again.',
      );
    } finally {
      await held.query('rollback');
      held.release();
    }
    expect(await sealedBytes()).toEqual(before);
    expect(await liveSessions()).toBe(sessions);

    // Anything else that goes wrong once it has begun says so too.
    const unreachable = await run(NEW, TEST_MASTER, {
      adminUrl: 'postgres://nobody@127.0.0.1:1/none',
    });
    expect(unreachable.code).toBe(1);
    expect(unreachable.err).toMatch(/^Nothing was changed: .*ECONNREFUSED/);
  });

  it('stops at anything that does not open, and leaves everything as it was', async () => {
    // The mail password is the last thing a rotation reaches: by then the
    // scope keys, the two-step secret and the S3 credentials have been
    // moved, in the same transaction.
    const { rows } = await admin.query<{ p: Buffer }>(
      'select password_encrypted as p from smtp_settings where household_id = $1',
      [owner.household_id],
    );
    const kept = rows[0]?.p as Buffer;
    const foreign = deriveKey(FOREIGN, 'smtp-credentials');
    await admin.query('update smtp_settings set password_encrypted = $1', [
      sealPassword(foreign, MAIL_PASSWORD, owner.household_id),
    ]);
    try {
      const before = await sealedBytes();
      const sessions = await liveSessions();
      const stopped = await run(NEW);
      expect(stopped.code).toBe(1);
      expect(stopped.err).toMatch(
        /^Nothing was changed\. These open with neither FDV_MASTER_KEY nor FDV_MASTER_KEY_NEW:\n {2}smtp_settings\.password_encrypted of [0-9a-f-]{36}\n/,
      );
      // The rest opens: it points to the repair.
      expect(stopped.err).toContain('repair-master-key');
      expect(await sealedBytes()).toEqual(before);
      expect(await liveSessions()).toBe(sessions);
      // The vault as it runs now still opens all of it.
      const totp = new TotpService(
        h.db,
        deriveKey(TEST_MASTER, 'totp-secrets'),
        deriveSigningKey(TEST_MASTER),
      );
      expect(await totp.verify(accountId, codeFor(totpSecret))).toBe(true);
    } finally {
      await admin.query('update smtp_settings set password_encrypted = $1', [kept]);
    }
  });

  describe('once rotated', () => {
    let scopeKeys: number;
    let sessions: number;
    let done: { code: number; out: string; err: string };

    beforeAll(async () => {
      scopeKeys = (await admin.query('select id from scope_key')).rowCount ?? 0;
      sessions = (await liveSessions()) ?? 0;
      expect(sessions).toBeGreaterThan(0);
      // Told to, it goes ahead although something is connected: here, a
      // vault still running on the old key, in the middle of adding a
      // person (their key wrapped under the old one) and signing somebody
      // in. The rotation waits for both, moves the new key too, and ends
      // that session too.
      const held = await admin.connect();
      try {
        await held.query('begin');
        const { rows } = await held.query<{ id: string }>(
          "insert into member (household_id, display_name) values ($1, 'Added') returning id",
          [owner.household_id],
        );
        const ref = {
          householdId: owner.household_id,
          kind: 'member' as const,
          memberId: rows[0]?.id ?? null,
        };
        await held.query(
          "insert into scope_key (household_id, kind, member_id, key_wrapped) values ($1, 'member', $2, $3)",
          [
            ref.householdId,
            ref.memberId,
            wrapKey(randomBytes(32), deriveKey(TEST_MASTER, KEK_PURPOSE), binding(ref)),
          ],
        );
        await held.query(
          `insert into session (account_id, household_id, refresh_hash, expires_at)
           values ($1, $2, $3, now() + interval '30 days')`,
          [accountId, owner.household_id, randomBytes(32)],
        );
        const rotating = run(NEW, TEST_MASTER, { evenIfConnected: true });
        await waitingOnALock();
        await held.query('commit');
        done = await rotating;
      } finally {
        held.release();
      }
      sessions += 1;
      scopeKeys += 1;
    });

    it('moved all of it in one go, and says what it moved: counts, never a secret', () => {
      expect(done.err).toBe('');
      expect(done.code).toBe(0);
      expect(done.out).toContain(`${scopeKeys} scope keys rewrapped`);
      expect(done.out).toContain('1 two-step sign-in secret sealed again');
      expect(done.out).toContain('1 storage (S3) credential sealed again');
      expect(done.out).toContain('1 mail (SMTP) password sealed again');
      expect(done.out).toContain(`${sessions} session${sessions === 1 ? '' : 's'} ended`);
      for (const secret of [NEW, TEST_MASTER, totpSecret, S3.secretAccessKey, MAIL_PASSWORD]) {
        expect(done.out).not.toContain(secret);
      }
    });

    it("an owner's two-step sign-in code verifies under the new key, and the old opens nothing", async () => {
      const totp = new TotpService(h.db, deriveKey(NEW, 'totp-secrets'), deriveSigningKey(NEW));
      expect(await totp.verify(accountId, codeFor(totpSecret))).toBe(true);
      const stale = new TotpService(
        h.db,
        deriveKey(TEST_MASTER, 'totp-secrets'),
        deriveSigningKey(TEST_MASTER),
      );
      await expect(stale.verify(accountId, codeFor(totpSecret))).rejects.toThrow();
    });

    it("an S3 vault's credentials open under the new key, as the storage adapter opens them", async () => {
      const vault = await admin.query<{ c: Buffer }>(
        'select credentials_encrypted as c from vault where id = $1',
        [vaultId],
      );
      expect(
        openCredentials(deriveKey(NEW, 'vault-credentials'), vault.rows[0]?.c as Buffer, vaultId),
      ).toEqual(S3);
    });

    it('the mail password opens under the new key, as the API and the worker open it', async () => {
      const smtp = await admin.query<{ p: Buffer }>(
        'select password_encrypted as p from smtp_settings where household_id = $1',
        [owner.household_id],
      );
      expect(
        openPassword(
          deriveKey(NEW, 'smtp-credentials'),
          smtp.rows[0]?.p as Buffer,
          owner.household_id,
        ),
      ).toBe(MAIL_PASSWORD);
    });

    it('every scope key opens under the new key, and opens its files', async () => {
      // All of them: the one added while it waited too.
      expect(await checkMasterKey(admin, NEW)).toEqual({ checked: scopeKeys + 3 });
      const keys = new ScopeKeys(new EnvKeyProvider(NEW));
      // As the owning role, which every household's rows are open to.
      const db = createDb(createPool(h.adminUrl, 1));
      const scopes = new Set<string>();
      let versions = 0;
      try {
        for (const v of await db.selectFrom('document_version').selectAll().execute()) {
          const scopeKey = await keys.unwrapById(db, v.wrapped_by_scope);
          const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
          const dec = new DecryptStream(fileKey);
          Readable.from([await readFile(path.join(h.vaultDir, v.storage_key))]).pipe(dec);
          const plain = await readAll(dec);
          expect(createHash('sha256').update(plain).digest().equals(v.sha256)).toBe(true);
          scopes.add(v.wrapped_by_scope);
          versions += 1;
        }
      } finally {
        await db.destroy();
      }
      const opened = { versions, scopes: scopes.size };
      // Household, adults and the owner's own: one file under each.
      expect(opened).toEqual({ versions: 3, scopes: 3 });
    });

    it('run again, it says an earlier run finished, and changes nothing', async () => {
      const before = await sealedBytes();
      const again = await run(NEW);
      expect(again.err).toBe('');
      expect(again.code).toBe(0);
      expect(again.out).toMatch(/^The database is already on the new key: an earlier run finished/);
      expect(again.out).toContain('docker compose up -d');
      expect(await sealedBytes()).toEqual(before);
    });

    it('everybody is signed out: a refresh token does not depend on the key', async () => {
      expect(await liveSessions()).toBe(0);
      const refreshed = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refresh_token: owner.refresh_token },
      });
      expect(refreshed.statusCode).toBe(401);
    });
  });

  describe('a vault the old rotate-master-key left part under each key', () => {
    /** The old command's rotation from NEW to NEWER: the scope keys, nothing else. */
    beforeAll(async () => {
      const { rows } = await admin.query<{
        id: string;
        household_id: string;
        kind: ScopeKind;
        member_id: string | null;
        key_wrapped: Buffer;
      }>('select id, household_id, kind, member_id, key_wrapped from scope_key');
      for (const r of rows) {
        const b = binding({ householdId: r.household_id, kind: r.kind, memberId: r.member_id });
        const key = unwrapKey(r.key_wrapped, deriveKey(NEW, KEK_PURPOSE), b);
        await admin.query('update scope_key set key_wrapped = $1 where id = $2', [
          wrapKey(key, deriveKey(NEWER, KEK_PURPOSE), b),
          r.id,
        ]);
      }
      // And somebody signed in since, on the vault that half worked.
      await admin.query(
        `insert into session (account_id, household_id, refresh_hash, expires_at)
         values ($1, $2, $3, now() + interval '30 days')`,
        [accountId, owner.household_id, randomBytes(32)],
      );
    });

    it('a rotation refuses it, names what does not open, and points to the repair', async () => {
      const before = await sealedBytes();
      const refused = await run('yet-another-master-key-long-enough-777777777', NEWER);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(`account.totp_secret of ${accountId}`);
      expect(refused.err).toContain('repair-master-key');
      expect(await sealedBytes()).toEqual(before);
    });

    it('the repair wants the key before, and not the one in use', async () => {
      expect((await repair(NEWER, undefined)).code).toBe(2);
      const same = await repair(NEWER, NEWER);
      expect(same.code).toBe(2);
      expect(same.err).toMatch(/is the key the vault runs with/);
      // Given the key in .env as the one before, the rotation's own key was
      // lost: only a backup from before it helps.
      expect(same.err).toContain('repair-master-key cannot help');
      expect(same.err).toContain(
        'Restore a backup made before that rotation,\nwith this .env and without FDV_MASTER_KEY_PREVIOUS',
      );
    });

    it('the repair refuses, naming it, what opens with neither key, and changes nothing', async () => {
      const { rows } = await admin.query<{ p: Buffer }>(
        'select password_encrypted as p from smtp_settings where household_id = $1',
        [owner.household_id],
      );
      const kept = rows[0]?.p as Buffer;
      await admin.query('update smtp_settings set password_encrypted = $1', [
        sealPassword(deriveKey(FOREIGN, 'smtp-credentials'), MAIL_PASSWORD, owner.household_id),
      ]);
      try {
        const before = await sealedBytes();
        const refused = await repair(NEWER, NEW);
        expect(refused.code).toBe(1);
        expect(refused.err).toBe(
          'Nothing was changed. These open with neither FDV_MASTER_KEY nor FDV_MASTER_KEY_PREVIOUS:\n' +
            `  smtp_settings.password_encrypted of ${owner.household_id}`,
        );
        expect(await sealedBytes()).toEqual(before);
      } finally {
        await admin.query('update smtp_settings set password_encrypted = $1', [kept]);
      }
    });

    it('the repair moves it wholly onto the key in use, and signs everybody out', async () => {
      const done = await repair(NEWER, NEW);
      expect(done.err).toBe('');
      expect(done.code).toBe(0);
      expect(done.out).toContain('0 scope keys rewrapped');
      expect(done.out).toContain('1 two-step sign-in secret sealed again');
      expect(done.out).toContain('1 storage (S3) credential sealed again');
      expect(done.out).toContain('1 mail (SMTP) password sealed again');
      expect(done.out).toContain('1 session ended');
      expect(await liveSessions()).toBe(0);

      const totp = new TotpService(h.db, deriveKey(NEWER, 'totp-secrets'), deriveSigningKey(NEWER));
      expect(await totp.verify(accountId, codeFor(totpSecret))).toBe(true);
      const vault = await admin.query<{ c: Buffer }>(
        'select credentials_encrypted as c from vault where id = $1',
        [vaultId],
      );
      expect(
        openCredentials(deriveKey(NEWER, 'vault-credentials'), vault.rows[0]?.c as Buffer, vaultId),
      ).toEqual(S3);
      const smtp = await admin.query<{ p: Buffer }>(
        'select password_encrypted as p from smtp_settings where household_id = $1',
        [owner.household_id],
      );
      expect(
        openPassword(
          deriveKey(NEWER, 'smtp-credentials'),
          smtp.rows[0]?.p as Buffer,
          owner.household_id,
        ),
      ).toBe(MAIL_PASSWORD);

      const again = await repair(NEWER, NEW);
      expect(again.code).toBe(0);
      expect(again.out).toBe(
        'Everything already opens with FDV_MASTER_KEY: there is nothing to repair.',
      );
    });
  });
});
