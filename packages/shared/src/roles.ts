/**
 * The role matrix (SHR-03).
 *
 * Four roles and no custom permission editor: a permissions matrix with
 * checkboxes is how family software becomes unusable. The design fixes the
 * four and describes them in a sentence each; this is that table turned
 * into something the API can enforce and a test can walk.
 *
 * Two rules about this file:
 *
 *  1. It is the only place a role is compared to a string. Every endpoint
 *     asks `can(role, capability)`, so a new endpoint has to name the
 *     capability it needs, and a capability nobody enforces shows up as an
 *     unused key rather than as a hole.
 *  2. The refusal is written here, next to the rule, because the sentence
 *     a person reads when they are told "no" is part of the rule. It says
 *     who *can* do the thing, so the answer to "then who?" is in the
 *     refusal and not in a support email.
 */

export const ROLES = ['owner', 'adult', 'teen', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  /** Create a document, upload a version, or capture one. */
  | 'document.add'
  /** Change a document's fields. Teens may only change their own — the
   *  ownership half of that rule lives with the document, not here. */
  | 'document.edit'
  /** Move a document to the trash, or restore it. */
  | 'document.delete'
  /** See documents marked *Adults only*. This one is read by the query
   *  that lists documents, so it is a filter before it is a refusal. */
  | 'document.see_adults'
  /** Change a document's visibility. */
  | 'document.visibility'
  /** Create a link that someone outside the family can open (SHR-05). */
  | 'document.share'
  /** Add, snooze or acknowledge reminders. */
  | 'reminder.manage'
  /** Answer the household questions from the wizard. */
  | 'profile.edit'
  /** Add a person who has no sign-in. */
  | 'member.add'
  /** Invite someone to sign in as a teen or a viewer. */
  | 'member.invite'
  /** Invite someone to sign in as an adult or an owner — which hands out
   *  the Adults-only documents, so it is an owner's decision alone. */
  | 'member.invite_adult'
  /** Remove a person's sign-in from the household. */
  | 'member.remove'
  /** Promote or demote another account. */
  | 'role.change'
  /** Change where the files are kept. */
  | 'storage.manage'
  /** Change how the household sends email and who gets reminded. */
  | 'notifications.manage'
  /** Ask for a copy of everything. */
  | 'export.request'
  /** Read the household activity log (SHR-07), filtered to what the
   *  reader could already see. */
  | 'audit.read'
  /** The family's own details: birthdays, the household's answers, what they lack (5.3). */
  | 'family.details'
  /** Add and change the household's kinds of document, and hide the built-in ones (5.11). */
  | 'types.manage'
  /** Let more people see a kind of document by default: Adults only to Everyone (5.11). */
  | 'types.widen_visibility'
  /** Make lists of documents, and change your own (5.14). Only a list's maker changes it (A18). */
  | 'list.manage';

interface Rule {
  readonly roles: readonly Role[];
  /** Shown verbatim to whoever was refused. */
  readonly refusal: string;
}

const MATRIX: Record<Capability, Rule> = {
  'document.add': {
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers can open and download documents, but not add them.',
  },
  'document.edit': {
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers can open and download documents, but not change them.',
  },
  'document.delete': {
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers can open and download documents, but not remove them.',
  },
  'document.see_adults': {
    roles: ['owner', 'adult'],
    refusal: 'That document is for the adults in the family.',
  },
  'document.visibility': {
    roles: ['owner', 'adult'],
    refusal: 'Only an adult can change who is able to see a document.',
  },
  'document.share': {
    roles: ['owner', 'adult'],
    refusal: 'Only an adult can share a document outside the family.',
  },
  'reminder.manage': {
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers can see reminders, but not change them.',
  },
  'profile.edit': {
    roles: ['owner', 'adult'],
    refusal: 'Only an adult can change the household details.',
  },
  'member.add': {
    roles: ['owner', 'adult'],
    refusal: 'Only an adult can add someone to the family.',
  },
  'member.invite': {
    roles: ['owner', 'adult'],
    refusal: 'Only an adult can invite someone to sign in.',
  },
  'member.invite_adult': {
    roles: ['owner'],
    refusal:
      'Only an owner can give someone adult access, because it opens the adults-only documents.',
  },
  'member.remove': {
    roles: ['owner'],
    refusal: 'Only an owner can remove someone from the family.',
  },
  'role.change': {
    roles: ['owner'],
    refusal: 'Only an owner can change what someone is allowed to do.',
  },
  'storage.manage': {
    roles: ['owner'],
    refusal: 'Only an owner can change where your files are kept.',
  },
  'notifications.manage': {
    roles: ['owner'],
    refusal: 'Only an owner can change how the vault sends email.',
  },
  'export.request': {
    roles: ['owner', 'adult'],
    refusal: 'Only an adult can export the whole vault.',
  },
  'audit.read': {
    // A teen can already see the household's documents, so the log of
    // what happened to them tells them nothing new — and being able to
    // see what happened is the thing that makes a shared vault feel
    // fair. A viewer is an outsider and sees none of it.
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers can open and download documents, but not see what the family has been doing.',
  },
  'family.details': {
    // Who is how old, whether the family owns a home or a business, and
    // the "no passport for Aisha" worked out from those: the family's own
    // business. A viewer — an accountant or an attorney with a sign-in —
    // is given documents, not the family (5.3).
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers see the documents they are given, not the family’s own details.',
  },
  'types.manage': {
    // What the family calls its papers, which fields each asks for and
    // when it is reminded: the adults' to decide, as the household
    // details are (A6).
    roles: ['owner', 'adult'],
    refusal: 'Only an adult can change the kinds of document the family keeps.',
  },
  'types.widen_visibility': {
    // Turning Will or Tax from Adults only into Everyone puts the next one
    // anybody files — a phone's scan queued offline among them — in front
    // of the teens and the viewers. Narrowing is `types.manage`.
    roles: ['owner'],
    refusal: 'Only an owner can let more people see a kind of document from now on.',
  },
  'list.manage': {
    // Gathering papers for a purpose — for the mortgage broker, before a
    // trip — is filing, which everybody who files does. A teen may make a
    // list, and will never share one outside the family (A18, 5.19). A
    // viewer is given documents, not the family's lists (A17).
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers can open and download documents, but not make lists of them.',
  },
};

export const CAPABILITIES = Object.keys(MATRIX) as Capability[];

export function can(role: Role, capability: Capability): boolean {
  return MATRIX[capability].roles.includes(role);
}

/** The sentence to show someone who cannot do it. */
export function refusalFor(capability: Capability): string {
  return MATRIX[capability].refusal;
}

/** Which roles may do it, for the tests and for the settings screen. */
export function rolesWith(capability: Capability): readonly Role[] {
  return MATRIX[capability].roles;
}

/** Everything this role may do — what the client uses to hide dead buttons. */
export function capabilitiesFor(role: Role): Capability[] {
  return CAPABILITIES.filter((c) => can(role, c));
}

/** The role's name as a person would say it. */
export function roleLabel(role: Role): string {
  return { owner: 'Owner', adult: 'Adult', teen: 'Teen', viewer: 'Viewer' }[role];
}

/**
 * One line describing what the role gets, shown where an invitation is
 * being made — the moment the choice is actually consequential.
 */
export function roleDescription(role: Role): string {
  return {
    owner: 'Everything, including storage, people and emergency contacts.',
    adult: 'Everything day to day. Cannot change storage or remove people.',
    teen: 'Their own documents, plus anything shared with the whole family.',
    viewer: 'Can open and download what the family shares. Changes nothing.',
  }[role];
}

/** Which role may hand out which. Used before an invitation is created. */
export function capabilityToInvite(role: Role): Capability {
  return role === 'owner' || role === 'adult' ? 'member.invite_adult' : 'member.invite';
}

/**
 * Whether someone may see a document.
 *
 * The API asks this in SQL, inside the queries that list and fetch
 * documents. This is the same three clauses for code that already holds
 * the rows — the worker, which reads everything in a household to build
 * each person their own copy of the digest. A second copy of the rule is
 * how the digest came to leak private titles, so `apps/api` has a test
 * that holds the two to the same answers.
 *
 * An unknown visibility is closed, not open: a value added later must be
 * taught here before anybody is shown it.
 */
export function canSee(
  viewer: { role: Role; memberId: string | null },
  doc: { visibility: string; owner_member_id: string | null },
): boolean {
  switch (doc.visibility) {
    case 'household':
      return true;
    case 'adults':
      return can(viewer.role, 'document.see_adults');
    case 'private':
      return viewer.memberId !== null && doc.owner_member_id === viewer.memberId;
    default:
      return false;
  }
}

/** Who a list of documents is for (5.14). */
export const LIST_AUDIENCES = ['everyone', 'teens', 'adults', 'only_me'] as const;
export type ListAudience = (typeof LIST_AUDIENCES)[number];

/**
 * The roles in each audience (A17). "Everyone" is the family that files:
 * owners, adults and teens. A viewer — an accountant or an attorney with a
 * sign-in — is in none of them, and sees a list only when it is granted to
 * them (5.33): a list called "For the divorce lawyer" is not theirs to
 * know about. Only me is its maker's alone, whatever their role.
 */
const LIST_READERS: ReadonlyMap<string, readonly Role[]> = new Map<string, readonly Role[]>([
  ['everyone', ['owner', 'adult', 'teen']],
  ['teens', ['owner', 'adult', 'teen']],
  ['adults', ['owner', 'adult']],
  ['only_me', ['owner', 'adult', 'teen']],
]);

/**
 * Whether a role is in an audience. For Only me that is only half of it:
 * the reader must also be the list's maker (`canSeeList`). An audience
 * this code has never heard of is nobody's.
 */
export function inListAudience(role: Role, audience: string): boolean {
  return LIST_READERS.get(audience)?.includes(role) ?? false;
}

/**
 * Whether someone may see a list — that it exists, its name, and what of
 * it they can see. The API asks this in SQL (lists/service.ts) and of each
 * line in the activity log; the database itself keeps Only me (0036).
 */
export function canSeeList(
  reader: { role: Role; memberId: string | null },
  list: { audience: string; owner_member_id: string | null },
): boolean {
  if (!inListAudience(reader.role, list.audience)) return false;
  return (
    list.audience !== 'only_me' ||
    (reader.memberId !== null && list.owner_member_id === reader.memberId)
  );
}

/** A list's maker is told, beside a document on it, who of its audience is not given it (5.14). */
export const LIST_HINT_TEENS = 'Teens in this list’s audience can’t see this one.';
export const LIST_HINT_PRIVATE = 'Only you can see this one. It is private.';
export const LIST_HINT_SOME = 'Some people in this list’s audience can’t see this one.';

/**
 * The hint beside a document on a list, for its maker alone: who in the
 * list's audience the visibility rule keeps it from, or null when every one
 * of them sees it. Nobody else is told — a hint would say that a document
 * they are not given is there.
 */
export function listItemHint(
  audience: string,
  doc: { visibility: string; owner_member_id: string | null },
): string | null {
  if (audience === 'only_me') return null;
  // Anybody of each role but the document's owner, whom a private one is for.
  const shut = ROLES.filter(
    (role) => inListAudience(role, audience) && !canSee({ role, memberId: null }, doc),
  );
  if (shut.length === 0) return null;
  if (doc.visibility === 'private') return LIST_HINT_PRIVATE;
  return shut.every((role) => role === 'teen') ? LIST_HINT_TEENS : LIST_HINT_SOME;
}
