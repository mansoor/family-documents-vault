import { openEmergency, sealEmergency, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  BLOOD_TYPES,
  canEditEmergency,
  EMERGENCY_AUDIENCES,
  EMERGENCY_CHOOSE_REFUSAL,
  EMERGENCY_CHOSEN_MAX,
  EMERGENCY_DEFAULT_AUDIENCE,
  EMERGENCY_DOCUMENT_KINDS,
  EMERGENCY_DOCUMENT_LABELS,
  EMERGENCY_EDIT_REFUSAL,
  EMERGENCY_LIST_MAX,
  EMERGENCY_NAME_MAX,
  EMERGENCY_NOTE_MAX,
  EMERGENCY_NOTES_MAX,
  type EmergencyAudience,
  type EmergencyCandidate,
  type EmergencyChosen,
  type EmergencyDocumentKind,
  type EmergencyDocumentRef,
  type EmergencyFields,
  type EmergencyView,
} from '@fdv/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import { readDocument } from '../documents/service.js';
import { ApiError, notFound } from '../errors.js';

/**
 * A person's emergency information (0.9.0, H4 of the health plan).
 *
 * One sealed record a person (0102): what was typed — allergies,
 * medications, conditions, blood type, insurance, doctors, emergency
 * contacts, a note — under a fresh data key at every write, wrapped under
 * the household's identity key. Their advance directive, healthcare proxy
 * and insurance card are their own documents, found by kind as the reader
 * may open them, never copied in.
 *
 * Who reads it: the person, the owners, whoever its audience takes in or
 * names, and the person's caregiver with a live grant they kept (H1b); the
 * database holds the same rule (`emergency_reads`) and gives nobody else
 * the row. Who writes it: the person and the owners. Who chooses its
 * audience: the person signed in as a grown-up; an owner for anybody else.
 *
 * Anybody not given a page is told there is none (404), the same as for a
 * person who is not there for them. Nothing of it is ever written to the
 * activity log but that it changed, and who may see it (H2): no allergy,
 * medication or condition, and never which part.
 *
 * Not a medical tool: nothing here reads what was typed but to keep it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const blankIsNone = (v: string | null | undefined) => (v === '' ? null : v);
/** Text of a field, trimmed; blank is none. */
const words = (max: number) =>
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
const named = z
  .string()
  .trim()
  .min(1, 'Give it a name, or leave the entry out.')
  .max(EMERGENCY_NAME_MAX, `At most ${EMERGENCY_NAME_MAX} characters.`);
const list = <T extends z.ZodType<{ id: string }>>(entry: T) =>
  z
    .array(entry)
    .max(EMERGENCY_LIST_MAX, `At most ${EMERGENCY_LIST_MAX} of these.`)
    .refine(
      (entries) => new Set(entries.map((e) => e.id)).size === entries.length,
      'Each entry in a list has an id of its own.',
    )
    .optional();

const item = z.object({ id: entryId, name: named, note: words(EMERGENCY_NOTE_MAX) }).strict();
const medication = z
  .object({
    id: entryId,
    name: named,
    dose: words(EMERGENCY_NAME_MAX),
    note: words(EMERGENCY_NOTE_MAX),
  })
  .strict();
const person = z
  .object({
    id: entryId,
    name: named,
    role: words(EMERGENCY_NAME_MAX),
    phone: words(40),
    note: words(EMERGENCY_NOTE_MAX),
  })
  .strict();

/** The page, as typed: the catalogue and nothing else. */
export const emergencyFieldsBody = z
  .object({
    blood_type: z.enum(BLOOD_TYPES).nullable().optional(),
    allergies: list(item),
    medications: list(medication),
    conditions: list(item),
    insurance: z
      .object({
        insurer: words(EMERGENCY_NAME_MAX),
        member_id: words(60),
        group_number: words(60),
        phone: words(40),
      })
      .strict()
      .nullable()
      .optional(),
    doctors: list(person),
    emergency_contacts: list(person),
    notes: words(EMERGENCY_NOTES_MAX),
  })
  .strict();

/** PUT /members/{id}/emergency: the whole page. */
export const emergencyWriteBody = z.object({ fields: emergencyFieldsBody }).strict();

