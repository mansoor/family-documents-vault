import { COLLECTION_AUDIENCES, inCollectionAudience, mayBeRestricted } from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal } from '../auth/service.js';

/**
 * "This caller may see collection `l`", as SQL: `canSeeCollection` for every audience
 * there is, and not deleted. Its maker always may; Only me, its maker
 * alone. An audience it does not name is nobody's. And a viewer, a
 * collection for Everyone an owner has given them (A17, 5.33): the
 * database's own answer (0054's app_granted_collections(), nothing for a
 * viewer with no limits), which its rule for a restricted reader asks too.
 *
 * On its own since R2, so that a list of documents (the Documents table's
 * collections) asks the very rule the collections do, with nothing of the
 * collections' service to import.
 */
export const seenCollection = (p: Principal) => {
  const maker = sql<boolean>`coalesce(l.owner_member_id = ${p.memberId}::uuid, false)`;
  const granted = mayBeRestricted(p.role)
    ? sql<boolean>`or (l.audience = 'everyone' and l.id in (select app_granted_collections()))`
    : sql<boolean>``;
  return sql<boolean>`(l.deleted_at is null and (case l.audience ${sql.join(
    COLLECTION_AUDIENCES.map((a) =>
      a === 'only_me'
        ? sql`when ${sql.lit(a)} then ${maker}`
        : sql`when ${sql.lit(a)} then ${sql.lit(inCollectionAudience(p.role, a))} or ${maker}`,
    ),
    sql` `,
  )} else false end ${granted}))`;
};
