import { withPrincipal, type Db, type Role, type Visibility } from '@fdv/db';
import { canSee, describeEvents, type ActivityEvent, type ActivityLine } from '@fdv/shared';
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

/** Who is reading, as far as the rules below care. */
export interface Reader {
  role: Role;
  memberId: string;
}

/** What a rule is told about a row: what happened, to what, and the document's live row. */
export interface Line {
  action: string;
  object_type: string | null;
  document_visibility: Visibility | null;
  document_owner: string | null;
}

type Audience = (reader: Reader, line: Line) => boolean;

/** Everyone who may read the log at all (`audit.read`). */
const everyone: Audience = () => true;

/**
 * A document's lines follow the document: whoever may see it now, as its
 * live row says. No row to see it through — one the reader is not given, or
 * one that has gone — is nobody's line (5.24 keeps a tombstone).
 */
const seesTheDocument: Audience = (reader, line) =>
  line.document_visibility !== null &&
  canSee(reader, { visibility: line.document_visibility, owner_member_id: line.document_owner });

/** "The audience of what it is about": the row's object type decides. */
const BY_TYPE = 'by type';

/**
 * Who reads a line, by what happened (5.6). The log denies by default: a
 * line is shown only when a row here says to whom.
 *
 *  - An action's own row wins. Each action with a sentence today is listed
 *    by name and takes the audience of its object type (`TYPES`), which is
 *    the audience it has always had.
 *  - Nothing else inherits. A new action — even about a type listed below,
 *    like the owner's actions of 5.28–5.30 on `member` — is shown to nobody
 *    until the iteration that adds it gives it a row. Actions written today
 *    with no sentence (step-ups, reminders, suggestions, devices) have no
 *    row either: they were never shown, and a sentence for one decides its
 *    audience then.
 *
 * A test holds every action with a sentence in `@fdv/shared/activity` to
 * having a row here.
 */
const RULES: ReadonlyMap<string, Audience | typeof BY_TYPE> = new Map<
  string,
  Audience | typeof BY_TYPE
>([
  // documents, and the links made to them
  ['document.created', BY_TYPE],
  ['document.updated', BY_TYPE],
  ['document.version_added', BY_TYPE],
  ['document.downloaded', BY_TYPE],
  ['document.viewed', BY_TYPE],
  ['document.cached_offline', BY_TYPE],
  ['document.opened_offline', BY_TYPE],
  ['document.deleted', BY_TYPE],
  ['document.restored', BY_TYPE],
  ['document.visibility_changed', BY_TYPE],
  ['share.created', BY_TYPE],
  ['share.opened', BY_TYPE],
  ['share.downloaded', BY_TYPE],
  ['share.revoked', BY_TYPE],
  // people
  ['member.added', BY_TYPE],
  ['member.role_changed', BY_TYPE],
  ['member.stepped_down', BY_TYPE],
  ['member.sign_in_removed', BY_TYPE],
  ['invitation.created', BY_TYPE],
  ['invitation.accepted', BY_TYPE],
  ['invitation.revoked', BY_TYPE],
  ['owner_change.requested', BY_TYPE],
  ['owner_change.refused', BY_TYPE],
  ['owner_change.withdrawn', BY_TYPE],
  // the vault
  ['household.created', BY_TYPE],
  ['household.profile_updated', BY_TYPE],
  ['vault.added', BY_TYPE],
  ['vault.activated', BY_TYPE],
  ['vault.removed', BY_TYPE],
  ['notifications.smtp_saved', BY_TYPE],
  ['export.requested', BY_TYPE],
  ['export.downloaded', BY_TYPE],
  // signing in
  ['auth.signed_in', BY_TYPE],
  ['auth.session_revoked', BY_TYPE],
  ['auth.totp_enabled', BY_TYPE],
  ['auth.totp_disabled', BY_TYPE],
  ['credential.passkey_added', BY_TYPE],
  ['credential.passkey_removed', BY_TYPE],
  // kinds of document (5.11): what the family calls its papers is the
  // family's, and each line names the kind as it was then, not a document.
  // Everyone who reads the log; a viewer reads none of it.
  ['document_type.created', everyone],
  ['document_type.updated', everyone],
  ['document_type.archived', everyone],
  ['document_type.restored', everyone],
  ['document_type.deleted', everyone],
  ['document_attribute.created', everyone],
]);

/**
 * Today's object types, with today's audiences: a document's lines go to
 * whoever may see it, every other line to everyone who reads the log. Only
 * the actions listed above by name reach this table. A type not here is
 * nobody's.
 */
const TYPES: ReadonlyMap<string | null, Audience> = new Map<string | null, Audience>([
  ['document', seesTheDocument],
  ['member', everyone],
  ['invitation', everyone],
  ['owner_change_request', everyone],
  ['household', everyone],
  ['vault', everyone],
  ['export', everyone],
  ['session', everyone],
  ['credential', everyone],
  // About nobody but the person who did it: a sign-in, a step down, the
  // household's own details.
  [null, everyone],
]);

/** Whether an action has a row of its own in the log's rules. */
export function hasRule(action: string): boolean {
  return RULES.has(action);
}

/** Whether a reader is shown a line. No rule, or no type to fall back on, is no. */
export function shownTo(reader: Reader, line: Line): boolean {
  const rule = RULES.get(line.action);
  const audience = rule === BY_TYPE ? TYPES.get(line.object_type) : rule;
  return audience ? audience(reader, line) : false;
}

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
  document_visibility: Visibility | null;
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
        // A private document belongs to one person, and so does every line
        // about it; a line nobody has said the audience of is nobody's.
        if (!shownTo(p, r)) continue;
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
