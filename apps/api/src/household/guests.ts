import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import { guestEndProblem, type GuestRenewal } from '@fdv/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';

/**
 * Someone outside the family with a sign-in of their own: a guest (5.34,
 * D4, A28). What is theirs alone here is the end of their sign-in, and an
 * owner renewing it. Everything else a guest is, is a viewer's, limited
 * (restrictions.ts), and the database holds to it (0056).
 *
 * Renewing (POST /members/{id}/renew) is an owner's (`role.change`) and an
 * owner power (A54): a passkey or a code, never the password
 * (`renew_guest`, asked by the route). It takes its locks in a role
 * change's order: the household (FOR SHARE), the person, their sign-in (FOR
 * NO KEY UPDATE, as a lock and a reset take it), and the activity log's
 * lock last.
 */

/** POST /members/{id}/renew. */
export const renewBody = z
  .object({ access_expires_at: z.string().datetime({ offset: true }) })
  .strict();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new ApiError(404, 'not_found', 'They have no sign-in to renew.');

export class GuestService {
  constructor(private readonly db: Db) {}

  /**
   * A guest's sign-in, renewed to end at `end` (A28): in the future and
   * within a year — sooner than it would have is a renewal too. Nobody with
   * no sign-in, or nobody of this household, is 404; somebody of the family
   * `409 not_a_guest`.
   */
  async renew(p: Principal, memberId: string, end: Date, meta: RequestMeta): Promise<GuestRenewal> {
    requireCapability(p, 'role.change');
    const problem = guestEndProblem(end);
    if (problem) {
      throw new ApiError(422, 'validation_failed', problem, { detail: 'access_expires_at' });
    }
    if (!UUID.test(memberId)) throw notFound();
    return withPrincipal(this.db, p, async (trx) => {
      // 1. The household, as a role change holds it.
      await sql`select 1 from household where id = app_household() for share`.execute(trx);
      // 2. The person, then their sign-in, held.
      const person = await trx
        .selectFrom('member')
        .select(['id', 'display_name', 'kind'])
        .where('id', '=', memberId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!person) throw notFound();
      const signIn = await trx
        .selectFrom('account_household')
        .select(['account_id', 'access_expires_at'])
        .where('member_id', '=', person.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!signIn) throw notFound();
      if (person.kind !== 'guest') {
        throw new ApiError(
          409,
          'not_a_guest',
          `${person.display_name} is of the family: their sign-in has no end to renew.`,
        );
      }
      const changed = await trx
        .updateTable('account_household')
        .set({ access_expires_at: end })
        .where('member_id', '=', person.id)
        .where('account_id', '=', signIn.account_id)
        .executeTakeFirst();
      // A rule that quietly changed nothing renewed nothing.
      if (Number(changed.numUpdatedRows) !== 1) throw notFound();
      // 3. The log, last: for the owners, the guest and whoever did it.
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.access_renewed',
        objectType: 'member',
        objectId: person.id,
        detail: {
          access_expires_at: end.toISOString(),
          ...(signIn.access_expires_at
            ? { was: new Date(signIn.access_expires_at).toISOString() }
            : {}),
        },
        ip: meta.ip,
      });
      return { member_id: person.id, access_expires_at: end.toISOString() };
    });
  }
}
