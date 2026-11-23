import {
  appendAudit,
  householdZone,
  withPrincipal,
  type Db,
  type Role,
  type Visibility,
} from '@fdv/db';
import {
  ACTIVITY_ANYBODY_ELSE,
  activityKind,
  activityLineKept,
  APP_SENT_FOLD_MS,
  can,
  canSee,
  canSeeCollection,
  describeEvents,
  describeEventSpans,
  guestLabel,
  localToday,
  SENSITIVE_IN_WORDS,
  type ActivityCsvLine,
  type ActivityEvent,
  type ActivityExportAsk,
  type ActivityFilters,
  type ActivityLine,
} from '@fdv/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Principal } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError, notFound } from '../errors.js';
import { sensitiveSql } from '../documents/filters.js';
import { madeWith } from '../documents/made-with.js';
import { issuerNamesOf } from '../cabinet/issuers.js';

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

/** How many of the log's rows an export reads at a time (0.9.0-dev.82). */
export const EXPORT_BATCH = 500;
/**
 * The most of the log's rows one export reads, and for how long: a filter
 * that keeps few lines (a rare kind, a teen shown little) stops there, and
 * says how far back it read, as a file past its lines' cap does.
 */
export const EXPORT_MAX_ROWS = 250_000;
export const EXPORT_MAX_MS = 60_000;

/** What an export is asked, its filters checked: as `GET /audit/export`'s query. */
export type ExportAsk = ActivityExportAsk;

/** How much an export may read: rows a batch, rows in all, and milliseconds. */
export interface ExportLimits {
  batch?: number;
  rows?: number;
  ms?: number;
}

/** Why an export stopped short of the end of the log, and the newest moment it no longer holds lines before. */
export interface ExportOutcome {
  stopped: { by: 'rows' | 'time'; readTo: string } | null;
}

/** What an export knows before its first line (`exportStart`). */
export interface ExportStart {
  /** The household's time zone: its clock for the When column, its calendar for the days. */
  zone: string;
  /** The household's today, for the file's name. */
  today: string;
  /** The family as the reader is given it, by member id: the Who column's names. */
  family: Map<string, string>;
  /** One document's links' stretches (`aboutDocument`), when one document's lines are asked. */
  windows: Window[] | null;
  /** Midnight starting the From day, and midnight ending the To day, on the household's clock. */
  fromStart: Date | null;
  toEnd: Date | null;
}

/**
 * What an export's reads leave out before its lines are said, each only
 * where it cannot change a line the page would show:
 *
 *  - moments past the To day by more than a fold can reach (an app's files
 *    an hour apart are one line, whose moment is its newest);
 *  - actions of another sort of thing, for a sort none of whose lines fold
 *    (not Opened and downloaded, not Added: a line between two looks keeps
 *    them two lines on the page);
 *  - rows by anybody but the person asked for: a line names its doer only
 *    when it is theirs. (Two of their sittings parted only by somebody
 *    else's line are one line here, two on the page.)
 */
interface Narrow {
  until: Date | null;
  actions: readonly string[] | null;
  who: string | null;
}

/** A read narrowed, as SQL on the audit row's columns (`e.` or none). */
function narrowed(
  n: Narrow | undefined,
  householdId: string,
  prefix: '' | 'e.',
): RawBuilder<unknown> {
  if (!n) return sql``;
  const col = (c: string) => sql.ref(`${prefix}${c}`);
  return sql`${n.until ? sql`and ${col('at')} < ${n.until}` : sql``}
    ${n.actions ? sql`and ${col('action')} = any(${n.actions}::text[])` : sql``}
    ${
      n.who
        ? sql`and ${col('actor_account_id')} in (
            select account_id from account_household
             where household_id = ${householdId} and member_id = ${n.who}::uuid)`
        : sql``
    }`;
}

/**
 * Whether the reader still reads the log as the export began (0.9.0-dev.82),
 * asked again before each batch: their session open, the same person with
 * the same role (a role lowered mid-download would see the rest by the old
 * one's rules), not locked or paused, a guest's access not ended. One
 * indexed row; anything else ends the file there, unfinished.
 */
async function stillReading(trx: Db, p: Principal): Promise<void> {
  const row = await trx
    .selectFrom('session')
    .innerJoin('account_household', (j) =>
      j
        .onRef('account_household.account_id', '=', 'session.account_id')
        .onRef('account_household.household_id', '=', 'session.household_id'),
    )
    .select([
      'account_household.role',
      'account_household.member_id',
      'account_household.suspended_at',
      'account_household.suspended_until',
      'account_household.access_expires_at',
    ])
    .where('session.id', '=', p.sessionId)
    .where('session.account_id', '=', p.accountId)
    .where('session.revoked_at', 'is', null)
    .executeTakeFirst();
  const now = Date.now();
  const suspended =
    row?.suspended_at != null &&
    (row.suspended_until == null || new Date(row.suspended_until).getTime() > now);
  const ended = row?.access_expires_at != null && new Date(row.access_expires_at).getTime() <= now;
  if (
    !row ||
    row.role !== p.role ||
    row.member_id !== p.memberId ||
    !can(row.role, 'audit.read') ||
    suspended ||
    ended
  ) {
    throw new ApiError(403, 'forbidden', 'You no longer read the activity log as you did.');
  }
}

/**
 * Each sort of thing's actions, from the actions the log has a rule for —
 * no other line is ever shown — for a sort none of whose lines fold.
 */
function actionsOfKind(kind: string): string[] | null {
  if (kind === 'opened' || kind === 'added') return null;
  return [...RULES.keys()].filter((a) => activityKind(a) === kind);
}

