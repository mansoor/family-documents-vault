import type { Db } from '@fdv/db';
import type { ReadingField } from '@fdv/shared';
import { sql } from 'kysely';

/**
 * What an accept confirmed of a document's details, said to the database in
 * the accept's own transaction, just before its incoming file is decided:
 * incoming_file_filed (0074, R0, the review's A-2) keeps it in
 * review_filing.confirmed, and the Reading check scores only those. A
 * batch's item filed as a document of its own need not say: its card filed
 * every detail. Said for this transaction alone, and let go once kept.
 */
export async function confirmedByAccept(trx: Db, fields: readonly ReadingField[]): Promise<void> {
  await sql`select set_config('fdv.review_confirmed', ${fields.join(',')}, true)`.execute(trx);
}
