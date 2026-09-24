import type { Db } from '@fdv/db';

/**
 * This installation's identifier, read once and remembered: it is made
 * when the database is (migration 0021) and never changes. A failure is
 * not remembered, so a database that was not ready yet is asked again.
 */
export function instanceIdReader(db: Db): () => Promise<string | null> {
  let known: string | null = null;
  return async () => {
    if (known) return known;
    try {
      const row = await db.selectFrom('instance').select('instance_id').executeTakeFirst();
      known = row?.instance_id ?? null;
    } catch {
      return null;
    }
    return known;
  };
}