/** PUT /members/{id}/emergency/audience. */
export const emergencyAudienceBody = z
  .object({
    audience: z.enum(EMERGENCY_AUDIENCES),
    chosen_member_ids: z
      .array(z.string().uuid('Name somebody by their id.'))
      .max(EMERGENCY_CHOSEN_MAX, `At most ${EMERGENCY_CHOSEN_MAX} people.`)
      .optional(),
  })
  .strict();

/** A page's version as an ETag: `"3"`, as a person's is. */
export const emergencyEtag = (version: number) => `"${version}"`;

/** Whether an If-Match names this version: `"3"`, `W/"3"`, `3`, or `*`. */
function matches(ifMatch: string, version: number): boolean {
  const said = ifMatch.trim();
  if (said === '*') return true;
  return said.replace(/^W\//, '').replace(/^"(.*)"$/, '$1') === String(version);
}

const conflict = (version: number) =>
  new ApiError(
    409,
    'conflict',
    'Someone else changed this emergency information. Reload and try again.',
    { detail: JSON.stringify({ version }) },
  );

/** A page left out of what is kept: blanks gone, so nothing different is no change. */
function tidy(fields: EmergencyFields): EmergencyFields {
  const out: EmergencyFields = {};
  for (const [k, v] of Object.entries(fields) as [keyof EmergencyFields, unknown][]) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'insurance') {
      const ins = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, x]) => x != null && x !== ''),
      );
      if (Object.keys(ins).length === 0) continue;
      out.insurance = ins;
      continue;
    }
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

interface Subject {
  id: string;
  self: boolean;
  dateOfBirth: string | null;
}

interface Page {
  fields: EmergencyFields;
  audience: EmergencyAudience;
  chosen: string[];
  version: number;
  updated_at: Date | null;
}

