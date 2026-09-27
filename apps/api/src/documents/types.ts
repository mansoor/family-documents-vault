import { randomBytes } from 'node:crypto';
import { appendAudit, withPrincipal, type Db, type Visibility } from '@fdv/db';
import {
  CATEGORY_LABELS,
  CORE_FIELDS,
  EXPIRY_ALWAYS_REQUIRED,
  libraryHasName,
  nextReminder,
  TYPE_IN_USE,
  TYPE_LABEL_MAX,
  UNSEEN_DOCUMENTS,
  widensVisibility,
  withSealed,
  type AttributeKind,
  type CoreField,
  type CoreFieldRule,
  type DocumentAttributeView,
  type DocumentTypeImpact,
  type DocumentTypeView,
  type FieldImpact,
  type Reminding,
  type TypeField,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import {
  forgetTypes,
  sealedOf,
  seenDocument,
  typeEtag,
  typeLookup,
  typeView,
  type EffectiveType,
  type Enqueue,
} from './service.js';

/**
 * Kinds of document, managed (5.11): a household adds its own, changes them
 * and the built-ins, hides, archives and deletes them.
 *
 * What a kind says is kept where 0031 keeps it: the household's own in
 * `document_type`, its changes to a built-in in `document_type_setting`,
 * which the built-in itself never sees. Everybody who files documents
 * reads them through `effective_document_type`.
 *
 * Four rules:
 *
 *  - **Owners and adults** change them (`types.manage`, A6). Letting more
 *    people see a kind by default — Will from Adults only to Everyone — is
 *    an owner's decision, confirmed with a fresh credential, and said in
 *    the activity log as news: the next will anybody files, a phone's scan
 *    queued offline with the kind's default among them, is in front of the
 *    teens and the viewers. Narrowing is anybody's who may manage kinds.
 *  - **A key never changes** (0031's trigger holds it), whatever happens to
 *    the name, so what holds a key means the same kind for good.
 *  - **Archiving never touches a document.** A kind in use is archived, or
 *    hidden if it is a built-in, never deleted: every document filed under
 *    it keeps it, and its history keeps its lines.
 *  - **Nothing depends on what the caller cannot see.** The impact of a
 *    change counts the documents the caller can see, and says in words,
 *    always, that others may be affected. A delete is refused only for a
 *    document the caller can see; one that only others' Only me documents
 *    use is deleted for the caller like an unused one, and kept, deleted,
 *    for those documents (0035). A count, or a refusal, would tell an adult
 *    that another has Only me documents of a kind such as "Immigration
 *    case" — the gap the privacy wall forbids (5.11 review).
 *
 * Each change is checked against the kind as it is, held: a lock per kind
 * and household, and the row itself where there is one. A transaction that
 * writes one forgets the kinds it looked up (`forgetTypes`), so what it
 * answers with is the kind as it now is (5.7 review).
 */

/** What POST and PATCH /document-types take; anything left out stays as it is. */
export interface TypeInput {
  label?: string | undefined;
  category?: string | undefined;
  short_label?: string | null | undefined;
  issuer_noun?: string | null | undefined;
  core?: Partial<Record<CoreField, RuleInput | undefined>> | undefined;
  fields?:
    Array<{ key: string; label?: string | undefined; required?: boolean | undefined }> | undefined;
  /** The reminding date's lead times, as before 0.5.15: see `nextReminder`. */
  reminder_leads?: number[] | undefined;
  /** The date to remind from (0.5.15): 'expires', a date field's key, or null for none. */
  remind_from?: string | null | undefined;
  /** Its lead times (0.5.15). Never with `reminder_leads`. */
  remind_leads?: number[] | undefined;
  default_visibility?: Visibility | undefined;
  usually_essential?: boolean | undefined;
  hidden?: boolean | undefined;
}

/** A fixed field's rule as sent: each part left out stays as it is. */
export interface RuleInput {
  shown?: boolean | undefined;
  required?: boolean | undefined;
  label?: string | null | undefined;
}

export interface AttributeInput {
  label: string;
  kind: AttributeKind;
  choices?: string[] | null | undefined;
}

/** The worker's job that makes a kind's reminders again (its JOBS.regenerateTypes). */
export const REGENERATE_JOB = 'types.regenerate';

/** A kind's own key, or a field's: 'h_' and ten base32 characters (0031). */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ownKey = () => `h_${[...randomBytes(10)].map((b) => BASE32[b % 32]).join('')}`;

/** Where a household's own kinds sit in the list: after the built-ins, before "Something else". */
const OWN_SORT_ORDER = 500;

const CATEGORIES = Object.keys(CATEGORY_LABELS);

/**
 * What a change does to a kind's reminders: the date and lead times after
 * it, and which of the two it changes, so only those are written — a
 * household's setting keeps the built-in's own where it said nothing.
 */
interface ReminderWrite extends Reminding {
  fromChanged: boolean;
  leadsChanged: boolean;
}

/** The reminding date and its lead times as one key: what moves every reminder of a kind. */
const remindKey = (t: Pick<EffectiveType, 'remind_from' | 'remind_leads'>) =>
  t.remind_from ? `${t.remind_from}:${leadsOf(t.remind_leads ?? []).join(',')}` : 'off';

const notOnTheList = () =>
  new ApiError(404, 'not_found', 'That kind of document is not on the list.');

const invalid = (message: string, detail?: string) =>
  new ApiError(422, 'validation_failed', message, detail !== undefined ? { detail } : {});

const BUILTIN_KEEPS_NAME =
  'A built-in kind of document keeps its name and category. Add a kind of your own to call it something else.';

/** A name as the person typed it, spaces tidied; blank is none. Too long is refused. */
function nameOf(v: string | null | undefined, what: string): string | null {
  if (v === undefined || v === null) return null;
  const tidy = v.trim().replace(/\s+/g, ' ');
  if (tidy.length > TYPE_LABEL_MAX) {
    throw invalid(`${what} is too long: ${TYPE_LABEL_MAX} characters at most.`);
  }
  return tidy || null;
}

/** A value somebody has given, as missingFields counts one (blank is none). */
function given(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** The lead times, each once, furthest first. */
const leadsOf = (leads: number[]) => [...new Set(leads)].sort((a, b) => b - a);

const sameLeads = (a: number[] | null | undefined, b: number[] | null | undefined) =>
  leadsOf(a ?? []).join(',') === leadsOf(b ?? []).join(',');

/** One change to one kind at a time, in one household: its row may not exist yet (a setting). */
const lockType = (trx: Db, householdId: string, key: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`type:${householdId}:${key}`}, 0))`.execute(
    trx,
  );

export class TypeService {
  constructor(
    private readonly db: Db,
    private readonly enqueue: Enqueue = async () => undefined,
    private readonly stepUp: StepUpService | null = null,
  ) {}

  // ------------------------------------------------------------- reading

  /**
   * The kind, as the household has it now — hidden, archived or not; 404
   * when it has none. A kind deleted while others' documents still use it
   * (0035) is gone here, for everybody, even whoever can see one of them:
   * each change to it would be a line in the log, which the family reads,
   * saying that it is still there.
   */
  private async find(trx: Db, key: string): Promise<EffectiveType> {
    const t = await typeLookup(trx)(key);
    if (!t || t.deleted_at) throw notOnTheList();
    return t;
  }

  /**
   * The kind, held for a change checked against it: one change to a kind
   * at a time in a household (its setting may not exist yet), and the row
   * that keeps it locked, then read as it is once held.
   */
  private async hold(trx: Db, p: Principal, key: string): Promise<EffectiveType> {
    await lockType(trx, p.householdId, key);
    const t = await this.find(trx, key);
    if (t.builtin) {
      await trx
        .selectFrom('document_type_setting')
        .select('type_key')
        .where('type_key', '=', t.key)
        .forUpdate()
        .execute();
    } else {
      await trx
        .selectFrom('document_type')
        .select('key')
        .where('key', '=', t.key)
        .forUpdate()
        .execute();
    }
    return t;
  }

  /**
   * What a change to a kind would touch, for the editor's warnings: "12
   * passports have no number yet". Only the documents the caller can see
   * are counted, and `unseen` says, always and with no number, that there
   * may be others.
   */
  async impact(p: Principal, key: string): Promise<DocumentTypeImpact> {
    requireCapability(p, 'types.manage');
    return withPrincipal(this.db, p, async (trx) => {
      const t = await this.find(trx, key);
      const docs = await trx
        .selectFrom('document as d')
        .select([
          'd.identifier',
          'd.issued_by',
          'd.issued_on',
          'd.expires_on',
          'd.physical_location',
          'd.tags',
          'd.notes',
          'd.extra',
          'd.notes_sealed',
          'd.sealed_details',
          'd.deleted_at',
        ])
        .where('d.type_key', '=', t.key)
        .where(seenDocument(p))
        .execute();
      const live = docs.filter((d) => d.deleted_at === null);
      // An Only me document the caller can see is their own: its sealed
      // notes and details count as given where it has them, unopened.
      const day = (on: string | null) => (on ? { date: on, precision: 'day' as const } : null);
      const values = live.map((d) =>
        withSealed(
          {
            identifier: d.identifier,
            issued_by: d.issued_by,
            issued: day(d.issued_on),
            expires: day(d.expires_on),
            physical_location: d.physical_location,
            tags: d.tags,
            notes: d.notes,
            extra: (d.extra ?? {}) as Record<string, unknown>,
          },
          sealedOf(d),
        ),
      );
      const count = (has: (v: (typeof values)[number]) => boolean) => {
        const n = values.filter(has).length;
        return { with_value: n, without_value: values.length - n };
      };
      const core = Object.fromEntries(
        CORE_FIELDS.map((f) => [f, count((v) => given(v[f]))]),
      ) as DocumentTypeImpact['core'];
      const own = (t.fields ?? []) as TypeField[];
      const fields: FieldImpact[] = own.map((f) => ({
        key: f.key,
        label: f.label,
        ...count((v) => given(v.extra?.[f.key])),
      }));
      // Then every other field one of them keeps a value for — one the kind
      // dropped, kept under Other details — so an editor showing it again
      // as required counts what would need it as Needs info will (the 5.12
      // review). A field none of them has a value for is not listed: all
      // of them lack it.
      const others = new Set(
        values.flatMap((v) => Object.keys(v.extra ?? {}).filter((k) => given(v.extra?.[k]))),
      );
      for (const key of [...others].filter((k) => !own.some((f) => f.key === k)).sort()) {
        fields.push({ key, label: null, ...count((v) => given(v.extra?.[key])) });
      }
      // Those not dealt with yet, by the date each is about (0.5.15): what a
      // move to another date would drop.
      const reminders = await sql<{ source: string; n: number }>`
        select r.source, count(*)::int as n
          from reminder r join document d on d.id = r.document_id
         where d.type_key = ${t.key} and d.deleted_at is null and ${seenDocument(p)}
           and r.kind = 'derived' and r.status in ('scheduled', 'due', 'snoozed')
         group by r.source order by r.source`.execute(trx);
      return {
        key: t.key,
        documents: live.length,
        in_trash: docs.length - live.length,
        core,
        fields,
        reminders: reminders.rows.reduce((n, r) => n + r.n, 0),
        reminders_by_source: Object.fromEntries(reminders.rows.map((r) => [r.source, r.n])),
        unseen: UNSEEN_DOCUMENTS,
      };
    });
  }

  // ------------------------------------------------------------- writing

  /** POST /document-types: a kind of the household's own, under a key it keeps for good. */
  async create(p: Principal, input: TypeInput, meta: RequestMeta): Promise<DocumentTypeView> {
    requireCapability(p, 'types.manage');
    const label = nameOf(input.label, 'The name');
    if (!label) throw invalid('Give the kind of document a name.', 'label');
    const category = input.category ?? 'other';
    if (!CATEGORIES.includes(category)) {
      throw invalid('Choose one of the categories the vault has.', 'category');
    }
    if (input.hidden !== undefined) throw invalid(OWN_NOT_HIDDEN, 'hidden');
    expiryRequired(input, false);
    return withPrincipal(this.db, p, async (trx) => {
      const own = await this.ownColumns(trx, input, null);
      const expires = input.core?.expires?.shown === true;
      // Made showing Expires, it reminds 30 days before, as a new kind that
      // expires always has; or from the date it is told (0.5.15).
      const reminding = reminderFor(input, null, { expires, fields: own.fields ?? [] });
      const fields = requireReminding(own.fields ?? [], reminding.from);
      let key: string | undefined;
      // A key another household holds is not seen here; one more try.
      for (let i = 0; i < 3 && !key; i++) {
        const made = await trx
          .insertInto('document_type')
          .values({
            key: ownKey(),
            household_id: p.householdId,
            label,
            category,
            short_label: nameOf(input.short_label, 'The short name'),
            issuer_noun: nameOf(input.issuer_noun, 'The word after who issued it'),
            fields: JSON.stringify(fields ?? own.fields ?? []),
            core: JSON.stringify(own.core),
            issued_by_label: own.issued_by_label ?? null,
            expiry_driver: expires ? 'expires_on' : null,
            remind_from: reminding.from,
            reminder_leads: reminding.leads,
            usually_essential: input.usually_essential ?? false,
            default_visibility: input.default_visibility ?? 'household',
            sort_order: OWN_SORT_ORDER,
            pack_version: 1,
            created_by: p.accountId,
          })
          .onConflict((oc) => oc.column('key').doNothing())
          .returning('key')
          .executeTakeFirst();
        key = made?.key;
      }
      if (!key) throw new Error('no free key for a new kind of document');
      forgetTypes(trx);
      const t = await this.find(trx, key);
      shownIfRequired(t);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document_type.created',
        objectType: 'document_type',
        detail: { key: t.key, label: t.label },
        ip: meta.ip,
      });
      return typeView(t);
    });
  }

  /**
   * PATCH /document-types/{key}: a change to a kind, made to the kind as
   * the caller last saw it (If-Match) or refused. The date it reminds from
   * or its lead times changed, or its reminders switched on or off, every
   * document of it is reminded anew by the worker (types.regenerate) once
   * the change is kept.
   *
   * Expires switched on for a kind that reminds nobody is reminded 30 days
   * before, as a new kind that expires is (5.11 review): whether a family
   * is reminded never depends on the order it made its changes in. A kind
   * reminding from another date keeps it (0.5.15, `reminderFor`).
   */
  async update(
    p: Principal,
    key: string,
    input: TypeInput,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<DocumentTypeView> {
    requireCapability(p, 'types.manage');
    let regenerate = false;
    const view = await withPrincipal(this.db, p, async (trx) => {
      const before = await this.hold(trx, p, key);
      if (ifMatch && ifMatch !== typeEtag(before)) {
        throw new ApiError(
          409,
          'conflict',
          'Someone else changed this kind of document. Reload and try again.',
          { detail: JSON.stringify(typeView(before)) },
        );
      }
      expiryRequired(input, before.expiry_driver !== null);
      await this.mayWiden(trx, p, before, input.default_visibility);
      if (before.builtin) {
        if (
          input.label !== undefined ||
          input.category !== undefined ||
          input.short_label !== undefined ||
          input.issuer_noun !== undefined
        ) {
          throw invalid(BUILTIN_KEEPS_NAME);
        }
      } else if (input.hidden !== undefined) {
        throw invalid(OWN_NOT_HIDDEN, 'hidden');
      }
      // The kind as it will be, and what it will remind from (0.5.15):
      // worked out from its date and lead times as they are kept, never
      // from reminder_leads, which reads [] while a date field reminds.
      const sentFields = input.fields
        ? await this.fieldsFor(trx, input.fields, (before.fields ?? []) as TypeField[])
        : undefined;
      const afterFields = sentFields ?? ((before.fields ?? []) as TypeField[]);
      const reminding = reminderFor(input, before, {
        expires: input.core?.expires?.shown ?? before.expiry_driver !== null,
        fields: afterFields,
      });
      const required = requireReminding(afterFields, reminding.from);
      const fields = required ?? sentFields;
      if (before.builtin) {
        await this.writeSetting(trx, p, before, input, fields, reminding);
      } else {
        await this.writeOwn(trx, before, input, fields, reminding);
      }
      // Asked again: the kind as it now is, not as this transaction first saw it.
      forgetTypes(trx);
      const after = await this.find(trx, before.key);
      shownIfRequired(after);

      const changed = Object.keys(input).filter(
        (k) => k !== 'hidden' && input[k as keyof TypeInput] !== undefined,
      );
      // Switched off by hiding the date it reminded from: said as a change
      // to what it reminds from.
      if (reminding.fromChanged && !changed.includes('remind_from')) changed.push('remind_from');
      if (changed.length > 0) {
        const moved = after.default_visibility !== before.default_visibility;
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'document_type.updated',
          objectType: 'document_type',
          detail: {
            key: after.key,
            label: after.label,
            fields: changed,
            ...(moved
              ? {
                  from: before.default_visibility,
                  default_visibility: after.default_visibility,
                  widened: widensVisibility(before.default_visibility, after.default_visibility),
                }
              : {}),
          },
          ip: meta.ip,
        });
      }
      if (input.hidden !== undefined && after.hidden !== before.hidden) {
        await this.auditShown(trx, p, after, meta);
      }
      // Every document reminded anew when the date or its lead times move,
      // or reminders are switched on or off (0.5.15).
      regenerate = remindKey(before) !== remindKey(after);
      return typeView(after);
    });
    if (regenerate) await this.regenerate(p, view.key);
    return view;
  }

  /**
   * POST /document-types/{key}/archive: no longer offered for a new
   * document. The household's own is archived; a built-in is hidden, which
   * is all a household can do to one. Every document filed under it keeps
   * it, and it stays in the list while one the caller can see does.
   */
  async archive(p: Principal, key: string, meta: RequestMeta): Promise<DocumentTypeView> {
    return this.offer(p, key, false, meta);
  }

  /** POST /document-types/{key}/restore: offered again. */
  async restore(p: Principal, key: string, meta: RequestMeta): Promise<DocumentTypeView> {
    return this.offer(p, key, true, meta);
  }

  private async offer(
    p: Principal,
    key: string,
    offered: boolean,
    meta: RequestMeta,
  ): Promise<DocumentTypeView> {
    requireCapability(p, 'types.manage');
    return withPrincipal(this.db, p, async (trx) => {
      const before = await this.hold(trx, p, key);
      if (before.hidden === !offered) return typeView(before);
      if (before.builtin) {
        await this.writeSetting(trx, p, before, { hidden: !offered });
      } else {
        await trx
          .updateTable('document_type')
          .set({ archived_at: offered ? null : new Date(), updated_at: new Date() })
          .where('key', '=', before.key)
          .execute();
      }
      forgetTypes(trx);
      const after = await this.find(trx, before.key);
      await this.auditShown(trx, p, after, meta);
      return typeView(after);
    });
  }

  /**
   * DELETE /document-types/{key}: a kind of the household's own is refused
   * while a document the caller can see uses it, in the Trash included; a
   * built-in is hidden instead. Otherwise it is deleted, and the answer is
   * the same whatever else uses it (5.11 review): a kind no document uses
   * is gone; one that only documents the caller cannot see use — another
   * member's Only me — is kept for them, marked deleted (0035), and gone
   * for everybody else. A refusal there would say that such a document
   * exists.
   */
  async remove(p: Principal, key: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'types.manage');
    await withPrincipal(this.db, p, async (trx) => {
      // Held: a document filed under it meanwhile waits for this to end,
      // and one filed before is seen by what follows.
      const t = await this.hold(trx, p, key);
      if (t.builtin) {
        throw invalid("A built-in kind of document can't be deleted. Hide it instead.");
      }
      const seen = await trx
        .selectFrom('document as d')
        .select('d.id')
        .where('d.type_key', '=', t.key)
        .where(seenDocument(p))
        .limit(1)
        .executeTakeFirst();
      if (seen) throw inUse();
      const gone = await trx
        .deleteFrom('document_type')
        .where('key', '=', t.key)
        .where(sql<boolean>`not exists (select 1 from document d where d.type_key = ${t.key})`)
        .executeTakeFirst();
      if (Number(gone.numDeletedRows) === 0) {
        await trx
          .updateTable('document_type')
          .set({ deleted_at: new Date(), updated_at: new Date() })
          .where('key', '=', t.key)
          .execute();
      }
      forgetTypes(trx);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document_type.deleted',
        objectType: 'document_type',
        detail: { key: t.key, label: t.label },
        ip: meta.ip,
      });
    });
  }

  /** POST /document-attributes: a field of the household's own, for any of its kinds to ask for. */
  async createAttribute(
    p: Principal,
    input: AttributeInput,
    meta: RequestMeta,
  ): Promise<DocumentAttributeView> {
    requireCapability(p, 'types.manage');
    const label = nameOf(input.label, 'The name');
    if (!label) throw invalid('Give the field a name.', 'label');
    let choices: string[] | null = null;
    if (input.kind === 'choice') {
      const answers = [
        ...new Set((input.choices ?? []).map((c) => nameOf(c, 'An answer')).filter(Boolean)),
      ] as string[];
      if (answers.length === 0) throw invalid('Give a choice at least one answer.', 'choices');
      choices = answers;
    } else if (input.choices?.length) {
      throw invalid('Only a choice has answers to choose from.', 'choices');
    }
    return withPrincipal(this.db, p, async (trx) => {
      // A name the library already has, a built-in's included, in any case,
      // is refused (0.5.15): two "Due date"s in one list, and the kind
      // editor's dropdown, could not be told apart. Two at once wait on
      // each other, so both cannot pass the check.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`attribute:${p.householdId}`}, 0))`.execute(
        trx,
      );
      const said = label.toLowerCase();
      const same = (await trx.selectFrom('document_attribute').select('label').execute()).find(
        (a) => a.label.trim().replace(/\s+/g, ' ').toLowerCase() === said,
      );
      if (same) throw invalid(libraryHasName(same.label), 'label');
      let made: { key: string } | undefined;
      for (let i = 0; i < 3 && !made; i++) {
        made = await trx
          .insertInto('document_attribute')
          .values({ household_id: p.householdId, key: ownKey(), label, kind: input.kind, choices })
          .onConflict((oc) => oc.columns(['household_id', 'key']).doNothing())
          .returning('key')
          .executeTakeFirst();
      }
      if (!made) throw new Error('no free key for a new field');
      forgetTypes(trx);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document_attribute.created',
        objectType: 'document_attribute',
        detail: { key: made.key, label },
        ip: meta.ip,
      });
      return { key: made.key, label, kind: input.kind, choices, builtin: false };
    });
  }

  // ------------------------------------------------------------- helpers

  /**
   * Letting more people see the kind's next document: an owner's, confirmed
   * with a fresh credential (SEC-17), asked here, under the lock, against
   * the kind as it is — so a change that became a widening while it waited
   * is asked too. A role that may not is refused before anything is asked.
   */
  private async mayWiden(
    trx: Db,
    p: Principal,
    before: EffectiveType,
    to: Visibility | undefined,
  ): Promise<void> {
    if (to === undefined || !widensVisibility(before.default_visibility, to)) return;
    requireCapability(p, 'types.widen_visibility');
    await this.stepUp?.require(p, 'widen_type_visibility', trx);
  }

  /**
   * The columns of the household's own kind that `input` changes. The
   * fixed fields are kept in `core`, except two its own columns say, which
   * the view reads over it: whether it expires (`expiry_driver`) and its
   * word for who issued it (`issued_by_label`).
   */
  private async ownColumns(
    trx: Db,
    input: TypeInput,
    current: EffectiveType | null,
    stored: Record<string, Partial<CoreFieldRule>> = {},
  ) {
    const core: Record<string, Partial<CoreFieldRule>> = { ...stored };
    let issued_by_label: string | null | undefined;
    for (const f of CORE_FIELDS) {
      const rule = input.core?.[f];
      if (!rule) continue;
      const next: Partial<CoreFieldRule> = { ...(core[f] ?? {}) };
      if (rule.shown !== undefined) next.shown = rule.shown;
      if (rule.required !== undefined) next.required = rule.required;
      if (rule.label !== undefined) {
        const label = nameOf(rule.label, 'A field’s name');
        if (f === 'issued_by') issued_by_label = label;
        else next.label = label;
      }
      // Whether it expires is its own column; that an expiry is then
      // required goes without saying (expiryRequired).
      if (f === 'expires') {
        delete next.shown;
        delete next.required;
      }
      core[f] = next;
    }
    const fields = input.fields
      ? await this.fieldsFor(trx, input.fields, (current?.fields ?? []) as TypeField[])
      : undefined;
    return { core, issued_by_label, fields };
  }

  private async writeOwn(
    trx: Db,
    before: EffectiveType,
    input: TypeInput,
    fields: TypeField[] | undefined,
    reminding: ReminderWrite,
  ): Promise<void> {
    const row = await trx
      .selectFrom('document_type')
      .select(['core', 'expiry_driver'])
      .where('key', '=', before.key)
      .executeTakeFirstOrThrow();
    const own = await this.ownColumns(
      trx,
      { ...input, fields: undefined },
      before,
      (row.core ?? {}) as Record<string, Partial<CoreFieldRule>>,
    );
    const set: Record<string, unknown> = { core: JSON.stringify(own.core), updated_at: new Date() };
    if (input.label !== undefined) {
      const label = nameOf(input.label, 'The name');
      if (!label) throw invalid('Give the kind of document a name.', 'label');
      set.label = label;
    }
    if (input.category !== undefined) {
      if (!CATEGORIES.includes(input.category)) {
        throw invalid('Choose one of the categories the vault has.', 'category');
      }
      set.category = input.category;
    }
    if (input.short_label !== undefined) {
      set.short_label = nameOf(input.short_label, 'The short name');
    }
    if (input.issuer_noun !== undefined) {
      set.issuer_noun = nameOf(input.issuer_noun, 'The word after who issued it');
    }
    if (own.issued_by_label !== undefined) set.issued_by_label = own.issued_by_label;
    const expires = input.core?.expires?.shown;
    if (expires !== undefined)
      set.expiry_driver = expires ? (row.expiry_driver ?? 'expires_on') : null;
    if (fields) set.fields = JSON.stringify(fields);
    if (reminding.fromChanged) set.remind_from = reminding.from;
    if (reminding.leadsChanged) set.reminder_leads = reminding.leads;
    if (input.default_visibility !== undefined) set.default_visibility = input.default_visibility;
    if (input.usually_essential !== undefined) set.usually_essential = input.usually_essential;
    await trx
      .updateTable('document_type')
      .set(set as never)
      .where('key', '=', before.key)
      .execute();
  }

  /**
   * A household's change to a built-in, kept beside it (A8): made, or
   * changed key by key. The built-in itself is never written.
   */
  private async writeSetting(
    trx: Db,
    p: Principal,
    before: EffectiveType,
    input: TypeInput,
    fields?: TypeField[],
    reminding?: ReminderWrite,
  ): Promise<void> {
    const held = await trx
      .selectFrom('document_type_setting')
      .selectAll()
      .where('type_key', '=', before.key)
      .executeTakeFirst();
    const core: Record<string, Partial<CoreFieldRule>> = {
      ...((held?.core ?? {}) as Record<string, Partial<CoreFieldRule>>),
    };
    for (const f of CORE_FIELDS) {
      const rule = input.core?.[f];
      if (!rule) continue;
      const next: Partial<CoreFieldRule> = { ...(core[f] ?? {}) };
      if (rule.shown !== undefined) next.shown = rule.shown;
      if (rule.required !== undefined && f !== 'expires') next.required = rule.required;
      if (rule.label !== undefined) next.label = nameOf(rule.label, 'A field’s name');
      core[f] = next;
    }
    const values = {
      core: JSON.stringify(core),
      ...(fields ? { fields: JSON.stringify(fields) } : {}),
      // Off is 'none': null in a setting is "as the built-in" (0038).
      ...(reminding?.fromChanged ? { remind_from: reminding.from ?? 'none' } : {}),
      ...(reminding?.leadsChanged ? { reminder_leads: reminding.leads } : {}),
      ...(input.default_visibility !== undefined
        ? { default_visibility: input.default_visibility }
        : {}),
      ...(input.usually_essential !== undefined
        ? { usually_essential: input.usually_essential }
        : {}),
      ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
      updated_at: new Date(),
      updated_by: p.accountId,
    };
    if (held) {
      await trx
        .updateTable('document_type_setting')
        .set(values)
        .where('type_key', '=', before.key)
        .execute();
    } else {
      await trx
        .insertInto('document_type_setting')
        .values({ household_id: p.householdId, type_key: before.key, ...values })
        .execute();
    }
  }

  /**
   * A kind's own fields, as the list sent names them: each a field of the
   * library, or one the kind already has, by key. Its kind and answers are
   * the library's (or, for one it has, what it has), its name the one sent,
   * else the kind's, else the library's.
   */
  private async fieldsFor(
    trx: Db,
    sent: NonNullable<TypeInput['fields']>,
    current: TypeField[],
  ): Promise<TypeField[]> {
    const keys = sent.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      throw invalid('Each field can be asked for once.', 'fields');
    }
    const library = keys.length
      ? await trx
          .selectFrom('document_attribute')
          .select(['key', 'label', 'kind', 'choices'])
          .where('key', 'in', keys)
          .execute()
      : [];
    return sent.map((f) => {
      const had = current.find((c) => c.key === f.key);
      const lib = library.find((a) => a.key === f.key);
      if (!had && !lib) throw invalid('That field is not in the library.', f.key);
      const kind = (had?.kind ?? lib?.kind) as AttributeKind;
      const label = nameOf(f.label, 'A field’s name') ?? had?.label ?? lib?.label ?? f.key;
      const choices = lib?.choices ?? had?.choices ?? [];
      return {
        key: f.key,
        label,
        kind,
        required: f.required ?? had?.required ?? false,
        ...(kind === 'choice' ? { choices } : {}),
      };
    });
  }

  /** "Archived", "stopped offering", or the way back: a line for the log. */
  private async auditShown(trx: Db, p: Principal, t: EffectiveType, meta: RequestMeta) {
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: t.hidden ? 'document_type.archived' : 'document_type.restored',
      objectType: 'document_type',
      detail: { key: t.key, label: t.label, builtin: t.builtin },
      ip: meta.ip,
    });
  }

  /**
   * Every document of the kind reminded anew, by the worker, as the vault
   * (it sees them all; the caller may not). A queue that cannot be reached
   * leaves the change made: each document is reminded anew when next edited.
   */
  private async regenerate(p: Principal, key: string): Promise<void> {
    await this.enqueue(
      REGENERATE_JOB,
      { household_id: p.householdId, type_key: key },
      { singletonKey: `${REGENERATE_JOB}:${p.householdId}:${key}` },
    ).catch(() => undefined);
  }
}

