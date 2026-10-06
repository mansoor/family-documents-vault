import { randomBytes } from 'node:crypto';
import {
  openChunk,
  openPrivate,
  sealChunk,
  sealPrivate,
  unwrapKey,
  wrapKey,
  type ScopeKeys,
} from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db, type Visibility } from '@fdv/db';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { requireCapability } from '../authz.js';
import {
  can,
  canSee,
  mayChangeVisibilityAtAll,
  ONLY_ME_KEEP_REFUSED,
  visibilityRefusal,
  type OwnLinkToEnd,
  type VisibilityAsker,
  type VisibilityChange,
} from '@fdv/shared';
import { onlyMeShareable } from './only-me-rule.js';
import { endSessions } from './share-sessions.js';
import { protectionOf, SHARE_PAGES_PRUNE_JOB } from './shares.js';
import type { Enqueue } from './service.js';

/**
 * Changing a document's visibility (SEC-13, FND-07, decision 2).
 *
 * The file is never re-encrypted: each version's file key is unwrapped
 * with the old scope key and rewrapped with the new one, 32 bytes at a
 * time. OCR text moves between the plain table (household, adults) and the
 * sealed table (private), so a private document's words leave the index
 * in the same transaction that hides the document. Its notes and details
 * move with it (0.5.8): sealed under its owner's member key on the way in,
 * the plain columns emptied; opened and put back on the way out.
 */
