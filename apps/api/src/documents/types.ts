import { randomBytes } from 'node:crypto';
import { appendAudit, withPrincipal, type Db, type Visibility } from '@fdv/db';
import {
  CATEGORY_LABELS,
  CORE_FIELDS,
  EXPIRY_ALWAYS_REQUIRED,
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
  reminder_leads?: number[] | undefined;
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

/** Reminded this long before it expires, when a new kind that expires says nothing. */
const DEFAULT_LEADS = [30];

const CATEGORIES = Object.keys(CATEGORY_LABELS);

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
      const reminders = await sql<{ n: number }>`
        select count(*)::int as n
          from reminder r join document d on d.id = r.document_id
         where d.type_key = ${t.key} and d.deleted_at is null and ${seenDocument(p)}
           and r.kind = 'derived' and r.status in ('scheduled', 'due', 'snoozed')`.execute(trx);
      return {
        key: t.key,
        documents: live.length,
        in_trash: docs.length - live.length,
        core,
        fields,
        reminders: reminders.rows[0]?.n ?? 0,
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
            fields: JSON.stringify(own.fields ?? []),
            core: JSON.stringify(own.core),
            issued_by_label: own.issued_by_label ?? null,
            expiry_driver: expires ? 'expires_on' : null,
            reminder_leads: leadsOf(input.reminder_leads ?? (expires ? DEFAULT_LEADS : [])),
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
   * the caller last saw it (If-Match) or refused. Its lead times changed,
   * or its Expires switched on or off, every document of it is reminded
   * anew by the worker (types.regenerate) once the change is kept.
   *
   * Expires switched on for a kind with no lead times is reminded 30 days
   * before, as a new kind that expires is (5.11 review): whether a family
   * is reminded never depends on the order it made its changes in.
   */
  async update(
    p: Principal,
    key: string,
    sent: TypeInput,
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
      expiryRequired(sent, before.expiry_driver !== null);
      const switchedOn = before.expiry_driver === null && sent.core?.expires?.shown === true;
      const input: TypeInput =
        switchedOn && sent.reminder_leads === undefined && !before.reminder_leads?.length
          ? { ...sent, reminder_leads: DEFAULT_LEADS }
          : sent;
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
        await this.writeSetting(trx, p, before, input);
      } else {
        if (input.hidden !== undefined) throw invalid(OWN_NOT_HIDDEN, 'hidden');
        await this.writeOwn(trx, before, input);
      }
      // Asked again: the kind as it now is, not as this transaction first saw it.
      forgetTypes(trx);
      const after = await this.find(trx, before.key);
      shownIfRequired(after);

      const changed = Object.keys(input).filter(
        (k) => k !== 'hidden' && input[k as keyof TypeInput] !== undefined,
      );
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
      regenerate =
        !sameLeads(before.reminder_leads, after.reminder_leads) ||
        (before.expiry_driver === null) !== (after.expiry_driver === null);
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

  private async writeOwn(trx: Db, before: EffectiveType, input: TypeInput): Promise<void> {
    const row = await trx
      .selectFrom('document_type')
      .select(['core', 'expiry_driver'])
      .where('key', '=', before.key)
      .executeTakeFirstOrThrow();
    const own = await this.ownColumns(
      trx,
      input,
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
    if (own.fields) set.fields = JSON.stringify(own.fields);
    if (input.reminder_leads !== undefined) set.reminder_leads = leadsOf(input.reminder_leads);
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
    const fields = input.fields
      ? await this.fieldsFor(trx, input.fields, (before.fields ?? []) as TypeField[])
      : undefined;
    const values = {
      core: JSON.stringify(core),
      ...(fields ? { fields: JSON.stringify(fields) } : {}),
      ...(input.reminder_leads !== undefined
        ? { reminder_leads: leadsOf(input.reminder_leads) }
        : {}),
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