const OWN_NOT_HIDDEN = 'A kind of document of your own is archived, not hidden.';

const inUse = () => new ApiError(409, 'type_in_use', TYPE_IN_USE);

/**
 * An expiry is required of every kind that expires, and of no other (5.11
 * review): a document of a kind that expires reads "Needs an expiry date"
 * without one, whatever its rule says, and has since 0.5.6. So
 * `core.expires.required` is answered as whether the kind expires
 * (typeView), and a change that asks for anything else is refused with a
 * sentence rather than kept and ignored. `expiresBefore`: whether the kind
 * expires now; `shown`, sent with it, is what it will be.
 */
function expiryRequired(input: TypeInput, expiresBefore: boolean): void {
  const rule = input.core?.expires;
  if (rule?.required === undefined) return;
  const expires = rule.shown ?? expiresBefore;
  if (rule.required === expires) return;
  throw invalid(
    expires ? EXPIRY_ALWAYS_REQUIRED : 'A field has to be shown to be required.',
    'expires',
  );
}

/**
 * What the kind will remind from, and how long before (0.5.15), run on the
 * kind as it will be after the change — its Expires shown or not, and its
 * fields — by the rules every vault and fake keeps (`nextReminder`,
 * @fdv/shared): a date it asks for, with lead times; the legacy rule when
 * `remind_from` is left out; hiding the reminding date switches reminders
 * off; the reminding date always required. Read from the date and lead
 * times the kind keeps (`remind_from`, `remind_leads`), never from
 * `reminder_leads`, which is [] while a date field reminds. Refused with
 * the rule's sentence.
 */
