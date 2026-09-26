import { withPrincipal, type Db } from '@fdv/db';
import { describeEvents, type ActivityEvent, type ActivityLine } from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal } from '../auth/service.js';
import { requireCapability } from '../authz.js';

/**
 * The household activity log (SHR-07).
 *
 * The audit chain already records everything; this is the part a person
 * reads. Two things make it different from dumping the table:
 *
 *  - **Nothing appears that the reader could not already see.** An event
 *    about a private document is shown only to the member it belongs to.
 *    Not redacted — left out, because "somebody did something to a
 *    document" between two adults in a shared vault is worse than silence.
 *  - **Every row becomes a sentence** (`@fdv/shared/activity`), and an
 *    action that cannot be said in one is left out rather than printed as
 *    a row of fields.
 *
 * The chain itself is untouched by any of this. What is hidden here is
 * still hashed, still verified nightly, and still in the export.
 */

const PAGE = 50;

export interface ActivityPage {
  items: ActivityLine[];
  /** Cursor for the next page: the id of the last row returned. */
  next: number | null;
}

interface Row {
  id: string | number;
  at: Date;
  action: string;
  actor_account_id: string | null;
  actor_label: string | null;
  object_type: string | null;
  object_id: string | null;
  detail: unknown;
  actor_name: string | null;
  document_title: string | null;
  document_visibility: 'household' | 'adults' | 'private' | null;
  document_owner: string | null;
  member_name: string | null;
}

export class AuditService {
  constructor(private readonly db: Db) {}

  async activity(
    p: Principal,
    opts: { before?: number | undefined; limit?: number | undefined } = {},
  ): Promise<ActivityPage> {
    requireCapability(p, 'audit.read');
    const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 100);

    return withPrincipal(this.db, p, async (trx) => {
      // Raw SQL because this joins the audit row to three different
      // things by `object_type`, which Kysely would make harder to read
      // rather than easier.
      const result = await sql<Row>`
        select e.id,
               e.at,
               e.action,
               e.actor_account_id,
               e.actor_label,
               e.object_type,
               e.object_id,
               e.detail,
               actor_member.display_name as actor_name,
               d.title                   as document_title,
               d.visibility              as document_visibility,
               d.owner_member_id         as document_owner,
               object_member.display_name as member_name
          from audit_event e
          left join account_household ah
            on ah.account_id = e.actor_account_id
           and ah.household_id = e.household_id
          left join member actor_member on actor_member.id = ah.member_id
          left join document d
            on e.object_type = 'document' and d.id = e.object_id
          left join member object_member
            on e.object_type = 'member' and object_member.id = e.object_id
         where e.household_id = ${p.householdId}
           ${opts.before ? sql`and e.id < ${opts.before}` : sql``}
         order by e.id desc
         limit ${limit + 1}
      `.execute(trx);

      const rows = result.rows.slice(0, limit);
      const events: ActivityEvent[] = [];
      for (const r of rows) {
        // The one rule that hides anything: a private document belongs to
        // one person, and so does every line about it.
        if (r.document_visibility === 'private' && r.document_owner !== p.memberId) continue;
        if (r.document_visibility === 'adults' && p.role !== 'owner' && p.role !== 'adult') {
          continue;
        }
        events.push({
          id: Number(r.id),
          at: r.at.toISOString(),
          action: r.action,
          actor: r.actor_name,
          actor_id: r.actor_account_id,
          actor_label: r.actor_label,
          object_type: r.object_type,
          object_id: r.object_id,
          object_title: r.document_title ?? r.member_name,
          detail: (r.detail ?? {}) as Record<string, unknown>,
        });
      }
      // One sitting with a document is one line, not one per page (0.4.12).
      const items = describeEvents(events);

      const last = rows[rows.length - 1];
      return {
        items,
        // The cursor follows the rows read, not the lines shown: a page
        // that hides everything still moves forward.
        next: result.rows.length > limit && last ? Number(last.id) : null,
      };
    });
  }
}