/**
 * The document a line is about, as its words name it: its title, or "a
 * sensitive document" (H1a); null for a line about none, or one whose
 * title is not given (removed for good).
 */
function documentNamed(e: ActivityEvent): string | null {
  if (e.object_type !== 'document') return null;
  if (e.object_sensitive === true) return SENSITIVE_IN_WORDS;
  return e.object_title;
}

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
const ownersAndAdults: Audience = (reader) => reader.role === 'owner' || reader.role === 'adult';

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
 * A caregiver for somebody's medical papers (0.9.0, H1b): named, kept,
 * revoked or given up. For the owners, the person it is about, whoever did
 * it, and the caregiver it names — nobody else, not another adult, not a
 * teen (a viewer reads no log). Never a paper, so never a title.
 */
const caregiverLine: Audience = (reader, line) => {
  const carer = (line.detail as { caregiver_member_id?: unknown } | null | undefined)
    ?.caregiver_member_id;
  return (
    ownersThePersonAndTheActor(reader, line) ||
    (typeof carer === 'string' && carer === reader.memberId)
  );
};

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

/**
 * A person's emergency information (0.9.0, H4): changed, who sees it
 * changed, and every line of a clinician's link to it — made, opened, taken
 * back, its code sent, emailed. For the owners, the person and whoever did
 * it: never another adult, a teen or a caregiver, whoever may read the page
 * itself, and never a word of what is on it (H2).
 */
