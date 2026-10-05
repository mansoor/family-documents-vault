import { withPrincipal, type Db, type Role, type Visibility } from '@fdv/db';
import {
  can,
  canSee,
  canSeeCollection,
  describeEvents,
  type ActivityEvent,
  type ActivityLine,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { madeWith } from '../documents/made-with.js';

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
  /** Whether they may see Adults only documents (5.32): the Principal's own answer. */
  seesAdults: boolean;
  /** Their sign-in: a link they made is theirs to read of (5.19 review). */
  accountId?: string;
}

/**
 * What a rule is told about a row: what happened, to what, who may see the
 * document — as its live row says, or once it has been removed for good, as
 * its tombstone does (5.24) — and the live row of the collection it was
 * about or in (5.14): null when the reader is not given it (another member's
 * Only me collection), or when there is none.
 */
export interface Line {
  action: string;
  object_type: string | null;
  /** What it is about, by id: whom, for a line about a person (5.25). */
  object_id?: string | null;
  document_visibility: Visibility | null;
  document_owner: string | null;
  collection_audience?: string | null;
  collection_owner?: string | null;
  /**
   * Whether the reader is given the request to send documents a line is
   * about, or that a file came in through (5.21): the database keeps a
   * review-by-me request, and its files, from everybody but its requester.
   */
  request_visible?: boolean | null;
  /** Who did it, by account: a line about somebody's identity details is theirs too (5.26). */
  actor_account_id?: string | null;
  /** What the line says, for a rule that reads it: which part of a record (5.26). */
  detail?: unknown;
  /**
   * A collection's link the line is about (5.19 review). Null when it must
   * be about one and there is none to be found; undefined for a line about
   * no collection's link.
   */
  link?: LinkFacts | null | undefined;
}

/** What a line's rule is told of the collection's link it is about. */
export interface LinkFacts {
  /** Who made it. */
  made_by: string;
  /** The reader can see every document it was made with or has followed. */
  all_seen: boolean;
  /**
   * The reader is in its collection's audience now, as the collection's own
   * lines ask (5.14): not once it is made another's Only me. A deleted
   * collection's lines are its history, and stay (the third review).
   */
  collection_seen: boolean;
}

type Audience = (reader: Reader, line: Line) => boolean;

/** Everyone who may read the log at all (`audit.read`). */
const everyone: Audience = () => true;

/**
 * A document's lines follow the document: whoever may see it now, as its
 * live row says — or, removed for good, as its tombstone says whoever could
 * see it then (5.24). Neither to see it through — a row the reader is not
 * given, or a document gone with nothing left behind — is nobody's line.
 */
const seesTheDocument: Audience = (reader, line) =>
  line.document_visibility !== null &&
  canSee(reader, { visibility: line.document_visibility, owner_member_id: line.document_owner });

/**
 * A collection's lines follow the collection (5.14): whoever is in its audience now, as
 * its live row says — Only me, its maker alone. A collection the reader is not
 * given (the database keeps another member's Only me collection from them) is
 * nobody's line, like a document with no row.
 */
const seesTheCollection: Audience = (reader, line) =>
  line.collection_audience != null &&
  canSeeCollection(reader, {
    audience: line.collection_audience,
    owner_member_id: line.collection_owner ?? null,
  });

/**
 * A document put in a collection, or taken out: one line per document, written
 * about the document, so the document's rule applies — and the collection's too,
 * or the line would say that a collection the reader may not know of exists.
 */
const seesTheDocumentInTheCollection: Audience = (reader, line) =>
  seesTheDocument(reader, line) && seesTheCollection(reader, line);

/**
 * A collection's link outside the family (5.19 review, C519-04): its lines
 * say who it went to, so they are for those the list of links (GET /shares)
 * gives it to — one who may share, in the collection's audience now, and
 * made it or can see every document it was made with or has followed. A
 * download through it, a look at pages, as much as its lines about the
 * collection (the third review: once the collection was made Only me, its
 * links' downloads still named their recipients to the adults).
 */
