import { appendAudit, withScope, type Db } from '@fdv/db';
import {
  adapterFromRow,
  LocalAdapter,
  PROVIDER_PRESETS,
  sealCredentials,
  type StorageAdapter,
  type TestResult,
} from '@fdv/storage';
import { ApiError } from '../errors.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';

/**
 * Vaults: where a household's files are kept. One local vault is created
 * at setup and activated after a self-test; S3-compatible vaults are added
 * through the Storage screen and cannot be activated until their Test passes.
 */

export interface VaultView {
  id: string;
  kind: 'local' | 's3';
  provider: string | null;
  label: string;
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  prefix: string | null;
  path_style: boolean;
  role: string;
  status: string;
  active: boolean;
  last_verified_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export interface NewS3Vault {
  provider: string;
  label?: string | undefined;
  endpoint?: string | null | undefined;
  region?: string | null | undefined;
  bucket: string;
  prefix?: string | null | undefined;
  pathStyle?: boolean | undefined;
  accessKeyId: string;
  secretAccessKey: string;
}

const ownerOnly = (p: Principal) => requireCapability(p, 'storage.manage');

export class VaultService {
  constructor(
    private readonly db: Db,
    private readonly credentialsKey: Buffer,
    private readonly localRoot: string,
  ) {}

  /** Called in setup's transaction: the zero-configuration local vault. */
  async createDefaultLocal(trx: Db, householdId: string): Promise<void> {
    const adapter = new LocalAdapter(this.localRoot);
    const test = await adapter.test();
    const vault = await trx
      .insertInto('vault')
      .values({
        household_id: householdId,
        kind: 'local',
        label: 'This computer',
        status: test.ok ? 'ok' : 'failed',
        last_verified_at: test.ok ? new Date() : null,
        last_error: test.ok ? null : (test.detail ?? test.message),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (test.ok) {
      await trx
        .updateTable('household')
        .set({ active_vault_id: vault.id })
        .where('id', '=', householdId)
        .execute();
    }
  }

  async list(p: Principal): Promise<VaultView[]> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const hh = await trx
        .selectFrom('household')
        .select('active_vault_id')
        .where('id', '=', p.householdId)
        .executeTakeFirstOrThrow();
      const rows = await trx.selectFrom('vault').selectAll().orderBy('created_at').execute();
      return rows.map((r) => this.view(r, hh.active_vault_id));
    });
  }