function reminderFor(
  input: TypeInput,
  before: EffectiveType | null,
  after: { expires: boolean; fields: ReadonlyArray<TypeField> },
): ReminderWrite {
  const was: Reminding = {
    from: before?.remind_from ?? null,
    leads: leadsOf(before?.remind_leads ?? []),
  };
  const next = nextReminder(
    input,
    before ? { reminding: was, expires: before.expiry_driver !== null } : null,
    {
      expires: after.expires,
      dates: after.fields.filter((f) => f.kind === 'date').map((f) => f.key),
    },
  );
  if ('problem' in next) throw invalid(next.problem.message, next.problem.detail);
  return {
    ...next,
    fromChanged: next.from !== was.from,
    leadsChanged: !sameLeads(next.leads, was.leads),
  };
}

/**
 * The kind's fields with the one it reminds from required, as it always
 * is (0.5.15): older phones ask for it through `fields[].required`. Null
 * when they need no change.
 */
function requireReminding(fields: TypeField[], from: string | null): TypeField[] | null {
  if (from === null || from === 'expires') return null;
  if (fields.every((f) => f.key !== from || f.required === true)) return null;
  return fields.map((f) => (f.key === from ? { ...f, required: true } : f));
}

/**
 * A field is required only where the card shows it: a required field
 * nobody is asked for would leave every document Needs info for good.
 */
function shownIfRequired(t: EffectiveType): void {
  const core = (t.core ?? {}) as Record<CoreField, CoreFieldRule>;
  for (const f of CORE_FIELDS) {
    if (f === 'expires') continue;
    if (core[f]?.required === true && core[f]?.shown === false) {
      throw invalid('A field has to be shown to be required.', f);
    }
  }
}