export class VisibilityService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    /** How a view-only link ended here has its pages removed (5.18). */
    private readonly enqueue: Enqueue = async () => undefined,
  ) {}

  /**
   * The sentence that has to be said at the moment it becomes true
   * (SEC-19). It is a message about death, so it is brief, plain and
   * unsentimental, and it is said once per document and never again.
   */
  static readonly PRIVATE_NOTICE = {
    title: 'Only you can open this',
    body: 'Nobody can open it after you, unless you leave a key. Leaving a key with someone you trust is not built yet; when it is, this document will be on the list.',
  };

  /**
   * Into Only me (the owner's decision of 6 Oct 2026): links others made to
   * it stop, as they always have — none of them may see it now — and are
   * counted in the answer; the person's own links that would still send it
   * are theirs to end (`ownLinks: 'end'`, the default the web offers) or
   * keep (`'keep'`), and with neither said, while there are any, it is `409
   * links_choice_needed`, its `detail` naming them — whom each is for, its
   * end, what it asks for, never a token. While the household does not
   * share Only me documents outside the family, there is no keeping them
   * (`409 only_me_not_shared`). The notice says what is true now.
   */
  async change(
    p: Principal,
    documentId: string,
    to: Visibility,
    meta: RequestMeta,
    ownLinks?: 'end' | 'keep',
  ): Promise<VisibilityChange> {
    // A viewer is refused before anything is looked up, as always. A teen
    // may change their own (A72): which, the document says.
    if (!mayChangeVisibilityAtAll(p.role)) requireCapability(p, 'document.visibility');
    const result = await withPrincipal(this.db, p, async (trx) => {
      // Locked before its versions are read: an upload committing a new
      // version holds the same lock, so every version is rewrapped, the new
      // one included (documents/service.ts accept()).
      const doc = await trx
        .selectFrom('document')
        .select([
          'id',
          'visibility',
          'owner_member_id',
          'created_by',
          'notes',
          'extra',
          'notes_sealed',
          'extra_sealed',
        ])
        .where('id', '=', documentId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      // Somebody else's private document is not there, as it is everywhere
      // else — a 403 here would confirm that it exists.
      if (!doc || !canSee(p, doc)) {
        throw new ApiError(404, 'not_found', 'That document is not in the vault.');
      }
      // Sealed and wrapped for the id as the database writes it: the one in
      // the address may be in capitals, or without its hyphens, and every
      // reader opens by the row's own (5.9 review).
      documentId = doc.id;
      // Only the owning member may see a private document, so only they may
      // move one in or out of private; a teen, only their own that they
      // filed, between Only me and Everyone (A72). The rule and its
      // sentences: roles.ts.
      const refusal = visibilityRefusal(askerOf(p, doc), doc.visibility, to);
      if (refusal) throw new ApiError(403, 'forbidden', refusal);
      if (doc.visibility === to) return { notice: null, prune: [] as string[] };

      // Into Only me: the person's own links that would still send it, and
      // how many of everybody else's stop with it.
      const into = to === 'private' && doc.visibility !== 'private';
      const own = into ? await ownLinksServing(trx, p, documentId) : [];
      const others = into ? await othersLinksServing(trx, p, documentId) : 0;
      // A link a restore paused waits for an owner to turn it back on (A55),
      // and no owner can see somebody else's Only me document: for anybody
      // but an owner, it can never send again once this is Only me. Named,
      // it ends whichever is chosen; only a link that can send is kept, and
      // said to be (the Phase 5 exit's fourth round, API-1).
      const resumes = can(p.role, 'restore.review');
      const canSend = (l: OwnLink) => l.paused_reason !== 'restored' || resumes;
      let ending: OwnLink[] = [];
      let kept: OwnLink[] = [];
      let yoursNow: 'ended' | 'kept' | null = null;
      if (own.length > 0) {
        const shareable = await onlyMeShareable(trx);
        if (ownLinks === 'keep' && !shareable) {
          throw new ApiError(409, 'only_me_not_shared', ONLY_ME_KEEP_REFUSED);
        }
        if (ownLinks === undefined) {
          const links: OwnLinkToEnd[] = own.map((l) => ({
            id: l.id,
            kind: l.kind,
            recipient_label: l.recipient_label,
            collection_name: l.collection_name,
            expires_at: l.expires_at.toISOString(),
            protection: protectionOf(l),
            ...(canSend(l) ? {} : { will_end: true }),
          }));
          throw new ApiError(
            409,
            'links_choice_needed',
            own.length === 1
              ? 'You have a link that sends this outside the family. Choose whether it ends or is kept, now that it is Only me.'
              : `You have ${own.length} links that send this outside the family. Choose whether they end or are kept, now that it is Only me.`,
            { detail: JSON.stringify({ links, keep_allowed: shareable, others }) },
          );
        }
        ending = ownLinks === 'end' ? own : own.filter((l) => !canSend(l));
        kept = ownLinks === 'keep' ? own.filter(canSend) : [];
        yoursNow = kept.length > 0 ? 'kept' : 'ended';
      }
      const prune: string[] = [];
      if (ending.length > 0) {
        // A document's link ends, as Take it back ends it — its code's
        // address with it; a collection's link leaves this one out, and
        // gives the rest as before.
        const single = ending.filter((l) => l.kind === 'document').map((l) => l.id);
        if (single.length > 0) {
          await trx
            .updateTable('share_link')
            .set({ revoked_at: new Date(), revoked_by: p.accountId, code_email: null })
            .where('id', 'in', single)
            .where('revoked_at', 'is', null)
            .execute();
          await endSessions(trx, single);
        }
        const collections = ending.filter((l) => l.kind === 'collection').map((l) => l.id);
        if (collections.length > 0) {
          // Left out, as one not ticked when the link was made: it never
          // goes with this link again, whatever it is made later.
          await sql`update share_link_item set kind = 'left_out'
                     where share_id = any(${collections}::uuid[])
                       and document_id = ${documentId} and kind = 'ticked'`.execute(trx);
        }
        prune.push(
          ...ending
            .filter((l) => l.kind === 'document' && l.permission === 'view')
            .map((l) => l.id),
        );
      }
      const links = into ? { yours: own.length, yours_now: yoursNow, others } : undefined;
      // Made private, it leaves every export somebody else asked for:
      // those were built while they could see it.
      if (to === 'private') {
        await trx
          .updateTable('export')
          .set({ expires_at: new Date() })
          .where('requested_by', '!=', p.accountId)
          .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
          .execute();
      }

      const from = await this.keys.unwrap(
        trx,
        scopeRef(p.householdId, doc.visibility, doc.owner_member_id),
      );
      const target = await this.keys.unwrap(trx, scopeRef(p.householdId, to, doc.owner_member_id));

      const versions = await trx
        .selectFrom('document_version')
        .select(['id', 'file_key_wrapped'])
        .where('document_id', '=', documentId)
        .execute();
      for (const v of versions) {
        const fileKey = unwrapKey(v.file_key_wrapped, from.key, `version:${documentId}`);
        await trx
          .updateTable('document_version')
          .set({
            file_key_wrapped: wrapKey(fileKey, target.key, `version:${documentId}`),
            wrapped_by_scope: target.id,
          })
          .where('id', '=', v.id)
          .execute();
      }

      // Move the text.
      if (to === 'private') {
        const plain = await trx
          .selectFrom('document_text')
          .selectAll()
          .where('document_id', '=', documentId)
          .execute();
        for (const row of plain) {
          const prefix = randomBytes(8);
          const bytes = Buffer.from(row.content, 'utf8');
          const sealed = sealChunk(
            target.key,
            { prefix, chunkSize: bytes.length || 1 },
            0,
            true,
            bytes,
          );
          await trx
            .insertInto('document_text_sealed')
            .values({
              version_id: row.version_id,
              household_id: p.householdId,
              document_id: documentId,
              content_cipher: Buffer.concat([prefix, sealed]),
            })
            .execute();
        }
        await trx.deleteFrom('document_text').where('document_id', '=', documentId).execute();
      } else if (doc.visibility === 'private') {
        const sealed = await trx
          .selectFrom('document_text_sealed')
          .selectAll()
          .where('document_id', '=', documentId)
          .execute();
        for (const row of sealed) {
          const prefix = row.content_cipher.subarray(0, 8);
          const body = row.content_cipher.subarray(8);
          const content = openChunk(
            from.key,
            { prefix, chunkSize: body.length - 16 },
            0,
            true,
            body,
          ).toString('utf8');
          await trx
            .insertInto('document_text')
            .values({
              version_id: row.version_id,
              household_id: p.householdId,
              document_id: documentId,
              content,
            })
            .execute();
        }
        await trx
          .deleteFrom('document_text_sealed')
          .where('document_id', '=', documentId)
          .execute();
      }

      // Move the notes and details, in the same statement that hides or
      // shows the document: sealed under the owner's key on the way in (the
      // plain columns emptied, and which details have a value written down
      // for its status), opened and put back on the way out.
      let moved = {};
      if (to === 'private' || doc.visibility === 'private') {
        const plain = { notes: doc.notes, extra: extraOf(doc.extra) };
        const sealed =
          doc.notes_sealed || doc.extra_sealed
            ? openPrivate(from.key, documentId, doc)
            : { notes: null, extra: {} };
        // Anything the private.seal job had not reached yet, as it is.
        const values = {
          notes: plain.notes ?? sealed.notes,
          extra: { ...sealed.extra, ...plain.extra },
        };
        moved =
          to === 'private'
            ? { ...sealPrivate(target.key, documentId, values), notes: null, extra: '{}' }
            : {
                notes: values.notes,
                extra: JSON.stringify(values.extra),
                notes_sealed: null,
                extra_sealed: null,
                sealed_details: [],
              };
      }

      await trx
        .updateTable('document')
        .set({ visibility: to, updated_at: new Date(), updated_by: p.accountId, ...moved })
        .where('id', '=', documentId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.visibility_changed',
        objectType: 'document',
        objectId: documentId,
        // What happened to the links, as counts: never whom they were for,
        // nor a token.
        detail: {
          from: doc.visibility,
          to,
          versions: versions.length,
          ...(links
            ? {
                links_others_stopped: others,
                ...(ending.length > 0 ? { links_ended: ending.length } : {}),
                ...(kept.length > 0 ? { links_kept: kept.length } : {}),
              }
            : {}),
        },
        ip: meta.ip,
      });

      if (to !== 'private') return { notice: null, prune };
      // Told once per document, per person. A second visit to the same
      // decision is not a second chance to warn somebody; it is a nag.
      const already = await trx
        .selectFrom('private_notice')
        .select(['document_id'])
        .where('document_id', '=', documentId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      if (!already) {
        await trx
          .insertInto('private_notice')
          .values({
            household_id: p.householdId,
            document_id: documentId,
            member_id: p.memberId,
          })
          .execute();
      }
      // With links of their own, what is true now is said every time: who
      // else can open it, or that the links ended; and that links somebody
      // else made have stopped.
      const notice = yoursNow
        ? {
            // Who else can open it: the people the links kept are for, and
            // only those that can send.
            title:
              yoursNow === 'kept'
                ? privateTitle('kept', kept.length)
                : privateTitle('ended', ending.length),
            body:
              (already
                ? 'Nobody else in the family can open it.'
                : VisibilityService.PRIVATE_NOTICE.body) +
              (kept.length > 0 ? pausedEndedWords(ending.length) : '') +
              stoppedWords(others),
          }
        : already
          ? null
          : {
              ...VisibilityService.PRIVATE_NOTICE,
              body: VisibilityService.PRIVATE_NOTICE.body + stoppedWords(others),
            };
      return { notice, links, prune };
    });
    // A view-only link ended here: its pages go, as when it is taken back.
    for (const id of result.prune) {
      await this.enqueue(SHARE_PAGES_PRUNE_JOB, {
        household_id: p.householdId,
        share_id: id,
      }).catch(() => undefined);
    }
    return {
      notice: result.notice,
      ...('links' in result && result.links ? { links: result.links } : {}),
    };
  }
}

