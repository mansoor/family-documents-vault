import type { Role } from './roles.js';
import type { Share } from './wire.js';

/**
 * A person's emergency information (0.9.0, H4 of the health plan,
 * `features.emergency_info`): one page a person — allergies, medications,
 * conditions, blood type, insurance, doctors and emergency contacts — with
 * their advance directive, healthcare proxy and insurance card found among
 * their documents by kind.
 *
 * Not a medical tool: the vault files and shows what was typed, as typed.
 * It interprets nothing, checks no interaction and suggests nothing.
 *
 * Sealed as identity details are (0102). Read by the person, the owners,
 * whoever the page's audience takes in or names, and the person's caregiver
 * with a live grant they kept (H1b); written by the person and the owners;
 * its audience chosen by the person when they sign in as a grown-up, and by
 * an owner for anybody else. Never a viewer's or a guest's to read.
 *
 * Health, and Sensitive: nothing of it is ever in an email, a push, a text,
 * a digest, a search, a count, a snippet or a line of the activity log —
 * those say "emergency information" and nothing more.
 */

/** Who reads somebody's page besides them and the owners, narrowest first: the identity words. */
export const EMERGENCY_AUDIENCES = ['owners_and_self', 'adults', 'family'] as const;
export type EmergencyAudience = (typeof EMERGENCY_AUDIENCES)[number];

/** Each audience in words, about one person's page. */
export const EMERGENCY_AUDIENCE_LABELS: Record<EmergencyAudience, string> = {
  owners_and_self: 'Only them and the owners',
  adults: 'Them, the owners and every adult',
  family: 'Everyone in the family',
};

/** Where a page starts: the person, the owners and the adults. */
export const EMERGENCY_DEFAULT_AUDIENCE: EmergencyAudience = 'adults';

/** The most people a page may name besides its audience. */
export const EMERGENCY_CHOSEN_MAX = 50;

/** Blood types as a card prints them; "Unknown" is a blank. */
export const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type BloodType = (typeof BLOOD_TYPES)[number];

/** One allergy or condition: what it is, and the family's own note. */
export interface EmergencyItem {
  id: string;
  name: string;
  note?: string | null;
}

/** One medication: its name, the dose as written, a note. */
export interface EmergencyMedication {
  id: string;
  name: string;
  dose?: string | null;
  note?: string | null;
}

/** A doctor, or somebody to call: name, what they are (specialty, relationship), a phone. */
export interface EmergencyPerson {
  id: string;
  name: string;
  role?: string | null;
  phone?: string | null;
  note?: string | null;
}

/** The short fields of an insurance card, beside the card itself (a document). */
export interface EmergencyInsurance {
  insurer?: string | null;
  member_id?: string | null;
  group_number?: string | null;
  phone?: string | null;
}

/** What is sealed: everything typed on the page. */
export interface EmergencyFields {
  blood_type?: BloodType | null;
  allergies?: EmergencyItem[];
  medications?: EmergencyMedication[];
  conditions?: EmergencyItem[];
  insurance?: EmergencyInsurance | null;
  doctors?: EmergencyPerson[];
  emergency_contacts?: EmergencyPerson[];
  notes?: string | null;
}

/** The longest a list may be, and its words. */
export const EMERGENCY_LIST_MAX = 40;
export const EMERGENCY_NAME_MAX = 120;
export const EMERGENCY_NOTE_MAX = 300;
export const EMERGENCY_NOTES_MAX = 2000;

/**
 * The parts of a page, in the order it, a wallet card and a clinician's
 * link show them. `date_of_birth` is the person's own, from the family's
 * details; the rest is what was typed.
 */
export const EMERGENCY_FIELD_KEYS = [
  'date_of_birth',
  'blood_type',
  'allergies',
  'medications',
  'conditions',
  'insurance',
  'doctors',
  'emergency_contacts',
  'notes',
] as const;
export type EmergencyFieldKey = (typeof EMERGENCY_FIELD_KEYS)[number];

export const EMERGENCY_FIELD_LABELS: Record<EmergencyFieldKey, string> = {
  date_of_birth: 'Date of birth',
  blood_type: 'Blood type',
  allergies: 'Allergies',
  medications: 'Medications',
  conditions: 'Conditions',
  insurance: 'Insurance',
  doctors: 'Doctors',
  emergency_contacts: 'Emergency contacts',
  notes: 'Other information',
};

/** What a wallet card ticks to begin with: what a stranger needs first. */
export const WALLET_CARD_DEFAULT: readonly EmergencyFieldKey[] = [
  'date_of_birth',
  'blood_type',
  'allergies',
  'medications',
  'conditions',
  'emergency_contacts',
];

/** The papers a page links to, by their H3 kinds, never copied. */
export const EMERGENCY_DOCUMENT_KINDS = [
  'advance_directive',
  'healthcare_proxy',
  'insurance_card',
] as const;
export type EmergencyDocumentKind = (typeof EMERGENCY_DOCUMENT_KINDS)[number];

