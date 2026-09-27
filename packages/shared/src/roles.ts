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
  /**
   * Make collections of documents, and change your own (5.14). Only a
   * collection's maker changes it (A18).
   */
  | 'collection.manage'
  /**
   * Give a person a photo, or change theirs (5.17c). Whose, is
   * `canChangePerson` (A66); anybody may remove a photo of themselves.
   */
  | 'member.photo'
  /**
   * Turn back on what a restore paused (A55): every link to a document the
   * owner can see (5.16). Without it, nothing — not even a link you made
   * to your own Only me document, which no owner can see: that one stays
   * paused, and you take it back and make a new one. Taking a link back
   * stays with `document.share`.
   */
  | 'restore.review';

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
  'collection.manage': {
    // Gathering papers for a purpose — for the mortgage broker, before a
    // trip — is filing, which everybody who files does. A teen may make a
    // collection, and will never share one outside the family (A18, 5.19). A
    // viewer is given documents, not the family's collections (A17).
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers can open and download documents, but not make collections of them.',
  },
  'member.photo': {
    // The family's own faces, set by the family: whose is canChangePerson.
    // A viewer is given documents, not the family (A65), and sets none —
    // not even their own; they may take their own away.
    roles: ['owner', 'adult', 'teen'],
    refusal: 'Viewers can open and download documents, but not add photos.',
  },
  'restore.review': {
    // A backup brings back links taken back since it was made, so after a
    // restore every link waits for an owner to say it still stands (A55).
    roles: ['owner'],
    refusal: 'Only an owner can turn things back on after a restore.',
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

/** Said to whoever tries to move somebody else's document into, or out of, Only me. */
export const PRIVATE_OWNER_ONLY =
  'Only the person a document belongs to can make it private, or un-private it.';

/** Said to a teen who asks to make their own document Adults only (A72). */
export const TEEN_NOT_ADULTS_ONLY =
  'Adults only would hide it from you too. You can make your own documents Only me or Everyone.';

type Visibility = 'household' | 'adults' | 'private';
const VISIBILITIES: readonly Visibility[] = ['household', 'adults', 'private'];

/**
 * Whether someone may change who sees a document, from `from` to `to`:
 * null if they may, else the sentence that refuses it. `mine` is whether
 * the document belongs to them. The API asks the rows it holds; the web
 * asks what it may offer (`visibilityChoices`).
 *
 *  - Owners and adults: `document.visibility`, as always; Only me, into it
 *    or out of it, only on their own.
 *  - A teen (A72, 5.17c): their own documents, between Only me and
 *    Everyone, and nothing else. Not Adults only, which would hide it from
 *    them too; not anybody else's.
 *  - Viewers: never.
 *
 * A document the caller cannot see is not asked about: it is not there.
 */
export function visibilityRefusal(
  role: Role,
  mine: boolean,
  from: Visibility,
  to: Visibility,
): string | null {
  if (role === 'teen') {
    if (!mine) return refusalFor('document.visibility');
    if (to === 'adults') return TEEN_NOT_ADULTS_ONLY;
    if (from === 'adults') return refusalFor('document.visibility');
    return null;
  }
  if (!can(role, 'document.visibility')) return refusalFor('document.visibility');
  if ((from === 'private' || to === 'private') && !mine) return PRIVATE_OWNER_ONLY;
  return null;
}

/**
 * Whether this role could ever change who sees a document: asked before a
 * document is looked up, so a viewer is refused as they always were.
 */
export function mayChangeVisibilityAtAll(role: Role): boolean {
  return can(role, 'document.visibility') || role === 'teen';
}

/**
 * What a screen offers for who sees a document now `current`: the choices
 * `visibilityRefusal` allows, in the usual order, or none when there is
 * nothing to change it to. A teen, on their own, gets Everyone and Only me.
 */
export function visibilityChoices(role: Role, mine: boolean, current: Visibility): Visibility[] {
  const allowed = VISIBILITIES.filter((to) => visibilityRefusal(role, mine, current, to) === null);
  return allowed.length > 1 ? allowed : [];
}

/** Said to whoever may not change somebody's photo, who may (A66). */
export const PHOTO_REFUSAL =
  'Only an owner or the person themselves can change this photo. For someone without a sign-in, any adult can.';

/**
 * Whether someone may change a person (A66): their photo (5.17c), and their
 * details (5.25). An owner, anybody's; an adult, their own and those of the
 * people with no sign-in (a child, a late parent); a teen, their own; a
 * viewer, nobody's. A person with no sign-in is one whose `role` is null.
 */
export function canChangePerson(
  viewer: { role: Role; memberId: string | null },
  person: { id: string; role: Role | null },
): boolean {
  const self = viewer.memberId !== null && viewer.memberId === person.id;
  switch (viewer.role) {
    case 'owner':
      return true;
    case 'adult':
      return self || person.role === null;
    case 'teen':
      return self;
    default:
      return false;
  }
}

/**
 * Whether someone may give a person a photo, or change it: `member.photo`,
 * and the person theirs to change (A66).
 */
export function canChangePhoto(
  viewer: { role: Role; memberId: string | null },
  person: { id: string; role: Role | null },
): boolean {
  return can(viewer.role, 'member.photo') && canChangePerson(viewer, person);
}

/** Whether someone may take a person's photo away: who may change it, or the person themselves. */
export function canRemovePhoto(
  viewer: { role: Role; memberId: string | null },
  person: { id: string; role: Role | null },
): boolean {
  return (
    canChangePhoto(viewer, person) || (viewer.memberId !== null && viewer.memberId === person.id)
  );
}

/** Who a collection of documents is for (5.14). */
export const COLLECTION_AUDIENCES = ['everyone', 'teens', 'adults', 'only_me'] as const;
export type CollectionAudience = (typeof COLLECTION_AUDIENCES)[number];

/**
 * The roles in each audience (A17). "Everyone" is the family that files:
 * owners, adults and teens. A viewer — an accountant or an attorney with a
 * sign-in — is in none of them, and sees a collection only when it is granted to
 * them (5.33): a collection called "For the divorce lawyer" is not theirs to
 * know about. Only me is its maker's alone, whatever their role.
 */
const COLLECTION_READERS: ReadonlyMap<string, readonly Role[]> = new Map<string, readonly Role[]>([
  ['everyone', ['owner', 'adult', 'teen']],
  ['teens', ['owner', 'adult', 'teen']],
  ['adults', ['owner', 'adult']],
  ['only_me', ['owner', 'adult', 'teen']],
]);

/**
 * Whether a role is in an audience. For Only me that is only half of it:
 * the reader must also be the collection's maker (`canSeeCollection`). An audience
 * this code has never heard of is nobody's. A collection's maker changes it only
 * while they are in its audience (A18); the database's own copy of these
 * roles is collection_audience_has (0036).
 */
export function inCollectionAudience(role: Role, audience: string): boolean {
  return COLLECTION_READERS.get(audience)?.includes(role) ?? false;
}

/**
 * Whether someone may see a collection — that it exists, its name, and what of
 * it they can see. The API asks this in SQL (collections/service.ts) and of each
 * line in the activity log; the database itself keeps Only me (0036).
 *
 * Its maker always may, whatever their role now (the 5.14 review): an
 * adult made a teen, or a viewer, still sees the collection they made for the
 * adults — the documents in it as a teen or a viewer sees them — and may
 * delete it, but no longer change it. Everybody else, by its audience.
 */
export function canSeeCollection(
  reader: { role: Role; memberId: string | null },
  collection: { audience: string; owner_member_id: string | null },
): boolean {
  if (!COLLECTION_READERS.has(collection.audience)) return false;
  if (reader.memberId !== null && collection.owner_member_id === reader.memberId) return true;
  return (
    collection.audience !== 'only_me' && inCollectionAudience(reader.role, collection.audience)
  );
}

/**
 * A collection's maker is told, beside a document in it, who of its audience
 * is not given it (5.14).
 */
export const COLLECTION_HINT_TEENS = 'Teens in this collection’s audience can’t see this one.';
export const COLLECTION_HINT_PRIVATE = 'Only you can see this one. It is private.';
export const COLLECTION_HINT_SOME = 'Some people in this collection’s audience can’t see this one.';

/**
 * The hint beside a document in a collection, for its maker alone: who in the
 * collection's audience the visibility rule keeps it from, or null when every one
 * of them sees it. Nobody else is told — a hint would say that a document
 * they are not given is there.
 */
export function collectionItemHint(
  audience: string,
  doc: { visibility: string; owner_member_id: string | null },
): string | null {
  if (audience === 'only_me') return null;
  // Anybody of each role but the document's owner, whom a private one is for.
  const shut = ROLES.filter(
    (role) => inCollectionAudience(role, audience) && !canSee({ role, memberId: null }, doc),
  );
  if (shut.length === 0) return null;
  if (doc.visibility === 'private') return COLLECTION_HINT_PRIVATE;
  return shut.every((role) => role === 'teen') ? COLLECTION_HINT_TEENS : COLLECTION_HINT_SOME;
}
