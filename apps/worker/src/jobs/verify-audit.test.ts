import { randomUUID } from 'node:crypto';
import { appendAudit, withHousehold } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connections, verifyAllAuditChains } from './verify-audit.js';

describe.skipIf(!testAdminUrl())('audit.verify job', () => {
  let tdb: TestDatabase;
  let dbs: ReturnType<typeof connections>;
  const A = randomUUID();
  const B = randomUUID();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    dbs = connections(tdb.appUrl, tdb.adminUrl);
    for (const id of [A, B]) {
      await dbs.admin.query('insert into household (id, name) values ($1, $2)', [id, id]);
      await withHousehold(dbs.app, id, async (trx) => {
        await appendAudit(trx, { householdId: id, action: 'household.created' });
        await appendAudit(trx, { householdId: id, action: 'auth.signed_in' });
      });
    }
  });
  afterAll(async () => {
    await dbs.close();
    await tdb.drop();
  });

  it('reports every household clean, then finds the one that was tampered with', async () => {
    expect(await verifyAllAuditChains(dbs.admin, dbs.app)).toEqual({ households: 2, broken: [] });

    await dbs.admin.query('alter table audit_event disable trigger audit_event_no_update');
    await dbs.admin.query(`update audit_event set action = 'forged' where household_id = $1`, [B]);
    await dbs.admin.query('alter table audit_event enable trigger audit_event_no_update');

    const report = await verifyAllAuditChains(dbs.admin, dbs.app);
    expect(report.households).toBe(2);
    expect(report.broken).toHaveLength(1);
    expect(report.broken[0]?.household_id).toBe(B);
  });
});
