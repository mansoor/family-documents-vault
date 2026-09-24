import type { Db } from '@fdv/db';

/**
 * This installation's identifier, read once and remembered: it is made
 * when the database is (migration 0021) and never changes. A failure is
 * thrown, not remembered, so the caller can report it and the next call
 * asks again.
 */
export function instanceIdReader(db: Db): () => Promise<string | null> {
  let known: string | null = null;
  return async () => {
    if (known) return known;
    const row = await db.selectFrom('instance').select('instance_id').executeTakeFirst();
    known = row?.instance_id ?? null;
    return known;
  };
}
