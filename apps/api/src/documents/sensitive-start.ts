import { householdToday, type Db, type Visibility } from '@fdv/db';
import {
  keepsOwnSensitive,
  parentsKeep,
  SENSITIVE_SHARE_CONFIRM,
  sensitiveOf,
  sensitiveStartingVisibility,
  teenUploader,
  type SensitiveStillShared,
} from '@fdv/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { sensitiveSql } from './filters.js';

/**
 * `409 sensitive_confirm` (0.9.0, H1a): a sensitive document about to go
 * outside the family, by a link of its own, a collection's, or one that
 * keeps up with a collection, without `confirm_sensitive: true`. Its
 * message is the question the client asks.
 */
export const sensitiveConfirm = (message: string = SENSITIVE_SHARE_CONFIRM) =>
  new ApiError(409, 'sensitive_confirm', message);

/** The warning an edit's answer carries (H1a): made sensitive, and still shared outside the family. */
export const stillShared = (n: { links?: number; documents?: number }): SensitiveStillShared => ({
  code: 'sensitive_still_shared',
  ...n,
});

/**
 * "A live link outside the family gives this document", as SQL on a
 * document id (0.9.0, H1a): its own link, or a collection's link that was
 * made with it ticked, or that it followed, while it is in that collection
 * — not taken back, paused, run out or stopped by wrong tries (as
 * app_live_share's 10). What the link's own checks would take away later
 * (its maker's sight, a restriction) is not asked: this only ever says
 * there may be a link to end.
 */
export const givenByLiveLink = (doc: RawBuilder<string>) => sql<boolean>`exists (
  select 1 from share_link s
   where s.revoked_at is null and s.paused_at is null and s.expires_at > now() and s.attempts < 10
     and (s.document_id = ${doc}
          or (s.collection_id is not null and exists (
                select 1 from share_link_item t
                  join doc_collection_item i
                    on i.collection_id = s.collection_id and i.document_id = t.document_id
                 where t.share_id = s.id and t.document_id = ${doc}
                   and t.kind in ('ticked', 'followed')))))`;

/** The live links outside the family that give a document now (H1a): its own, and collections'. */
export async function liveLinksGiving(
  trx: Db,
  documentId: string,
): Promise<Array<{ id: string; collection_id: string | null; permission: string }>> {
  const r = await sql<{ id: string; collection_id: string | null; permission: string }>`
    select s.id, s.collection_id, s.permission from share_link s
     where s.revoked_at is null and s.paused_at is null and s.expires_at > now()
       and s.attempts < 10
       and (s.document_id = ${documentId}::uuid
            or (s.collection_id is not null and exists (
                  select 1 from share_link_item t
                    join doc_collection_item i
                      on i.collection_id = s.collection_id and i.document_id = t.document_id
                   where t.share_id = s.id and t.document_id = ${documentId}::uuid
                     and t.kind in ('ticked', 'followed'))))
     order by s.id`.execute(trx);
  return r.rows;
}

/** Whether a document is sensitive now, all said (`sensitiveSql`), as the caller may read it. */
export async function documentSensitive(trx: Db, documentId: string): Promise<boolean> {
  const r = await sql<{ sensitive: boolean }>`
    select ${sensitiveSql('d')} as sensitive from document d where d.id = ${documentId}::uuid`.execute(
    trx,
  );
  return r.rows[0]?.sensitive === true;
}

/**
 * Whether the caller's own sensitive papers start as Only me (0.9.0, H1a;
 * `keepsOwnSensitive`): a teen's always; anybody else's by their own date
 * of birth and relationship, on the household's calendar. Read through the
 * caller's transaction: their own member row, which they may always read.
 */
export async function keepsOwnSensitiveOf(trx: Db, p: Principal): Promise<boolean> {
  if (p.role === 'teen') return true;
  return (await ownSensitiveOf(trx, p)).keeps;
}

/**
 * The same, and whether the caller is a teen by H1a's count
 * (`teenUploader`): signed in as one, or 13 to 17 by their date of birth —
 * whose own vaccination record is never Only me by the rule (H3).
 */
export async function ownSensitiveOf(
  trx: Db,
  p: Principal,
): Promise<{ keeps: boolean; teen: boolean }> {
  const m = await trx
    .selectFrom('member')
    .select(['date_of_birth', 'relationship'])
    .where('id', '=', p.memberId)
    .executeTakeFirst();
  if (!m) return { keeps: p.role === 'teen', teen: p.role === 'teen' };
  const who = {
    role: p.role,
    date_of_birth: m.date_of_birth ? String(m.date_of_birth).slice(0, 10) : null,
    relationship: m.relationship,
  };
  const today = await householdToday(trx);
  return { keeps: keepsOwnSensitive(who, today), teen: teenUploader(who, today) };
}

/**
 * A new paper's visibility with H1a's rule on top of `base`, where nobody
 * said one: Only me for the caller's own sensitive paper when their papers
 * start so. `own` is whose it will be: the caller. Never a teen's own
 * vaccination record (H3, `parentsKeep`): it stays `base`, where their
 * parents see it.
 */
export async function sensitiveStart(
  trx: Db,
  p: Principal,
  base: Visibility,
  paper: {
    sensitive: boolean | null | undefined;
    kind:
      | { key?: string | null | undefined; sensitive_default?: boolean | null | undefined }
      | null
      | undefined;
    owner: string | null | undefined;
  },
): Promise<Visibility> {
  if (base === 'private') return base;
  const own = paper.owner != null && paper.owner === p.memberId;
  if (!own) return base;
  const sensitive = sensitiveOf({ sensitive: paper.sensitive ?? null }, paper.kind ?? null);
  if (!sensitive) return base;
  const who = await ownSensitiveOf(trx, p);
  return sensitiveStartingVisibility(base, {
    sensitive,
    own,
    keeps: who.keeps,
    parentsKept: who.teen && parentsKeep(paper.kind),
  });
}
