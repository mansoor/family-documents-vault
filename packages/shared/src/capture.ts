import { checkExtra } from './details.js';
import {
  wellFormedDate,
  type DateValue,
  type DocumentTypeView,
  type TypeField,
  type Visibility,
} from './documents.js';
import { can, type Role } from './roles.js';
import { issuerNoun, monthYear } from './titles.js';

/**
 * The details a capture can carry (POST /capture's `metadata` field, 0.4.9):
 * everything the confirm card asks, so a document is made complete, with
 * the right visibility, from its first byte. Every field is optional; Skip
 * sends none.
 */
export interface CaptureMetadata {
  type_key?: string | null;
  title?: string | null;
  owner_member_id?: string | null;
  visibility?: Visibility;
  issued?: DateValue | null;
  expires?: DateValue | null;
  identifier?: string | null;
  /** Who issued it (0.4.10): send only to a vault with `features.issued_by`. */
  issued_by?: string | null;
  physical_location?: string | null;
  is_essential?: boolean;
  tags?: string[];
  notes?: string | null;
  /**
   * The type's own details, by field key (0.5.7), each checked by its kind
   * (details.ts). A vault before 0.5.7 refuses the field: send it only to
   * one whose types have fields to fill in.
   */
  extra?: Record<string, unknown>;
}

/** The fields a capture's metadata may hold, in the order the card asks them. */
export const CAPTURE_FIELDS = [
  'type_key',
  'title',
  'owner_member_id',
  'visibility',
  'issued',
  'expires',
  'identifier',
  'issued_by',
  'physical_location',
  'is_essential',
  'tags',
  'notes',
  'extra',
] as const satisfies ReadonlyArray<keyof CaptureMetadata>;

export interface CaptureContext {
  /** Who is filing it. */
  me: { member_id: string; role: Role };
  /** The household's people. */
  members: ReadonlyArray<{ id: string }>;
  /**
   * The document types the vault knows, and each one's own fields, which
   * its details are checked against. A type given without its fields has
   * its details left to the server.
   */
  types: ReadonlyArray<
    Pick<DocumentTypeView, 'key' | 'expiry_driver' | 'default_visibility'> & {
      fields?: ReadonlyArray<Pick<TypeField, 'key' | 'label' | 'kind' | 'choices'>>;
    }
  >;
}

/** Why a capture's details were refused: the field, the words, the status. */
export interface CaptureProblem {
  field: keyof CaptureMetadata;
  /** Which of the type's details, when the problem is in `extra` (0.5.7). */
  key?: string;
  message: string;
  status: 403 | 422;
}

/**
 * The rules a capture's details must keep, the same on the phone (checked
 * before a scan is queued, offline) and on the server (checked before the
 * upload is claimed, so a refusal leaves nothing behind):
 *
 *  - a teen files documents for themselves only, and never as Adults only
 *    (a teen cannot see those, their own included);
 *  - Only me is for documents that are yours;
 *  - the person is in the family, and the type is one the vault knows;
 *  - an expiry date needs a type that expires;
 *  - a date is a real day, with a precision it agrees with;
 *  - text fits: the same limits POST /documents keeps;
 *  - the details are the type's own, each of its kind (0.5.7). A required
 *    one left out is not a problem: the document is Needs info until it is
 *    given (A7).
 *
 * Returns the first problem, or null.
 */