  async create(p: Principal, input: NewS3Vault, meta: RequestMeta): Promise<VaultView> {
    ownerOnly(p);
    const preset = PROVIDER_PRESETS[input.provider];
    if (!preset)
      throw new ApiError(422, 'validation_failed', 'Pick a storage provider from the list.');
    const endpoint = input.endpoint ?? (preset.endpoint || null);
    if (input.provider !== 'aws' && (!endpoint || /\{/.test(endpoint))) {
      throw new ApiError(422, 'validation_failed', 'Enter the address of your storage provider.');
    }
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .insertInto('vault')
        .values({
          household_id: p.householdId,
          kind: 's3',
          provider: input.provider,
          label: input.label ?? preset.name,
          endpoint,
          bucket: input.bucket,
          region: input.region ?? preset.region ?? null,
          prefix: input.prefix ?? null,
          path_style: input.pathStyle ?? preset.pathStyle,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const sealed = sealCredentials(
        this.credentialsKey,
        { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
        row.id,
      );
      await trx
        .updateTable('vault')
        .set({ credentials_encrypted: sealed })
        .where('id', '=', row.id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'vault.added',
        objectType: 'vault',
        objectId: row.id,
        detail: { provider: input.provider, bucket: input.bucket },
        ip: meta.ip,
      });
      return this.view(row, null);
    });
  }

  async test(p: Principal, vaultId: string): Promise<TestResult> {
    ownerOnly(p);
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await this.row(trx, vaultId);
      const result = await this.adapter(row).test();
      await trx
        .updateTable('vault')
        .set({
          status: result.ok ? 'ok' : 'failed',
          last_verified_at: result.ok ? new Date() : null,
          last_error: result.ok ? null : (result.detail ?? result.message),
        })
        .where('id', '=', vaultId)
        .execute();
      return result;
    });
  }

  /** STO-03: no activation without a passing test. */
  async activate(p: Principal, vaultId: string, meta: RequestMeta): Promise<void> {
    ownerOnly(p);
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await this.row(trx, vaultId);
      if (row.status !== 'ok') {
        throw new ApiError(
          409,
          'vault_untested',
          'Test this place first. Files are only sent somewhere that has passed a test.',
        );
      }
      await trx
        .updateTable('household')
        .set({ active_vault_id: vaultId })
        .where('id', '=', p.householdId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'vault.activated',
        objectType: 'vault',
        objectId: vaultId,
        ip: meta.ip,
      });
    });
  }

  async remove(p: Principal, vaultId: string, meta: RequestMeta): Promise<void> {
    ownerOnly(p);
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const hh = await trx
        .selectFrom('household')
        .select('active_vault_id')
        .where('id', '=', p.householdId)
        .executeTakeFirstOrThrow();
      if (hh.active_vault_id === vaultId) {
        throw new ApiError(
          409,
          'vault_in_use',
          'This is where your files are kept right now. Choose another place first.',
        );
      }
      const r = await trx.deleteFrom('vault').where('id', '=', vaultId).executeTakeFirst();
      if (Number(r.numDeletedRows) === 0)
        throw new ApiError(404, 'not_found', 'That place is not set up.');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'vault.removed',
        objectType: 'vault',
        objectId: vaultId,
        ip: meta.ip,
      });
    });
  }

  /** The adapter for the household's active vault; what uploads and downloads use. */
  async activeAdapter(
    trx: Db,
    householdId: string,
  ): Promise<{ vaultId: string; adapter: StorageAdapter }> {
    const hh = await trx
      .selectFrom('household')
      .select('active_vault_id')
      .where('id', '=', householdId)
      .executeTakeFirstOrThrow();
    if (!hh.active_vault_id) {
      throw new ApiError(
        503,
        'no_vault',
        'There is nowhere to keep files yet. Set up storage first.',
        {
          retriable: true,
        },
      );
    }
    const row = await this.row(trx, hh.active_vault_id);
    return { vaultId: row.id, adapter: this.adapter(row) };
  }

  async adapterById(trx: Db, vaultId: string): Promise<StorageAdapter> {
    return this.adapter(await this.row(trx, vaultId));
  }

  private async row(trx: Db, vaultId: string) {
    const row = await trx
      .selectFrom('vault')
      .selectAll()
      .where('id', '=', vaultId)
      .executeTakeFirst();
    if (!row) throw new ApiError(404, 'not_found', 'That place is not set up.');
    return row;
  }

  private adapter(row: Parameters<typeof adapterFromRow>[0]): StorageAdapter {
    return adapterFromRow(row, this.credentialsKey, this.localRoot);
  }

  private view(
    r: {
      id: string;
      kind: 'local' | 's3';
      provider: string | null;
      label: string;
      endpoint: string | null;
      bucket: string | null;
      region: string | null;
      prefix: string | null;
      path_style: boolean;
      role: string;
      status: string;
      last_verified_at: Date | null;
      last_error: string | null;
      created_at: Date;
    },
    activeId: string | null,
  ): VaultView {
    return {
      id: r.id,
      kind: r.kind,
      provider: r.provider,
      label: r.label,
      endpoint: r.endpoint,
      bucket: r.bucket,
      region: r.region,
      prefix: r.prefix,
      path_style: r.path_style,
      role: r.role,
      status: r.status,
      active: r.id === activeId,
      last_verified_at: r.last_verified_at,
      last_error: r.last_error,
      created_at: r.created_at,
    };
  }
}
