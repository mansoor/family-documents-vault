import { appendAudit, familyMedicalOf, householdToday, withPrincipal, type Db } from '@fdv/db';
import {
  GROWN_UP_ANSWERED,
  GROWN_UP_EXPLAINED,
  GROWN_UP_ONLY_ME_THEIRS,
  GROWN_UP_QUESTION,
  GROWN_UP_THEIRS_TO_ANSWER,
  mayNameOwnCaregiver,
  roleFirstWords,
  turnedEighteenWords,
  type CaregiverCandidate,
  type CaregiverGrantView,
  type CaregiverLook,
  type GrownUpAnswerChoice,
  type GrownUpAnswerResult,
  type GrownUpQuestionView,
  type MyCaregivers,
  type PersonCaregivers,
} from '@fdv/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { sensitiveSql } from '../documents/filters.js';
import type { VisibilityService } from '../documents/visibility.js';
import { ApiError, notFound } from '../errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most looks GET /members/{id}/caregiver-views gives: the newest. */
export const CAREGIVER_LOOKS_MAX = 200;

const nobody = () => notFound('That person');
const notYours = () =>
  new ApiError(
    403,
    'forbidden',
    'Only the person themselves, or an owner for somebody without a sign-in, can change who their caregivers are.',
  );

interface GrantRow {
  id: string;
  person_member_id: string;
  person_name: string;
  caregiver_member_id: string;
  caregiver_name: string;
  granted_at: Date;
  granted_by_name: string | null;
  person_confirmed_at: Date | null;
}

/**
 * Caregivers for somebody's medical papers, and turning 18 (0.9.0, H1b; the
 * owner's decisions of 14 Nov 2026; migration 0098).
 *
 * Who reads what is the database's (`caregiver_reads`): this service names,
 * keeps and revokes grants, says who looked, and asks the turning-18
 * question. Every grant, keep, revoke and give-up is written to the activity
 * log about the person — never a document, so never a title.
 */
export class CaregiverService {
  constructor(
    private readonly db: Db,
    private readonly visibility: VisibilityService,
  ) {}

  // ------------------------------------------------------------- grants

