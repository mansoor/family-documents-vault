import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool, type Db } from '@fdv/db';
import type { Role } from '@fdv/shared';
import { createTestDatabase, type TestDatabase } from '@fdv/db/testing';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { AuthService, type Tokens } from './auth/service.js';
import { TotpService } from './auth/totp.js';
import { deriveSigningKey } from './auth/tokens.js';
import { loadConfig } from './config.js';
import { DocumentService } from './documents/service.js';
import { VisibilityService } from './documents/visibility.js';
import { ExportService } from './exports/service.js';
import { NotificationService } from './notifications/service.js';
import { ReminderService } from './reminders/service.js';
import { HouseholdService } from './household/service.js';
import { InvitationService } from './household/invitations.js';
import { CoOwnerService } from './household/co-owners.js';
import { ShareService } from './documents/shares.js';
import { AuditService } from './audit/service.js';
import { SealedSearchService } from './documents/sealed-search.js';
import { deriveSealedKey } from './documents/sealed-token.js';
import { PasskeyService, passkeyConfig } from './auth/passkeys.js';
import { StepUpService } from './auth/step-up.js';
import { PasswordService } from './auth/passwords.js';
import { SuggestionService } from './suggestions/service.js';
import { VaultService } from './vaults/service.js';

/**
 * A fully wired API on a throwaway database with a temp local vault.
 * Integration tests build one per file.
 */
export const TEST_MASTER = 'test-master-key-that-is-long-enough-0123456789';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  vaultDir: string;
  /** Jobs the API asked the worker to run. */
  jobs: Array<{ name: string; data: Record<string, unknown> }>;
  close(): Promise<void>;
  /** Runs first-run setup and returns the owner's tokens. */
  setup(overrides?: Partial<SetupBody>): Promise<Tokens>;
  /** Bearer header for a token set. */
  as(t: Tokens): { authorization: string };
  /**
   * A second person, through the real invitation path: invited by `owner`,
   * accepted with the link and the code. This is how the role tests get a
   * teen and a viewer to try things with.
   */
  join(owner: Tokens, who: JoinRequest): Promise<Tokens>;
}

export interface JoinRequest {
  name: string;
  email: string;
  role: Role;
  password?: string;
}

export interface SetupBody {
  household_name: string;
  display_name: string;
  email: string;
  password: string;
}

export async function createHarness(): Promise<Harness> {
  const tdb: TestDatabase = await createTestDatabase();
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-api-vault-'));
  const db = createDb(createPool(tdb.appUrl, 4));
  const config = loadConfig({
    DATABASE_URL: tdb.appUrl,
    FDV_MASTER_KEY: TEST_MASTER,
    FDV_LOCAL_VAULT_DIR: vaultDir,
    LOG_LEVEL: 'error',
  });
  const vaults = new VaultService(db, deriveKey(TEST_MASTER, 'vault-credentials'), vaultDir);
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  const jobs: Harness['jobs'] = [];
  const enqueue = async (name: string, data: Record<string, unknown>) => {
    jobs.push({ name, data });
  };
  const alert = (a: {
    householdId: string;
    accountIds: string[];
    subject: string;
    body: string;
    url?: string;
    urlLabel?: string;
    emailOnly?: boolean;
  }) =>
    enqueue('alert.send', {
      household_id: a.householdId,
      account_ids: a.accountIds,
      subject: a.subject,
      body: a.body,
      ...(a.url ? { url: a.url, url_label: a.urlLabel } : {}),
      ...(a.emailOnly ? { email_only: true } : {}),
    });
  const reminders = new ReminderService(db);
  const totp = new TotpService(
    db,
    deriveKey(TEST_MASTER, 'totp-secrets'),
    deriveSigningKey(TEST_MASTER),
  );
  const auth = new AuthService(
    db,
    deriveSigningKey(TEST_MASTER),
    keys,
    (trx, hh) => vaults.createDefaultLocal(trx, hh),
    alert,
    totp,
  );
  const passkeys = new PasskeyService(
    db,
    auth,
    passkeyConfig('http://localhost:8080', 'Test vault'),
  );
  const invitations = new InvitationService(db, keys, auth);
  let joined = 1;
  const stepUp = new StepUpService(db, passkeys, totp);
  const passwords = new PasswordService(db, keys, stepUp, 'http://localhost:8080', alert);
  const app = await buildApp(config, {
    serverVersion: '0.0.0-test',
    pingDatabase: async () => undefined,
    auth,
    totp,
    passkeys,
    stepUp: stepUp,
    passwords,
    visibility: new VisibilityService(db, keys),
    vaults,
    documents: new DocumentService(
      db,
      keys,
      vaults,
      5 * 1024 * 1024,
      enqueue,
      reminders,
      deriveSealedKey(TEST_MASTER),
    ),
    sealedSearch: new SealedSearchService(db, keys, deriveSealedKey(TEST_MASTER)),
    shares: new ShareService(db, keys, vaults),
    audit: new AuditService(db),
    reminders,
    notifications: new NotificationService(
      db,
      deriveKey(TEST_MASTER, 'smtp-credentials'),
      'test-vapid-public-key',
    ),
    exports: new ExportService(db, keys, vaults, enqueue),
    household: new HouseholdService(db, keys),
    invitations,
    coOwners: new CoOwnerService(db, alert),
    suggestions: new SuggestionService(db),
    logger: false,
  });

  return {
    app,
    db,
    vaultDir,
    jobs,
    async close() {
      await app.close();
      await db.destroy();
      await tdb.drop();
      await rm(vaultDir, { recursive: true, force: true });
    },
    async setup(overrides = {}) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: {
          household_name: 'The Test family',
          display_name: 'Owner',
          email: 'owner@example.test',
          password: 'correct horse battery',
          ...overrides,
        },
      });
      if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
      return res.json<Tokens>();
    },
    as: (t) => ({ authorization: `Bearer ${t.access_token}` }),
    async join(owner, who) {
      const invited = await app.inject({
        method: 'POST',
        url: '/api/v1/invitations',
        headers: { authorization: `Bearer ${owner.access_token}` },
        payload: { display_name: who.name, email: who.email, role: who.role },
      });
      if (invited.statusCode !== 201) throw new Error(`invite failed: ${invited.body}`);
      const { link_token, code } = invited.json<{ link_token: string; code: string }>();
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/v1/invitations/${link_token}/accept`,
        payload: { code, password: who.password ?? 'another correct horse' },
        // Accepting is rate-limited per address like signing in. Tests that
        // add several people would otherwise throttle themselves.
        remoteAddress: `10.8.${joined >> 8}.${joined++ & 0xff}`,
      });
      if (accepted.statusCode !== 201) throw new Error(`accept failed: ${accepted.body}`);
      return accepted.json<Tokens>();
    },
  };
}
