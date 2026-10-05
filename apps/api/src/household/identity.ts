import { openIdentity, sealIdentity, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  canEditIdentity,
  canSee,
  canSeeIdentity,
  IDENTITY_AUDIENCE_LABELS,
  IDENTITY_AUDIENCES,
  IDENTITY_EDIT_REFUSAL,
  IDENTITY_ID_KINDS,
  IDENTITY_NOTICE_HOURS,
  IDENTITY_PARTS,
  IDENTITY_SEXES,
  identityAudienceRank,
  identityAudienceSees,
  identityChanges,
  identityDocuments,
  identityFilled,
  identityTooLong,
  IDENTITY_TOO_LONG,
  maskIdentity,
  mergeIdentityWrite,
  revealIdentity,
  ROLES,
  shareEndWords,
  SITTING_MS,
  suspensionInEffect,
  type IdentityAudience,
  type IdentityAudienceView,
  type IdentityFields,
  type IdentityPart,
  type IdentityPartView,
  type IdentityReveal,
  type IdentityView,
} from '@fdv/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import type { PushRequest, PushTarget } from '../push-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError, notFound } from '../errors.js';

/**
 * A person's identity details, sealed (5.26).
 *
 * Two parts a person: `shared`, which the person, the owners and — as the
 * household chooses (A34) — all adults or the whole family read; and
 * `only_me`, which nobody but the person reads or writes, through any path
 * (A33). Each part is sealed under a fresh data key at every write, bound
 * to its household, person and part (@fdv/crypto `sealIdentity`), the key
 * wrapped under the household's identity key (minted on the first write)
 * or the person's own member key. The database holds the same walls under
 * these (0050): an owner's query, with no WHERE clause at all, finds no
 * other person's Only me row.
 *
 * The honest limit: whoever runs the server holds the master key, which
 * wraps every key here. No owner can open an Only me part through the
 * vault; the operator could.
 *
 * Who is not given a record is told there is none (404), never that it is
 * kept from them. ID numbers and hidden custom fields come masked; showing
 * one is a request of its own (`reveal`), which asks who is asking —
 * somebody else's, with a passkey or a code, whoever asks — and is a
 * line in the activity log naming the fields, never their values.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Something about your details is changing" (5.33): the word, and nothing else. */
export const NOTICE_PUSH = { v: 1, type: 'notice' } as const;

