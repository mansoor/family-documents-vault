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
   * Ask somebody outside the family to send documents in (5.21, A39): a
   * request link. Anybody else is not refused but answered as if there
   * were no such thing (404): a teen or a viewer never learns that a
   * request, or a file sent through one, exists.
   */
  | 'upload_request.create'
  /**
   * Change a person's name, date of birth or relationship (5.25). Whose, as
   * a photo's, is `canChangePerson` (A66); that somebody has passed away is
   * an owner's alone to say.
   */
  | 'member.edit'
  /**
   * Turn back on what a restore paused (A55): every link to a document the
   * owner can see (5.16). Without it, nothing — not even a link you made
   * to your own Only me document, which no owner can see: that one stays
   * paused, and you take it back and make a new one. Taking a link back
   * stays with `document.share`.
   */
  | 'restore.review'
  /**
   * Remove a document in the Trash for good (5.24): one they filed or that
   * is theirs at once, anybody else's 24 hours after its filer was told.
   */
  | 'document.purge'
  /**
   * Choose who reads other people's shared identity details (5.26, A34):
   * wider only after 72 hours' notice, narrower at once. Whose record each
   * reader sees is `canSeeIdentity`.
   */
  | 'identity.audience'
  /**
   * Lock somebody's sign-in, and unlock it (5.28, A51, A52): never one's
   * own, and never another owner's (A50). An owner power (A54): asked with a
   * passkey or a code, never the password.
   */
  | 'member.suspend'
  /**
   * Start a password reset for somebody (5.29, D5): never one's own, never
   * another owner's (A50), never while they are locked or paused. An owner
   * power (A54). Which way it goes is ResetPath: no owner is ever handed a
   * working link for somebody who keeps anything private.
   */
  | 'member.reset_password'
  /**
   * Sign somebody out everywhere (5.30, A53): every session and device of
   * theirs ends at once, a co-owner's too, who is told. An owner power
   * (A54), as a lock is.
   */
  | 'member.sign_out';

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
  'upload_request.create': {
    // What comes in through a request is reviewed before it is filed, by
    // whoever asked or by any adult (A43): the adults' to ask for, as it is
    // theirs to share out (A39). The database's own copy of these roles is
    // app_live_upload_request() and the request's rule (0044).
    roles: ['owner', 'adult'],
    refusal: 'Only an adult can ask someone outside the family to send documents.',
  },
  'member.edit': {
    // The family's own details, kept by the family, as its photos are:
    // whose is canChangePerson. A viewer is given documents, not the family
    // (A65), and changes nobody's details — not even their own.
    roles: ['owner', 'adult', 'teen'],
    refusal: "Viewers can open and download documents, but not change anybody's details.",
  },
  'restore.review': {
    // A backup brings back links taken back since it was made, so after a
    // restore every link waits for an owner to say it still stands (A55).
    roles: ['owner'],
    refusal: 'Only an owner can turn things back on after a restore.',
  },
  'document.purge': {
    // Nothing empties the Trash by itself (D1): removing a mistaken upload
    // for good is an owner's decision, and somebody else's document waits
    // a day for whoever filed it to bring it back.
    roles: ['owner'],
    refusal: 'Only an owner can remove a document for good.',
  },
  'identity.audience': {
    // Every adult's passport number in front of every other adult, or the
    // teens: the owners' decision, made with two-step sign-in (A54), and
    // never at once when it widens (A34).
    roles: ['owner'],
    refusal: 'Only an owner can change who sees identity details.',
  },
  'member.suspend': {
    // Only owners lock (A52), and one owner cannot lock out another (A50):
    // that would be a weapon against a spouse, as taking the owner role
    // away at once would be (co-owners.ts).
    roles: ['owner'],
    refusal: "Only an owner can lock or unlock someone's sign-in.",
  },
  'member.reset_password': {
    // An owner, for somebody who is not one (A50): mailed to their own
    // address, handed over only when they keep nothing private, and
    // otherwise left to whoever runs the server (D5).
    roles: ['owner'],
    refusal: "Only an owner can start a reset of someone's password.",
  },
  'member.sign_out': {
    // Signing a person out of every device is the owners' (A53), as locking
    // is (A52): for a lost phone, or a password somebody else has.
    roles: ['owner'],
    refusal: 'Only an owner can sign someone out everywhere.',
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

/**
 * How much of the family's documents a role sees, for comparing two: the
 * adults' documents (owners and adults), the family's (teens), or only what
 * is given (viewers).
 */
const SIGHT: Record<Role, number> = { owner: 2, adult: 2, teen: 1, viewer: 0 };

/**
 * Whether a change of role takes sight away (5.30): an owner or an adult
 * made a teen or a viewer, anybody made a viewer. An owner made an adult
 * sees what they saw.
 */
export function reducesSight(from: Role, to: Role): boolean {
  return SIGHT[to] < SIGHT[from];
}

/**
 * What a change of role does besides the role (5.30), said before it is
 * made and answered once it is (`RoleChangeResult.effects`):
 *
 *  - `offline_ended`: sight taken away, so the Essentials their phones keep
 *    go — each phone is given an empty set at its next sync;
 *  - `requests_closed`: no longer an adult, so their requests to send
 *    documents close (A39), and what was sent for them alone to review goes
 *    to the owners (5.23);
 *  - `exports_ended`: no longer seeing the adults' documents, so their
 *    exports stop being downloadable. (One that showed identity details
 *    they no longer see ends too, which only the vault can tell.)
 *
 * Treat a kind never heard of as something it did.
 */
export type RoleChangeEffect = 'offline_ended' | 'requests_closed' | 'exports_ended';

export function roleChangeEffects(from: Role, to: Role): RoleChangeEffect[] {
  const effects: RoleChangeEffect[] = [];
  if (reducesSight(from, to)) effects.push('offline_ended');
  if (can(from, 'upload_request.create') && !can(to, 'upload_request.create')) {
    effects.push('requests_closed');
  }
  if (can(from, 'document.see_adults') && !can(to, 'document.see_adults')) {
    effects.push('exports_ended');
  }
  return effects;
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
 *
 * `seesAdults` is the one answer to "may they see Adults only documents"
 * (5.32): worked out once for each sign-in by `seesAdults()`, and handed to
 * this and to every SQL copy. Without it, the role's own answer.
 */
export function canSee(
  viewer: { role: Role; memberId: string | null; seesAdults?: boolean },
  doc: { visibility: string; owner_member_id: string | null },
): boolean {
  switch (doc.visibility) {
    case 'household':
      return true;
    case 'adults':
      return viewer.seesAdults ?? can(viewer.role, 'document.see_adults');
    case 'private':
      return viewer.memberId !== null && doc.owner_member_id === viewer.memberId;
    default:
      return false;
  }
}

/** What of a restriction decides whether it lets its viewer see Adults only documents. */
export interface AdultsGrant {
  include_adults_only: boolean;
  expires_at: Date | string | null;
}

/**
 * Whether somebody may see documents marked Adults only (5.32, D6): their
 * role's `document.see_adults`, or a viewer whose restriction an owner has
 * let include them, while it lasts. Worked out once for each sign-in, in
 * `authenticate()` and for each person the worker writes to, and handed to
 * `canSee` and every SQL copy of it: widening the copies one at a time is
 * how the digest leaked before.
 *
 * An unrestricted viewer never sees them. A restriction adds nothing else —
 * the database narrows to its grant — and one left on somebody of another
 * role (their sign-in given back as a teen) gives them nothing: restrictions
 * are for viewers (A58), and a teen sees Adults only documents under no rule.
 */
export function seesAdults(
  role: Role,
  restriction: AdultsGrant | null | undefined,
  now: number = Date.now(),
): boolean {
  if (can(role, 'document.see_adults')) return true;
  if (!restrictionMayWiden(role) || restriction?.include_adults_only !== true) return false;
  return restriction.expires_at === null || new Date(restriction.expires_at).getTime() > now;
}

/**
 * Whether a restriction can let somebody of this role see Adults only
 * documents (D6): a viewer's alone (A58). Everybody else's answer is their
 * role's, so nothing about a restriction need be read for them.
 */
export function restrictionMayWiden(role: Role): boolean {
  return role === 'viewer';
}

/**
 * Whether somebody of this role reads other people's shared identity
 * details under the household's audience (A34): owners always; adults once
 * it is `adults` or `family`; teens once it is `family`; viewers, and any
 * role or audience never heard of, never. The database's own copy is
 * identity_audience_sees (0050); visibility-rule.test.ts holds them equal.
 */
export function identityAudienceSees(audience: string, role: Role): boolean {
  switch (role) {
    case 'owner':
      return audience === 'owners_and_self' || audience === 'adults' || audience === 'family';
    case 'adult':
      return audience === 'adults' || audience === 'family';
    case 'teen':
      return audience === 'family';
    default:
      return false;
  }
}

/**
 * Whether someone may see a person's identity details (5.26), under the
 * household's audience — a part of them, the shared one unless said:
 *
 *  - the person themselves: always, both parts;
 *  - owners: every shared part, and never another person's Only me (A33);
 *  - adults, once the audience is `adults`; teens, once it is `family`:
 *    every shared part;
 *  - viewers (and guests, 5.34): only their own record.
 *
 * The person themselves is the only reader of an Only me part, whoever
 * else asks. The API asks this of a record before it says the record is
 * there; anybody it refuses is told there is nothing (404).
 */
export function canSeeIdentity(
  viewer: { role: Role; memberId: string | null },
  subject: { id: string },
  audience: string,
  part: 'shared' | 'only_me' = 'shared',
): boolean {
  if (viewer.memberId !== null && viewer.memberId === subject.id) return true;
  if (part !== 'shared') return false;
  return identityAudienceSees(audience, viewer.role);
}

/**
 * Whether someone may change a part of a person's identity details (5.26):
 * the person, both parts of their own — an owner, an adult or a teen; a
 * viewer changes nothing — and an owner, the shared part of anybody's.
 * Nobody else, and nobody another person's Only me part. The database's
 * own copy is member_identity's writer rule (0050).
 */
export function canEditIdentity(
  viewer: { role: Role; memberId: string | null },
  subject: { id: string },
  part: 'shared' | 'only_me',
): boolean {
  const self = viewer.memberId !== null && viewer.memberId === subject.id;
  switch (viewer.role) {
    case 'owner':
      return self || part === 'shared';
    case 'adult':
    case 'teen':
      return self;
    default:
      return false;
  }
}

/** Said to whoever may see a person's identity details and not change them (5.26). */
export const IDENTITY_EDIT_REFUSAL =
  'Only the person themselves, or an owner, can change these identity details.';

/** Said to whoever tries to move somebody else's document into, or out of, Only me. */
export const PRIVATE_OWNER_ONLY =
  'Only the person a document belongs to can make it private, or un-private it.';

/** Said to a teen who asks to make a document they filed Adults only (A72). */
export const TEEN_NOT_ADULTS_ONLY =
  'Adults only would hide it from you too. You can make the documents you filed Only me or Everyone.';

type Visibility = 'household' | 'adults' | 'private';
const VISIBILITIES: readonly Visibility[] = ['household', 'adults', 'private'];

/**
 * Who is asking to change who sees a document: their role; whether the
 * document belongs to them (`owner_member_id` is their member); and
 * whether they filed it (`created_by` is their account; `filed_by_me` on
 * the wire).
 */
export interface VisibilityAsker {
  role: Role;
  mine: boolean;
  filedByMe: boolean;
}

/**
 * Whether someone may change who sees a document, from `from` to `to`:
 * null if they may, else the sentence that refuses it. The API asks the
 * rows it holds; the web asks what it may offer (`visibilityChoices`).
 *
 *  - Owners and adults: `document.visibility`, as always; Only me, into it
 *    or out of it, only on their own.
 *  - A teen (A72, 5.17c): their own documents that they filed, between
 *    Only me and Everyone, and nothing else. Not Adults only, which would
 *    hide it from them too; not anybody else's; and not one an owner or
 *    adult filed for them, which made Only me the family would lose with
 *    no trace (the 5.17c review).
 *  - Viewers: never.
 *
 * A document the caller cannot see is not asked about: it is not there.
 */
export function visibilityRefusal(
  who: VisibilityAsker,
  from: Visibility,
  to: Visibility,
): string | null {
  if (who.role === 'teen') {
    if (!who.mine || !who.filedByMe) return refusalFor('document.visibility');
    if (to === 'adults') return TEEN_NOT_ADULTS_ONLY;
    if (from === 'adults') return refusalFor('document.visibility');
    return null;
  }
  if (!can(who.role, 'document.visibility')) return refusalFor('document.visibility');
  if ((from === 'private' || to === 'private') && !who.mine) return PRIVATE_OWNER_ONLY;
  return null;
}

/**
 * Whether this role could ever change who sees a document: asked before a
 * document is looked up, so a viewer is refused as they always were. A
 * teen may, on the ones they filed; which, the document says.
 */
export function mayChangeVisibilityAtAll(role: Role): boolean {
  return can(role, 'document.visibility') || role === 'teen';
}

/**
 * What a screen offers for who sees a document now `current`: the choices
 * `visibilityRefusal` allows, in the usual order, or none when there is
 * nothing to change it to. A teen, on their own that they filed, gets
 * Everyone and Only me.
 */
export function visibilityChoices(who: VisibilityAsker, current: Visibility): Visibility[] {
  const allowed = VISIBILITIES.filter((to) => visibilityRefusal(who, current, to) === null);
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

/** Said to whoever may not change somebody's details, who may (A66, 5.25). */
export const DETAILS_REFUSAL =
  'Only an owner or the person themselves can change these details. For someone without a sign-in, any adult can.';

/** Said to anybody but an owner who would record that somebody has passed away (5.25). */
export const DECEASED_REFUSAL = 'Only an owner can record that someone has passed away.';

/**
 * Said to an owner who would record that somebody still signing in has
 * passed away (5.25): their sign-in goes first, so that nobody signs in as
 * them afterwards.
 */
export const DECEASED_SIGNED_IN = (name: string) =>
  `${name} can still sign in. Take their sign-in away first, then record that they have passed away.`;

/**
 * Said to whoever would give a sign-in to somebody recorded as passed away
 * (5.25): an invitation made or accepted, a sign-in given back.
 */
export const DECEASED_NO_SIGN_IN = (name: string) =>
  `${name} is recorded as having passed away, so they can't be given a sign-in.`;

/**
 * Whether someone may change a person's details (5.25): their name, date of
 * birth and relationship. Whose, as a photo's, is `canChangePerson` (A66);
 * that somebody has passed away, an owner's alone (`DECEASED_REFUSAL`).
 */
export function canChangeDetails(
  viewer: { role: Role; memberId: string | null },
  person: { id: string; role: Role | null },
): boolean {
  return can(viewer.role, 'member.edit') && canChangePerson(viewer, person);
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