  /** GET /caregivers: the caller's own grants — about them, and those they give care in. */
  async mine(p: Principal): Promise<MyCaregivers> {
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await grants(
        trx,
        sql`(g.person_member_id = ${p.memberId}::uuid
                                        or g.caregiver_member_id = ${p.memberId}::uuid)`,
      );
      const about = rows.filter((r) => r.person_member_id === p.memberId);
      const ofOthers = rows.filter((r) => r.caregiver_member_id === p.memberId);
      const answers = await this.selfAnswers(trx, p);
      return {
        about_me: about.map((r) => viewOf(p, r, answers)),
        for_others: ofOthers.map((r) => viewOf(p, r, answers)),
      };
    });
  }

  /**
   * GET /members/{id}/caregivers: a person's caregivers, for the person, an
   * owner, and a caregiver of theirs (who is given only their own grant);
   * refused to anybody else. Who may be named, when the caller may name one.
   */
  async ofPerson(p: Principal, personId: string): Promise<PersonCaregivers> {
    if (!UUID.test(personId)) throw nobody();
    return withPrincipal(this.db, p, async (trx) => {
      const person = await personOf(trx, personId);
      const rows = await grants(trx, sql`g.person_member_id = ${person.id}::uuid`);
      const self = person.id === p.memberId;
      const caregiver = rows.some((r) => r.caregiver_member_id === p.memberId);
      if (!self && p.role !== 'owner' && !caregiver) {
        throw new ApiError(
          403,
          'forbidden',
          'Only the person themselves and the owners can see who their caregivers are.',
        );
      }
      const answers = await this.selfAnswers(trx, p);
      const mayAdd = await mayName(trx, p, person);
      return {
        items: rows.map((r) => viewOf(p, r, answers)),
        may_add: mayAdd,
        candidates: mayAdd ? await candidatesFor(trx, person.id, rows) : [],
      };
    });
  }

  /**
   * POST /members/{id}/caregivers: name a caregiver. By the person
   * themselves (kept as it is made), or by an owner for somebody without a
   * sign-in (kept once they say so, H1b). Naming one already named gives
   * the grant there is — kept now, if its person names them.
   */
  async name(
    p: Principal,
    personId: string,
    caregiverId: string,
    meta: RequestMeta,
  ): Promise<CaregiverGrantView> {
    if (!UUID.test(personId)) throw nobody();
    if (!UUID.test(caregiverId)) throw notEligible();
    return withPrincipal(this.db, p, async (trx) => {
      const person = await personOf(trx, personId);
      if (!(await mayName(trx, p, person))) throw notYours();
      if (caregiverId === person.id) {
        throw new ApiError(422, 'validation_failed', 'Somebody can’t be their own caregiver.');
      }
      const eligible = await sql<{ ok: boolean; name: string | null }>`
        select member_may_give_care(${caregiverId}::uuid) and m.kind = 'family' as ok,
               m.display_name as name
          from member m where m.id = ${caregiverId}::uuid`.execute(trx);
      const c = eligible.rows[0];
      if (!c?.ok) throw notEligible();
      const self = person.id === p.memberId;
      const made = await trx
        .insertInto('caregiver_grant')
        .values({
          household_id: p.householdId,
          person_member_id: person.id,
          caregiver_member_id: caregiverId,
          granted_by: p.accountId,
          person_confirmed_at: self ? new Date() : null,
        })
        .onConflict((oc) =>
          oc
            .columns(['household_id', 'person_member_id', 'caregiver_member_id'])
            .where('revoked_at', 'is', null)
            .doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (made) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'caregiver.granted',
          objectType: 'member',
          objectId: person.id,
          detail: {
            caregiver_member_id: caregiverId,
            caregiver: c.name,
            ...(self ? {} : { on_behalf: true }),
          },
          ip: meta.ip,
        });
      } else if (self) {
        // Named already, by an owner: naming them now keeps it.
        await this.keepWithin(trx, p, person.id, caregiverId, meta);
      }
      return this.grantView(trx, p, person.id, caregiverId);
    });
  }

  /**
   * POST /members/{id}/caregivers/{caregiverId}/keep: the person keeps a
   * grant an owner named for them, and their Only me medical papers are
   * included from now. Theirs alone.
   */
  async keep(
    p: Principal,
    personId: string,
    caregiverId: string,
    meta: RequestMeta,
  ): Promise<CaregiverGrantView> {
    if (!UUID.test(personId) || !UUID.test(caregiverId)) throw noGrant();
    return withPrincipal(this.db, p, async (trx) => {
      if (personId.toLowerCase() !== p.memberId.toLowerCase()) {
        throw new ApiError(403, 'forbidden', 'Only the person themselves can keep a caregiver.');
      }
      await this.keepWithin(trx, p, p.memberId, caregiverId, meta);
      return this.grantView(trx, p, p.memberId, caregiverId);
    });
  }

  private async keepWithin(
    trx: Db,
    p: Principal,
    personId: string,
    caregiverId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const kept = await trx
      .updateTable('caregiver_grant')
      .set({ person_confirmed_at: new Date() })
      .where('person_member_id', '=', personId)
      .where('caregiver_member_id', '=', caregiverId)
      .where('revoked_at', 'is', null)
      .where('person_confirmed_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    const live = await liveGrant(trx, personId, caregiverId);
    if (!live) throw noGrant();
    if (kept) {
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'caregiver.kept',
        objectType: 'member',
        objectId: personId,
        detail: { caregiver_member_id: caregiverId, caregiver: live.caregiver_name },
        ip: meta.ip,
      });
    }
  }

  /**
   * POST /members/{id}/caregivers/{caregiverId}/revoke: the grant ends now.
   * By the person; by the caregiver, giving it up; by an owner for somebody
   * without a sign-in. Nothing a grant gave is read after it.
   */
  async revoke(
    p: Principal,
    personId: string,
    caregiverId: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (!UUID.test(personId) || !UUID.test(caregiverId)) throw noGrant();
    await withPrincipal(this.db, p, async (trx) => {
      const live = await liveGrant(trx, personId, caregiverId);
      if (!live) throw noGrant();
      const self = live.person_member_id === p.memberId;
      const givingUp = live.caregiver_member_id === p.memberId;
      const forThem =
        p.role === 'owner' && !self && !(await answersForSelf(trx, live.person_member_id));
      if (!self && !givingUp && !forThem) throw notYours();
      const ended = await trx
        .updateTable('caregiver_grant')
        .set({ revoked_at: new Date(), revoked_by: p.accountId })
        .where('id', '=', live.id)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!ended) throw noGrant();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: givingUp && !self ? 'caregiver.given_up' : 'caregiver.revoked',
        objectType: 'member',
        objectId: live.person_member_id,
        detail: {
          caregiver_member_id: live.caregiver_member_id,
          caregiver: live.caregiver_name,
          ...(forThem && !givingUp ? { on_behalf: true } : {}),
        },
        ip: meta.ip,
      });
    });
  }

  /**
   * GET /members/{id}/caregiver-views: who looked at which of the person's
   * papers a grant gave them, and when — the person's alone (the database
   * gives nobody else a row). A sensitive paper is said as the activity log
   * says it, never by its title.
   */
  async looks(p: Principal, personId: string): Promise<{ items: CaregiverLook[] }> {
    if (!UUID.test(personId)) throw nobody();
    const self = personId.toLowerCase() === p.memberId.toLowerCase();
    if (!self && p.role !== 'owner') {
      throw new ApiError(
        403,
        'forbidden',
        'Only the person themselves and the owners can see who looked at their papers.',
      );
    }
    return withPrincipal(this.db, p, async (trx) => {
      if (!self) await personOf(trx, personId);
      const rows = await sql<{
        caregiver_name: string;
        document_id: string | null;
        seen_id: string | null;
        title: string | null;
        sensitive: boolean | null;
        action: CaregiverLook['action'];
        at: Date;
      }>`
        select m.display_name as caregiver_name, v.document_id, d.id as seen_id, d.title,
               ${sensitiveSql('d')} as sensitive, v.action, v.at
          from caregiver_view v
          join member m on m.id = v.caregiver_member_id
          -- The paper only while it is still about this person: a row can
          -- never name another member's.
          left join document d
            on d.id = v.document_id and d.owner_member_id = v.person_member_id
         where v.person_member_id = ${personId}::uuid
         order by v.at desc, v.id desc
         limit ${CAREGIVER_LOOKS_MAX}`.execute(trx);
      return {
        items: rows.rows.map((r) => {
          // An owner is told who looked, and when — never which of the
          // person's Only me papers (the owner's decision of 14 Nov 2026).
          if (!self) {
            return {
              caregiver_name: r.caregiver_name,
              document_id: null,
              title: null,
              sensitive: false,
              only_me: true,
              action: r.action,
              at: r.at.toISOString(),
            };
          }
          const shown = r.seen_id !== null;
          const sensitive = shown && r.sensitive === true;
          return {
            caregiver_name: r.caregiver_name,
            document_id: shown ? r.document_id : null,
            title: !shown || sensitive ? null : r.title,
            sensitive,
            action: r.action,
            at: r.at.toISOString(),
          };
        }),
      };
    });
  }

  private async grantView(
    trx: Db,
    p: Principal,
    personId: string,
    caregiverId: string,
  ): Promise<CaregiverGrantView> {
    const rows = await grants(
      trx,
      sql`(g.person_member_id = ${personId}::uuid and g.caregiver_member_id = ${caregiverId}::uuid)`,
    );
    const row = rows[0];
    if (!row) throw noGrant();
    return viewOf(p, row, await this.selfAnswers(trx, p));
  }

  /** Whether an owner caller may act for a grant's person: they cannot answer for themselves. */
  private async selfAnswers(trx: Db, p: Principal): Promise<Set<string>> {
    if (p.role !== 'owner') return new Set();
    const r = await sql<{ member_id: string }>`
      select ah.member_id from account_household ah
       where ah.role in ('owner', 'adult', 'teen')`.execute(trx);
    return new Set(r.rows.map((x) => x.member_id));
  }

  // --------------------------------------------------------- turning 18

  /**
   * GET /grown-up/questions: the turning-18 questions waiting for the
   * caller — their own, while they sign in as an owner or an adult; and
   * for an owner, those of anybody who cannot answer themselves, to ask in
   * person. Only while there are Medical papers the family can see.
   */
  async questions(p: Principal): Promise<{ items: GrownUpQuestionView[] }> {
    return withPrincipal(this.db, p, async (trx) => {
      const today = await householdToday(trx);
      const rows = await sql<{
        member_id: string;
        display_name: string;
        turned_on: string;
        self: boolean;
        signs_in: boolean;
        papers: number;
      }>`
        select q.member_id, m.display_name, q.turned_on::text as turned_on,
               member_signs_in_grown_up(q.member_id) as self,
               member_has_sign_in(q.member_id) as signs_in,
               (select count(*)::int from document d
                 where ${familyMedicalOf(sql`q.member_id`)}) as papers
          from grown_up_question q
          join member m on m.id = q.member_id
         where q.answered_at is null
           and not m.is_deceased
         order by q.turned_on, m.display_name, q.member_id`.execute(trx);
      const items: GrownUpQuestionView[] = [];
      for (const r of rows.rows) {
        if (r.papers === 0) continue;
        const own = r.member_id === p.memberId;
        if (own && r.self && (p.role === 'owner' || p.role === 'adult')) {
          items.push({
            member_id: r.member_id,
            display_name: r.display_name,
            turned_on: r.turned_on,
            papers: r.papers,
            asks: 'self',
            title: GROWN_UP_QUESTION,
            label: GROWN_UP_EXPLAINED,
          });
        } else if (!own && !r.self && p.role === 'owner') {
          // No sign-in at all: asked in person, Keep only. A sign-in still a
          // teen's: their role first, then they are asked themselves.
          items.push({
            member_id: r.member_id,
            display_name: r.display_name,
            turned_on: r.turned_on,
            papers: r.papers,
            asks: r.signs_in ? 'role_first' : 'in_person',
            ...(r.signs_in
              ? roleFirstWords(r.display_name)
              : turnedEighteenWords(r.display_name, r.turned_on, today)),
          });
        }
      }
      return { items };
    });
  }

  /**
   * POST /members/{id}/grown-up-answer: the answer, once and final. "Keep"
   * changes nothing. "Only me" — the person's own answer alone — makes every
   * Medical paper about them the family can see Only me, keys rewrapped and
   * words sealed as any change to Only me does, their own links to those
   * papers ended and everybody else's stopped; owners included, nobody else
   * opens them after (a caregiver they named still reads them). An owner
   * answers only for somebody who cannot answer themselves, and only Keep.
   */
  async answer(
    p: Principal,
    memberId: string,
    answer: GrownUpAnswerChoice,
    meta: RequestMeta,
  ): Promise<GrownUpAnswerResult> {
    if (!UUID.test(memberId)) throw noQuestion();
    const result = await withPrincipal(this.db, p, async (trx) => {
      const q = await trx
        .selectFrom('grown_up_question')
        .select(['member_id', 'answered_at'])
        .where('member_id', '=', memberId)
        .forUpdate()
        .executeTakeFirst();
      if (!q) throw noQuestion();
      if (q.answered_at !== null) throw new ApiError(409, 'already_answered', GROWN_UP_ANSWERED);
      const own = q.member_id === p.memberId;
      if (own) {
        // Their own, while they sign in as a grown-up; a teen's sign-in
        // waits for its role to be an adult's (H1b).
        if (p.role !== 'owner' && p.role !== 'adult') throw noQuestion();
      } else {
        // An owner, for somebody with no sign-in at all, Keep only.
        if (p.role !== 'owner') throw noQuestion();
        if (await hasSignIn(trx, q.member_id)) {
          throw new ApiError(403, 'ask_them_themselves', GROWN_UP_THEIRS_TO_ANSWER);
        }
        if (answer === 'only_me')
          throw new ApiError(403, 'only_the_person', GROWN_UP_ONLY_ME_THEIRS);
      }
      const prune: string[] = [];
      let made = 0;
      if (answer === 'only_me') {
        // Every one the family can see, those in the Trash too: one left
        // there would be brought back as it was.
        const papers = (
          await sql<{ id: string }>`
            select d.id from document d
             where ${familyMedicalOf(sql`${p.memberId}::uuid`)}
             order by d.id`.execute(trx)
        ).rows;
        for (const d of papers) {
          const changed = await this.visibility.changeWithin(trx, p, d.id, 'private', meta, 'end', {
            inTrash: true,
          });
          prune.push(...changed.prune);
          made++;
        }
      }
      await trx
        .updateTable('grown_up_question')
        .set({
          answered_at: new Date(),
          answer,
          answered_by: p.accountId,
          made_private: made,
        })
        .where('member_id', '=', q.member_id)
        .execute();
      // The owners' reminder to ask in person is done with (an owner's to
      // change; the vault's tick otherwise).
      if (p.role === 'owner') {
        await trx
          .updateTable('reminder')
          .set({ status: 'resolved', acknowledged_by: p.accountId, acknowledged_at: new Date() })
          .where('kind', '=', 'turned_18')
          .where('member_id', '=', q.member_id)
          .where('status', 'in', ['scheduled', 'due', 'snoozed'])
          .execute();
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'grown_up.answered',
        objectType: 'member',
        objectId: q.member_id,
        // Never which papers, nor how many: the owners read this line.
        detail: { answer, ...(own ? {} : { on_behalf: true }) },
        ip: meta.ip,
      });
      return { answer, made_private: made, prune };
    });
    await this.visibility.pruneEnded(p, result.prune);
    return { answer: result.answer, made_private: result.made_private };
  }
}