export const EMERGENCY_DOCUMENT_LABELS: Record<EmergencyDocumentKind, string> = {
  advance_directive: 'Advance directive',
  healthcare_proxy: 'Healthcare proxy',
  insurance_card: 'Insurance card',
};

/** How long a clinician's link lasts unless the sharer says (hours), and at most. */
export const EMERGENCY_LINK_DEFAULT_HOURS = 4;
export const EMERGENCY_LINK_MAX_HOURS = 24;

/** The line every page, card and link carries: it files, it does not advise. */
export const EMERGENCY_NOT_ADVICE =
  'Entered by the family. Not checked by a doctor, and not medical advice.';

/** Said where the activity log, an email or a notification mentions it: the words, never what is on it. */
export const EMERGENCY_NEUTRAL = 'emergency information';

/** What somebody may not change is refused with (403). */
export const EMERGENCY_EDIT_REFUSAL =
  'Only the person themselves, or an owner, can change their emergency information.';

/** Who sees it, refused to anybody else (403): the person's, or a parent's for a child. */
export const EMERGENCY_CHOOSE_REFUSAL =
  'Only the person chooses who sees their emergency information — or an owner, for a child or somebody without their own sign-in.';

/** Somebody the page may name: of the family, signed in as an adult or a teen. */
export function mayBeChosenForEmergency(role: Role | null): boolean {
  return role === 'adult' || role === 'teen';
}

/**
 * Whether a reader sees another person's page (the database's
 * `emergency_reads`, 0102, said again): an owner; an adult or a teen the
 * audience takes in, or named; a caregiver with a live grant kept. The
 * person reads their own whatever this says. Never a viewer.
 */
export function canSeeEmergency(
  reader: { role: Role; memberId: string },
  page: { member_id: string; audience: EmergencyAudience; chosen: readonly string[] },
  caregiver = false,
): boolean {
  if (reader.memberId === page.member_id) return true;
  if (reader.role === 'owner') return true;
  if (reader.role === 'adult' && (page.audience === 'adults' || page.audience === 'family')) {
    return true;
  }
  if (reader.role === 'teen' && page.audience === 'family') return true;
  if (
    (reader.role === 'adult' || reader.role === 'teen') &&
    page.chosen.includes(reader.memberId)
  ) {
    return true;
  }
  return caregiver && reader.role === 'adult';
}

/** Whether somebody writes a person's page: the person (not as a viewer), and every owner. */
export function canEditEmergency(reader: { role: Role; memberId: string }, memberId: string) {
  if (reader.role === 'owner') return true;
  return reader.memberId === memberId && (reader.role === 'adult' || reader.role === 'teen');
}

/**
 * Whether somebody chooses who sees a person's page, and makes a
 * clinician's link (the database's `emergency_chooses`): the person, signed
 * in as a grown-up; for anybody else, an owner. `grownUp`: whether the
 * person signs in as an owner or an adult.
 */
export function choosesEmergency(
  reader: { role: Role; memberId: string },
  memberId: string,
  grownUp: boolean,
): boolean {
  if (reader.memberId === memberId) return reader.role === 'owner' || reader.role === 'adult';
  return reader.role === 'owner' && !grownUp;
}

/** Which parts of a page have something on them: a part with nothing is left off a card. */
export function emergencyFilled(
  fields: EmergencyFields,
  dateOfBirth: string | null = null,
): EmergencyFieldKey[] {
  const ins = fields.insurance;
  const has: Record<EmergencyFieldKey, boolean> = {
    date_of_birth: Boolean(dateOfBirth),
    blood_type: Boolean(fields.blood_type),
    allergies: (fields.allergies ?? []).length > 0,
    medications: (fields.medications ?? []).length > 0,
    conditions: (fields.conditions ?? []).length > 0,
    insurance: Boolean(ins && (ins.insurer || ins.member_id || ins.group_number || ins.phone)),
    doctors: (fields.doctors ?? []).length > 0,
    emergency_contacts: (fields.emergency_contacts ?? []).length > 0,
    notes: Boolean(fields.notes && fields.notes.trim()),
  };
  return EMERGENCY_FIELD_KEYS.filter((k) => has[k]);
}