const emergencyLine: Audience = (reader, line) =>
  reader.role === 'owner' ||
  (line.object_id != null && line.object_id === reader.memberId) ||
  (line.actor_account_id != null && line.actor_account_id === reader.accountId);

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
  // 5.35: its note added, changed or taken off — never what it says: the
  // document's line, for whoever may see the document.
  ['document.notes_changed', BY_TYPE],
  // 0.9.0 (T1): a tag renamed, merged or deleted from Settings → Tags, on
  // each document it changed — never which tag: the document's line, for
  // whoever may see the document, as an edit's is.
  ['document.tags_changed', BY_TYPE],
  ['document.version_added', BY_TYPE],
  // 0.9.0: marked no longer needed, and needed again — never why, nor what
  // replaced it: the document's line, for whoever may see the document.
  ['document.no_longer_needed', BY_TYPE],
  ['document.needed_again', BY_TYPE],
  // 0.8.0 (S1): a copy added from a batch and taken back: the document's
  // line, for whoever may see the document, as its adding was.
  ['batch.version_undone', BY_TYPE],
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
  // 0.9.0 (SMS3): a link's code could not be texted, and why in a word: to
  // whoever may see what the link is to, as its other lines are.
  ['share.code_not_sent', BY_TYPE],
  // 0.9.0: a link shown again to whoever made it (never the link): to
  // whoever may see what it is to, as its other lines are.
  ['share.revealed', BY_TYPE],
  // 0.9.0 (13 Nov 2026): a link emailed to its recipient by the vault, the
  // address masked (never the link): to whoever may see what it is to, as
  // its other lines are.
  ['share_link.emailed', BY_TYPE],
  // 0.9.0-dev.69: a link texted to its recipient by the vault, the number
  // masked (never the link): as an email of it.
  ['share_link.texted', BY_TYPE],
  // And not sent after all, why in a word (the dev.69 review).
  ['share_link.text_not_sent', BY_TYPE],
  // 0.9.0 (LK): a link's properties changed by whoever made it, never its
  // PIN or password: to whoever may see what it is to, as its other lines are.
  ['share.changed', BY_TYPE],
  // 5.19: a document put in a collection whose link keeps up with it, and
  // so sent outside the family: a line about the document, in the collection,
  // on the link — for those who may know of the link.
  ['share.followed', seesTheDocumentFollowTheLink],
  // 0.9.0 (H1a): a document made sensitive taken out of a collection's link
  // — to those who could know it followed or was ticked.
  ['share.left_out', seesTheDocumentFollowTheLink],
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
  // 0.9.0 (H1b): a caregiver for somebody's medical papers named, kept,
  // revoked or given up — for the owners, the person, whoever did it and
  // the caregiver.
  ['caregiver.granted', caregiverLine],
  ['caregiver.kept', caregiverLine],
  ['caregiver.revoked', caregiverLine],
  ['caregiver.given_up', caregiverLine],
  // Turning 18 (H1b): the question answered, how many papers made Only me
  // and never which — for the owners, the person and whoever answered.
  ['grown_up.answered', ownersThePersonAndTheActor],
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
  // 0.8.0 (D1): a computer paired to send scans, and its key revoked — by
  // its person, an owner, or as their sign-in went or their role changed:
  // for the owners, the person and whoever did it. Its name, never
  // anything it sent.
  ['computer.paired', ownersThePersonAndTheActor],
  ['computer.revoked', ownersThePersonAndTheActor],
  // 0.9.0 (APP1): a connected app — connected, turned on, changed, its keys,
  // paused, removed — and what it did as the person it acts as: for the
  // owners, that person and whoever did it. Its name, never what it sent.
  ['app.connected', ownersThePersonAndTheActor],
  ['app.approved', ownersThePersonAndTheActor],
  ['app.changed', ownersThePersonAndTheActor],
  // Its API keys (APP6): generated and revoked by an owner, and the
  // vault's notices that one expires soon and that it has.
  ['app.key_added', ownersThePersonAndTheActor],
  ['app.key_retired', ownersThePersonAndTheActor],
  ['app.key_expiring', ownersThePersonAndTheActor],
  ['app.key_expired', ownersThePersonAndTheActor],
  // Unusual use (0.9.0-dev.72): a key used from a new network, and a day
  // far past the app's usual; the owners are emailed of each.
  ['app.key_new_network', ownersThePersonAndTheActor],
  ['app.busy_day', ownersThePersonAndTheActor],
  ['app.paused', ownersThePersonAndTheActor],
  ['app.resumed', ownersThePersonAndTheActor],
  ['app.revoked', ownersThePersonAndTheActor],
  ['app.sent', ownersThePersonAndTheActor],
  ['app.withdrawn', ownersThePersonAndTheActor],
  ['app.checked', ownersThePersonAndTheActor],
  ['app.refused_today', ownersThePersonAndTheActor],
  // An app acting as itself with nobody who can review what it sends (APP8):
  // for the owners, who choose somebody (the line names no person).
  ['app.reviewer_needed', ownersThePersonAndTheActor],
  // 0.9.0 (APP2): its reading, once an hour — for the owners, its person and
  // whoever did it — and one document's details read: that document's line,
  // for whoever may see it, as a download's is.
  ['app.looked_up', ownersThePersonAndTheActor],
  ['app.read', BY_TYPE],
  // 0.9.0-dev.77: a link it made to one document, to view or download —
  // that document's line, for whoever may see it, as a read's is.
  ['app.link_made', BY_TYPE],
  // 0.9.0 (APP3): a document it sent let go of — that document's line, for
  // whoever may see it. (Its links opened, and its moves to the Trash, are
  // document.viewed, document.downloaded and document.deleted lines.)
  ['app.unlinked', BY_TYPE],
  // 5.33: what a viewer can see, limited, changed or let go — by an owner,
  // or by whoever invited them as they accepted: for the owners, the person
  // and whoever did it (the adult who invited them among them). Never what
  // it gives, only how many of each.
  ['access.restricted', ownersThePersonAndTheActor],
  ['access.changed', ownersThePersonAndTheActor],
  ['access.removed', ownersThePersonAndTheActor],
  // 5.34: a guest's sign-in renewed (A28): for the owners, the guest and
  // whoever did it.
  ['member.access_renewed', ownersThePersonAndTheActor],
  // A guest who never signed in, removed (the 5.34 review): for the owners
  // and whoever did it; the person is gone.
  ['member.removed', ownersThePersonAndTheActor],
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
  // 0.9.0 (H4): somebody's emergency information changed, and who sees it
  // — that, never what is on it: the owners, the person, whoever did it.
  ['emergency.updated', emergencyLine],
  ['emergency.audience_changed', emergencyLine],
  // 5.41: whether the household's Only me documents can be shared outside
  // the family, and how many links that paused or turned back on: for the
  // owners and the adults, who may share. Never which links.
  ['household.only_me_sharing_changed', ownersAndAdults],
  // 0.9.0-dev.91: issuers said to be the same, or separated, in the
  // household's "Same as" list: for the owners and the adults, who keep it.
  // The names are issuers', never a paper's.
  ['issuer.joined', ownersAndAdults],
  ['issuer.separated', ownersAndAdults],
  // 0.9.0 (TZ): the family's time zone, chosen or cleared by an owner: the
  // clock everybody's times are on, so for whoever reads the log.
  ['household.timezone_changed', everyone],
  // 0.9.0 (H2): how notifications and email name documents, chosen by an
  // owner: what is sent to everybody, so for whoever reads the log.
  ['household.neutral_wording_changed', everyone],
  // 0.9.0 (RQ): how long ended links and requests are kept, chosen by an
  // owner: never which, so for whoever reads the log.
  ['household.ended_sharing_changed', everyone],
  // 0.9.0: whether every adult must have two-step sign-in, chosen by an
  // owner: how the family signs in, so for whoever reads the log.
  ['household.two_step_changed', everyone],
  // 0.9.0-dev.87: when the vault locks itself in a browser left unused,
  // chosen by an owner: how the family's browsers stay safe, so for whoever
  // reads the log.
  ['household.auto_lock_changed', everyone],
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
  // The scanner folder turned on or off, and whose Inbox it fills (S3): for
  // the owners, and the person whose Inbox it is.
  ['watch_folder.changed', ownersAndThePerson],
  // Which folder it is and how long scans are kept (0.9.0, O1): about the
  // household, so for the owners alone.
  ['watch_folder.folder_changed', ownersAndThePerson],
  // Email in turned on or off (S4): about the household, so for the owners alone.
  ['mail_in.changed', ownersAndThePerson],
  // The household mailbox set up in Settings, or taken away (O1): the owners'.
  ['mail_in.mailbox_saved', ownersAndThePerson],
  ['mail_in.mailbox_removed', ownersAndThePerson],
  // The household's SMS Gate set up, tested or taken away (0.9.0, SMS1):
  // about the household, so for the owners alone.
  ['sms.settings_saved', ownersAndThePerson],
  ['sms.settings_tested', ownersAndThePerson],
  ['sms.settings_removed', ownersAndThePerson],
  // Somebody's mobile number added, confirmed or removed (SMS1): for the
  // owners, the person and whoever did it. Masked, never the number.
  ['member.phone_added', ownersThePersonAndTheActor],
  ['member.phone_confirmed', ownersThePersonAndTheActor],
  ['member.phone_removed', ownersThePersonAndTheActor],
  // The vault's reading model turned on or off (0.9.0, R2): about the
  // household, so for the owners alone.
  ['household.reading_model_changed', ownersAndThePerson],
  // The local AI reader turned on or off for the household (0.9.0, R4):
  // about the household, so for the owners alone.
  ['household.local_ai_changed', ownersAndThePerson],
  // The AI reader set in Settings, changed or removed, and tested (0.9.0,
  // AIR1): about the household, so for the owners alone.
  ['ai_reader.changed', ownersAndThePerson],
  ['ai_reader.tested', ownersAndThePerson],
  // "Also send sensitive papers" on or off (0.9.0, AIR3): the owners'.
  ['ai_reader.send_sensitive_changed', ownersAndThePerson],
  // Where the nightly backups are copied (0.9.0-dev.76): saved, tested,
  // turned on or off, forgotten — about the household, so for the owners alone.
  ['backup.offsite_saved', ownersAndThePerson],
  ['backup.offsite_tested', ownersAndThePerson],
  ['backup.offsite_changed', ownersAndThePerson],
  ['backup.offsite_removed', ownersAndThePerson],
  ['export.requested', BY_TYPE],
  ['export.downloaded', BY_TYPE],
  // 0.9.0-dev.82: the activity log downloaded as a spreadsheet — the whole
  // log's for whoever reads it (no object), as a copy of everything asked
  // for is; one document's lines, that document's line, for whoever may see it.
  ['audit.exported', BY_TYPE],
  // signing in
  ['auth.signed_in', BY_TYPE],
  ['auth.session_revoked', BY_TYPE],
  // 0.9.0: every other device of one's own signed out, as one is.
  ['auth.signed_out_others', BY_TYPE],
  // 0.9.0-dev.86: a session locked, and unlocked, as a sign-in's lines are.
  ['session.locked', BY_TYPE],
  ['session.unlocked', BY_TYPE],
  // 0.9.0-dev.87: a browser locked by the vault after a while away, as Lock's
  // line is; and somebody's own time for it: for the owners, the person and
  // whoever did it.
  ['session.locked_away', BY_TYPE],
  ['session.auto_lock_changed', ownersThePersonAndTheActor],
  // 0.9.0: a failed try at signing in to somebody's account, or at
  // confirming it's them: for the person and the owners, nobody else.
  ['auth.sign_in_failed', ownersThePersonAndTheActor],
  ['auth.totp_enabled', BY_TYPE],
  ['auth.totp_disabled', BY_TYPE],
  // 0.9.0 (SMS3): codes by text turned on or off for a reset or a sign-in,
  // as two-step sign-in's lines are.
  ['auth.text_codes_changed', BY_TYPE],
  // A sign-in or a reset that went on without its code by text (SMS3; the
  // owner's decision of 12 Nov 2026): for the owners, the person and whoever
  // did it, as the owners' sign-in lines are.
  ['auth.text_code_skipped', ownersThePersonAndTheActor],
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
  // Who manages a collection (0.9.0): made one, what they may do changed,
  // taken away — by somebody, or as it was made for fewer people. The
  // collection's audience's, as its other lines are: the person it is
  // about among them while they can see it, and never once they cannot
  // (its name is information).
  ['collection.manager_added', seesTheCollection],
  ['collection.manager_changed', seesTheCollection],
  ['collection.manager_removed', seesTheCollection],
  // asking somebody to send documents (5.21): the request's reviewers'.
  ['upload_request.created', BY_TYPE],
  ['upload_request.revoked', BY_TYPE],
  ['upload_request.opened', BY_TYPE],
  ['upload_request.code_sent', BY_TYPE],
  ['upload_request.locked', BY_TYPE],
  ['upload_request.submitted', BY_TYPE],
  ['upload_request.resumed', BY_TYPE],
  ['upload_request.closed', BY_TYPE],
  // 0.9.0 (LK): a request shown again to whoever asked, and changed by them.
  ['upload_request.revealed', BY_TYPE],
  ['upload_request.changed', BY_TYPE],
  // 16 Nov 2026: a request emailed by the vault, the address masked.
  ['upload_request.emailed', BY_TYPE],
  // 0.9.0-dev.69: a request texted by the vault, the number masked.
  ['upload_request.texted', BY_TYPE],
  ['upload_request.text_not_sent', BY_TYPE],
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
  // 0.9.0 (H4): a clinician's link to somebody's emergency information —
  // made, opened, taken back, emailed — is the person's, the owners' and
  // whoever made it.
  ['emergency', emergencyLine],
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