/** "Only you can open this. Your 2 links to it have ended." */
function privateTitle(now: 'ended' | 'kept', n: number): string {
  const links = `${n} link${n === 1 ? '' : 's'}`;
  return now === 'kept'
    ? `Only you, and the people your ${links} ${n === 1 ? 'is' : 'are'} for, can open this.`
    : `Only you can open this. Your ${links} to it ${n === 1 ? 'has' : 'have'} ended.`;
}

/** " Your link paused after a restore has ended: …" — kept beside others that can send. */
function pausedEndedWords(n: number): string {
  if (n === 0) return '';
  return n === 1
    ? ' Your link paused after a restore has ended: no owner could turn it back on while this is Only me.'
    : ` Your ${n} links paused after a restore have ended: no owner could turn them back on while this is Only me.`;
}

/** " The link someone else made to it has stopped." */
function stoppedWords(others: number): string {
  if (others === 0) return '';
  return others === 1
    ? ' The link someone else made to it has stopped.'
    : ` The ${others} links others made to it have stopped.`;
}

interface OwnLink {
  id: string;
  kind: 'document' | 'collection';
  /** Paused, and why: a restore's ('restored'), or the household's rule's. */
  paused_reason: string | null;
  recipient_label: string | null;
  collection_name: string | null;
  expires_at: Date;
  permission: string;
  pin_hash: string | null;
  secret_kind: string | null;
  code_email: string | null;
}