const notEligible = () =>
  new ApiError(
    422,
    'caregiver_not_eligible',
    'A caregiver must be somebody in the family who signs in as an owner or an adult, and isn’t locked out.',
  );
const noGrant = () => new ApiError(404, 'not_found', 'That caregiver does not exist.');
const noQuestion = () =>
  new ApiError(404, 'not_found', 'There is no question waiting for that person.');

/** A person of the household, alive or not; 404 for anybody the caller is not given. */
async function personOf(
  trx: Db,
  id: string,
): Promise<{ id: string; kind: string; is_deceased: boolean }> {
  const m = await trx
    .selectFrom('member')
    .select(['id', 'kind', 'is_deceased'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!m) throw nobody();
  return m;
}

/** Whether somebody signs in with a role that answers for their own papers (an owner, an adult, a teen). */
async function answersForSelf(trx: Db, memberId: string): Promise<boolean> {
  const r = await sql<{ yes: boolean }>`
    select member_answers_for_self(${memberId}::uuid) as yes`.execute(trx);
  return r.rows[0]?.yes === true;
}

/** Whether somebody has a sign-in here at all, whatever its role: an owner answers only for somebody with none. */
async function hasSignIn(trx: Db, memberId: string): Promise<boolean> {
  const r = await sql<{ yes: boolean }>`
    select member_has_sign_in(${memberId}::uuid) as yes`.execute(trx);
  return r.rows[0]?.yes === true;
}

/**
 * Whether the caller may name a caregiver for this person: the person
 * themselves (an owner, an adult or a teen); an owner for somebody of the
 * family, alive, who cannot answer for themselves.
 */
async function mayName(
  trx: Db,
  p: Principal,
  person: { id: string; kind: string; is_deceased: boolean },
): Promise<boolean> {
  if (person.kind !== 'family' || person.is_deceased) return false;
  if (person.id === p.memberId) return mayNameOwnCaregiver(p.role);
  return p.role === 'owner' && !(await answersForSelf(trx, person.id));
}

/** Who may be named: of the family, an owner or an adult signed in and not locked, not already named. */
async function candidatesFor(
  trx: Db,
  personId: string,
  named: ReadonlyArray<GrantRow>,
): Promise<CaregiverCandidate[]> {
  const already = new Set(named.map((g) => g.caregiver_member_id));
  const r = await sql<CaregiverCandidate>`
    select m.id as member_id, m.display_name
      from member m
     where m.kind = 'family'
       and m.id <> ${personId}::uuid
       and member_may_give_care(m.id)
     order by m.display_name, m.id`.execute(trx);
  return r.rows.filter((c) => !already.has(c.member_id));
}

/** Live grants the caller is given (the database's rule), with names. */
async function grants(trx: Db, where: RawBuilder<unknown>): Promise<GrantRow[]> {
  const r = await sql<GrantRow>`
    select g.id, g.person_member_id, pm.display_name as person_name,
           g.caregiver_member_id, cm.display_name as caregiver_name,
           g.granted_at, gm.display_name as granted_by_name, g.person_confirmed_at
      from caregiver_grant g
      join member pm on pm.id = g.person_member_id
      join member cm on cm.id = g.caregiver_member_id
      left join account_household gah
        on gah.account_id = g.granted_by and gah.household_id = g.household_id
      left join member gm on gm.id = gah.member_id
     where g.revoked_at is null and ${where}
     order by cm.display_name, g.id`.execute(trx);
  return r.rows;
}

async function liveGrant(trx: Db, personId: string, caregiverId: string) {
  const rows = await grants(
    trx,
    sql`(g.person_member_id = ${personId}::uuid and g.caregiver_member_id = ${caregiverId}::uuid)`,
  );
  return rows[0] ?? null;
}

function viewOf(p: Principal, r: GrantRow, answersForSelfIds: Set<string>): CaregiverGrantView {
  const self = r.person_member_id === p.memberId;
  const forThem = p.role === 'owner' && !self && !answersForSelfIds.has(r.person_member_id);
  return {
    id: r.id,
    person_member_id: r.person_member_id,
    person_name: r.person_name,
    caregiver_member_id: r.caregiver_member_id,
    caregiver_name: r.caregiver_name,
    granted_at: r.granted_at.toISOString(),
    granted_by_name: r.granted_by_name,
    confirmed: r.person_confirmed_at !== null,
    may_revoke: self || forThem,
    may_keep: self && r.person_confirmed_at === null,
    may_give_up: r.caregiver_member_id === p.memberId,
  };
}