export class EmergencyService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
  ) {}

  // ------------------------------------------------------------- reading

  /**
   * The person asked about, when they are of the family and there for the
   * caller: a guest keeps no page, and a viewer reads nobody's but their
   * own (and keeps none they could write).
   */
  private async subject(trx: Db, p: Principal, requested: string): Promise<Subject> {
    if (!UUID.test(requested)) throw notFound();
    const row = await trx
      .selectFrom('member')
      .select(['id', 'kind', 'date_of_birth'])
      .where('id', '=', requested)
      .executeTakeFirst();
    if (!row || row.kind !== 'family') throw notFound();
    const self = row.id === p.memberId;
    if (!self && (p.role === 'viewer' || p.guest === true)) throw notFound();
    // Somebody whose access is limited reads nobody else's page, whatever
    // their role, as the database answers them (the H4 review): told there
    // is none, never left to a refusal of the database's own.
    if (!self) {
      const limited = await sql<{ r: boolean }>`select app_restricted() as r`
        .execute(trx)
        .then((r) => r.rows[0]?.r === true);
      if (limited) throw notFound();
    }
    return { id: row.id, self, dateOfBirth: row.date_of_birth };
  }

  /** Whether the database says the caller is the person's caregiver (0102). */
  private async caregiver(trx: Db, memberId: string): Promise<boolean> {
    const r = await sql<{
      ok: boolean;
    }>`select emergency_caregiver(${memberId}::uuid) as ok`.execute(trx);
    return r.rows[0]?.ok === true;
  }

  /** Whether the caller chooses who sees the person's page (0102, `emergency_chooses`). */
  private async chooses(trx: Db, memberId: string): Promise<boolean> {
    const r = await sql<{ ok: boolean }>`select emergency_chooses(${memberId}::uuid) as ok`.execute(
      trx,
    );
    return r.rows[0]?.ok === true;
  }

  /**
   * The page as the caller is given it, opened; null when they are given
   * none. A page nobody has written yet is the default's: the person, the
   * owners, the adults, and a caregiver — so whether one exists is asked
   * as the vault, and nobody outside a page's audience is shown an empty
   * one as if it were theirs to see.
   */
  private async page(trx: Db, p: Principal, subject: Subject, lock = false): Promise<Page | null> {
    let q = trx.selectFrom('member_emergency').selectAll().where('member_id', '=', subject.id);
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (row) {
      const key = await this.keys.unwrapById(trx, row.wrapped_by_scope);
      const fields = openEmergency(
        key,
        { householdId: p.householdId, memberId: subject.id },
        row,
      ) as EmergencyFields;
      return {
        fields,
        audience: row.audience,
        chosen: row.chosen,
        version: row.version,
        updated_at: row.updated_at,
      };
    }
    // Kept, and not given to the caller: not theirs (0102, emergency_page_kept).
    const kept = await sql<{
      kept: boolean;
    }>`select emergency_page_kept(${subject.id}::uuid) as kept`
      .execute(trx)
      .then((r) => r.rows[0]?.kept === true);
    if (kept) return null;
    const empty: Page = {
      fields: {},
      audience: EMERGENCY_DEFAULT_AUDIENCE,
      chosen: [],
      version: 0,
      updated_at: null,
    };
    // Nothing written yet: the person's to fill, an owner's (who writes
    // anybody's) — and nobody else's to be told about. An adult or a
    // caregiver is answered as for a page not given them (404), so whether
    // a page is unwritten or kept from them reads the same (the H4 review).
    return subject.self || p.role === 'owner' ? empty : null;
  }

  /** Their advance directive, healthcare proxy and insurance card, as the caller may open them. */
  private async documents(
    trx: Db,
    p: Principal,
    memberId: string,
  ): Promise<Record<EmergencyDocumentKind, EmergencyDocumentRef[]>> {
    const rows = await trx
      .selectFrom('document as d')
      .select(['d.id', 'd.title', 'd.type_key'])
      .where('d.owner_member_id', '=', memberId)
      .where('d.type_key', 'in', [...EMERGENCY_DOCUMENT_KINDS])
      .where('d.deleted_at', 'is', null)
      .where(readDocument(p, 'd'))
      .orderBy('d.updated_at', 'desc')
      .limit(30)
      .execute();
    const out: Record<EmergencyDocumentKind, EmergencyDocumentRef[]> = {
      advance_directive: [],
      healthcare_proxy: [],
      insurance_card: [],
    };
    for (const r of rows) {
      const kind = r.type_key as EmergencyDocumentKind;
      out[kind].push({ id: r.id, title: r.title ?? EMERGENCY_DOCUMENT_LABELS[kind] });
    }
    return out;
  }

  /** The people named, by name: for whoever chooses, and the person. */
  private async chosenNames(trx: Db, ids: string[]): Promise<EmergencyChosen[]> {
    if (ids.length === 0) return [];
    const rows = await trx
      .selectFrom('member')
      .select(['id', 'display_name'])
      .where('id', 'in', ids)
      .orderBy('display_name')
      .execute();
    return rows.map((r) => ({ member_id: r.id, name: r.display_name }));
  }

  /** Who may be named: of the family, signed in as an adult or a teen, not the person. */
  private async candidates(trx: Db, memberId: string): Promise<EmergencyCandidate[]> {
    const rows = await trx
      .selectFrom('account_household')
      .innerJoin('member', 'member.id', 'account_household.member_id')
      .select(['member.id', 'member.display_name', 'account_household.role'])
      .where('member.kind', '=', 'family')
      .where('account_household.role', 'in', ['adult', 'teen'])
      .where('member.id', '!=', memberId)
      .orderBy('member.display_name')
      .execute();
    return rows.map((r) => ({ member_id: r.id, name: r.display_name, role: r.role }));
  }

  private async view(trx: Db, p: Principal, subject: Subject, page: Page): Promise<EmergencyView> {
    const chooses = await this.chooses(trx, subject.id);
    const me = { role: p.role, memberId: p.memberId };
    // Seen only as their caregiver: not the person, not an owner, not in
    // the audience or named.
    const throughAudience =
      subject.self ||
      p.role === 'owner' ||
      (p.role === 'adult' && (page.audience === 'adults' || page.audience === 'family')) ||
      (p.role === 'teen' && page.audience === 'family') ||
      page.chosen.includes(p.memberId);
    const caregiver = !throughAudience && (await this.caregiver(trx, subject.id));
    return {
      member_id: subject.id,
      fields: page.fields,
      date_of_birth: subject.dateOfBirth,
      audience: page.audience,
      chosen: chooses || subject.self ? await this.chosenNames(trx, page.chosen) : [],
      documents: await this.documents(trx, p, subject.id),
      version: page.version,
      updated_at: page.updated_at?.toISOString() ?? null,
      can_edit: canEditEmergency(me, subject.id),
      can_choose: chooses,
      can_see_links: subject.self || p.role === 'owner',
      caregiver,
      ...(chooses ? { candidates: await this.candidates(trx, subject.id) } : {}),
    };
  }

  /** GET /members/{id}/emergency: the page as the caller may see it, or 404. */
  async get(p: Principal, requested: string): Promise<EmergencyView> {
    return withPrincipal(this.db, p, async (trx) => {
      const subject = await this.subject(trx, p, requested);
      const page = await this.page(trx, p, subject);
      if (!page) throw notFound();
      return this.view(trx, p, subject, page);
    });
  }

  // -------------------------------------------------------------- writing

  /**
   * PUT /members/{id}/emergency: the whole page, made from the version the
   * writer read (If-Match; without one, it is written as sent). The person
   * writes their own, an owner anybody's (403 to anybody else who may read
   * it; 404 to anybody who may not). Nothing different is no change: the
   * version stays, and nothing is logged. A first write takes the page's
   * default audience, whoever writes it.
   */
  async put(
    p: Principal,
    requested: string,
    body: z.infer<typeof emergencyWriteBody>,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<EmergencyView> {
    const next = tidy(body.fields as EmergencyFields);
    return withPrincipal(this.db, p, async (trx) => {
      const subject = await this.subject(trx, p, requested);
      // Read first as the caller may see it (a held row is one they may
      // also change, so a reader who may not would be told nothing is
      // there), then held once they may write it.
      if (!(await this.page(trx, p, subject))) throw notFound();
      if (!canEditEmergency({ role: p.role, memberId: p.memberId }, subject.id)) {
        throw new ApiError(403, 'forbidden', EMERGENCY_EDIT_REFUSAL);
      }
      const current = await this.page(trx, p, subject, true);
      if (!current) throw notFound();
      if (ifMatch !== undefined && !matches(ifMatch, current.version)) {
        throw conflict(current.version);
      }
      if (JSON.stringify(tidy(current.fields)) === JSON.stringify(next)) {
        return this.view(trx, p, subject, current);
      }
      const written = await this.write(trx, p, subject, current, {
        fields: next,
        audience: current.audience,
        chosen: current.chosen,
      });
      // That it changed — never what, nor which part (H2).
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'emergency.updated',
        objectType: 'member',
        objectId: subject.id,
        ip: meta.ip,
      });
      return this.view(trx, p, subject, written);
    });
  }

  /**
   * The page sealed and written: a first write inserts — two at once, the
   * second is told the page moved on — and later ones update the version
   * read. The database's rules refuse what the caller may not write.
   */
  private async write(
    trx: Db,
    p: Principal,
    subject: Subject,
    current: Page,
    next: { fields: EmergencyFields; audience: EmergencyAudience; chosen: string[] },
  ): Promise<Page> {
    const scope = await this.keys.identityKey(trx, p.householdId);
    const sealed = sealEmergency(
      scope.key,
      { householdId: p.householdId, memberId: subject.id },
      next.fields,
    );
    const values = {
      sealed: sealed.sealed,
      dek_wrapped: sealed.dek_wrapped,
      wrapped_by_scope: scope.id,
      audience: next.audience,
      chosen: next.chosen,
    };
    const row =
      current.version === 0
        ? await trx
            .insertInto('member_emergency')
            .values({ household_id: p.householdId, member_id: subject.id, ...values })
            .onConflict((oc) => oc.column('member_id').doNothing())
            .returning(['version', 'updated_at'])
            .executeTakeFirst()
        : await trx
            .updateTable('member_emergency')
            .set(values)
            .where('member_id', '=', subject.id)
            .where('version', '=', current.version)
            .returning(['version', 'updated_at'])
            .executeTakeFirst();
    if (!row) throw conflict(current.version);
    return { ...next, version: row.version, updated_at: row.updated_at };
  }

  /**
   * PUT /members/{id}/emergency/audience: who reads the page besides the
   * person and the owners — the person's choice when they sign in as a
   * grown-up, an owner's for anybody else (403 to anybody else who may
   * read it). Those named are of the family, signed in as an adult or a
   * teen (422 otherwise): never a viewer, a guest, or the person.
   */
  async setAudience(
    p: Principal,
    requested: string,
    body: z.infer<typeof emergencyAudienceBody>,
    meta: RequestMeta,
  ): Promise<EmergencyView> {
    const chosen = [...new Set(body.chosen_member_ids ?? [])];
    return withPrincipal(this.db, p, async (trx) => {
      const subject = await this.subject(trx, p, requested);
      if (!(await this.page(trx, p, subject))) throw notFound();
      if (!(await this.chooses(trx, subject.id))) {
        throw new ApiError(403, 'forbidden', EMERGENCY_CHOOSE_REFUSAL);
      }
      const current = await this.page(trx, p, subject, true);
      if (!current) throw notFound();
      if (chosen.length) {
        const may = new Set((await this.candidates(trx, subject.id)).map((c) => c.member_id));
        if (chosen.some((id) => !may.has(id))) {
          throw new ApiError(
            422,
            'validation_failed',
            'Choose people of the family who sign in as an adult or a teen.',
          );
        }
      }
      const sameChosen =
        chosen.length === current.chosen.length && chosen.every((c) => current.chosen.includes(c));
      if (body.audience === current.audience && sameChosen && current.version > 0) {
        return this.view(trx, p, subject, current);
      }
      const written = await this.write(trx, p, subject, current, {
        fields: current.fields,
        audience: body.audience,
        chosen,
      });
      // Whoever no longer sees it: their exports end now (the H4 review), as
      // a narrower audience for identity details ends them (identity.ts) —
      // each held this page as they could see it then.
      await this.endExportsOfThoseLosing(trx, subject.id, current, {
        audience: body.audience,
        chosen,
      });
      // Who sees it, in a word, and how many named: never who, nor what is on it.
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'emergency.audience_changed',
        objectType: 'member',
        objectId: subject.id,
        detail: { audience: body.audience, chosen: chosen.length },
        ip: meta.ip,
      });
      return this.view(trx, p, subject, written);
    });
  }

  /**
   * The exports of everybody who saw a page through its audience or by
   * name, and does not now, ended: an adult or a teen signed in, never the
   * person, an owner (who always sees it) or a caregiver (whose sight is
   * the grant's, not the audience's).
   */
  private async endExportsOfThoseLosing(
    trx: Db,
    memberId: string,
    before: { audience: EmergencyAudience; chosen: string[] },
    after: { audience: EmergencyAudience; chosen: string[] },
  ): Promise<number> {
    const sees = (
      page: { audience: EmergencyAudience; chosen: string[] },
      role: string,
      member: string,
    ) =>
      (role === 'adult' && (page.audience === 'adults' || page.audience === 'family')) ||
      (role === 'teen' && page.audience === 'family') ||
      ((role === 'adult' || role === 'teen') && page.chosen.includes(member));
    const readers = await trx
      .selectFrom('account_household')
      .select(['account_id', 'member_id', 'role'])
      .where('role', 'in', ['adult', 'teen'])
      .where('member_id', '!=', memberId)
      .execute();
    const losing = readers
      .filter((r) => sees(before, r.role, r.member_id) && !sees(after, r.role, r.member_id))
      .map((r) => r.account_id);
    if (losing.length === 0) return 0;
    const ended = await trx
      .updateTable('export')
      .set({ expires_at: new Date() })
      .where('requested_by', 'in', losing)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .executeTakeFirst();
    return Number(ended.numUpdatedRows);
  }

  /**
   * Whether the caller sees a person's clinician's links and who opened
   * them: the person and the owners (404 to anybody else).
   */
  async mayListLinks(p: Principal, requested: string): Promise<void> {
    await withPrincipal(this.db, p, async (trx) => {
      const subject = await this.subject(trx, p, requested);
      if (!subject.self && p.role !== 'owner') throw notFound();
    });
  }
}