const blankIsNone = (v: string | null | undefined) => (v === '' ? null : v);
/** Text of a field, trimmed; blank is none. */
const words = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters.`)
    .nullable()
    .optional()
    .transform(blankIsNone);
const entryId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, 'Give each entry an id of letters, digits, - and _.');
const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'A country is its two-letter code.');
/** A day that is one. */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Give dates as YYYY-MM-DD.')
  .refine((d) => {
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    const at = new Date(Date.UTC(y, m - 1, dd));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === dd;
  }, 'That date is not a day.');
const list = <T extends z.ZodType<{ id: string }>>(entry: T, max: number) =>
  z
    .array(entry)
    .max(max, `At most ${max} of these.`)
    .refine(
      (entries) => new Set(entries.map((e) => e.id)).size === entries.length,
      'Each entry in a list has an id of its own.',
    )
    .optional();

const contact = z
  .object({
    id: entryId,
    label: words(60),
    value: z.string().trim().min(1, 'Give a value, or leave the entry out.').max(200),
  })
  .strict();

const address = z
  .object({
    id: entryId,
    label: words(60),
    line1: words(),
    line2: words(),
    line3: words(),
    city: words(),
    region: words(),
    postal_code: words(30),
    country: country.nullable().optional(),
  })
  .strict();

/**
 * A government ID. Its `number` left out keeps the number it has, which a
 * reader was shown masked; null or blank clears it. Its `document_id`, a
 * document the writer can see, or null; one linked by somebody else that
 * the writer cannot see is kept whatever is sent.
 */
const governmentId = z
  .object({
    id: entryId,
    kind: z.enum(IDENTITY_ID_KINDS),
    label: words(60),
    number: words(80),
    issuer: words(),
    issued_on: day.nullable().optional(),
    expires_on: day.nullable().optional(),
    document_id: z.string().uuid('Link a document by its id.').nullable().optional(),
  })
  .strict();

/** A field of the family's own; a hidden one's `value` left out keeps it, as an ID's number. */
const customField = z
  .object({
    id: entryId,
    label: z.string().trim().min(1, 'Give the field a name.').max(60),
    value: words(2000),
    hidden: z.boolean().optional(),
  })
  .strict();

/** One part's fields: the catalogue (A35), and nothing else. */
export const identityFieldsBody = z
  .object({
    title: words(40),
    given_name: words(),
    middle_name: words(),
    family_name: words(),
    other_names: words(),
    place_of_birth: words(),
    country_of_birth: country.nullable().optional(),
    sex: z.enum(IDENTITY_SEXES).nullable().optional(),
    nationalities: z.array(country).max(10, 'At most 10 nationalities.').optional(),
    username: words(),
    company: words(),
    job_title: words(),
    emails: list(contact, 20),
    phones: list(contact, 20),
    addresses: list(address, 10),
    ids: list(governmentId, 30),
    custom: list(customField, 50),
    notes: words(10_000),
  })
  .strict();

/** PUT /members/{id}/identity: a whole part, made from the version read. */
export const identityWriteBody = z
  .object({
    part: z.enum(IDENTITY_PARTS),
    version: z.number().int().min(0),
    fields: identityFieldsBody,
  })
  .strict();

/** POST /members/{id}/identity/reveal: which masked values, of which part (shared unless said). */
export const identityRevealBody = z
  .object({
    part: z.enum(IDENTITY_PARTS).optional(),
    keys: z.array(z.string().max(60)).min(1, 'Say which to show.').max(100),
  })
  .strict();

/** PUT /household/identity-audience. */
export const identityAudienceBody = z.object({ audience: z.enum(IDENTITY_AUDIENCES) }).strict();

/** Said to an owner who would widen the audience while somebody could not be told (A34). */
export const MEMBER_CANNOT_BE_TOLD = (names: string[]) =>
  `${names.join(', ')} cannot sign in just now, so could not be told, or mark anything Only me first. Let more people see identity details once everybody can sign in.`;

/**
 * The people with a sign-in who could not be told of a wider audience, nor
 * mark fields Only me while it waits (A34): everybody with a sign-in is
 * told (the 5.26 review), whatever their role, so anybody who cannot sign
 * in holds a widening back: an account switched off (account.disabled_at),
 * which no alert reaches either; and since 5.28 a sign-in an owner has
 * locked, or one paused after a restore — of any role. Locking somebody
 * withdraws a widening still waiting (household/locks.ts).
 */
export async function membersWhoCannotBeTold(trx: Db): Promise<string[]> {
  const rows = await trx
    .selectFrom('account_household')
    .innerJoin('account', 'account.id', 'account_household.account_id')
    .innerJoin('member', 'member.id', 'account_household.member_id')
    .select([
      'member.display_name',
      'account.disabled_at',
      'account_household.suspended_at',
      'account_household.suspended_until',
    ])
    .orderBy('member.display_name')
    .execute();
  return rows
    .filter((r) => r.disabled_at !== null || suspensionInEffect(r))
    .map((r) => r.display_name);
}

interface Subject {
  id: string;
  audience: IdentityAudience;
  self: boolean;
}

interface OpenedPart {
  fields: IdentityFields;
  filled: string[];
  version: number;
  updated_at: Date;
}

const conflict = (part: IdentityPart, version: number) =>
  new ApiError(409, 'conflict', 'Someone else changed these details. Reload and try again.', {
    detail: JSON.stringify({ part, version }),
  });

export class IdentityService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    /** Tells every adult of a wider audience: by the operator's mail server only (A21). */
    private readonly alert: (a: AlertRequest) => Promise<void>,
    /** Whether the operator's mail server is set (FDV_SMTP_URL): told by mail only then. */
    private readonly operatorMail: boolean,
    /**
     * What the worker pushes (`push.send`): the word `notice` to the phones
     * and browsers of everybody told of a widening (5.33), and nothing else.
     */
    private readonly push: (r: PushRequest) => Promise<void> = async () => undefined,
  ) {}

  // ------------------------------------------------------------- reading

  /** The household's audience in effect now: a widening whose notice has run out counts (0050). */
  private async audienceNow(trx: Db): Promise<IdentityAudience> {
    const r = await sql<{ a: IdentityAudience }>`select identity_audience_now() as a`.execute(trx);
    return r.rows[0]?.a ?? 'owners_and_self';
  }

  /**
   * The person asked about, when the caller may see their record (the
   * shared part, or the record at all): anybody else, and anybody not of
   * the family, is told there is nothing there.
   */
  private async subject(trx: Db, p: Principal, requested: string): Promise<Subject> {
    if (!UUID.test(requested)) throw notFound();
    const row = await trx
      .selectFrom('member')
      .select(['id'])
      .where('id', '=', requested)
      .executeTakeFirst();
    if (!row) throw notFound();
    const audience = await this.audienceNow(trx);
    if (!canSeeIdentity({ role: p.role, memberId: p.memberId }, row, audience)) throw notFound();
    return { id: row.id, audience, self: row.id === p.memberId };
  }

  /** One part, opened, as the database gives it to the caller; null when there is none for them. */
  private async openPart(
    trx: Db,
    p: Principal,
    subject: Subject,
    part: IdentityPart,
    lock = false,
  ): Promise<OpenedPart | null> {
    // The database keeps another person's Only me row from everybody
    // (0050); asked here as well, so a rule gone wrong is no leak.
    if (part === 'only_me' && !subject.self) return null;
    let q = trx
      .selectFrom('member_identity')
      .selectAll()
      .where('member_id', '=', subject.id)
      .where('part', '=', part);
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) return null;
    const key = await this.keys.unwrapById(trx, row.wrapped_by_scope);
    const fields = openIdentity(
      key,
      { householdId: p.householdId, memberId: subject.id, part },
      row,
    ) as IdentityFields;
    return { fields, filled: row.filled, version: row.version, updated_at: row.updated_at };
  }

  /** Of these documents, the ones the caller may see (canSee). */
  private async visibleDocuments(trx: Db, p: Principal, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const docs = await trx
      .selectFrom('document')
      .select(['id', 'visibility', 'owner_member_id'])
      .where('id', 'in', ids)
      .execute();
    return new Set(docs.filter((d) => canSee(p, d)).map((d) => d.id));
  }

  /** The record as the caller is shown it. */
  private async view(trx: Db, p: Principal, subject: Subject): Promise<IdentityView> {
    const shared = await this.openPart(trx, p, subject, 'shared');
    const onlyMe = await this.openPart(trx, p, subject, 'only_me');
    const visible = await this.visibleDocuments(trx, p, [
      ...identityDocuments(shared?.fields ?? {}),
      ...identityDocuments(onlyMe?.fields ?? {}),
    ]);
    const shown = (opened: OpenedPart | null): IdentityPartView => {
      const fields = opened?.fields ?? {};
      // A government ID's document, only to a reader who may see it.
      const linked: IdentityFields = fields.ids
        ? {
            ...fields,
            ids: fields.ids.map((i) => {
              if (!i.document_id || visible.has(i.document_id)) return i;
              const unlinked = { ...i };
              delete unlinked.document_id;
              return unlinked;
            }),
          }
        : fields;
      const masked = maskIdentity(linked);
      return {
        fields: masked.fields,
        masked: masked.masked,
        filled: opened?.filled ?? [],
        version: opened?.version ?? 0,
        updated_at: opened?.updated_at.toISOString() ?? null,
      };
    };
    const me = { role: p.role, memberId: p.memberId };
    return {
      member_id: subject.id,
      audience: subject.audience,
      can_edit: {
        shared: canEditIdentity(me, subject, 'shared'),
        only_me: canEditIdentity(me, subject, 'only_me'),
      },
      versions: {
        shared: shared?.version ?? 0,
        only_me: subject.self ? (onlyMe?.version ?? 0) : null,
      },
      shared: shown(shared),
      only_me: subject.self ? shown(onlyMe) : null,
    };
  }

  /**
   * GET /members/{id}/identity: masked, as the caller may see it. A look at
   * somebody else's record is a line in the activity log, once a sitting.
   */
  async get(p: Principal, requested: string, meta: RequestMeta): Promise<IdentityView> {
    return withPrincipal(this.db, p, async (trx) => {
      const subject = await this.subject(trx, p, requested);
      const view = await this.view(trx, p, subject);
      if (!subject.self) await this.viewedOnce(trx, p, subject.id, meta);
      return view;
    });
  }

  /**
   * `identity.viewed`, unless this caller looked at this person's record in
   * the last sitting (SITTING_MS): asked holding the log's lock, which
   * appendAudit takes again, so two looks at once write one line.
   */
  private async viewedOnce(trx: Db, p: Principal, memberId: string, meta: RequestMeta) {
    await sql`select pg_advisory_xact_lock(hashtext('audit:' || ${p.householdId}::uuid::text))`.execute(
      trx,
    );
    const recent = await sql<{ n: number }>`
      select count(*)::int as n from audit_event
       where household_id = ${p.householdId}
         and action = 'identity.viewed'
         and actor_account_id = ${p.accountId}
         and object_id = ${memberId}
         and at > clock_timestamp() - make_interval(secs => ${SITTING_MS / 1000})`.execute(trx);
    if ((recent.rows[0]?.n ?? 0) > 0) return;
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'identity.viewed',
      objectType: 'member',
      objectId: memberId,
      ip: meta.ip,
    });
  }

  // ------------------------------------------------------------ revealing

  /**
   * Whether the caller may be shown this part's masked values at all, before
   * they are asked who they are: whose it is (`self`), or 404. Another
   * person's Only me part is not there for anybody.
   */
  async mayReveal(p: Principal, requested: string, part: IdentityPart): Promise<{ self: boolean }> {
    return withPrincipal(this.db, p, async (trx) => {
      const subject = await this.subject(trx, p, requested);
      if (part === 'only_me' && !subject.self) throw notFound();
      return { self: subject.self };
    });
  }

  /**
   * POST /members/{id}/identity/reveal: the masked values asked for, by key;
   * a key that names nothing masked is left out. The route has asked who is
   * asking. Each reveal is a line in the activity log naming the keys shown,
   * never a value — for the person whose they are (A38), the owners, and the
   * one who looked; an Only me part's, for the person alone.
   */
  async reveal(
    p: Principal,
    requested: string,
    part: IdentityPart,
    keys: string[],
    meta: RequestMeta,
  ): Promise<IdentityReveal> {
    return withPrincipal(this.db, p, async (trx) => {
      // Asked again: the audience may have narrowed since the route asked.
      const subject = await this.subject(trx, p, requested);
      if (part === 'only_me' && !subject.self) throw notFound();
      const opened = await this.openPart(trx, p, subject, part);
      const values = opened ? revealIdentity(opened.fields, keys) : {};
      const shown = Object.keys(values);
      if (shown.length > 0) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'identity.revealed',
          objectType: 'member',
          objectId: subject.id,
          detail: { part, keys: shown },
          ip: meta.ip,
        });
      }
      return { part, values };
    });
  }

  // -------------------------------------------------------------- writing

  /**
   * PUT /members/{id}/identity: a whole part, made from the version the
   * writer read. The person writes both parts of their own; an owner the
   * shared part of anybody's (canEditIdentity). Another person's Only me
   * part is not there for anybody (404), so no write of anybody else's ever
   * reaches it — the database refuses it too (0050).
   *
   * What the writer was shown masked, or could not see, goes on as it was
   * (mergeIdentityWrite): an ID's number left out is kept; a document
   * linked that the writer may not see stays linked. A document linked anew
   * must be one the writer can see (422).
   *
   * Refused, in order: a record the caller may not see (404); another
   * person's Only me part (404); who may not change it (403); what is sent
   * (422, the route); a version moved on (409 conflict). Nothing different
   * is no change: the version stays, and nothing is logged. The part's row
   * is held first, then the identity key is minted if need be, then the
   * log (appendAudit's lock, last).
   */
  async put(
    p: Principal,
    requested: string,
    body: z.infer<typeof identityWriteBody>,
    meta: RequestMeta,
  ): Promise<IdentityView> {
    const fields = body.fields as IdentityFields;
    const outcome = await withPrincipal(this.db, p, async (trx) => {
      const subject = await this.subject(trx, p, requested);
      if (body.part === 'only_me' && !subject.self) throw notFound();
      if (!canEditIdentity({ role: p.role, memberId: p.memberId }, subject, body.part)) {
        throw new ApiError(403, 'forbidden', IDENTITY_EDIT_REFUSAL);
      }
      // Held, and read as it is once held: one write to a part at a time.
      const current = await this.openPart(trx, p, subject, body.part, true);
      const version = current?.version ?? 0;
      if (body.version !== version) return { stale: true as const, version };
      const stored = current?.fields ?? {};
      const before = identityDocuments(stored);
      const visible = await this.visibleDocuments(trx, p, [
        ...before,
        ...identityDocuments(fields),
      ]);
      const next = mergeIdentityWrite(stored, fields, (id) => visible.has(id));
      // A link an ID had stays; one made now, on any entry, is to a document
      // the writer can see.
      const had = new Map((stored.ids ?? []).map((i) => [i.id, i.document_id ?? null]));
      for (const i of next.ids ?? []) {
        if (i.document_id && i.document_id !== had.get(i.id) && !visible.has(i.document_id)) {
          throw new ApiError(
            422,
            'validation_failed',
            'Link an ID to a document you can see, or to none.',
          );
        }
      }
      const changed = identityChanges(stored, next);
      if (changed.length === 0) return { stale: false as const, subject };
      // More than the database keeps of a part (0050): refused as too long,
      // before anything is sealed, never a failure of the server's own.
      if (identityTooLong(next)) throw new ApiError(422, 'validation_failed', IDENTITY_TOO_LONG);
      const ref = { householdId: p.householdId, memberId: subject.id, part: body.part };
      // The shared part under the household's identity key, minted now if
      // this is the first; Only me under the person's own member key.
      const scope =
        body.part === 'shared'
          ? await this.keys.identityKey(trx, p.householdId)
          : await this.keys.unwrap(trx, {
              householdId: p.householdId,
              kind: 'member',
              memberId: subject.id,
            });
      const sealed = sealIdentity(scope.key, ref, next);
      const values = {
        sealed: sealed.sealed,
        dek_wrapped: sealed.dek_wrapped,
        wrapped_by_scope: scope.id,
        filled: identityFilled(next),
      };
      let written: bigint;
      if (current) {
        const r = await trx
          .updateTable('member_identity')
          .set(values)
          .where('member_id', '=', subject.id)
          .where('part', '=', body.part)
          .where('version', '=', version)
          .executeTakeFirst();
        written = r.numUpdatedRows;
      } else {
        // Two first writes at once: the second finds the first's row, adds
        // nothing, and is told the part moved on.
        const r = await trx
          .insertInto('member_identity')
          .values({
            household_id: p.householdId,
            member_id: subject.id,
            part: body.part,
            ...values,
          })
          .onConflict((oc) => oc.columns(['member_id', 'part']).doNothing())
          .executeTakeFirst();
        written = r.numInsertedOrUpdatedRows ?? 0n;
        if (written !== 1n) return { stale: true as const, version: 1 };
      }
      // The database's rule refused it (0050): nothing changed, and nothing
      // is said to have.
      if (written !== 1n) throw new ApiError(403, 'forbidden', IDENTITY_EDIT_REFUSAL);
      // Taken out of the shared part by the person themselves — into Only
      // me, or away (5.27): it leaves every export somebody else asked for,
      // as a document made Only me does (visibility.ts). Those were built
      // while they could read it.
      if (subject.self && body.part === 'shared') {
        const kept = new Set(values.filled);
        if ((current?.filled ?? []).some((key) => !kept.has(key))) {
          await trx
            .updateTable('export')
            .set({ expires_at: new Date() })
            .where('requested_by', '!=', p.accountId)
            .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
            .execute();
        }
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'identity.updated',
        objectType: 'member',
        objectId: subject.id,
        // Which fields, never what they were or are.
        detail: { part: body.part, keys: changed },
        ip: meta.ip,
      });
      return { stale: false as const, subject };
    });
    if (outcome.stale) throw conflict(body.part, outcome.version);
    return withPrincipal(this.db, p, (trx) => this.view(trx, p, outcome.subject));
  }

  // ------------------------------------------------------------ audience

  /** GET /household/identity-audience: what is in effect, and a widening waiting. */
  async audience(p: Principal): Promise<IdentityAudienceView> {
    return withPrincipal(this.db, p, (trx) => this.audienceView(trx, p));
  }

  private async audienceView(trx: Db, p: Principal): Promise<IdentityAudienceView> {
    const audience = await this.audienceNow(trx);
    const waiting = await trx
      .selectFrom('notice_request')
      .select(['subject', 'requested_at', 'notice_until'])
      .where('kind', '=', 'identity_audience')
      .where('completed_at', 'is', null)
      .where('withdrawn_at', 'is', null)
      .where('notice_until', '>', sql<Date>`now()`)
      .executeTakeFirst();
    return {
      audience,
      pending: waiting
        ? {
            to: waiting.subject as IdentityAudience,
            requested_at: waiting.requested_at.toISOString(),
            notice_until: waiting.notice_until.toISOString(),
          }
        : null,
      can_change: can(p.role, 'identity.audience'),
    };
  }

  /**
   * PUT /household/identity-audience (A34): an owner's, who has confirmed
   * it is them with a passkey or a code (the route, A54).
   *
   *  - Narrower, at once: and a widening still waiting is withdrawn, and the
   *    exports of whoever no longer sees other people's details are expired
   *    (they would hold them, from 5.27).
   *  - As it is: a widening still waiting is withdrawn.
   *  - Wider, after 72 hours' notice: a `notice_request`, from which moment
   *    the wider audience reads (0050). Everybody with a sign-in whose
   *    record gains readers is told — everybody but the owner asking: in
   *    the app, which shows the widening waiting (`pending`); by the
   *    operator's mail server, where there is one — and may mark fields Only
   *    me meanwhile. The mail is queued last, after the line in the log, in
   *    this transaction: a failed enqueue rolls the notice back, and asking
   *    again tries again (the 5.26 review). Asked again for the same, the
   *    clock does not start again; for another, the one waiting is
   *    withdrawn and the new one waits its own 72 hours. Refused while
   *    anybody with a sign-in cannot sign in to be told.
   *
   * Everything here goes by the audience in effect: a widening whose
   * notice has run out is written in as it is found, and narrowing from it
   * is narrowing from it.
   *
   * The household is held first — FOR NO KEY UPDATE, which lets the
   * activity log's foreign key to it (FOR KEY SHARE) through, so a line
   * written meanwhile by anybody else waits for nothing of ours (the 5.26
   * review) — then everybody's sign-in (FOR SHARE, 5.28: a lock holds the
   * person's first), then the notice waiting, then exports, then the log
   * (appendAudit's lock, last).
   */
  async setAudience(
    p: Principal,
    to: IdentityAudience,
    meta: RequestMeta,
  ): Promise<IdentityAudienceView> {
    requireCapability(p, 'identity.audience');
    await withPrincipal(this.db, p, async (trx) => {
      const household = await trx
        .selectFrom('household')
        .select(['identity_audience', 'timezone'])
        .where('id', '=', p.householdId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      // Everybody's sign-in, held as it is now (5.28), so a lock at the same
      // moment either lands first and is seen below (membersWhoCannotBeTold),
      // or waits for this and then withdraws what this asks for. Held before
      // the notice and the exports, as a lock holds the person before it
      // reaches its exports and the notices: the one order, so neither waits
      // on the other for ever — a narrowing too, which expires exports a
      // lock may be expiring.
      await trx.selectFrom('account_household').select(['account_id']).forShare().execute();
      const waiting = await trx
        .selectFrom('notice_request')
        .select(['id', 'subject', sql<boolean>`notice_until <= now()`.as('due')])
        .where('kind', '=', 'identity_audience')
        .where('completed_at', 'is', null)
        .where('withdrawn_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      let current: IdentityAudience = household.identity_audience;
      if (waiting?.due) {
        // In effect since its notice ran out: written in, the household
        // first (its guard reads the notice still waiting), then the notice.
        current = waiting.subject as IdentityAudience;
        await trx
          .updateTable('household')
          .set({ identity_audience: current })
          .where('id', '=', p.householdId)
          .execute();
        await trx
          .updateTable('notice_request')
          .set({ completed_at: sql<Date>`now()` })
          .where('id', '=', waiting.id)
          .execute();
      }
      const pending = waiting && !waiting.due ? waiting : null;
      const withdraw = async () => {
        if (!pending) return;
        await trx
          .updateTable('notice_request')
          .set({ withdrawn_at: sql<Date>`now()` })
          .where('id', '=', pending.id)
          .execute();
      };

      if (identityAudienceRank(to) <= identityAudienceRank(current)) {
        if (to === current && !pending) return null;
        await withdraw();
        if (to !== current) {
          await trx
            .updateTable('household')
            .set({ identity_audience: to })
            .where('id', '=', p.householdId)
            .execute();
          // Whoever no longer sees other people's details: their exports
          // end now, as a document made Only me ends other people's.
          const losing = ROLES.filter(
            (r) => identityAudienceSees(current, r) && !identityAudienceSees(to, r),
          );
          if (losing.length > 0) {
            await trx
              .updateTable('export')
              .set({ expires_at: new Date() })
              .where('requested_by', 'in', (eb) =>
                eb.selectFrom('account_household').select('account_id').where('role', 'in', losing),
              )
              .where((eb) =>
                eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]),
              )
              .execute();
          }
        }
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'identity.audience_changed',
          objectType: 'household',
          objectId: p.householdId,
          detail: {
            from: current,
            to,
            ...(pending ? { withdrawn: pending.subject } : {}),
          },
          ip: meta.ip,
        });
        return null;
      }

      // Wider: only after everybody with a sign-in has been told.
      if (pending?.subject === to) return null;
      const cannot = await membersWhoCannotBeTold(trx);
      if (cannot.length > 0) {
        throw new ApiError(409, 'member_cannot_be_told', MEMBER_CANNOT_BE_TOLD(cannot));
      }
      await withdraw();
      const notice = await trx
        .insertInto('notice_request')
        .values({
          household_id: p.householdId,
          kind: 'identity_audience',
          subject: to,
          requested_by: p.accountId,
          notice_until: sql<Date>`now() + make_interval(hours => ${IDENTITY_NOTICE_HOURS})`,
        })
        .returning(['notice_until'])
        .executeTakeFirstOrThrow();
      // Everybody with a sign-in: whose details gain readers, and who may
      // mark fields Only me before then. Not the owner asking.
      const told = await trx
        .selectFrom('account_household')
        .select(['account_id'])
        .where('account_id', '!=', p.accountId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'identity.audience_changed',
        objectType: 'household',
        objectId: p.householdId,
        detail: {
          from: current,
          to,
          notice_until: notice.notice_until.toISOString(),
          ...(pending ? { withdrawn: pending.subject } : {}),
        },
        ip: meta.ip,
      });
      // Their phones and browsers too (5.33): the word `notice`, and nothing
      // of whose details, who asked or from when — a lock screen is no place
      // for it; the app asks the vault once it is open. Every device of
      // theirs that can be pushed to, whose sign-in has not ended: found
      // here, and queued last of all, after the mail (below).
      let targets: PushTarget[] = [];
      if (told.length > 0) {
        const devices = await trx
          .selectFrom('device')
          .select(['id', 'kind', 'endpoint', 'p256dh', 'auth'])
          .where(
            'account_id',
            'in',
            told.map((a) => a.account_id),
          )
          .where('kind', 'in', ['web_push', 'unified_push'])
          .where('failed_at', 'is', null)
          .where(
            sql<boolean>`(device.session_id is null or exists (
              select 1 from session s
               where s.id = device.session_id and s.revoked_at is null and s.expires_at > now()))`,
          )
          .orderBy('id')
          .execute();
        targets = devices.flatMap((d) =>
          d.p256dh && d.auth && (d.kind === 'web_push' || d.kind === 'unified_push')
            ? [{ id: d.id, kind: d.kind, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }]
            : [],
        );
      }
      if (told.length > 0 && this.operatorMail) {
        // Nothing of anybody's details: who will see them, and from when, on
        // the household's clock. Queued last, as co-owners.ts queues its
        // notice: the queue is not this transaction's, so a failed enqueue
        // rolls the notice back, and only a failure after it (the commit
        // itself) could leave a mail with no notice behind it.
        const when = `${shareEndWords(notice.notice_until, household.timezone)} (${household.timezone})`;
        await this.alert({
          householdId: p.householdId,
          accountIds: told.map((a) => a.account_id),
          subject: 'Who can see identity details is changing',
          body:
            `From ${when}, ${IDENTITY_AUDIENCE_LABELS[to].toLowerCase()} will see the identity ` +
            'details people share in your family vault: names, contacts, addresses and ID ' +
            'numbers. Anything you mark Only me before then stays yours alone. Open the vault ' +
            'to look at yours.',
          emailOnly: true,
          operatorMail: true,
        });
      }
      // The push, last (the 5.33 review, L533-07): inside the transaction,
      // after the mail. Neither queue is this transaction's, so a failure
      // of anything before it — the mail's enqueue among them — rolls the
      // notice back with nothing pushed; a failed enqueue of the push rolls
      // it back too, and asking again tries again.
      if (targets.length > 0) {
        await this.push({ householdId: p.householdId, message: NOTICE_PUSH, targets });
      }
      return null;
    });
    return this.audience(p);
  }
}