const knowsTheLink: Audience = (reader, line) =>
  can(reader.role, 'document.share') &&
  line.link != null &&
  line.link.collection_seen &&
  (line.link.made_by === reader.accountId || line.link.all_seen);

const seesTheCollectionsLink: Audience = (reader, line) =>
  seesTheCollection(reader, line) && knowsTheLink(reader, line);

const seesTheDocumentFollowTheLink: Audience = (reader, line) =>
  seesTheDocumentInTheCollection(reader, line) && knowsTheLink(reader, line);

/**
 * A request to send documents, and every file that came in through it
 * (5.21): its reviewers' alone — its requester, or for a request any adult
 * reviews, the owners and adults. A teen, a viewer, and another adult of a
 * review-by-me request see no line, and so no title, label or file name.
 * No row to go by is nobody's line.
 */
const reviewsTheRequest: Audience = (reader, line) =>
  line.request_visible === true && can(reader.role, 'upload_request.create');

/**
 * An owner's look at somebody's sign-in (5.25): for the owners, who answer
 * to each other for it, and for the person it was about. Nobody else — not
 * another adult, not a teen. (A viewer reads no log at all.)
 */
const ownersAndThePerson: Audience = (reader, line) =>
  reader.role === 'owner' ||
  (line.object_type === 'member' && line.object_id != null && line.object_id === reader.memberId);

/**
 * What an owner did to somebody's sign-in, or a role change did besides the
 * role (5.30): signed out everywhere; the Essentials on their phones ended;
 * their requests to send documents closed. For the owners, the person it is
 * about and whoever did it — nobody else, not another adult, not a teen (a
 * viewer reads no log).
 */
const ownersThePersonAndTheActor: Audience = (reader, line) =>
  ownersAndThePerson(reader, line) ||
  (line.actor_account_id != null && line.actor_account_id === reader.accountId);

/**
 * A line about somebody's identity details (5.26): who looked at them, showed
 * their numbers or changed them. For the owners, the person it is about —
 * who sees a line whenever somebody else shows their numbers, with no values
 * (A38) — and whoever did it; nobody else, not another adult, not a teen (a
 * viewer reads no log). A line about an Only me part, or a part this does
 * not know, is the person's alone: an owner is told nothing of it, not even
 * that it moved. Who sees them at all is everybody's (below).
 */
