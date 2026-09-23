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
  | 'audit.read';

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
