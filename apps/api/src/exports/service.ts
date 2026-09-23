import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, unwrapKey, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withScope, type Db } from '@fdv/db';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { Enqueue } from '../documents/service.js';
import { ApiError } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { requireCapability } from '../authz.js';

export interface ExportView {
  id: string;
  state: string;
  document_count: number | null;
  byte_size: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
}

/** Full export: request → worker builds the ZIP → download while it lasts. */
export class ExportService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    private readonly enqueue: Enqueue,
  ) {}

  async request(p: Principal, meta: RequestMeta): Promise<ExportView> {
    requireCapability(p, 'export.request');
    const row = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const r = await trx
        .insertInto('export')
        .values({ household_id: p.householdId, requested_by: p.accountId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'export.requested',
        objectType: 'export',
        objectId: r.id,
        ip: meta.ip,
      });
      return r;
    });
    await this.enqueue('export.build', { household_id: p.householdId, export_id: row.id });
    return view(row);
  }

  async list(p: Principal): Promise<ExportView[]> {
    const rows = await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx.selectFrom('export').selectAll().orderBy('created_at', 'desc').limit(20).execute(),
    );
    return rows.map(view);
  }

  async get(p: Principal, id: string): Promise<ExportView> {
    const row = await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx.selectFrom('export').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    if (!row) throw new ApiError(404, 'not_found', 'That export does not exist.');
    return view(row);
  }

  async content(
    p: Principal,
    id: string,
    meta: RequestMeta,
  ): Promise<{ stream: Readable; bytes: number }> {
    const ctx = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .selectFrom('export')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (
        !row ||
        row.state !== 'done' ||
        !row.storage_key ||
        !row.file_key_wrapped ||
        !row.wrapped_by_scope ||
        !row.vault_id
      ) {
        throw new ApiError(404, 'not_found', 'That export is not ready.');
      }
      if (row.expires_at && row.expires_at.getTime() < Date.now()) {
        throw new ApiError(410, 'export_expired', 'That export has expired. Make a new one.');
      }
      if (row.requested_by !== p.accountId && p.role !== 'owner') {
        throw new ApiError(
          403,
          'forbidden',
          'Only the person who made this export can download it.',
        );
      }
      const scopeKey = await this.keys.unwrapById(trx, row.wrapped_by_scope);
      const fileKey = unwrapKey(row.file_key_wrapped, scopeKey, `export:${row.id}`);
      const adapter = await this.vaults.adapterById(trx, row.vault_id);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'export.downloaded',
        objectType: 'export',
        objectId: row.id,
        ip: meta.ip,
      });
      return { row, fileKey, adapter };
    });
    const dec = new DecryptStream(ctx.fileKey);
    const cipher = await ctx.adapter.get(ctx.row.storage_key as string);
    void pipeline(cipher, dec).catch(() => undefined);
    return { stream: dec, bytes: Number(ctx.row.byte_size ?? 0) };
  }
}

function view(r: {
  id: string;
  state: string;
  document_count: number | null;
  byte_size: string | number | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
}): ExportView {
  return {
    id: r.id,
    state: r.state,
    document_count: r.document_count,
    byte_size: r.byte_size === null ? null : Number(r.byte_size),
    error: r.error,
    created_at: r.created_at.toISOString(),
    finished_at: r.finished_at?.toISOString() ?? null,
    expires_at: r.expires_at?.toISOString() ?? null,
  };
}
