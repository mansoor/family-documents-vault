import type { Db } from '@fdv/db';
import { sql } from 'kysely';

/**
 * Whether an owner may remove a document for good at once, without asking
 * first (5.24): one they filed; or one that is theirs, when nobody filed it
 * or whoever did is no longer one of the household's. Anything else filed
 * by somebody still here is asked about, and waits a day for them to bring
 * it back.
 *
 * By who filed it, not only whose it is: an owner may hand a household
 * document, or a child's, to themselves (mayHandOver), and "theirs" alone
 * would then let them remove another adult's filing with no notice at all
 * (the 5.24 review, M524-1).
 */
export function removableAtOnce(
  caller: { accountId: string; memberId: string },
  doc: { created_by: string | null; owner_member_id: string | null },
  filerStillHere: boolean,
): boolean {
  if (doc.created_by !== null && doc.created_by === caller.accountId) return true;
  const theirs = doc.owner_member_id !== null && doc.owner_member_id === caller.memberId;
  return theirs && (doc.created_by === null || !filerStillHere);
}

/** Who signs in to the household now, by account: looked up once a transaction. */
const signedIn = new WeakMap<Db, Promise<Set<string>>>();

/** Whether an account signs in to the caller's household now. */
export async function signsInHere(trx: Db, accountId: string | null): Promise<boolean> {
  if (accountId === null) return false;
  let accounts = signedIn.get(trx);
  if (!accounts) {
    accounts = trx
      .selectFrom('account_household')
      .select('account_id')
      // Its own household only: an account also sees its memberships elsewhere.
      .where(sql<boolean>`household_id = app_household()`)
      .execute()
      .then((rows) => new Set(rows.map((r) => r.account_id)));
    signedIn.set(trx, accounts);
  }
  return (await accounts).has(accountId);
}