/**
 * The caller's own links that could send this document once it is Only me:
 * a link to it, and a collection's link that ticked it — one that only
 * followed it stops by itself, as it no longer fits. Not only those that
 * send it this moment (the third round, F1 and F2): one paused, by the
 * household's rule or by a restore, sends it again once turned back on;
 * and a collection's link whose ticked document is out of the collection
 * now sends it again once it is put back. Each is named, and ended or kept.
 */
async function ownLinksServing(trx: Db, p: Principal, documentId: string): Promise<OwnLink[]> {
  const rows = await sql<OwnLink>`
    select s.id, 'document' as kind, s.paused_reason, s.recipient_label,
           null as collection_name, s.expires_at, s.permission, s.pin_hash, s.secret_kind,
           s.code_email
      from share_link s
     where s.document_id = ${documentId}
       and s.created_by = ${p.accountId}
       and s.revoked_at is null
       and s.expires_at > now() and s.attempts < 10
    union all
    select s.id, 'collection' as kind, s.paused_reason, s.recipient_label,
           c.name as collection_name, s.expires_at, s.permission, s.pin_hash, s.secret_kind,
           s.code_email
      from share_link s
      join share_link_item t on t.share_id = s.id and t.document_id = ${documentId}
                            and t.kind = 'ticked'
      join doc_collection c on c.id = s.collection_id
     where s.created_by = ${p.accountId}
       and s.revoked_at is null
       and s.expires_at > now() and s.attempts < 10
     order by expires_at, id`.execute(trx);
  return rows.rows;
}

/** How many live links somebody else made send this document now: each stops. */
async function othersLinksServing(trx: Db, p: Principal, documentId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    select count(*)::int as n
      from share_link s
     where s.created_by <> ${p.accountId}
       and s.revoked_at is null and s.paused_at is null
       and s.expires_at > now() and s.attempts < 10
       and (s.document_id = ${documentId}
            or exists (select 1 from share_link_item t
                         join doc_collection_item i on i.collection_id = t.collection_id
                                                   and i.document_id = t.document_id
                        where t.share_id = s.id and t.document_id = ${documentId}
                          and t.kind in ('ticked', 'followed')))`.execute(trx);
  return r.rows[0]?.n ?? 0;
}

/**
 * Who is asking, as the visibility rule reads them (roles.ts): whether the
 * document is theirs, and whether they filed it.
 */
export function askerOf(
  p: Principal,
  doc: { owner_member_id: string | null; created_by: string | null },
): VisibilityAsker {
  return {
    role: p.role,
    mine: doc.owner_member_id !== null && doc.owner_member_id === p.memberId,
    filedByMe: doc.created_by !== null && doc.created_by === p.accountId,
  };
}

/** The details as the database hands them over: an object, or nothing. */
function extraOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function scopeRef(householdId: string, visibility: Visibility, ownerMemberId: string | null) {
  switch (visibility) {
    case 'household':
      return { householdId, kind: 'household' as const };
    case 'adults':
      return { householdId, kind: 'adults' as const };
    case 'private':
      return { householdId, kind: 'member' as const, memberId: ownerMemberId };
  }
}
