import type { Db } from '@fdv/db';
import { sql } from 'kysely';

/** Where a link or request was last emailed, masked, and who had the vault send it. */
export interface LastEmailed {
  to: string;
  /** The sender's name in the family, as the reader is given it; null if not. */
  by: string | null;
}

/**
 * The last email the vault sent of each of these links or requests (0.9.0;
 * the owner's decision of 16 Nov 2026): to whom, masked (j•••@e•••.com),
 * and by whom. The database gives a row to whoever sees its link or request
 * (0108), so the family can tell a paper was sent and to which inbox; the
 * caller lists only links and requests the reader may see.
 */
export async function lastEmailed(
  trx: Db,
  table: 'share_link_email' | 'upload_request_email',
  column: 'share_id' | 'request_id',
  ids: readonly string[],
): Promise<Map<string, LastEmailed>> {
  if (ids.length === 0) return new Map();
  const key = sql.ref(`e.${column}`);
  const rows = await sql<{ id: string; to_masked: string; by_name: string | null }>`
    select distinct on (${key}) ${key} as id, e.to_masked, m.display_name as by_name
      from ${sql.table(table)} e
      left join account_household ah
        on ah.account_id = e.sent_by and ah.household_id = e.household_id
      left join member m on m.id = ah.member_id
     where ${key} = any(${[...ids]}::uuid[])
     order by ${key}, e.sent_at desc`.execute(trx);
  return new Map(rows.rows.map((r) => [r.id, { to: r.to_masked, by: r.by_name }]));
}