/** A stretch of the log in which a collection's link gave a document: `[from, to)` by row id. */
interface Window {
  share_id: string;
  from: number;
  /** Null: it gives it still, or did until it was removed. */
  to: number | null;
}

/** Past every row id: a stretch that has not ended. */
const END = '9223372036854775807';

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
  /** A guest's, said as one (5.34): "Guest — Jane Smith, attorney". */
  actor_guest: string | null;
  member_guest: string | null;
  document_title: string | null;
  /** Sensitive, all said (H1a): its line names it "a sensitive document". */
  document_sensitive: boolean | null;
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
    opts: {
      before?: number | undefined;
      limit?: number | undefined;
      /**
       * One document's lines alone (0.9.0, DA): `GET /documents/{id}/activity`.
       * The same lines, shown to the same people, as the whole log.
       */
      documentId?: string | undefined;
    } = {},
  ): Promise<ActivityPage> {
    requireCapability(p, 'audit.read');
    const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 100);

    return withPrincipal(this.db, p, async (trx) => {
      // A moment a line names is said on the household's clock (5.26).
      const household = await trx
        .selectFrom('household')
        .select(['timezone'])
        .where('id', '=', p.householdId)
        .executeTakeFirst();
      const zone = householdZone(household?.timezone);
      if (opts.documentId) {
        return this.documentPage(trx, p, opts.documentId, opts.before, limit, zone);
      }
      const read = await this.read(trx, p, null, opts.before, limit + 1);
      const rows = read.slice(0, limit);
      // One sitting with a document is one line, not one per page (0.4.12).
      const items = describeEvents(await this.shown(trx, p, rows, zone));
      const last = rows[rows.length - 1];
      return {
        items,
        // The cursor follows the rows read, not the lines shown: a page
        // that hides everything still moves forward.
        next: read.length > limit && last ? Number(last.id) : null,
      };
    });
  }

  /**
   * What an export of the log (0.9.0-dev.82) needs before its first line,
   * and everything it may refuse, asked before anything is written: whoever
   * reads the log (`audit.read`), and for one document's lines a document
   * they can see (`404` else, as `GET /documents/{id}/activity` says). The
   * household's clock and calendar, and the family as the reader is given
   * it (`GET /members`): the names of the Who column and its filter.
   */
  async exportStart(p: Principal, ask: ExportAsk): Promise<ExportStart> {
    requireCapability(p, 'audit.read');
    return withPrincipal(this.db, p, async (trx) => {
      const household = await trx
        .selectFrom('household')
        .select(['timezone'])
        .where('id', '=', p.householdId)
        .executeTakeFirst();
      const zone = householdZone(household?.timezone);
      // As GET /members gives the family: never a guest but oneself.
      const family = await trx
        .selectFrom('member')
        .select(['id', 'display_name'])
        .where((eb) => eb.or([eb('kind', '=', 'family'), eb('id', '=', p.memberId)]))
        .execute();
      const windows = ask.document ? await this.aboutDocument(trx, p, ask.document) : null;
      // The From and To days' bounds, on the household's clock as the
      // database keeps its zones: a day of 23 or 25 hours as it was.
      const bounds = await sql<{ from_start: Date | null; to_end: Date | null }>`
        select case when ${ask.from ?? null}::date is null then null
                    else (${ask.from ?? null}::date)::timestamp at time zone ${zone} end as from_start,
               case when ${ask.to ?? null}::date is null then null
                    else (${ask.to ?? null}::date + 1)::timestamp at time zone ${zone} end as to_end
      `.execute(trx);
      return {
        zone,
        today: localToday(zone),
        family: new Map(family.map((m) => [m.id, m.display_name])),
        windows,
        fromStart: bounds.rows[0]?.from_start ?? null,
        toEnd: bounds.rows[0]?.to_end ?? null,
      };
    });
  }

  /**
   * The lines an export writes, newest first, each as the log shows it to
   * this reader — the same rows, the same rule, the same words, a sitting's
   * looks one line — and the filters' lines alone, each kept as the page
   * keeps it: a line's day is its newest moment's. Read `EXPORT_BATCH` rows
   * at a time, each batch in its own transaction, so a long log is never
   * held whole, nor one transaction kept open while a slow download is
   * taken; each batch asks again that the reader still reads the log as
   * they did (`stillReading`). A line that may yet fold older rows (a
   * sitting) waits for the next batch. The reads leave out what cannot be
   * a line the filters keep (`Narrow`), and stop once past the From day
   * with no line left that began in it. At most `EXPORT_MAX_ROWS` rows, or
   * `EXPORT_MAX_MS`: `outcome` then says how far back it read.
   */
  async *exportLines(
    p: Principal,
    ask: ExportAsk,
    start: ExportStart,
    limits: ExportLimits = {},
    outcome: ExportOutcome = { stopped: null },
  ): AsyncGenerator<ActivityCsvLine> {
    const batch = limits.batch ?? EXPORT_BATCH;
    const maxRows = limits.rows ?? EXPORT_MAX_ROWS;
    const maxMs = limits.ms ?? EXPORT_MAX_MS;
    const began = Date.now();
    const narrow: Narrow = {
      until: start.toEnd ? new Date(start.toEnd.getTime() + APP_SENT_FOLD_MS) : null,
      actions: ask.kind ? actionsOfKind(ask.kind) : null,
      who: ask.who && ask.who !== ACTIVITY_ANYBODY_ELSE ? ask.who : null,
    };
    const filters: ActivityFilters = {
      who: ask.who ?? '',
      kind: ask.kind ?? '',
      // Kept by moment below, as the days' bounds are moments.
      from: '',
      to: '',
    };
    const isFamily = (id: string) => start.family.has(id);
    const inDays = (iso: string) => {
      const at = Date.parse(iso);
      return (
        (!start.fromStart || at >= start.fromStart.getTime()) &&
        (!start.toEnd || at < start.toEnd.getTime())
      );
    };
    let cursor: number | undefined;
    let carry: ActivityEvent[] = [];
    let read = 0;
    for (;;) {
      const before = cursor;
      const { rows, events } = await withPrincipal(this.db, p, async (trx) => {
        await stillReading(trx, p);
        const picked =
          ask.document && start.windows
            ? this.picked(p, ask.document, start.windows, before, batch, narrow)
            : null;
        const rows = await this.read(trx, p, picked, before, batch, narrow);
        return { rows, events: await this.shown(trx, p, rows, start.zone) };
      });
      read += rows.length;
      const all = [...carry, ...events];
      const done = rows.length < batch;
      const spans = describeEventSpans(all);
      const ready = done ? spans : spans.slice(0, -1);
      for (const { line } of ready) {
        if (!inDays(line.at) || !activityLineKept(line, filters, isFamily, () => '')) continue;
        const e = all.find((x) => x.id === line.id);
        yield {
          line,
          who: line.actor_member_id ? (start.family.get(line.actor_member_id) ?? null) : null,
          document: e ? documentNamed(e) : null,
        };
      }
      const last = rows[rows.length - 1];
      if (done || !last) return;
      const waiting = spans[spans.length - 1];
      carry = waiting ? all.slice(all.findIndex((x) => x.id === waiting.line.id)) : [];
      cursor = Number(last.id);
      // Past the From day, and the line still folding (if any) newer than
      // nothing in it: there is nothing more to keep.
      if (
        start.fromStart &&
        last.at.getTime() < start.fromStart.getTime() &&
        (!waiting || Date.parse(waiting.line.at) < start.fromStart.getTime())
      ) {
        return;
      }
      const by = read >= maxRows ? 'rows' : Date.now() - began >= maxMs ? 'time' : null;
      if (by) {
        outcome.stopped = { by, readTo: waiting ? waiting.line.at : last.at.toISOString() };
        return;
      }
    }
  }

  /**
   * An export's own line (0.9.0-dev.82), written once as it ends: the
   * filters it was asked for, how many lines it wrote, whether it stopped
   * short and why (its lines, the rows or the time one file reads), and
   * whether it was taken to the end. Never a line's words.
   */
  async recordExport(
    p: Principal,
    ask: ExportAsk,
    done: { lines: number; capped: 'lines' | 'rows' | 'time' | null; finished: boolean },
    ip: string | null | undefined,
  ): Promise<void> {
    await withPrincipal(this.db, p, (trx) =>
      appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'audit.exported',
        objectType: ask.document ? 'document' : null,
        objectId: ask.document ?? null,
        detail: {
          format: 'csv',
          ...(ask.who ? { who: ask.who } : {}),
          ...(ask.kind ? { kind: ask.kind } : {}),
          ...(ask.from ? { from: ask.from } : {}),
          ...(ask.to ? { to: ask.to } : {}),
          lines: done.lines,
          capped: done.capped !== null,
          ...(done.capped ? { capped_by: done.capped } : {}),
          finished: done.finished,
        },
        ip: ip ?? null,
      }),
    );
  }

  /**
   * One document's page (0.9.0, DA): read on until it has `limit` lines
   * the reader is shown, or there is nothing older. Its cursor is the
   * oldest row of the last line shown (a sitting's last look), never a row
   * the reader is not shown — a page with nothing shown would otherwise
   * hand over a cursor for each line kept from them, counting them.
   */
  private async documentPage(
    trx: Db,
    p: Principal,
    documentId: string,
    before: number | undefined,
    limit: number,
    zone: string,
  ): Promise<ActivityPage> {
    const windows = await this.aboutDocument(trx, p, documentId);
    const visible: ActivityEvent[] = [];
    let cursor = before;
    for (let batch = limit + 1; ; batch = 100) {
      const rows = await this.read(
        trx,
        p,
        this.picked(p, documentId, windows, cursor, batch),
        cursor,
        batch,
      );
      visible.push(...(await this.shown(trx, p, rows, zone)));
      const spans = describeEventSpans(visible);
      // A line past the page: the page's last line is whole.
      const lastShown = spans[limit - 1];
      if (spans.length > limit && lastShown) {
        return { items: spans.slice(0, limit).map((s) => s.line), next: lastShown.oldest };
      }
      const last = rows[rows.length - 1];
      if (rows.length < batch || !last) {
        return { items: spans.map((s) => s.line), next: null };
      }
      cursor = Number(last.id);
    }
  }

  /** The log's rows, newest first, before the cursor: the household's, or those `picked` names. */
  private async read(
    trx: Db,
    p: Principal,
    picked: RawBuilder<unknown> | null,
    before: number | undefined,
    count: number,
    narrow?: Narrow,
  ): Promise<Row[]> {
    // Raw SQL because this joins the audit row to three different
    // things by `object_type`, which Kysely would make harder to read
    // rather than easier.
    const result = await sql<Row>`
        ${picked ?? sql``}
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
               -- A guest is never named as one of the family (5.34): what
               -- they are to it is said with their name.
               case when actor_member.kind = 'guest'
                    then coalesce(actor_member.relationship, '') end as actor_guest,
               case when object_member.kind = 'guest'
                    then coalesce(object_member.relationship, '') end as member_guest,
               d.title                   as document_title,
               -- Sensitive, all said (0.9.0, H1a): such a line never says
               -- its title, to whoever reads it.
               case when d.id is not null then ${sensitiveSql('d')} end as document_sensitive,
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
               (ur.id is not null or urt.id is not null) as request_visible
          from audit_event e
          left join account_household ah
            on ah.account_id = e.actor_account_id
           and ah.household_id = e.household_id
          left join member actor_member on actor_member.id = ah.member_id
          left join document d
            on e.object_type = 'document' and d.id = e.object_id
          left join document_tombstone gone
            on e.object_type = 'document' and gone.id = e.object_id
          -- Whom a line is about: a person's own lines, and a collection's
          -- manager's (0.9.0), who is named in its detail.
          left join member object_member
            on object_member.id = case when e.object_type in ('member', 'emergency')
                                         then e.object_id
                                       when e.action in ('collection.manager_added',
                                                         'collection.manager_changed',
                                                         'collection.manager_removed')
                                         then (e.detail->>'member_id')::uuid
                                  end
          -- A collection's own lines name it; a line about a document put in one,
          -- or taken out, keeps the collection's id in its detail (5.14).
          left join doc_collection l
            on l.id = case when e.object_type = 'collection' then e.object_id
                           when e.action in ('collection.item_added', 'collection.item_removed',
                                             'share.followed', 'share.left_out')
                             then (e.detail->>'collection_id')::uuid
                      end
          -- A request to send documents, as the reader is given it (5.21):
          -- its own lines, and those of the files that came in through it.
          left join upload_request ur
            on ur.id = case when e.object_type = 'upload_request' then e.object_id
                            when e.object_type = 'incoming_file'
                              then (e.detail->>'request_id')::uuid
                       end
          -- One removed once it had ended (0106, RQ): its tombstone, given
          -- to the reader as the request was.
          left join upload_request_tombstone urt
            on urt.id = case when e.object_type = 'upload_request' then e.object_id
                             when e.object_type = 'incoming_file'
                               then (e.detail->>'request_id')::uuid
                        end
         where e.household_id = ${p.householdId}
           ${before ? sql`and e.id < ${before}` : sql``}
           ${narrowed(narrow, p.householdId, 'e.')}
           ${picked ? sql`and e.id in (select id from picked)` : sql``}
         order by e.id desc
         limit ${count}
      `.execute(trx);
    return result.rows;
  }

  /** The rows a reader is shown, as events to say. */
  private async shown(trx: Db, p: Principal, rows: Row[], zone: string): Promise<ActivityEvent[]> {
    const links = await this.collectionLinks(trx, p, rows);
    // The "Same as" list's lines (0.9.0-dev.91) keep two issuer keys: each
    // named to this reader as their own papers name it, else not named.
    const keys = rows.flatMap((r) => {
      if (r.action !== 'issuer.joined' && r.action !== 'issuer.separated') return [];
      const d = (r.detail ?? {}) as Record<string, unknown>;
      return [d.from_key, d.to_key].filter((k): k is string => typeof k === 'string');
    });
    const issuerNames = keys.length > 0 ? await issuerNamesOf(trx, p, [...new Set(keys)]) : null;
    const events: ActivityEvent[] = [];
    for (const r of rows) {
      // A private document belongs to one person, and so does every line
      // about it; a line nobody has said the audience of is nobody's.
      if (!shownTo(p, { ...r, link: linkOf(r, links) })) continue;
      events.push({
        id: Number(r.id),
        at: r.at.toISOString(),
        action: r.action,
        actor:
          r.actor_name !== null && r.actor_guest !== null
            ? guestLabel(r.actor_name, r.actor_guest)
            : r.actor_name,
        actor_id: r.actor_account_id,
        actor_member_id: r.actor_member_id,
        actor_label: r.actor_label,
        object_type: r.object_type,
        object_id: r.object_id,
        object_title:
          r.document_title ??
          (r.member_name !== null && r.member_guest !== null
            ? guestLabel(r.member_name, r.member_guest)
            : r.member_name),
        ...(r.document_sensitive === true ? { object_sensitive: true } : {}),
        collection_name: r.collection_name,
        detail: issuerNames
          ? namedIssuers(r.action, (r.detail ?? {}) as Record<string, unknown>, issuerNames)
          : ((r.detail ?? {}) as Record<string, unknown>),
        timezone: zone,
      });
    }
    return events;
  }

  /**
   * One document (0.9.0, DA), and when each collection's link gave it:
   * the stretches of the log — `[from, to)` by row id — in which the
   * link's own lines (made, opened, a ZIP downloaded, a code sent or
   * emailed, taken back: written about its collection) carried it. Found
   * from the document's own lines and the link's `share.created`, never by
   * today's membership alone:
   *
   *  - from the link's making, for a document ticked as it was made
   *    (`share.created`'s `document_ids`); from its `share.followed`;
   *  - until its `share.left_out` (Sensitive), or until it was taken out
   *    of the collection (`collection.item_removed`) — a ticked one again
   *    from when it is put back (`collection.item_added`), a followed one
   *    from its next `share.followed`;
   *  - a ticked document the link left out with no `share.left_out` — as
   *    the document was made Only me or Adults only, whose line says only
   *    how many links ended, never which — has none of the link's own
   *    lines: the log cannot say when it stopped.
   *
   * Links live and removed once they had ended (0106, RQ: their
   * tombstones). A document the caller cannot see — another member's Only
   * me, removed for good, seen only as its person's caregiver — is not
   * there, as `GET /documents/{id}` says; one in the Trash keeps its history.
   */
  private async aboutDocument(trx: Db, p: Principal, documentId: string): Promise<Window[]> {
    const doc = await trx
      .selectFrom('document')
      .select(['visibility', 'owner_member_id'])
      .where('id', '=', documentId)
      .executeTakeFirst();
    if (!doc || !canSee(p, doc)) throw notFound('That document');
    // What the document's own lines say of collections and their links.
    const said = await sql<{
      id: string;
      action: string;
      share_id: string | null;
      collection_id: string | null;
    }>`
      select id, action, detail->>'share_id' as share_id, detail->>'collection_id' as collection_id
        from audit_event
       where household_id = ${p.householdId}
         and object_type = 'document'
         and object_id = ${documentId}::uuid
         and action in ('share.followed', 'share.left_out',
                        'collection.item_added', 'collection.item_removed')
       order by id`.execute(trx);
    // Every link that may have given it: as its row says now, as its
    // tombstone says, or as one of those lines names it.
    const now = await sql<{ id: string; kind: string }>`
      select share_id as id, kind from share_link_item where document_id = ${documentId}::uuid
      union all
      select id, 'ticked' from share_link_tombstone
       where document_ids @> array[${documentId}]::uuid[]`.execute(trx);
    const kinds = new Map<string, Set<string>>();
    for (const r of now.rows) kinds.set(r.id, (kinds.get(r.id) ?? new Set()).add(r.kind));
    const ids = [
      ...new Set([
        ...now.rows.map((r) => r.id),
        ...said.rows.flatMap((r) =>
          r.action.startsWith('share.') && r.share_id && UUID.test(r.share_id)
            ? [r.share_id.toLowerCase()]
            : [],
        ),
      ]),
    ];
    if (ids.length === 0) return [];
    // Each link's making: its collection, and what it was made with.
    const made = await sql<{
      id: string;
      share_id: string;
      collection_id: string;
      ticked: unknown;
    }>`
      select id, detail->>'share_id' as share_id, object_id as collection_id,
             detail->'document_ids' as ticked
        from audit_event
       where household_id = ${p.householdId}
         and object_type = 'collection'
         and detail->>'share_id' = any(${ids}::text[])
         and action = 'share.created'`.execute(trx);
    const windows: Window[] = [];
    for (const m of made.rows) {
      const link = m.share_id.toLowerCase();
      const mine = said.rows.filter((r) =>
        r.action.startsWith('share.')
          ? r.share_id?.toLowerCase() === link
          : r.collection_id?.toLowerCase() === m.collection_id,
      );
      const leftOutSaid = mine.some((r) => r.action === 'share.left_out');
      let ticked = Array.isArray(m.ticked) && (m.ticked as unknown[]).includes(documentId);
      // Left out with nothing in the log to say when: none of its lines.
      if (ticked && kinds.get(link)?.has('left_out') && !leftOutSaid) continue;
      let from: number | null = ticked ? Number(m.id) : null;
      for (const r of mine) {
        const at = Number(r.id);
        if (at < Number(m.id)) continue;
        if (r.action === 'share.followed' || r.action === 'collection.item_added') {
          // Put back in, a ticked one is given again; a followed one
          // only once it has followed again.
          if (r.action === 'share.followed' || ticked) from ??= at;
          continue;
        }
        // Left out (Sensitive), or taken out of the collection.
        if (r.action === 'share.left_out') ticked = false;
        if (from !== null) windows.push({ share_id: link, from, to: at });
        from = null;
      }
      if (from !== null) windows.push({ share_id: link, from, to: null });
    }
    return windows;
  }

  /**
   * The rows about one document (0.9.0, DA), as a `with picked (id)` for
   * the log's own query: its own lines (`object_type = 'document'`) by
   * `audit_event_document_idx`, and each collection's link's own lines in
   * the stretches it gave the document, by `audit_event_share_idx` (0107),
   * never by reading the household's whole log. Each part reads no more
   * than a page, newest first, before the cursor.
   */
  private picked(
    p: Principal,
    documentId: string,
    windows: Window[],
    before: number | undefined,
    count: number,
    narrow?: Narrow,
  ): RawBuilder<unknown> {
    const older = sql`${before ? sql`and id < ${before}` : sql``} ${narrowed(narrow, p.householdId, '')}`;
    return sql`
      with picked as (
        (select id from audit_event
          where household_id = ${p.householdId}
            and object_type = 'document'
            and object_id = ${documentId}::uuid
            ${older}
          order by id desc
          limit ${count})
        ${
          windows.length === 0
            ? sql``
            : sql`union all
        (select x.id
           from unnest(${windows.map((w) => w.share_id)}::text[],
                       ${windows.map((w) => w.from)}::bigint[],
                       ${windows.map((w) => w.to ?? END)}::bigint[]) as w(share_id, from_id, to_id)
          cross join lateral (
            select id from audit_event
             where household_id = ${p.householdId}
               and object_type = 'collection'
               and detail->>'share_id' = w.share_id
               and id >= w.from_id and id < w.to_id
               ${older}
             order by id desc
             limit ${count}) x
          order by x.id desc
          limit ${count})`
        }
      )`;
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
    const live = await trx
      .selectFrom('share_link as s')
      .leftJoin('doc_collection as c', 'c.id', 's.collection_id')
      .select(['s.id', 's.created_by', 'c.audience', 'c.owner_member_id'])
      .where('s.id', 'in', ids)
      .where('s.collection_id', 'is not', null)
      .execute();
    // And one removed once it had ended (0106, RQ), as its tombstone says.
    const removed = await trx
      .selectFrom('share_link_tombstone as s')
      .leftJoin('doc_collection as c', 'c.id', 's.collection_id')
      .select(['s.id', 's.created_by', 'c.audience', 'c.owner_member_id'])
      .where('s.id', 'in', ids)
      .execute();
    const made = [...live, ...removed.filter((g) => !live.some((l) => l.id === g.id))];
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
 * document may be either. A collection's link emailed by the vault
 * (`share_link.emailed`, about its collection) is one too: without it,
 * that line was shown to nobody, its maker included (fixed in DA). A
 * document's link emailed keeps its document's rule. Undefined for any
 * other line; an empty id for a line that names none it can be found by.
 */
function linkNamed(r: Row): { id: string; collections: boolean } | undefined {
  // Texted (0.9.0-dev.69) as emailed.
  const emailed =
    (r.action === 'share_link.emailed' ||
      r.action === 'share_link.texted' ||
      r.action === 'share_link.text_not_sent') &&
    r.object_type === 'collection';
  if (!r.action.startsWith('share.') && !emailed) return undefined;
  const collections =
    r.object_type === 'collection' ||
    r.action === 'share.followed' ||
    r.action === 'share.left_out';
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

/**
 * A "Same as" line's detail (0.9.0-dev.91) as one reader is told it: its two
 * issuer keys named by that reader's own papers (`issuer`, `same_as`), and
 * no name — never the key — for one they can read no paper of.
 */
function namedIssuers(
  action: string,
  detail: Record<string, unknown>,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (action !== 'issuer.joined' && action !== 'issuer.separated') return detail;
  const name = (k: unknown) => (typeof k === 'string' ? names.get(k) : undefined);
  const { from_key, to_key, ...rest } = detail;
  const from = name(from_key);
  const to = name(to_key);
  return { ...rest, ...(from ? { issuer: from } : {}), ...(to ? { same_as: to } : {}) };
}