const identityLine: Audience = (reader, line) => {
  const self =
    line.object_type === 'member' && line.object_id != null && line.object_id === reader.memberId;
  const part = (line.detail as { part?: unknown } | null | undefined)?.part;
  if (part !== undefined && part !== 'shared') return self;
  return (
    reader.role === 'owner' ||
    self ||
    (line.actor_account_id != null && line.actor_account_id === reader.accountId)
  );
};

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
 *    like the owner's actions of 5.29–5.30 on `member` — is shown to nobody
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
  // 5.24: an owner asked to remove somebody else's document for good, and
  // removed one for good — each the document's line, for whoever may (or,
  // removed, could) see it, by its tombstone once the row has gone.
  ['document.purge_requested', BY_TYPE],
  ['document.purged', BY_TYPE],
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
  // 5.16: a link locked by its tenth wrong PIN, and one turned back on
  // after a restore paused it.
  ['share.locked', BY_TYPE],
  ['share.resumed', BY_TYPE],
  // 5.18: a view-only link's pages looked at, once a session.
  ['share.viewed', BY_TYPE],
  // 5.20: a link's code emailed, the address masked — to whoever may see
  // what the link is to, as its other lines are.
  ['share.code_sent', BY_TYPE],
  // 5.19: a document put in a collection whose link keeps up with it, and
  // so sent outside the family: a line about the document, in the collection,
  // on the link — for those who may know of the link.
  ['share.followed', seesTheDocumentFollowTheLink],
  // people
  ['member.added', BY_TYPE],
  ['member.role_changed', BY_TYPE],
  ['member.stepped_down', BY_TYPE],
  ['member.sign_in_removed', BY_TYPE],
  // 5.17c: a person's photo added, changed or taken away — the family's,
  // as a member's lines are: owners, adults and teens. Never the picture,
  // a crop or a file's name.
  ['member.photo_changed', BY_TYPE],
  ['member.photo_removed', BY_TYPE],
  // 5.25: a person's details changed — which of them, never their values —
  // and that somebody has passed away, or not after all: the family's, as a
  // member's lines are. A viewer reads none of the log.
  ['member.updated', BY_TYPE],
  ['member.deceased', BY_TYPE],
  // 5.25: an owner looked at somebody's sign-in — never what it said.
  ['member.account_viewed', ownersAndThePerson],
  // 5.28: a sign-in locked, unlocked, or turned back on after a restore: for
  // the owners — whoever did it is one — and the person it is about. Not
  // another adult, not a teen (a viewer reads no log).
  ['member.locked', ownersAndThePerson],
  ['member.unlocked', ownersAndThePerson],
  // 5.29: a password reset an owner started, which way it went and never a
  // link — for the owners, whoever started it among them, and the person.
  ['member.reset_started', ownersAndThePerson],
  // 5.30: somebody signed out everywhere by an owner (or an owner signing
  // their own other devices out); and what a role change ended besides the
  // role — the Essentials on their phones, their requests to send
  // documents: for the owners, the person and whoever did it. The change's
  // own line (member.role_changed) keeps the family's audience.
  ['member.signed_out_everywhere', ownersThePersonAndTheActor],
  ['member.offline_ended', ownersThePersonAndTheActor],
  ['member.requests_closed', ownersThePersonAndTheActor],
  // 5.33: what a viewer can see, limited, changed or let go — by an owner,
  // or by whoever invited them as they accepted: for the owners, the person
  // and whoever did it (the adult who invited them among them). Never what
  // it gives, only how many of each.
  ['access.restricted', ownersThePersonAndTheActor],
  ['access.changed', ownersThePersonAndTheActor],
  ['access.removed', ownersThePersonAndTheActor],
  // 5.26: somebody's identity details looked at (once a sitting), their
  // numbers shown, changed — which fields, never a value — and who sees
  // them changed: for the owners, the person and whoever did it.
  ['identity.viewed', identityLine],
  ['identity.revealed', identityLine],
  ['identity.updated', identityLine],
  // Who sees identity details: asked, narrowed, withdrawn. Everybody with a
  // sign-in is told of a widening, and so reads each of these lines (the
  // 5.26 review); a viewer reads no log.
  ['identity.audience_changed', everyone],
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
  // collections of documents (5.14): a collection's name is information ("Divorce"),
  // so its lines are its audience's, and carry its id and no name. A
  // document put in it or taken out is a line about the document.
  ['collection.created', seesTheCollection],
  ['collection.renamed', seesTheCollection],
  ['collection.updated', seesTheCollection],
  ['collection.deleted', seesTheCollection],
  ['collection.item_added', seesTheDocumentInTheCollection],
  ['collection.item_removed', seesTheDocumentInTheCollection],
  // asking somebody to send documents (5.21): the request's reviewers'.
  ['upload_request.created', BY_TYPE],
  ['upload_request.revoked', BY_TYPE],
  ['upload_request.opened', BY_TYPE],
  ['upload_request.code_sent', BY_TYPE],
  ['upload_request.locked', BY_TYPE],
  ['upload_request.submitted', BY_TYPE],
  ['upload_request.resumed', BY_TYPE],
  ['upload_request.closed', BY_TYPE],
  // what came in, looked at (5.23): a file's lines name its request in
  // their detail, and go to the request's reviewers; what the vault did to
  // a request's files, its purge and its move to the owners, is the
  // request's line. Once moved, the owners' alone (0047).
  ['incoming.accepted', BY_TYPE],
  ['incoming.rejected', BY_TYPE],
  ['incoming.downloaded', BY_TYPE],
  ['incoming.purged', BY_TYPE],
  ['incoming.moved', BY_TYPE],
]);

