import { createDb, createPool, verifyAuditChain, withHousehold, type Db } from '@fdv/db';
import type pg from 'pg';

export interface VerifyAuditReport {
  households: number;
  broken: Array<{
    household_id: string;
    broken_at: number | undefined;
    reason: string | undefined;
  }>;
}

/**
 * Walks every household's audit chain (SEC-16). Households are listed with
 * the owning role because the application role cannot see across tenants;
 * each chain is then verified under that household's own scope.
 */
export async function verifyAllAuditChains(admin: pg.Pool, app: Db): Promise<VerifyAuditReport> {
  const { rows } = await admin.query<{ id: string }>(
    'select id from household where deleted_at is null order by created_at',
  );
  const report: VerifyAuditReport = { households: rows.length, broken: [] };
  for (const { id } of rows) {
    const result = await withHousehold(app, id, (trx) => verifyAuditChain(trx, id));
    if (!result.ok) {
      report.broken.push({ household_id: id, broken_at: result.brokenAt, reason: result.reason });
    }
  }
  return report;
}

export function connections(appUrl: string, adminUrl: string) {
  const adminPool = createPool(adminUrl, 1);
  const appPool = createPool(appUrl, 2);
  return {
    admin: adminPool,
    app: createDb(appPool),
    close: async () => {
      await adminPool.end();
      await appPool.end();
    },
  };
}
