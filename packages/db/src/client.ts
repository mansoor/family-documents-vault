import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

/**
 * The database schema as seen by Kysely. Tables are added by the iteration
 * that creates them, so this interface always matches the latest migration.
 */
export interface Schema {
  schema_migration: {
    version: number;
    name: string;
    applied_at: Date;
  };
}

export type Db = Kysely<Schema>;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Runs `fn` inside a transaction with `app.household_id` set for its duration.
 *
 * Every row-level-security policy reads `current_setting('app.household_id')`.
 * `set_config(..., true)` is transaction-local, so the value cannot leak to
 * the next borrower of the pooled connection.
 */
export async function withHousehold<T>(
  db: Db,
  householdId: string,
  fn: (trx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.household_id', ${householdId}, true)`.execute(trx);
    return fn(trx);
  });
}