export function checkCaptureMetadata(
  meta: CaptureMetadata,
  ctx: CaptureContext,
): CaptureProblem | null {
  const teen = ctx.me.role === 'teen';
  const owner = meta.owner_member_id ?? (teen ? ctx.me.member_id : null);
  if (teen && meta.owner_member_id != null && meta.owner_member_id !== ctx.me.member_id) {
    return {
      field: 'owner_member_id',
      message: 'You can only add documents that belong to you.',
      status: 403,
    };
  }
  if (meta.owner_member_id != null && !ctx.members.some((m) => m.id === meta.owner_member_id)) {
    return { field: 'owner_member_id', message: 'That person is not in the family.', status: 422 };
  }
  const type = meta.type_key != null ? ctx.types.find((t) => t.key === meta.type_key) : undefined;
  if (meta.type_key != null && !type) {
    return { field: 'type_key', message: 'That kind of document is not on the list.', status: 422 };
  }
  if (meta.visibility === 'adults' && !can(ctx.me.role, 'document.see_adults')) {
    return {
      field: 'visibility',
      message: 'Only an adult can make a document adults-only.',
      status: 403,
    };
  }
  const visibility = effectiveVisibility(meta, type, ctx.me.role);
  if (visibility === 'private' && owner !== ctx.me.member_id) {
    return {
      field: 'visibility',
      message: 'Only the person a document belongs to can make it private to them.',
      status: 422,
    };
  }
  for (const field of ['issued', 'expires'] as const) {
    const d = meta[field];
    if (d != null && !wellFormedDate(d)) {
      return {
        field,
        message: 'Send a date as a day, a month or a year, with its precision.',
        status: 422,
      };
    }
  }
  for (const [field, max] of LIMITS) {
    const v = meta[field];
    if (typeof v === 'string' && v.length > max) {
      return { field, message: `That is too long: ${max} characters at most.`, status: 422 };
    }
  }
  if (meta.tags && (meta.tags.length > 50 || meta.tags.some((t) => t.length > 40))) {
    return { field: 'tags', message: 'At most 50 tags, of 40 characters each.', status: 422 };
  }
  // A type queued with no fields to hand leaves its details to the server.
  if (meta.extra != null && (!type || type.fields !== undefined)) {
    const checked = checkExtra(meta.extra, type?.fields ?? []);
    if ('problem' in checked) {
      return {
        field: 'extra',
        key: checked.problem.key,
        message: checked.problem.message,
        status: 422,
      };
    }
  }
  if (meta.expires != null && !type?.expiry_driver) {
    return {
      field: 'expires',
      message: type
        ? "This kind of document doesn't expire, so it has no expiry date."
        : 'Choose what it is before giving it an expiry date.',
      status: 422,
    };
  }
  return null;
}

/** The longest each text field may be (POST /documents' limits). */
const LIMITS = [
  ['title', 200],
  ['identifier', 200],
  ['issued_by', 200],
  ['physical_location', 500],
  ['notes', 10_000],
] as const;

/**
 * Who a new document is for when the details do not say: the type's
 * default — except that a role that cannot see Adults only documents (a
 * teen) never files one, so their own stays theirs to see.
 */
export function effectiveVisibility(
  meta: Pick<CaptureMetadata, 'visibility'>,
  type: Pick<DocumentTypeView, 'default_visibility'> | null | undefined,
  role: Role,
): Visibility {
  if (meta.visibility) return meta.visibility;
  const fallback = type?.default_visibility ?? 'household';
  return fallback === 'adults' && !can(role, 'document.see_adults') ? 'household' : fallback;
}

/**
 * The name a document gets when nobody types one. Statements, bills,
 * policies and the like are named for who issued them and when: "Barclays
 * statement, September 2026" — a family has a dozen statements, and this is
 * what tells them apart (0.4.10). Everything else, and those whose issuer
 * is not known yet, for the person chosen on the card (not whoever is
 * filing it): "Aisha's passport"; "Passport" when nobody is chosen.
 */
export function autoTitle(
  type: Pick<DocumentTypeView, 'key' | 'label' | 'issuer_noun'>,
  member: { display_name: string } | null | undefined,
  details: { issued_by?: string | null; issued?: DateValue | null } = {},
): string {
  const noun = issuerNoun(type);
  const issuer = details.issued_by?.trim();
  if (noun && issuer) {
    const when = monthYear(details.issued);
    return when ? `${issuer} ${noun}, ${when}` : `${issuer} ${noun}`;
  }
  const first = member?.display_name.trim().split(/\s+/)[0];
  if (!first) return type.label;
  return `${first}'s ${type.label.toLowerCase()}`;
}

function lead(days: number): string {
  if (days >= 60) {
    const months = Math.round(days / 30);
    return months === 1 ? '1 month' : `${months} months`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * What the card promises about reminders: "We'll remind you 9 months and 6
 * months before it expires." Null for a type that does not expire or has
 * no reminders.
 */
export function reminderSentence(
  type: Pick<DocumentTypeView, 'expiry_driver' | 'reminder_leads'> | null | undefined,
): string | null {
  if (!type?.expiry_driver || type.reminder_leads.length === 0) return null;
  const when = type.expiry_driver === 'review_on' ? "it's due for review" : 'it expires';
  const leads = [...new Set(type.reminder_leads)].filter((d) => d > 0).sort((a, b) => b - a);
  const onTheDay = type.reminder_leads.includes(0);
  if (leads.length === 0) return `We'll remind you on the day ${when}.`;
  const words = leads.map(lead);
  const list =
    words.length === 1
      ? words[0]
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `We'll remind you ${list} before ${when}${onTheDay ? ', and on the day' : ''}.`;
}
