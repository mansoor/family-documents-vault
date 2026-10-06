import type { Db } from '@fdv/db';
import { sql } from 'kysely';

/**
 * Whether this household lets its Only me documents out: "Only me documents
 * can be shared outside the family" (5.41; the owner's decision of 6 Oct
 * 2026), on unless an owner turned it off (0061). The database's own link
 * functions ask the same (app_only_me_shareable()).
 */
export async function onlyMeShareable(trx: Db): Promise<boolean> {
  const r = await sql<{ on: boolean }>`select app_only_me_shareable() as on`.execute(trx);
  return r.rows[0]?.on ?? true;
}