/** Of a page, only the parts ticked: what a card prints and a clinician's link shows. */
export function emergencyFieldsFor(
  fields: EmergencyFields,
  keys: readonly string[],
): EmergencyFields {
  const out: EmergencyFields = {};
  const ticked = new Set(keys);
  if (ticked.has('blood_type') && fields.blood_type) out.blood_type = fields.blood_type;
  if (ticked.has('allergies') && fields.allergies?.length) out.allergies = fields.allergies;
  if (ticked.has('medications') && fields.medications?.length) {
    out.medications = fields.medications;
  }
  if (ticked.has('conditions') && fields.conditions?.length) out.conditions = fields.conditions;
  if (ticked.has('insurance') && fields.insurance) out.insurance = fields.insurance;
  if (ticked.has('doctors') && fields.doctors?.length) out.doctors = fields.doctors;
  if (ticked.has('emergency_contacts') && fields.emergency_contacts?.length) {
    out.emergency_contacts = fields.emergency_contacts;
  }
  if (ticked.has('notes') && fields.notes) out.notes = fields.notes;
  return out;
}

/** Whether a page has nothing typed on it at all. */
export function emergencyEmpty(fields: EmergencyFields): boolean {
  return emergencyFilled(fields).length === 0;
}

/** A paper a page links to: the reader may open it, or it is not listed for them. */
export interface EmergencyDocumentRef {
  id: string;
  title: string;
}

/** Somebody the page names besides its audience. */
export interface EmergencyChosen {
  member_id: string;
  name: string;
}

/**
 * `GET /members/{id}/emergency` (`features.emergency_info`): a person's
 * page as the reader is given it, `ETag` its `version`. `404 not_found` for
 * a person who is not there for the reader, or whose page they may not see
 * — the same answer, so nobody learns a page is there. A page nobody has
 * written yet is answered (version 0) to the person and the owners alone;
 * to anybody else it is the same 404 as one kept from them.
 */
export interface EmergencyView {
  member_id: string;
  /** What was typed; empty when nothing has been. */
  fields: EmergencyFields;
  /** Their date of birth, from the family's details, for a card and a link. */
  date_of_birth: string | null;
  /** Who reads it besides the person and the owners. */
  audience: EmergencyAudience;
  /** Named besides; to whoever chooses, and to the person; empty to anybody else. */
  chosen: EmergencyChosen[];
  /** Their advance directive, healthcare proxy and insurance card, as the reader may open them. */
  documents: Record<EmergencyDocumentKind, EmergencyDocumentRef[]>;
  /** 0 before anything is written; the ETag. */
  version: number;
  updated_at: string | null;
  /** The reader writes it (the person, an owner). */
  can_edit: boolean;
  /** The reader chooses who sees it and makes a clinician's link. */
  can_choose: boolean;
  /** The reader sees its links and who opened them: the person, the owners. */
  can_see_links: boolean;
  /** The reader sees it only as the person's caregiver (H1b). */
  caregiver: boolean;
  /** Who may be named, for whoever chooses: of the family, signed in as an adult or a teen. */
  candidates?: EmergencyCandidate[];
}

/** `PUT /members/{id}/emergency`: the whole page, with `If-Match` its version. */
export interface EmergencyInput {
  fields: EmergencyFields;
}

/** `PUT /members/{id}/emergency/audience`: who reads it besides the person and the owners. */
export interface EmergencyAudienceInput {
  audience: EmergencyAudience;
  chosen_member_ids?: string[];
}

/** Somebody the chooser may name: of the family, signed in as an adult or a teen. */
export interface EmergencyCandidate {
  member_id: string;
  name: string;
  role: Role;
}

/** One time a clinician's link was opened: when, from what network and browser — never what was read. */
export interface EmergencyOpening {
  at: string;
  /** The network (IPv4 /24, IPv6 /48), never the address. */
  network: string | null;
  user_agent: string | null;
}

/** A clinician's link, as the person and the owners see it: a share link, its ticked parts and its openings. */
export interface EmergencyLink extends Share {
  emergency_fields: EmergencyFieldKey[];
  openings: EmergencyOpening[];
}

/** `GET /members/{id}/emergency/links`: the person's links, newest first; and who may be named. */
export interface EmergencyLinks {
  items: EmergencyLink[];
}

/**
 * `POST /members/{id}/emergency/links`: a link to view the parts ticked,
 * for hours (default 4, at most 24) or until `expires_at`, with the share
 * link's own factors (`ShareInput`'s). The person, or an owner for a child;
 * confirms it's you first (`share_emergency`).
 */
export interface EmergencyLinkInput {
  fields: EmergencyFieldKey[];
  expires_in_hours?: number;
  expires_at?: string;
  recipient_label?: string;
  with_pin?: boolean;
  with_password?: boolean;
  password?: string;
  code_email?: string;
  second_factor?: 'email' | 'sms';
  recipient_phone?: string;
  this_device_only?: boolean;
  max_opens?: number | null;
  /** The page before Open names the person. Absent: it does not. */
  show_title?: boolean;
}

/** Inside an opened clinician's link: the person, and the parts ticked — nothing else. */
export interface SharedEmergency {
  person_name: string;
  date_of_birth: string | null;
  fields: EmergencyFields;
  /** The parts ticked, in order, said even when one is empty. */
  shown: EmergencyFieldKey[];
  updated_at: string | null;
}