/**
 * Today's object types, with today's audiences: a document's lines go to
 * whoever may see it, every other line to everyone who reads the log. Only
 * the actions listed above by name reach this table. A type not here is
 * nobody's.
 */
const TYPES: ReadonlyMap<string | null, Audience> = new Map<string | null, Audience>([
  ['document', seesTheDocument],
  // 5.19: a link to a collection — made, opened, taken back, locked, turned
  // back on — is its collection's line, for whoever in the collection's
  // audience the list of links gives the link to (the 5.19 review). The
  // collection's own actions (collection.*) keep their rows above.
  ['collection', seesTheCollectionsLink],
  ['member', everyone],
  ['invitation', everyone],
  ['owner_change_request', everyone],
  ['household', everyone],
  ['vault', everyone],
  ['export', everyone],
  ['session', everyone],
  ['credential', everyone],
  // A request to send documents, and a file sent through one (5.21).
  ['upload_request', reviewsTheRequest],
  ['incoming_file', reviewsTheRequest],
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
  if (!audience || !audience(reader, line)) return false;
  // Any line about a collection's link — a download through it, a look at
  // a document's pages, as well as its own lines about the collection —
  // names whom it went to: for those the list of links gives it to, too
  // (C519-04, and the second review). A line about any other link has none.
  return line.link === undefined || knowsTheLink(reader, line);
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
  actor_member_id: string | null;
  document_title: string | null;
  document_visibility: Visibility | null;
  document_owner: string | null;
  member_name: string | null;
  collection_name: string | null;
  collection_audience: string | null;
  collection_owner: string | null;
  request_visible: boolean | null;
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
               actor_member.id           as actor_member_id,
               d.title                   as document_title,
               -- The live row while there is one; removed for good, its
               -- tombstone (5.24); neither, nobody (the rule fails closed).
               case when d.id is not null then d.visibility
                    else gone.visibility end as document_visibility,
               case when d.id is not null then d.owner_member_id
                    else gone.owner_member_id end as document_owner,
               object_member.display_name as member_name,
               l.name                    as collection_name,
               l.audience                as collection_audience,
               l.owner_member_id         as collection_owner,
               ur.id is not null         as request_visible
          from audit_event e
          left join account_household ah
            on ah.account_id = e.actor_account_id
           and ah.household_id = e.household_id
          left join member actor_member on actor_member.id = ah.member_id
          left join document d
            on e.object_type = 'document' and d.id = e.object_id
          left join document_tombstone gone
            on e.object_type = 'document' and gone.id = e.object_id
          left join member object_member
            on e.object_type = 'member' and object_member.id = e.object_id
          -- A collection's own lines name it; a line about a document put in one,
          -- or taken out, keeps the collection's id in its detail (5.14).
          left join doc_collection l
            on l.id = case when e.object_type = 'collection' then e.object_id
                           when e.action in ('collection.item_added', 'collection.item_removed',
                                             'share.followed')
                             then (e.detail->>'collection_id')::uuid
                      end
          -- A request to send documents, as the reader is given it (5.21):
          -- its own lines, and those of the files that came in through it.
          left join upload_request ur
            on ur.id = case when e.object_type = 'upload_request' then e.object_id
                            when e.object_type = 'incoming_file'
                              then (e.detail->>'request_id')::uuid
                       end
         where e.household_id = ${p.householdId}
           ${opts.before ? sql`and e.id < ${opts.before}` : sql``}
         order by e.id desc
         limit ${limit + 1}
      `.execute(trx);

      const rows = result.rows.slice(0, limit);
      // A moment a line names is said on the household's clock (5.26).
      const household = await trx
        .selectFrom('household')
        .select(['timezone'])
        .where('id', '=', p.householdId)
        .executeTakeFirst();
      const links = await this.collectionLinks(trx, p, rows);
      const events: ActivityEvent[] = [];
      for (const r of rows) {
        // A private document belongs to one person, and so does every line
        // about it; a line nobody has said the audience of is nobody's.
        if (!shownTo(p, { ...r, link: linkOf(r, links) })) continue;
        events.push({
          id: Number(r.id),
          at: r.at.toISOString(),
          action: r.action,
          actor: r.actor_name,
          actor_id: r.actor_account_id,
          actor_member_id: r.actor_member_id,
          actor_label: r.actor_label,
          object_type: r.object_type,
          object_id: r.object_id,
          object_title: r.document_title ?? r.member_name,
          collection_name: r.collection_name,
          detail: (r.detail ?? {}) as Record<string, unknown>,
          timezone: household?.timezone ?? null,
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

  /**
   * The collections' links the page's lines are about: who made each, and
   * whether the reader can see every document it was made with or has
   * followed (not what it was made without) — as GET /shares asks. Every
   * link a `share.*` line names is looked up, a document's too: which of
   * them are a collection's is what is found out.
   */
  private async collectionLinks(
    trx: Db,
    p: Principal,
    rows: Row[],
  ): Promise<Map<string, LinkFacts>> {
    const found = new Map<string, LinkFacts>();
    const ids = [
      ...new Set(
        rows.map((r) => linkNamed(r)?.id).filter((id): id is string => id !== undefined && !!id),
      ),
    ];
    if (ids.length === 0) return found;
    // With its collection as the reader is given it: the database gives
    // nobody another member's Only me collection (0036), and a deleted one
    // is still given, its lines being its history.
    const made = await trx
      .selectFrom('share_link as s')
      .leftJoin('doc_collection as c', 'c.id', 's.collection_id')
      .select(['s.id', 's.created_by', 'c.audience', 'c.owner_member_id'])
      .where('s.id', 'in', ids)
      .where('s.collection_id', 'is not', null)
      .execute();
    // Who may not share is given no link (GET /shares), and so none of
    // their lines; there is no more to ask.
    const shares = can(p.role, 'document.share');
    for (const l of made) {
      found.set(l.id, {
        made_by: l.created_by,
        all_seen: shares,
        collection_seen:
          l.audience != null &&
          canSeeCollection(p, { audience: l.audience, owner_member_id: l.owner_member_id }),
      });
    }
    if (!shares || made.length === 0) return found;
    // Removed for good since, as its tombstone says, too (5.24).
    const items = await madeWith(
      trx,
      made.map((l) => l.id),
    );
    for (const i of items) {
      const link = found.get(i.share_id);
      if (link && !canSee(p, i)) link.all_seen = false;
    }
    return found;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The link a `share.*` line names, by the id in its detail, and whether it
 * must be a collection's: its lines about the collection, and a document
 * that followed one, are; a download, a look at pages, an open about a
 * document may be either. Undefined for any other line; an empty id for a
 * line that names none it can be found by.
 */
function linkNamed(r: Row): { id: string; collections: boolean } | undefined {
  if (!r.action.startsWith('share.')) return undefined;
  const collections = r.object_type === 'collection' || r.action === 'share.followed';
  const id = (r.detail as { share_id?: unknown } | null)?.share_id;
  return { id: typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : '', collections };
}

/**
 * What a line's rule is told of the link it names: a collection's link as
 * found; null for one that must be a collection's and is not found (nobody's
 * line); undefined for a line about no collection's link.
 */
function linkOf(r: Row, links: Map<string, LinkFacts>): Line['link'] {
  const named = linkNamed(r);
  if (!named) return undefined;
  const link = named.id ? links.get(named.id) : undefined;
  if (link) return link;
  return named.collections ? null : undefined;
}
