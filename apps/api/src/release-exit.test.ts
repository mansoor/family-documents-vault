import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  EnvKeyProvider,
  itemProposalsBinding,
  itemTextBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, Tokens } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceKeyHash } from './devices/service.js';
import { alertsSent, createHarness, mailSent, TEST_MASTER, type Harness } from './test-harness.js';

/**
 * The release's exit test: every door, attacked together. Written for the
 * Phase 5 exit (5.41, as phase5-exit.test.ts), and the gate of every
 * release since: for 0.7.0 (the Phase 6 exit) it holds the batches, the
 * review queue, the learned rules and the Documents table's sorts and
 * filters to the same rules, with their planted secrets; for 0.8.0 (the
 * 0.8.0 exit) the scanner folder, email in, a paired computer and its key,
 * the folder a file came from, and duplicates and renewals as versions.
 *
 * Phase 5 added kinds of caller the vault never had — a restricted viewer,
 * a guest, somebody holding a share link, somebody sending files to a
 * request — and owner powers a phished password must not give. Each
 * iteration tested its own doors. This file tries every route the API
 * answers, read from Fastify's own route table when it runs, as each of
 * them in turn, and holds each to the rule written for that route below.
 * A route added later with no rule here fails it.
 *
 * The attackers: a restricted viewer; a guest, a guest whose sign-in has
 * ended and a guest whose restriction row is gone; a share link's
 * recipient and a request's sender, each with only their cookie; a locked
 * member with the tokens they had; an owner with only a password; and an
 * adult after another adult's Only me documents, collection, notes,
 * details, identity and pages. Each asks every route for what is not
 * theirs, and is held to its rule: a stale sign-in or a cookie alone is
 * told to sign in; a role the route is not for is refused; somebody else's
 * thing is refused unless the rule says why it is theirs to act on; an
 * owner power asks a password-only owner for two-step sign-in; nothing
 * answers 500; and no answer, refused or not, carries anything planted
 * that the attacker may not see.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

/** What is planted, and must reach nobody it is not for. */
const PASSPORT = 'X9F2K7Q41';
const LICENCE = 'KHANA7712049ZZ';
const NOTE = 'The spare key is under the blue flowerpot by the shed.';
const DETAIL = 'VIN-SECRET-7741-QX';
const PAGE_WORD = 'zanzibarquokka';
const PAGE_TEXT = `Registration certificate\nKeeper AHMED KHAN\n${PAGE_WORD} motorcycle\nVIN ${DETAIL}`;

/**
 * Where a paper original is kept: the household's alone (5.41, the owner's
 * decision of 6 Oct 2026). On documents a viewer, a guest and a link's
 * recipient do see.
 */
const LOCATION = 'Bedroom safe, top shelf, behind the shoebox';

/** An issuer the vault learned from Ahmed's corrections (Phase 6, I4): his rules alone. */
const AHMED_LEARNED = 'ahmed learned issuer 541';

/**
 * A tag on Ahmed's Only me document, and one among his batch's defaults
 * (the Phase 6 exit): the Documents table filters by tag, and a search hit
 * gives a document's tags (0.7.0-dev.13), so neither may reach anybody else.
 */
const AHMED_TAG = 'ahmed-private-tag-541';

/**
 * A detail tag on the same Only me document (0.9.0, T1): its label and its
 * value, each a secret of his. Tags are renamed, merged and deleted across
 * documents, filtered by a label, offered as somebody types and counted:
 * none of it may reach anybody else, an owner included, nor change it.
 */
const AHMED_LABEL = 'ahmed locker 541';
const AHMED_VALUE = 'ahmed-locker-value-541';
const AHMED_DETAIL_TAG = `${AHMED_LABEL}: ${AHMED_VALUE}`;

/** Ahmed's computer (0.8.0, D1): his, and the owners' to see by name; nobody else's. */
const AHMED_COMPUTER = 'ahmed-computer-541';
const BATCH_TAG = 'ahmed-batch-tag-541';

/**
 * The Documents table's sorts and filters (R2), each asked of every route
 * sweep's attacker: a different query from the older list's, read and
 * ordered by the caller's own rules. Its victims are the fill's collection
 * and person.
 */
const TABLE_QUERIES = (f: Fill): string[] => [
  '',
  'sort=title&limit=200',
  'sort=title&direction=desc&limit=200',
  'sort=status&limit=200',
  'sort=collections&limit=200',
  'sort=visibility&limit=200',
  'sort=person&member_id=none',
  'sort=location&limit=200',
  `sort=title&location=${encodeURIComponent(LOCATION)}`,
  `sort=title&tag=${AHMED_TAG}`,
  `sort=title&tag=${BATCH_TAG}`,
  // A detail tag whatever its case, and its label alone (0.9.0, T1).
  `sort=title&tag=${encodeURIComponent(AHMED_DETAIL_TAG.toUpperCase())}`,
  `sort=title&tag_label=${encodeURIComponent(AHMED_LABEL)}`,
  `tag_label=${encodeURIComponent(AHMED_LABEL)}`,
  `tag=${encodeURIComponent(AHMED_DETAIL_TAG)}`,
  `sort=title&collection_id=${f.collection}`,
  'sort=title&collection_id=none',
  `sort=expires&member_id=${f.member}`,
  'sort=title&status=expired',
];

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

// ------------------------------------------------------------- the rules

/** Who a route is for. */
type Who =
  /** Anybody, signed in or not: the allow-list of public routes. */
  | 'public'
  /** Whoever holds a share link's session (its cookie), and nobody else. */
  | 'link'
  /** Whoever holds an upload request's session (its cookie), and nobody else. */
  | 'drop'
  /** Anybody signed in: a viewer, limited or not, and a guest too. */
  | 'signedIn'
  /** Owners, adults and teens: never a viewer or a guest. */
  | 'family'
  /** Owners and adults. */
  | 'adults'
  /** Owners. */
  | 'owners'
  /** Owners with two-step sign-in or a passkey (A54): never one with only a password. */
  | 'ownerPower'
  /**
   * Whoever holds a computer's key (0.8.0, D1), and nobody else: no
   * attacker holds one, so every one is told to sign in (401), a sign-in
   * as much as a cookie.
   */
  | 'device';

/** The attackers. */
type Attacker =
  | 'restrictedViewer'
  | 'guest'
  | 'endedGuest'
  | 'guestWithNoRow'
  | 'linkRecipient'
  | 'uploadSender'
  | 'lockedMember'
  | 'passwordOnlyOwner'
  | 'otherAdult';

/** What a route's parameter names: the kind of thing, and so whose it is. */
type Kind =
  | 'document'
  | 'version'
  | 'collection'
  | 'member'
  | 'photo'
  | 'share'
  | 'uploadRequest'
  | 'incoming'
  | 'reminder'
  | 'export'
  | 'vault'
  | 'device'
  | 'ownerChange'
  | 'invitation'
  | 'invitationToken'
  | 'session'
  | 'passkey'
  | 'typeKey'
  | 'suggestionKey'
  | 'shareToken'
  | 'resetToken'
  | 'uploadKey'
  | 'dropFile'
  | 'dropToken'
  | 'page'
  /** Not a parameter: another account's push address, sent in a body. */
  | 'deviceEndpoint'
  /** A batch of many documents, and a file in it (Phase 6, I1): their uploader's alone. */
  | 'batch'
  | 'batchItem'
  /** A note that the scanner folder could not add a file (S3): its person's alone. */
  | 'watchNotice'
  /** A computer that sends scans (0.8.0, D1): its person's, and an owner's to revoke. */
  | 'pairedDevice'
  /** Not a parameter: another person's code to confirm their address for email in (S4), sent in a body. */
  | 'mailInCode';

/** The ids one request is made with: the thing of each kind the attacker is after. */
type Fill = Record<Kind, string>;

/**
 * A parameter's kind, by the segment before it: a route whose parameter is
 * not here fails the sweep until it is said what it names.
 */
const PARAM_KINDS: Record<string, Kind> = {
  'documents/:id': 'document',
  'versions/:id': 'version',
  'collections/:id': 'collection',
  'items/:documentId': 'document',
  'items/:doc': 'document',
  'members/:id': 'member',
  'photo/:photoId': 'photo',
  'shares/:id': 'share',
  'upload-requests/:id': 'uploadRequest',
  'incoming/:id': 'incoming',
  'reminders/:id': 'reminder',
  // Somebody turned 13 (0066): an owner's reminder about a person.
  'people/:id': 'reminder',
  'exports/:id': 'export',
  'vaults/:id': 'vault',
  'devices/:id': 'device',
  'owner-changes/:id': 'ownerChange',
  'invitations/:id': 'invitation',
  'invitations/:token': 'invitationToken',
  'sessions/:id': 'session',
  'passkeys/:id': 'passkey',
  'document-types/:key': 'typeKey',
  'suggestions/:key': 'suggestionKey',
  'shared/:token': 'shareToken',
  'password-resets/:token': 'resetToken',
  'uploads/:key': 'uploadKey',
  'pages/:version': 'version',
  'files/:id': 'dropFile',
  'batches/:id': 'batch',
  'items/:itemId': 'batchItem',
  'notices/:id': 'watchNotice',
  'paired-devices/:id': 'pairedDevice',
};

/** The kinds that name a thing of somebody's: another's id here is refused unless the rule says. */
const OBJECT_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'document',
  'version',
  'collection',
  'member',
  'photo',
  'share',
  'uploadRequest',
  'incoming',
  'reminder',
  'export',
  'vault',
  'device',
  'ownerChange',
  'invitation',
  'session',
  'passkey',
  'typeKey',
  'suggestionKey',
  'uploadKey',
  'dropFile',
  'batch',
  'batchItem',
  'watchNotice',
  'pairedDevice',
]);

interface Rule {
  who: Who;
  body?: (f: Fill) => unknown;
  /** Several bodies, each tried: for a route whose refusal depends on what is asked. */
  bodies?: (f: Fill) => unknown[];
  query?: (f: Fill) => string;
  /** Several queries, each tried: for a route that answers differently by what is asked. */
  queries?: (f: Fill) => string[];
  /** A multipart upload: a PDF, or a photo. */
  file?: 'pdf' | 'photo';
  /** It ends or changes the caller: tried after everything else. */
  last?: true;
  /** Attackers for whom another's id here is theirs to act on, and why. */
  theirs?: Partial<Record<Attacker, string>>;
  /** Attackers who do not try it, and why. */
  skip?: Partial<Record<Attacker, string>>;
  /**
   * Attackers whose victims here are others than their usual ones: by kind,
   * names of the fixture's ids (`ids[name]`).
   */
  victims?: Partial<Record<Attacker, Partial<Record<Kind, string[]>>>>;
}

/** What a route says to a caller whose sign-in no longer works. */
const SIGN_IN_AGAIN: ReadonlySet<string> = new Set(['unauthenticated', 'session_ended']);

const PHOTO_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const IS_DAY = '2031-01-01';
const NOBODY = 'nobody-541@example.test';

/**
 * An owner's power from before Phase 5 over somebody else, asked with any
 * credential (SEC-17); A54 moved only the new powers behind two-step
 * sign-in. The password-only owner's attack is on those (and on what is
 * Only me), so these, which would change the household the others attack,
 * are left to the tests that own them.
 */
const OLD_OWNER_POWER =
  'an owner power from before Phase 5, asked with any credential (SEC-17), which A54 left as it was';

/**
 * An owner takes a sign-in away and gives it back with any credential
 * (SEC-17): a lock, or a restore's pause, goes with the person and comes
 * back with it (0059), so neither lifts what only an owner power does.
 */
const SIGN_IN_KEEPS_LOCK =
  'an owner takes a sign-in away and gives it back; a lock or a pause comes back with it (0059)';

/** Adults manage the kinds of document the family keeps, owners included (A6). */
const ADULTS_TYPES = {
  otherAdult: 'adults manage the kinds of document (A6)',
  passwordOnlyOwner: 'adults manage the kinds of document (A6)',
} as const;
/** The household's own suggestions (what it is missing) are the family's to dismiss. */
const FAMILY_SUGGESTIONS = {
  otherAdult: 'the household’s suggestions are the family’s',
  passwordOnlyOwner: 'the household’s suggestions are the family’s',
} as const;
/** Owners read and write everybody's shared identity part, masked (A33); never an Only me part. */
const OWNERS_SHARED_IDENTITY =
  "owners read everybody's shared part, its numbers masked (A33); never an Only me part";

/**
 * Every route's rule. A route the router has and this does not fails the
 * sweep; so does a rule for a route the router no longer has.
 */
const RULES: Record<string, Rule> = {
  // The public allow-list: what anybody may call, signed in or not.
  'GET /healthz': { who: 'public' },
  'GET /readyz': { who: 'public' },
  'GET /api/v1/capabilities': { who: 'public' },
  'GET /api/v1/notifications/push-key': { who: 'public' },
  'POST /api/v1/setup': {
    who: 'public',
    body: () => ({
      household_name: 'Taken over',
      display_name: 'Attacker',
      email: NOBODY,
      password: 'a long attacker password',
    }),
  },
  'POST /api/v1/auth/password': {
    who: 'public',
    body: () => ({ email: NOBODY, password: 'not anybody’s password' }),
  },
  'POST /api/v1/auth/mfa': { who: 'public', body: () => ({ mfa_token: 'x', code: '000000' }) },
  'POST /api/v1/auth/refresh': { who: 'public', body: () => ({ refresh_token: 'not-one' }) },
  'POST /api/v1/auth/passkey/challenge': { who: 'public', body: () => ({}) },
  'POST /api/v1/auth/passkey/verify': {
    who: 'public',
    bodies: () => [{ response: {} }, { response: { id: 'AAAA', response: {} } }],
  },
  'POST /api/v1/auth/password/forgot': { who: 'public', body: () => ({ email: NOBODY }) },
  'POST /api/v1/password-resets/lookup': {
    who: 'public',
    body: (f) => ({ token: f.resetToken }),
  },
  'POST /api/v1/password-resets/complete': {
    who: 'public',
    body: (f) => ({ token: f.resetToken, password: 'a long attacker password' }),
  },
  'GET /api/v1/password-resets/:token': { who: 'public' },
  'POST /api/v1/password-resets/:token': {
    who: 'public',
    body: () => ({ password: 'a long attacker password' }),
  },
  'POST /api/v1/invitations/lookup': {
    who: 'public',
    body: (f) => ({ token: f.invitationToken }),
  },
  'POST /api/v1/invitations/accept': {
    who: 'public',
    body: (f) => ({ token: f.invitationToken, code: '000000', password: 'a long password' }),
  },
  'GET /api/v1/invitations/:token': { who: 'public' },
  'POST /api/v1/invitations/:token/accept': {
    who: 'public',
    body: () => ({ code: '000000', password: 'a long password' }),
  },
  'POST /api/v1/shared/preview': { who: 'public', body: (f) => ({ token: f.shareToken }) },
  'POST /api/v1/shared/code': { who: 'public', body: (f) => ({ token: f.shareToken }) },
  'POST /api/v1/shared/unlock': { who: 'public', body: (f) => ({ token: f.shareToken }) },
  // The old routes (A25): they answer only links made before 5.16.
  'GET /api/v1/shared/:token': { who: 'public' },
  'POST /api/v1/shared/:token/open': { who: 'public', body: () => ({}) },
  'GET /api/v1/shared/:token/content': { who: 'public' },
  'POST /api/v1/drop/preview': { who: 'public', body: (f) => ({ token: f.dropToken }) },
  'POST /api/v1/drop/code': { who: 'public', body: (f) => ({ token: f.dropToken }) },
  'POST /api/v1/drop/unlock': { who: 'public', body: (f) => ({ token: f.dropToken }) },

  // Inside a share link's session.
  'GET /api/v1/shared/items': { who: 'link' },
  'GET /api/v1/shared/items/:doc/content': { who: 'link' },
  'GET /api/v1/shared/items/:doc/pages/:n': { who: 'link' },

  // Inside an upload request's session.
  'GET /api/v1/drop/session': { who: 'drop' },
  'POST /api/v1/drop/files': { who: 'drop', file: 'pdf' },
  'DELETE /api/v1/drop/files/:id': { who: 'drop' },
  'POST /api/v1/drop/finish': { who: 'drop', body: () => ({}), last: true },

  // One's own sign-in.
  'GET /api/v1/me': { who: 'signedIn' },
  'DELETE /api/v1/me/reset-notice': { who: 'signedIn' },
  'GET /api/v1/auth/sessions': { who: 'signedIn' },
  'DELETE /api/v1/auth/sessions/:id': { who: 'signedIn' },
  'GET /api/v1/auth/step-up': { who: 'signedIn' },
  'POST /api/v1/auth/step-up': {
    who: 'signedIn',
    bodies: () => [{ password: 'wrong password' }, { code: '000000' }, { passkey: {} }],
  },
  'GET /api/v1/auth/passkeys': { who: 'signedIn' },
  'POST /api/v1/auth/passkeys/challenge': { who: 'signedIn', body: () => ({}) },
  'POST /api/v1/auth/passkeys': { who: 'signedIn', body: () => ({ response: {} }) },
  'DELETE /api/v1/auth/passkeys/:id': { who: 'signedIn' },
  'POST /api/v1/auth/totp/enrol': { who: 'signedIn', body: () => ({}) },
  'POST /api/v1/auth/totp/confirm': { who: 'signedIn', body: () => ({ code: '000000' }) },
  'POST /api/v1/auth/totp/disable': { who: 'signedIn', body: () => ({ code: '000000' }) },
  'POST /api/v1/auth/password/change': {
    who: 'signedIn',
    body: () => ({ current_password: 'wrong password', new_password: 'a long attacker password' }),
  },
  'POST /api/v1/auth/logout': { who: 'signedIn', body: () => ({}), last: true },

  // Documents.
  // The older list, and the Documents table's every sort and filter (R2).
  'GET /api/v1/documents': { who: 'signedIn', queries: TABLE_QUERIES },
  'POST /api/v1/documents': {
    who: 'family',
    body: (f) => ({ title: 'Attacker’s document', owner_member_id: f.member }),
  },
  'GET /api/v1/documents/counts': { who: 'signedIn' },
  'GET /api/v1/documents/:id': { who: 'signedIn' },
  'PATCH /api/v1/documents/:id': {
    who: 'signedIn',
    body: () => ({ title: 'Changed by an attacker', notes: 'Changed by an attacker' }),
  },
  'DELETE /api/v1/documents/:id': { who: 'signedIn' },
  'GET /api/v1/documents/:id/collections': { who: 'signedIn' },
  'GET /api/v1/documents/:id/issuer-suggestions': { who: 'signedIn' },
  'GET /api/v1/documents/:id/suggestions': { who: 'family' },
  'POST /api/v1/documents/:id/share': { who: 'adults', body: () => ({ permission: 'download' }) },
  'POST /api/v1/documents/:id/visibility': {
    who: 'adults',
    body: () => ({ visibility: 'household' }),
  },
  'GET /api/v1/documents/:id/versions': { who: 'signedIn' },
  'POST /api/v1/documents/:id/versions': { who: 'family', file: 'pdf' },
  'POST /api/v1/documents/:id/restore': { who: 'family', body: () => ({}) },
  'POST /api/v1/documents/:id/purge': { who: 'owners', body: () => ({}) },
  'GET /api/v1/versions/:id/thumbnail': { who: 'signedIn' },
  'GET /api/v1/versions/:id/pages/:n': { who: 'signedIn' },
  'GET /api/v1/versions/:id/content': { who: 'signedIn' },
  'POST /api/v1/capture': { who: 'family', file: 'pdf' },
  'GET /api/v1/uploads/:key': { who: 'signedIn' },
  // A hit gives its document's tags and expiry (0.7.0-dev.13).
  'GET /api/v1/search': {
    who: 'signedIn',
    queries: () => [
      `q=${PAGE_WORD}`,
      `q=${AHMED_TAG}`,
      'q=ahmed',
      `q=${encodeURIComponent(AHMED_VALUE)}`,
      `q=${encodeURIComponent(AHMED_LABEL)}`,
    ],
  },
  'GET /api/v1/search/sealed': {
    who: 'signedIn',
    queries: () => [`token=${PAGE_WORD}`, `token=${AHMED_TAG}`],
  },
  // The list of tags counts, and offers as somebody types, only what the
  // caller can see (0.9.0, T1): after "ahmed locker 541: ", never his value.
  'GET /api/v1/tags': {
    who: 'signedIn',
    queries: () => [
      '',
      'q=ahmed',
      'limit=1000',
      `q=${encodeURIComponent(`${AHMED_LABEL}: `)}`,
      `q=${encodeURIComponent(AHMED_LABEL.toUpperCase())}`,
    ],
  },
  // A tag renamed, merged or deleted (0.9.0, T1): on what the caller may
  // change, and only that — his Only me document's tags neither changed
  // (checked after the sweep) nor told of: renamed into one of them is no
  // merge to ask about, and no count says they are there.
  'POST /api/v1/tags/rename': {
    who: 'family',
    bodies: () => [
      { from: AHMED_TAG, to: 'stolen-541' },
      { from: AHMED_DETAIL_TAG, to: 'stolen-541', merge: true },
      { from: 'nothing-of-theirs-541', to: AHMED_TAG },
      { from: 'nothing-of-theirs-541', to: AHMED_DETAIL_TAG.toUpperCase() },
    ],
  },
  'POST /api/v1/tags/delete': {
    who: 'family',
    bodies: () => [{ tag: AHMED_TAG }, { tag: AHMED_DETAIL_TAG }, { tag: AHMED_LABEL }],
  },
  'GET /api/v1/issuers': { who: 'signedIn' },
  'GET /api/v1/document-types': { who: 'signedIn' },
  'GET /api/v1/document-attributes': { who: 'signedIn' },

  // Kinds of document (A6): the adults'.
  'POST /api/v1/document-types': {
    who: 'adults',
    body: () => ({ label: 'Attacker kind', category: 'other' }),
  },
  'PATCH /api/v1/document-types/:key': {
    who: 'adults',
    body: () => ({ label: 'Renamed' }),
    theirs: ADULTS_TYPES,
  },
  'POST /api/v1/document-types/:key/archive': {
    who: 'adults',
    body: () => ({}),
    theirs: ADULTS_TYPES,
  },
  'POST /api/v1/document-types/:key/restore': {
    who: 'adults',
    body: () => ({}),
    theirs: ADULTS_TYPES,
  },
  'DELETE /api/v1/document-types/:key': { who: 'adults', theirs: ADULTS_TYPES },
  'GET /api/v1/document-types/:key/impact': { who: 'adults', theirs: ADULTS_TYPES },
  'POST /api/v1/document-attributes': {
    who: 'adults',
    body: () => ({ label: 'Attacker field', kind: 'text' }),
  },

  // Collections.
  'GET /api/v1/collections': { who: 'signedIn' },
  'POST /api/v1/collections': {
    who: 'family',
    body: () => ({ name: 'Attacker’s collection', audience: 'everyone' }),
  },
  'GET /api/v1/collections/:id': { who: 'signedIn' },
  'PATCH /api/v1/collections/:id': { who: 'family', body: () => ({ audience: 'everyone' }) },
  'DELETE /api/v1/collections/:id': { who: 'signedIn' },
  'POST /api/v1/collections/:id/items': {
    who: 'family',
    body: (f) => ({ document_ids: [f.document] }),
  },
  'DELETE /api/v1/collections/:id/items/:documentId': { who: 'family' },
  'GET /api/v1/collections/:id/share-preview': { who: 'adults' },
  'POST /api/v1/collections/:id/shares': {
    who: 'adults',
    body: (f) => ({ document_ids: [f.document], follow_collection: false }),
  },

  // Links, and what a restore paused.
  'GET /api/v1/shares': { who: 'signedIn' },
  'DELETE /api/v1/shares/:id': {
    who: 'signedIn',
    theirs: {
      otherAdult:
        'whoever may share and sees every document a collection’s link was made with may take it back (5.19)',
      passwordOnlyOwner: 'an owner may take back any link the family made (5.19)',
    },
  },
  'POST /api/v1/shares/:id/resume': { who: 'owners', body: () => ({}) },
  'GET /api/v1/after-restore': { who: 'signedIn' },

  // Reminders.
  'GET /api/v1/reminders': { who: 'signedIn' },
  'POST /api/v1/reminders': {
    who: 'family',
    body: (f) => ({ document_id: f.document, fire_at: IS_DAY }),
  },
  'POST /api/v1/reminders/:id/snooze': { who: 'family', body: () => ({ until: IS_DAY }) },
  'POST /api/v1/reminders/:id/acknowledge': { who: 'family', body: () => ({}) },
  'DELETE /api/v1/reminders/:id': { who: 'family' },
  // Somebody turned 13 (0066, after 0.7.0): the owners' alone.
  'GET /api/v1/reminders/people': { who: 'owners' },
  'POST /api/v1/reminders/people/:id/dismiss': { who: 'owners', body: () => ({}) },

  // The household's suggestions (what is missing), not a document's.
  'GET /api/v1/suggestions': { who: 'signedIn' },
  'POST /api/v1/suggestions/:key/dismiss': {
    who: 'family',
    body: () => ({}),
    theirs: FAMILY_SUGGESTIONS,
  },
  'DELETE /api/v1/suggestions/:key/dismiss': { who: 'family', theirs: FAMILY_SUGGESTIONS },

  // People.
  'GET /api/v1/profile': { who: 'signedIn' },
  'PUT /api/v1/profile': { who: 'adults', body: () => ({ has_pets: true }) },
  'GET /api/v1/members': { who: 'signedIn' },
  'POST /api/v1/members': { who: 'adults', body: () => ({ display_name: 'Attacker’s person' }) },
  'PATCH /api/v1/members/:id': {
    who: 'family',
    body: () => ({ display_name: 'Renamed by an attacker' }),
    skip: { passwordOnlyOwner: OLD_OWNER_POWER },
  },
  'DELETE /api/v1/members/:id': { who: 'owners', skip: { passwordOnlyOwner: OLD_OWNER_POWER } },
  'GET /api/v1/members/:id/account': { who: 'ownerPower' },
  'POST /api/v1/members/:id/role': {
    who: 'owners',
    body: () => ({ role: 'viewer' }),
    skip: { passwordOnlyOwner: OLD_OWNER_POWER },
  },
  'POST /api/v1/me/step-down': { who: 'owners', body: () => ({ role: 'adult' }), last: true },
  // An owner takes a sign-in away, and gives it back, with any credential:
  // the password-only owner tries both on somebody locked and somebody paused
  // after a restore — given back last, after the taking away — and they stay
  // so (0059; asserted after the sweep).
  'DELETE /api/v1/members/:id/sign-in': {
    who: 'owners',
    victims: { passwordOnlyOwner: { member: ['kemalMember', 'linaMember'] } },
    theirs: { passwordOnlyOwner: SIGN_IN_KEEPS_LOCK },
  },
  'POST /api/v1/members/:id/sign-in': {
    who: 'owners',
    body: () => ({ role: 'viewer' }),
    last: true,
    victims: { passwordOnlyOwner: { member: ['kemalMember', 'linaMember'] } },
    theirs: { passwordOnlyOwner: SIGN_IN_KEEPS_LOCK },
  },
  'POST /api/v1/members/:id/invite': {
    who: 'adults',
    body: () => ({ email: NOBODY, role: 'adult' }),
    skip: { passwordOnlyOwner: OLD_OWNER_POWER },
  },
  'POST /api/v1/members/:id/renew': {
    who: 'ownerPower',
    body: () => ({ access_expires_at: inDays(300) }),
  },
  'PUT /api/v1/members/:id/access': { who: 'ownerPower', body: () => ({ people: [] }) },
  'DELETE /api/v1/members/:id/access': { who: 'ownerPower' },
  'GET /api/v1/members/:id/access/preview': { who: 'signedIn' },
  'GET /api/v1/access/preview': { who: 'signedIn' },
  'PUT /api/v1/members/:id/photo': {
    who: 'family',
    file: 'photo',
    skip: { passwordOnlyOwner: OLD_OWNER_POWER },
  },
  'DELETE /api/v1/members/:id/photo': {
    who: 'signedIn',
    skip: { passwordOnlyOwner: OLD_OWNER_POWER },
  },
  'GET /api/v1/members/:id/photo/:photoId': { who: 'signedIn' },
  'POST /api/v1/members/:id/lock': { who: 'ownerPower', body: () => ({}) },
  'DELETE /api/v1/members/:id/lock': { who: 'ownerPower' },
  'POST /api/v1/members/:id/resume': { who: 'ownerPower', body: () => ({}) },
  'DELETE /api/v1/members/:id/sessions': { who: 'ownerPower' },
  'POST /api/v1/members/:id/password-reset': {
    who: 'ownerPower',
    body: () => ({ stop_now: true }),
  },

  // Identity (5.26).
  'GET /api/v1/members/:id/identity': {
    who: 'signedIn',
    theirs: { passwordOnlyOwner: OWNERS_SHARED_IDENTITY },
  },
  // Writing another person's is an owner power since the exit's review: the
  // password-only owner is refused it (its own test, below, says how).
  'PUT /api/v1/members/:id/identity': {
    who: 'family',
    bodies: () =>
      (['only_me', 'shared'] as const).map((part) => ({
        part,
        version: 1,
        fields: { ids: [{ id: 'p1', kind: 'passport', number: 'OVERWRITTEN' }] },
      })),
  },
  'POST /api/v1/members/:id/identity/reveal': {
    who: 'signedIn',
    bodies: () => [
      { part: 'only_me', keys: ['ids.p1'] },
      { part: 'shared', keys: ['ids.d1'] },
    ],
  },
  'GET /api/v1/household/identity-audience': { who: 'signedIn' },
  // 5.41: whether Only me documents can be shared outside the family —
  // read by those who may share, an owner power to change (A54).
  'GET /api/v1/household/sharing': { who: 'adults' },
  'PUT /api/v1/household/sharing': {
    who: 'ownerPower',
    body: () => ({ only_me_shareable: true }),
  },
  'PUT /api/v1/household/identity-audience': {
    who: 'ownerPower',
    body: () => ({ audience: 'family' }),
  },

  // Changes of owner.
  'GET /api/v1/owner-changes': { who: 'signedIn' },
  'POST /api/v1/owner-changes/:id/refuse': { who: 'signedIn', body: () => ({}) },
  'POST /api/v1/owner-changes/:id/complete': { who: 'signedIn', body: () => ({}) },
  'DELETE /api/v1/owner-changes/:id': { who: 'signedIn' },

  // Invitations.
  'GET /api/v1/invitations': { who: 'adults' },
  'POST /api/v1/invitations': {
    who: 'adults',
    body: () => ({ display_name: 'Attacker’s friend', email: NOBODY, role: 'adult' }),
  },
  'DELETE /api/v1/invitations/:id': {
    who: 'adults',
    theirs: {
      otherAdult: 'any adult may take back an invitation not yet accepted (member.invite)',
      passwordOnlyOwner: 'any adult may take back an invitation not yet accepted (member.invite)',
    },
  },

  // Where files are kept.
  'GET /api/v1/vaults/providers': { who: 'signedIn' },
  'GET /api/v1/vaults': { who: 'signedIn' },
  'POST /api/v1/vaults': {
    who: 'owners',
    body: () => ({
      provider: 'minio',
      label: 'Attacker’s bucket',
      endpoint: 'https://attacker.example.test',
      bucket: 'b',
      access_key_id: 'a',
      secret_access_key: 'b',
    }),
  },
  'POST /api/v1/vaults/:id/test': {
    who: 'owners',
    body: () => ({}),
    theirs: { passwordOnlyOwner: OLD_OWNER_POWER },
  },
  'POST /api/v1/vaults/:id/activate': {
    who: 'owners',
    body: () => ({}),
    theirs: { passwordOnlyOwner: OLD_OWNER_POWER },
  },
  'DELETE /api/v1/vaults/:id': { who: 'owners', theirs: { passwordOnlyOwner: OLD_OWNER_POWER } },

  // Exports.
  'POST /api/v1/exports': { who: 'adults', body: () => ({}) },
  'GET /api/v1/exports': { who: 'signedIn' },
  'GET /api/v1/exports/:id': { who: 'signedIn' },
  'GET /api/v1/exports/:id/content': { who: 'signedIn' },

  // Notifications and devices.
  'GET /api/v1/notifications/preferences': { who: 'signedIn' },
  'PUT /api/v1/notifications/preferences': {
    who: 'signedIn',
    body: () => ({ daily_email: false }),
  },
  'GET /api/v1/notifications/smtp/providers': { who: 'signedIn' },
  'GET /api/v1/notifications/smtp': { who: 'signedIn' },
  'PUT /api/v1/notifications/smtp': {
    who: 'owners',
    body: () => ({ host: 'smtp.attacker.example.test', from_email: NOBODY }),
  },
  'POST /api/v1/notifications/smtp/test': { who: 'owners', body: () => ({}) },
  'GET /api/v1/devices': { who: 'signedIn' },
  // A new address of one's own; and Ahmed's, which must stay his (E541-02).
  'POST /api/v1/devices': {
    who: 'signedIn',
    bodies: (f) =>
      [`https://ntfy.example.test/attacker${randomUUID().slice(0, 8)}`, f.deviceEndpoint].map(
        (endpoint) => ({ kind: 'unified_push', endpoint, keys: { p256dh: 'p', auth: 'a' } }),
      ),
  },
  'DELETE /api/v1/devices': {
    who: 'signedIn',
    bodies: (f) => [
      { endpoint: 'https://ntfy.example.test/nobody' },
      { endpoint: f.deviceEndpoint },
    ],
  },
  'POST /api/v1/devices/:id/test': { who: 'signedIn', body: () => ({}) },

  // What a phone keeps.
  'POST /api/v1/offline/grant': { who: 'signedIn', body: () => ({ password: 'wrong password' }) },
  'DELETE /api/v1/offline/grant': { who: 'signedIn' },
  'GET /api/v1/offline/essentials': { who: 'signedIn' },
  'GET /api/v1/offline/pages/:version/:n': { who: 'signedIn' },
  'POST /api/v1/offline/opens': {
    who: 'signedIn',
    body: (f) => ({
      events: [
        {
          id: randomUUID(),
          version_id: f.version,
          opened_at: new Date().toISOString(),
          mode: 'view',
          online: false,
        },
      ],
    }),
  },

  // The activity log.
  'GET /api/v1/audit': { who: 'family' },

  // Requests to send documents, and what came in.
  'POST /api/v1/upload-requests': {
    who: 'adults',
    body: () => ({ title: 'Attacker’s request', expires_at: inDays(3) }),
  },
  'GET /api/v1/upload-requests': { who: 'signedIn' },
  'DELETE /api/v1/upload-requests/:id': { who: 'adults' },
  'POST /api/v1/upload-requests/:id/resume': { who: 'owners', body: () => ({}) },
  'GET /api/v1/incoming': { who: 'signedIn' },
  'GET /api/v1/incoming/:id/pages/:n': { who: 'adults' },
  'GET /api/v1/incoming/:id/content': { who: 'adults' },
  'POST /api/v1/incoming/:id/accept': { who: 'adults', body: () => ({}) },
  'POST /api/v1/incoming/:id/reject': { who: 'adults', body: () => ({}) },

  // Many documents at once (Phase 6, I1): whoever adds documents, and a
  // batch and its files their uploader's alone — an owner's too (Q3).
  'POST /api/v1/batches': { who: 'family', body: () => ({ name: 'Attacker’s batch' }) },
  'GET /api/v1/batches': { who: 'family' },
  // How many of the caller's own items wait: theirs alone, an owner's too.
  'GET /api/v1/batches/counts': { who: 'family' },
  'GET /api/v1/batches/:id': { who: 'family' },
  'PATCH /api/v1/batches/:id': { who: 'family', body: () => ({ name: 'Renamed' }) },
  'DELETE /api/v1/batches/:id': { who: 'family' },
  'POST /api/v1/batches/:id/items': { who: 'family', file: 'pdf' },
  'DELETE /api/v1/batches/:id/items/:itemId': { who: 'family' },
  'POST /api/v1/batches/:id/items/:itemId/accept': { who: 'family', body: () => ({}) },
  'GET /api/v1/batches/:id/items/:itemId/pages/:n': { who: 'family' },
  // The review queue (I3): Accept all Ready, named or not, and its Undo —
  // the uploader's alone, as everything of a batch is.
  'POST /api/v1/batches/:id/accept-ready': {
    who: 'family',
    bodies: (f) => [{}, { item_ids: [f.batchItem] }],
  },
  'POST /api/v1/batches/:id/accept-ready/undo': {
    who: 'family',
    body: (f) => ({ item_ids: [f.batchItem] }),
  },
  // What the vault learned from the caller's own corrections (I4): theirs
  // alone, read and forgotten — never anybody else's, an owner's included.
  'GET /api/v1/batches/learned': { who: 'family' },
  'DELETE /api/v1/batches/learned': { who: 'family' },

  // The scanner folder (0.8.0, S3): an owner's setting; and the notes it
  // leaves, each its person's alone — an owner's too.
  'GET /api/v1/watch-folder': { who: 'owners' },
  'PUT /api/v1/watch-folder': { who: 'owners', body: () => ({ enabled: false }) },
  'GET /api/v1/watch-folder/notices': { who: 'family' },
  'POST /api/v1/watch-folder/notices/:id/dismiss': { who: 'family', body: () => ({}) },

  // Email in (0.8.0, S4): an owner's setting; and each person's own address
  // and code — never a viewer's or a guest's, and nobody else's.
  'GET /api/v1/mail-in': { who: 'owners' },
  'PUT /api/v1/mail-in': { who: 'owners', body: () => ({ enabled: false }) },
  'GET /api/v1/mail-in/me': { who: 'family' },
  'POST /api/v1/mail-in/me/code': { who: 'family', body: () => ({}) },
  'POST /api/v1/mail-in/me/email-code': { who: 'family', body: () => ({}) },
  // A code of nobody's, and Ahmed's own live one (the 0.8.0 exit): neither
  // confirms the caller's address, and his stays his.
  'POST /api/v1/mail-in/me/confirm': {
    who: 'family',
    bodies: (f) => [{ code: 'ABCD-EFGH' }, { code: f.mailInCode }],
  },
  // A computer that sends scans (0.8.0, D1): a code for whoever may add,
  // after the step-up; the code traded for a key by anybody, with no
  // sign-in; the key's own two routes, which nothing else opens; and the
  // computers listed and revoked — their person's, and any by an owner.
  'POST /api/v1/device-pairings': { who: 'family', body: () => ({}) },
  // And the caller's own code ended, as its dialog closes (the D1 review): nobody else's.
  'DELETE /api/v1/device-pairings': { who: 'family' },
  'POST /api/v1/devices/pair': {
    who: 'public',
    bodies: () => [
      { code: 'AAAA-AAAA', device_name: 'Attacker laptop', platform: 'other' },
      { code: 'not a code', device_name: '', platform: 'amiga' },
    ],
  },
  'GET /api/v1/devices/me': { who: 'device' },
  'POST /api/v1/device-uploads': { who: 'device', file: 'pdf' },
  'GET /api/v1/paired-devices': { who: 'family' },
  'DELETE /api/v1/paired-devices/:id': {
    who: 'family',
    last: true,
    theirs: {
      passwordOnlyOwner: 'an owner may revoke any computer in the household (D1)',
    },
  },
};

/** Whether a role is among those a rule is for. */
function roleAllowed(who: Who, role: string): boolean {
  switch (who) {
    case 'signedIn':
      return true;
    case 'family':
      return role !== 'viewer';
    case 'adults':
      return role === 'owner' || role === 'adult';
    case 'owners':
    case 'ownerPower':
      return role === 'owner';
    default:
      return false;
  }
}

describe.skipIf(!testAdminUrl())('the release exit (Phase 5, and Phase 6 for 0.7.0)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.41.${Math.floor(++nth / 200) % 250}.${nth % 200}` });
  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  // The family.
  let olivia: Tokens;
  let peter: Tokens;
  let ahmed: Tokens;
  let sara: Tokens;
  let kemal: Tokens;
  let vera: Tokens;
  let jane: Tokens;
  let gil: Tokens;
  let ned: Tokens;
  let tariq: Tokens;

  /** What each thing planted is called. */
  const doc: Record<string, { id: string; version: string; title: string; marker: string }> = {};
  const ids: Record<string, string> = {};
  let linkToken = '';
  let shareCookie = '';
  let dropCookie: Record<string, string> = {};

  const send = (
    who: Tokens,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(who),
      ...(payload === undefined ? {} : { payload: payload as never }),
      ...peer(),
    });
  const ok = async (r: Promise<LightMyRequestResponse> | LightMyRequestResponse, status = 200) => {
    const res = await r;
    expect(res.statusCode, `${res.statusCode} ${res.body}`).toBe(status);
    return res;
  };
  /** Their sessions just confirmed it's them, with every credential they have. */
  const fresh = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [t.member_id],
    );
  const upload = async (
    who: Tokens,
    documentId: string,
    marker: string,
    key: string = randomUUID(),
  ) => {
    const form = new FormData();
    form.append('file', PDF(marker), { filename: `${marker}.pdf`, contentType: 'application/pdf' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': key },
      payload: form.getBuffer(),
    });
    expect(res.statusCode, res.body).toBe(201);
    return json<{ id: string }>(res).id;
  };
  const make = async (
    name: string,
    who: Tokens,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) => {
    const title = `${String(body.title)}`;
    const made = await ok(send(who, 'POST', '/api/v1/documents', body), 201);
    const id = json<DocumentView>(made).id;
    const marker = `FILE-${name.toUpperCase()}-${randomUUID().slice(0, 8)}`;
    const version = await upload(who, id, marker, key);
    doc[name] = { id, version, title, marker };
    return doc[name];
  };
  const guest = async (name: string) => {
    await fresh(olivia);
    const invited = await ok(
      send(olivia, 'POST', '/api/v1/invitations', {
        display_name: name,
        relationship: 'attorney',
        email: `${name.toLowerCase()}-541@example.test`,
        role: 'viewer',
        kind: 'guest',
        restriction: { people: [ahmed.member_id], types: ['tax_return'] },
        access_expires_at: inDays(30),
      }),
      201,
    );
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    const accepted = await ok(
      h.app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        payload: { token: link_token, code, password: `${name} the guest’s own password` },
        ...peer(),
      }),
      201,
    );
    return json<Tokens>(accepted);
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    h.dns.set('ntfy.example.test', ['93.184.216.34']);
    olivia = await h.setup({
      household_name: 'The Khan family',
      display_name: 'Olivia',
      email: 'olivia-541@example.test',
    });
    // Olivia has two-step sign-in: the owner the vault trusts with its powers.
    await h.decider(olivia);
    peter = await h.join(olivia, {
      name: 'Peter',
      email: 'peter-541@example.test',
      role: 'owner',
    });
    await h.decider(olivia);
    ahmed = await h.join(olivia, { name: 'Ahmed', email: 'ahmed-541@example.test', role: 'adult' });
    await h.decider(olivia);
    sara = await h.join(olivia, { name: 'Sara', email: 'sara-541@example.test', role: 'adult' });
    await h.decider(olivia);
    kemal = await h.join(olivia, { name: 'Kemal', email: 'kemal-541@example.test', role: 'adult' });
    await h.decider(olivia);
    vera = await h.join(olivia, { name: 'Vera', email: 'vera-541@example.test', role: 'viewer' });
    await h.decider(olivia);
    tariq = await h.join(olivia, { name: 'Tariq', email: 'tariq-541@example.test', role: 'teen' });

    // The documents.
    await make('ahmedTax', olivia, {
      title: 'Ahmed tax return 2025',
      type_key: 'tax_return',
      visibility: 'household',
      owner_member_id: ahmed.member_id,
      physical_location: LOCATION,
      is_essential: true,
    });
    await make('will', olivia, {
      title: 'Olivia last will',
      type_key: 'will',
      visibility: 'adults',
      owner_member_id: olivia.member_id,
      physical_location: LOCATION,
    });
    await make('deed', olivia, {
      title: 'House deed Elm Street',
      type_key: 'property_deed',
      visibility: 'household',
      owner_member_id: null,
    });
    await make('oliviaPrivate', olivia, {
      title: 'Olivia private letter',
      visibility: 'private',
      owner_member_id: olivia.member_id,
    });
    await make('carInsurance', sara, {
      title: 'Sara car insurance',
      type_key: 'insurance_policy',
      visibility: 'household',
      owner_member_id: sara.member_id,
    });
    // Ahmed's Only me document: a note, a detail and pages read, all sealed.
    ids.uploadKey = randomUUID();
    await make(
      'ahmedPrivate',
      ahmed,
      {
        title: 'Ahmed motorbike papers',
        type_key: 'vehicle_registration',
        visibility: 'household',
        owner_member_id: ahmed.member_id,
        notes: NOTE,
        extra: { vin: DETAIL },
        tags: [AHMED_TAG, AHMED_DETAIL_TAG],
      },
      ids.uploadKey,
    );
    const priv = doc.ahmedPrivate as { id: string; version: string };
    await admin.query(
      'insert into document_text (version_id, household_id, document_id, content) values ($1, $2, $3, $4)',
      [priv.version, olivia.household_id, priv.id, PAGE_TEXT],
    );
    await admin.query("update document_version set ocr_status = 'done' where id = $1", [
      priv.version,
    ]);
    await ok(
      send(ahmed, 'POST', `/api/v1/documents/${priv.id}/visibility`, { visibility: 'private' }),
    );

    // Collections: one for the attorney, one only Ahmed's.
    await fresh(olivia);
    const attorney = await ok(
      send(olivia, 'POST', '/api/v1/collections', {
        name: 'For the attorney',
        audience: 'adults',
      }),
      201,
    );
    ids.attorney = json<{ id: string }>(attorney).id;
    await ok(
      send(olivia, 'POST', `/api/v1/collections/${ids.attorney}/items`, {
        document_ids: [doc.will?.id, doc.deed?.id],
      }),
    );
    const mine = await ok(
      send(ahmed, 'POST', '/api/v1/collections', { name: 'Ahmed only', audience: 'only_me' }),
      201,
    );
    ids.ahmedOnly = json<{ id: string }>(mine).id;
    await ok(
      send(ahmed, 'POST', `/api/v1/collections/${ids.ahmedOnly}/items`, {
        document_ids: [priv.id],
      }),
    );

    // The attorney's link: the will ticked, the deed not.
    await fresh(olivia);
    const shared = await ok(
      send(olivia, 'POST', `/api/v1/collections/${ids.attorney}/shares`, {
        document_ids: [doc.will?.id],
        left_out_ids: [doc.deed?.id],
        recipient_label: 'the attorney',
      }),
      201,
    );
    linkToken = json<{ link_token: string; share: { id: string } }>(shared).link_token;
    ids.share = json<{ share: { id: string } }>(shared).share.id;
    const unlocked = await ok(
      h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/unlock',
        payload: { token: linkToken },
        ...peer(),
      }),
    );
    shareCookie = unlocked.cookies.find((c) => c.name === 'fdv_share')?.value ?? '';
    expect(shareCookie).not.toBe('');

    // Identity: Olivia fills Ahmed's shared part; Ahmed keeps his passport Only me.
    await fresh(olivia);
    await ok(
      send(olivia, 'PUT', `/api/v1/members/${ahmed.member_id}/identity`, {
        part: 'shared',
        version: 0,
        fields: {
          given_name: 'Ahmed',
          ids: [{ id: 'd1', kind: 'driving_licence', number: LICENCE }],
        },
      }),
    );
    await ok(
      send(ahmed, 'PUT', `/api/v1/members/${ahmed.member_id}/identity`, {
        part: 'only_me',
        version: 0,
        fields: { ids: [{ id: 'p1', kind: 'passport', number: PASSPORT }] },
      }),
    );

    // Requests to send documents: one to the accountant, whose sender is
    // an attacker below; one a sender has used, waiting for review.
    const request = async (title: string) =>
      json<{ link_token: string; request: { id: string } }>(
        await ok(
          send(olivia, 'POST', '/api/v1/upload-requests', {
            title,
            recipient_label: 'accountant',
            expires_at: inDays(14),
          }),
          201,
        ),
      );
    const toAccountant = await request('Tax papers for 2025');
    ids.uploadRequest = toAccountant.request.id;
    const dropUnlock = async (token: string) => {
      const res = await ok(
        h.app.inject({
          method: 'POST',
          url: '/api/v1/drop/unlock',
          payload: { token },
          ...peer(),
        }),
      );
      const set = res.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
      return { [set?.name as string]: set?.value as string };
    };
    const dropFile = async (cookie: Record<string, string>, marker: string) => {
      const form = new FormData();
      form.append('file', PDF(marker), { filename: 'w2.pdf', contentType: 'application/pdf' });
      return json<{ id: string }>(
        await ok(
          h.app.inject({
            method: 'POST',
            url: '/api/v1/drop/files',
            headers: form.getHeaders(),
            cookies: cookie,
            payload: form.getBuffer(),
            ...peer(),
          }),
          201,
        ),
      ).id;
    };
    ids.dropToken = toAccountant.link_token;
    dropCookie = await dropUnlock(toAccountant.link_token);
    ids.dropFile = await dropFile(dropCookie, 'FILE-DROPPED-BY-ACCOUNTANT');
    const used = await request('Bank statements');
    const usedCookie = await dropUnlock(used.link_token);
    ids.incomingFile = await dropFile(usedCookie, 'FILE-SENT-FOR-REVIEW');
    await ok(
      h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/finish',
        cookies: usedCookie,
        payload: {},
        ...peer(),
      }),
    );

    // Ahmed's own uploads (I1): a batch, and a file in it, his alone.
    const batch = await ok(
      send(ahmed, 'POST', '/api/v1/batches', {
        name: 'AHMED-BATCH-541',
        defaults: {
          physical_location: 'AHMED-BATCH-SHELF',
          tags: [BATCH_TAG],
          collection_id: ids.ahmedOnly,
        },
      }),
      201,
    );
    ids.batch = json<{ id: string }>(batch).id;
    // Ahmed's computer (0.8.0, D1): paired, and a file sent with its key.
    await fresh(ahmed);
    const pairing = json<{ code: string }>(
      await ok(send(ahmed, 'POST', '/api/v1/device-pairings', {}), 201),
    );
    const computer = json<{ device_id: string; key: string }>(
      await ok(
        h.app.inject({
          method: 'POST',
          url: '/api/v1/devices/pair',
          payload: { code: pairing.code, device_name: AHMED_COMPUTER, platform: 'windows' },
          ...peer(),
        }),
        201,
      ),
    );
    ids.pairedDevice = computer.device_id;
    ids.deviceKey = computer.key;
    const keyHash = deviceKeyHash(computer.device_id, computer.key);
    ids.deviceKeyHex = keyHash.toString('hex');
    ids.deviceKeyBase64 = keyHash.toString('base64');
    const computerForm = new FormData();
    computerForm.append('file', PDF('AHMED-COMPUTER-FILE'), {
      filename: 'ahmed-computer-file-541.pdf',
      contentType: 'application/pdf',
    });
    await ok(
      h.app.inject({
        method: 'POST',
        url: '/api/v1/device-uploads',
        headers: {
          authorization: `Device ${computer.device_id}.${computer.key}`,
          ...computerForm.getHeaders(),
          'idempotency-key': randomUUID(),
        },
        payload: computerForm.getBuffer(),
        ...peer(),
      }),
      201,
    );
    ids.deviceBatch = (
      await admin.query<{ id: string }>('select id from intake_batch where device_id = $1', [
        computer.device_id,
      ])
    ).rows[0]?.id as string;
    const batchForm = new FormData();
    // The folder it came from (0.8.0, S2): his alone, sealed.
    batchForm.append('relative_path', 'AHMED-FOLDER-541/Passports/ahmed-batch-file-541.pdf');
    batchForm.append('file', PDF('AHMED-BATCH-FILE'), {
      filename: 'ahmed-batch-file-541.pdf',
      contentType: 'application/pdf',
    });
    ids.batchItem = json<{ id: string }>(
      await ok(
        h.app.inject({
          method: 'POST',
          url: `/api/v1/batches/${ids.batch}/items`,
          headers: { ...h.as(ahmed), ...batchForm.getHeaders() },
          payload: batchForm.getBuffer(),
          ...peer(),
        }),
        201,
      ),
    ).id;
    // …and read by the worker (I2): its words, and what they propose — a
    // number and an issuer that are nobody's but his — sealed under the
    // item's own key, as the worker seals them.
    await withSystem(h.db, olivia.household_id, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', ids.batchItem as string)
        .executeTakeFirstOrThrow();
      const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
      const fileKey = unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${ids.batchItem as string}`,
      );
      const proposal = {
        type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
        identifier: { value: 'AHMED-PROPOSED-NUMBER-541', confidence: 0.95, cue: 'number_label' },
        issued_by: { value: 'AHMED-PROPOSED-ISSUER-541', confidence: 0.9, cue: 'letterhead' },
      };
      await trx
        .updateTable('incoming_file')
        .set({
          read_state: 'read',
          text_sealed: sealBytes(
            fileKey,
            Buffer.from('AHMED-ITEM-WORDS-541'),
            itemTextBinding(ids.batchItem as string),
          ),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal })),
            itemProposalsBinding(ids.batchItem as string),
          ),
        })
        .where('id', '=', ids.batchItem as string)
        .execute();
    });
    // He is given them (the test of the test): nobody else is, below.
    const read = json<{ items: Array<{ proposals: unknown }> }>(
      await ok(send(ahmed, 'GET', `/api/v1/batches/${ids.batch}`)),
    );
    expect(JSON.stringify(read.items[0]?.proposals)).toContain('AHMED-PROPOSED-NUMBER-541');
    expect((read.items[0] as { folder?: string }).folder).toBe('AHMED-FOLDER-541/Passports');
    // What the vault learned from his corrections (I4): an issuer that is
    // his alone, ruled to be a kind and a person, and his count.
    await withSystem(h.db, olivia.household_id, async (trx) => {
      await trx
        .insertInto('intake_rule')
        .values([
          {
            household_id: olivia.household_id,
            member_id: ahmed.member_id,
            issuer_key: AHMED_LEARNED,
            type_key: 'boat_licence_541',
          },
          {
            household_id: olivia.household_id,
            member_id: ahmed.member_id,
            issuer_key: AHMED_LEARNED,
            person_id: ahmed.member_id,
          },
        ])
        .execute();
      await trx
        .insertInto('intake_outcome')
        .values({
          household_id: olivia.household_id,
          member_id: ahmed.member_id,
          item_id: ids.batchItem as string,
          unchanged: true,
        })
        .execute();
    });
    expect((await ok(send(ahmed, 'GET', '/api/v1/batches/learned'))).body).toContain(AHMED_LEARNED);
    // A scan the scanner folder could not add to his Inbox (0.8.0, S3): its
    // note, by name, his alone — an owner's too.
    ids.watchNotice = await withSystem(h.db, olivia.household_id, async (trx) => {
      const n = await trx
        .insertInto('watch_notice')
        .values({
          household_id: olivia.household_id,
          member_id: ahmed.member_id,
          file_name: 'ahmed-scan-541.zip',
          reason: 'unsupported',
          file_key: randomUUID(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return n.id;
    });
    expect((await ok(send(ahmed, 'GET', '/api/v1/watch-folder/notices'))).body).toContain(
      'ahmed-scan-541',
    );
    // And an attachment of his email the vault could not add (0.8.0, S4):
    // its note, by name, his alone too.
    await withSystem(h.db, olivia.household_id, (trx) =>
      trx
        .insertInto('watch_notice')
        .values({
          household_id: olivia.household_id,
          member_id: ahmed.member_id,
          source: 'email',
          file_name: 'ahmed-mail-541.pdf',
          reason: 'message_too_large',
          file_key: randomUUID(),
        })
        .execute(),
    );
    expect((await ok(send(ahmed, 'GET', '/api/v1/watch-folder/notices'))).body).toContain(
      'ahmed-mail-541',
    );
    // His live code to confirm his address for email in (S4, the 0.8.0
    // exit): the mailbox as the worker says it, and the household's email
    // in turned on by an owner; the code emailed to his own address through
    // the operator's mail server, to be typed in. The vault keeps a keyed
    // hash of it alone.
    await admin.query(
      `insert into mail_in_server (singleton, configured, address, folder, after, sender_check, poll_seconds, checked_at)
       values (true, true, 'home-541@vault.test', 'INBOX', 'move', false, 300, now())
       on conflict (singleton) do update set configured = true, sender_check = false, checked_at = now()`,
    );
    await ok(send(olivia, 'PUT', '/api/v1/mail-in', { enabled: true }));
    const mailsBefore = mailSent(h).length;
    await ok(send(ahmed, 'POST', '/api/v1/mail-in/me/email-code', {}));
    const codeMail = mailSent(h).slice(mailsBefore);
    expect(codeMail.map((m) => m.to)).toEqual(['ahmed-541@example.test']);
    ids.mailInCode = /\b([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\b/.exec(
      codeMail[0]?.text ?? '',
    )?.[1] as string;
    expect(ids.mailInCode).toBeTruthy();
    const held = await admin.query<{ code_hash: Buffer; code_kind: string }>(
      'select code_hash, code_kind from mail_in_address where member_id = $1',
      [ahmed.member_id],
    );
    expect(held.rows[0]?.code_kind).toBe('enter');
    ids.mailInCodeHex = held.rows[0]?.code_hash.toString('hex') as string;
    ids.mailInCodeBase64 = held.rows[0]?.code_hash.toString('base64') as string;

    // Ahmed's own: a reminder, an export, a phone.
    const reminder = await ok(
      send(ahmed, 'POST', '/api/v1/reminders', { document_id: priv.id, fire_at: '2031-01-01' }),
      201,
    );
    ids.reminder = json<{ id: string }>(reminder).id;
    await fresh(ahmed);
    const exported = await ok(send(ahmed, 'POST', '/api/v1/exports', {}), 202);
    ids.export = json<{ id: string }>(exported).id;
    ids.deviceEndpoint = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
    const device = await ok(
      send(ahmed, 'POST', '/api/v1/devices', {
        kind: 'unified_push',
        endpoint: ids.deviceEndpoint,
        keys: { p256dh: 'ahmed-p256dh', auth: 'ahmed-auth' },
      }),
      201,
    );
    ids.device = json<{ id: string }>(device).id;
    ids.session = (
      JSON.parse(
        Buffer.from(ahmed.access_token.split('.')[1] as string, 'base64url').toString(),
      ) as {
        sid: string;
      }
    ).sid;

    // The household's: its vault, a kind of document, an invitation not yet accepted.
    ids.vault = json<{ items: Array<{ id: string }> }>(
      await ok(send(olivia, 'GET', '/api/v1/vaults')),
    ).items[0]?.id as string;
    const boat = await ok(
      send(olivia, 'POST', '/api/v1/document-types', {
        label: 'Boat registration',
        category: 'property',
      }),
      201,
    );
    ids.typeKey = json<{ key: string }>(boat).key;
    await fresh(olivia);
    const pending = await ok(
      send(olivia, 'POST', '/api/v1/invitations', {
        display_name: 'Uma',
        email: 'uma-541@example.test',
        role: 'teen',
      }),
      201,
    );
    ids.invitation = json<{ invitation: { id: string } }>(pending).invitation.id;
    ids.invitationToken = json<{ link_token: string }>(pending).link_token;

    // Vera, limited to Ahmed's tax papers (5.33).
    await fresh(olivia);
    await ok(
      send(olivia, 'PUT', `/api/v1/members/${vera.member_id}/access`, {
        people: [ahmed.member_id],
        types: ['tax_return'],
      }),
    );
    // Guests: Jane, Gil whose sign-in has ended, Ned whose restriction is gone.
    jane = await guest('Jane');
    gil = await guest('Gil');
    ned = await guest('Ned');
    await admin.query(
      `update account_household set access_expires_at = now() - interval '1 minute'
        where member_id = $1`,
      [gil.member_id],
    );
    await admin.query('delete from access_restriction where member_id = $1', [ned.member_id]);

    // Kemal, locked by Olivia; Lina, paused as a restore leaves somebody.
    await fresh(olivia);
    await ok(send(olivia, 'POST', `/api/v1/members/${kemal.member_id}/lock`, {}));
    ids.kemalMember = kemal.member_id;
    await h.decider(olivia);
    const lina = await h.join(olivia, {
      name: 'Lina',
      email: 'lina-541@example.test',
      role: 'adult',
    });
    ids.linaMember = lina.member_id;
    await admin.query(
      `update account_household set suspended_at = now(), suspend_reason = 'restored'
        where member_id = $1`,
      [lina.member_id],
    );
  }, 180_000);

  /** Answers to many at once, each from an address of its own. */
  const together = <T>(n: number, one: (i: number) => Promise<T>) =>
    Promise.all(Array.from({ length: n }, (_, i) => one(i)));
  const codeOf = (r: LightMyRequestResponse) =>
    (JSON.parse(r.body) as { error?: { code?: string } }).error?.code;
  const unlockLink = (token: string, extra: Record<string, unknown> = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token, ...extra },
      ...peer(),
    });
  const sessionOf = (r: LightMyRequestResponse) =>
    r.cookies.find((c) => c.name === 'fdv_share')?.value as string;
  const linkRow = async (id: string) =>
    (
      await admin.query<{ open_count: number; downloads_used: number; attempts: number }>(
        'select open_count, downloads_used, attempts from share_link where id = $1',
        [id],
      )
    ).rows[0];
  const auditLines = async (action: string, shareId: string) =>
    Number(
      (
        await admin.query<{ n: string }>(
          `select count(*) as n from audit_event where action = $1 and detail->>'share_id' = $2`,
          [action, shareId],
        )
      ).rows[0]?.n,
    );

  it('open and download limits hold under 100 parallel unlocks', async () => {
    const tax = doc.ahmedTax as { id: string; title: string };
    await fresh(olivia);
    const made = json<{ link_token: string; share: { id: string } }>(
      await ok(
        send(olivia, 'POST', `/api/v1/documents/${tax.id}/share`, {
          permission: 'download',
          max_opens: 3,
          max_downloads: 2,
        }),
        201,
      ),
    );
    const unlocks = await together(100, () => unlockLink(made.link_token));
    const opened = unlocks.filter((r) => r.statusCode === 200);
    expect(opened).toHaveLength(3);
    for (const r of unlocks.filter((x) => x.statusCode !== 200)) {
      expect([r.statusCode, codeOf(r)]).toEqual([410, 'link_used_up']);
    }
    expect(await linkRow(made.share.id)).toMatchObject({ open_count: 3, attempts: 0 });

    // A hundred downloads at once across its three sessions: two sessions
    // download, as often as they like; the third never does.
    const sessions = opened.map(sessionOf);
    const downloads = await together(100, (i) =>
      h.app.inject({
        url: `/api/v1/shared/items/${tax.id}/content`,
        cookies: { fdv_share: sessions[i % 3] as string },
        ...peer(),
      }),
    );
    const gotTheFile = new Set<number>();
    for (const [i, r] of downloads.entries()) {
      if (r.statusCode === 200) gotTheFile.add(i % 3);
      else expect([r.statusCode, codeOf(r)], r.body).toEqual([403, 'downloads_used_up']);
    }
    expect(gotTheFile.size).toBe(2);
    for (const [i, r] of downloads.entries()) {
      expect(r.statusCode === 200, `session ${i % 3}`).toBe(gotTheFile.has(i % 3));
    }
    expect(await linkRow(made.share.id)).toMatchObject({ open_count: 3, downloads_used: 2 });
    // Written down once an open, and once a download a session.
    expect(await auditLines('share.opened', made.share.id)).toBe(3);
    expect(await auditLines('share.downloaded', made.share.id)).toBe(2);

    // A view-only link of a collection, opened five times at most.
    await fresh(olivia);
    const viewOnly = json<{ link_token: string; share: { id: string } }>(
      await ok(
        send(olivia, 'POST', `/api/v1/collections/${ids.attorney}/shares`, {
          document_ids: [doc.will?.id],
          permission: 'view',
          max_opens: 5,
        }),
        201,
      ),
    );
    const viewed = await together(100, () => unlockLink(viewOnly.link_token));
    expect(viewed.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(viewed.filter((r) => r.statusCode === 410)).toHaveLength(95);
    expect(await linkRow(viewOnly.share.id)).toMatchObject({ open_count: 5, downloads_used: 0 });
  }, 120_000);

  it("a new link's token opens nothing on the old routes, whatever its options", async () => {
    const deed = doc.deed as { id: string; title: string; marker: string };
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const options: Array<Record<string, unknown>> = [
      { permission: 'download' },
      { permission: 'view' },
      { permission: 'download', with_pin: true },
      { permission: 'download', with_password: true },
      { permission: 'view', password: 'a password the sharer typed' },
      { permission: 'download', code_email: 'attorney-541@example.test' },
      { permission: 'download', this_device_only: true },
      { permission: 'download', max_opens: 1, max_downloads: 1 },
      { permission: 'view', max_opens: 2, expires_at: soon },
      { expires_in_days: 3 },
      {
        permission: 'download',
        with_pin: true,
        code_email: 'attorney-541@example.test',
        this_device_only: true,
        max_opens: 4,
        max_downloads: 2,
        expires_at: soon,
      },
    ];
    // What a token that was never a link is answered on each old route.
    const nobody = Buffer.from(randomUUID() + randomUUID()).toString('base64url');
    const legacy = (token: string, secret?: string) => [
      h.app.inject({ url: `/api/v1/shared/${token}`, ...peer() }),
      h.app.inject({
        method: 'POST',
        url: `/api/v1/shared/${token}/open`,
        payload: secret ? { pin: secret } : {},
        ...peer(),
      }),
      h.app.inject({
        url: `/api/v1/shared/${token}/content${secret ? `?pin=${encodeURIComponent(secret)}` : ''}`,
        ...peer(),
      }),
    ];
    const answer = (r: LightMyRequestResponse) => ({
      status: r.statusCode,
      error: (JSON.parse(r.body) as { error?: { code?: string; message?: string } }).error?.code,
    });
    const strangers = (await Promise.all(legacy(nobody))).map(answer);
    expect(strangers.map((a) => a.status)).toEqual([404, 404, 404]);

    const tokens: string[] = [];
    for (const body of options) {
      await fresh(olivia);
      const made = json<{
        link_token: string;
        pin?: string;
        password?: string;
        share: { id: string; flow: string };
      }>(await ok(send(olivia, 'POST', `/api/v1/documents/${deed.id}/share`, body), 201));
      expect(made.share.flow, JSON.stringify(body)).toBe('v2');
      tokens.push(made.link_token);
      const secret = made.pin ?? made.password ?? (body.password as string | undefined);
      // Answered exactly as a token that was never a link, sent the same:
      // nothing says it is one.
      const asStranger = (await Promise.all(legacy(nobody, secret))).map(answer);
      const got = await Promise.all(legacy(made.link_token, secret));
      expect(got.map(answer), JSON.stringify(body)).toEqual(asStranger);
      for (const res of got) {
        expect(res.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        for (const s of [deed.id, deed.title, deed.marker]) expect(res.body).not.toContain(s);
      }
      // Nothing counted, nothing guessed, nothing written down.
      expect(await linkRow(made.share.id), JSON.stringify(body)).toMatchObject({
        open_count: 0,
        downloads_used: 0,
        attempts: 0,
      });
      expect(await auditLines('share.opened', made.share.id)).toBe(0);
      expect(await auditLines('share.downloaded', made.share.id)).toBe(0);
      // And the token is not a sign-in either.
      const asBearer = await h.app.inject({
        url: '/api/v1/documents',
        headers: { authorization: `Bearer ${made.link_token}` },
        ...peer(),
      });
      expect(asBearer.statusCode).toBe(401);
    }
    // A collection's link too.
    await fresh(olivia);
    const collection = json<{ link_token: string }>(
      await ok(
        send(olivia, 'POST', `/api/v1/collections/${ids.attorney}/shares`, {
          document_ids: [doc.will?.id],
        }),
        201,
      ),
    );
    expect((await Promise.all(legacy(collection.link_token))).map(answer)).toEqual(strangers);
    // While the new routes know every one of them.
    for (const token of [...tokens, collection.link_token]) {
      const shown = await h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/preview',
        payload: { token },
        ...peer(),
      });
      expect(shown.statusCode).toBe(200);
    }
  }, 120_000);

  it('a link session cannot fetch a document outside its snapshot by id', async () => {
    const [will, deed, car, tax, priv] = (
      ['will', 'deed', 'carInsurance', 'ahmedTax', 'ahmedPrivate'] as const
    ).map((n) => doc[n] as { id: string; version: string; title: string; marker: string });
    // A collection for the solicitor: the will ticked, the deed left out.
    await fresh(olivia);
    const made = json<{ id: string }>(
      await ok(
        send(olivia, 'POST', '/api/v1/collections', {
          name: 'For the solicitor',
          audience: 'adults',
        }),
        201,
      ),
    );
    await ok(
      send(olivia, 'POST', `/api/v1/collections/${made.id}/items`, {
        document_ids: [will?.id, deed?.id],
      }),
    );
    await fresh(olivia);
    const link = json<{ link_token: string }>(
      await ok(
        send(olivia, 'POST', `/api/v1/collections/${made.id}/shares`, {
          document_ids: [will?.id],
          left_out_ids: [deed?.id],
        }),
        201,
      ),
    );
    const session = sessionOf(await ok(unlockLink(link.link_token)));
    // Put in after the link was made: not in its snapshot either.
    await ok(
      send(olivia, 'POST', `/api/v1/collections/${made.id}/items`, { document_ids: [car?.id] }),
    );
    const asLink = (url: string, cookie = session) =>
      h.app.inject({ url, cookies: { fdv_share: cookie }, ...peer() });
    const items = await ok(asLink('/api/v1/shared/items'));
    expect(items.body).toContain(will?.id);
    for (const d of [deed, car, tax, priv]) {
      expect(items.body).not.toContain(d?.id);
      for (const url of [
        `/api/v1/shared/items/${d?.id}/content`,
        `/api/v1/shared/items/${d?.id}/pages/1`,
        // A version's id where a document's goes.
        `/api/v1/shared/items/${d?.version}/content`,
      ]) {
        const res = await asLink(url);
        expect(res.statusCode, url).toBe(404);
        for (const s of [d?.title, d?.marker]) expect(res.body, url).not.toContain(s);
      }
    }
    const theWill = await asLink(`/api/v1/shared/items/${will?.id}/content`);
    expect(theWill.statusCode).toBe(200);
    expect(theWill.rawPayload.toString('latin1')).toContain(will?.marker);

    // A document's link: its session asks for another document by id.
    await fresh(olivia);
    const one = json<{ link_token: string }>(
      await ok(send(olivia, 'POST', `/api/v1/documents/${deed?.id}/share`, {}), 201),
    );
    const own = sessionOf(await ok(unlockLink(one.link_token)));
    for (const d of [will, car, tax, priv]) {
      const res = await asLink(`/api/v1/shared/items/${d?.id}/content`, own);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(d?.title);
    }
    expect((await asLink(`/api/v1/shared/items/${deed?.id}/content`, own)).statusCode).toBe(200);
  });

  it('where the original is kept is answered, and found, only for owners, adults and teens (5.41)', async () => {
    const tax = doc.ahmedTax as { id: string; title: string };
    const get = (who: Tokens, url: string) => h.app.inject({ url, headers: h.as(who), ...peer() });
    const found = async (who: Tokens, q: string) =>
      json<{ items: Array<{ document_id: string; snippet?: string }> }>(
        await ok(get(who, `/api/v1/search?q=${encodeURIComponent(q)}`)),
      ).items;
    const listed = async (who: Tokens) =>
      json<{ items: DocumentView[] }>(await ok(get(who, '/api/v1/documents?limit=200'))).items.find(
        (d) => d.id === tax.id,
      );

    // The household: in the document, in the list, and found by its words.
    for (const [who, name] of [
      [olivia, 'an owner'],
      [peter, 'an owner with only a password'],
      [sara, 'an adult'],
      [tariq, 'a teen'],
    ] as const) {
      const one = json<DocumentView>(await ok(get(who, `/api/v1/documents/${tax.id}`)));
      expect(one.physical_location, name).toBe(LOCATION);
      expect((await listed(who))?.physical_location, name).toBe(LOCATION);
      expect(
        (await found(who, 'shoebox')).map((i) => i.document_id),
        name,
      ).toContain(tax.id);
    }

    // A viewer, limited, and a guest: the document, without it — and never
    // found by its words, nor hidden by them.
    for (const [who, name] of [
      [vera, 'a restricted viewer'],
      [jane, 'a guest'],
    ] as const) {
      const one = await ok(get(who, `/api/v1/documents/${tax.id}`));
      expect(json<DocumentView>(one).physical_location, name).toBeNull();
      expect(one.body, name).not.toContain('shoebox');
      expect((await listed(who))?.physical_location, name).toBeNull();
      for (const q of ['shoebox', 'Bedroom safe', 'shelf', '"top shelf"', 'behind']) {
        expect(await found(who, q), `${name}: ${q}`).toEqual([]);
      }
      // Left out with "-", the location's words hide nothing: they say
      // nothing of it by what they leave out.
      for (const q of ['tax', 'tax -shoebox', 'tax -bedroom']) {
        const items = await found(who, q);
        expect(
          items.map((i) => i.document_id),
          `${name}: ${q}`,
        ).toContain(tax.id);
        expect(JSON.stringify(items), `${name}: ${q}`).not.toMatch(/shoebox|Bedroom/);
      }
    }

    // (A phone's copy of an Essential is never a viewer's: no grant is given
    // to anybody outside the family, so the offline set is not asked here.)
    const refused = await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/grant',
      headers: h.as(vera),
      payload: { password: 'another correct horse' },
      ...peer(),
    });
    expect(refused.statusCode).toBe(403);

    // Nor may a viewer write it, by any path.
    const before = await admin.query('select physical_location from document where id = $1', [
      tax.id,
    ]);
    const patched = await send(vera, 'PATCH', `/api/v1/documents/${tax.id}`, {
      physical_location: 'Moved by a viewer',
    });
    expect(patched.statusCode).toBe(403);
    const scan = new FormData();
    scan.append('metadata', JSON.stringify({ title: 'A viewer’s scan', physical_location: 'x' }));
    scan.append('file', PDF('VIEWER'), { filename: 'v.pdf', contentType: 'application/pdf' });
    const captured = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: { ...h.as(vera), ...scan.getHeaders(), 'idempotency-key': randomUUID() },
      payload: scan.getBuffer(),
    });
    expect(captured.statusCode).toBe(403);
    const after = await admin.query('select physical_location from document where id = $1', [
      tax.id,
    ]);
    expect(after.rows).toEqual(before.rows);

    // A teen made a viewer: their own Only me document keeps its location,
    // and they no longer see it, nor find the document by it — in either
    // pass of a search.
    await h.decider(olivia);
    const rafi = await h.join(olivia, {
      name: 'Rafi',
      email: 'rafi-541@example.test',
      role: 'teen',
    });
    const mine = json<DocumentView>(
      await ok(
        send(rafi, 'POST', '/api/v1/documents', {
          title: 'Rafi diary',
          owner_member_id: rafi.member_id,
          visibility: 'private',
          notes: 'My own words',
          physical_location: 'Under the stairs cupboard',
        }),
        201,
      ),
    );
    const bothPasses = async (who: Tokens, q: string) => {
      const first = json<{
        items: Array<{ document_id: string }>;
        sealed_pending: { token?: string };
      }>(await ok(get(who, `/api/v1/search?q=${encodeURIComponent(q)}`)));
      const second = first.sealed_pending.token
        ? json<{ items: Array<{ document_id: string; snippet?: string }> }>(
            await ok(
              get(
                who,
                `/api/v1/search/sealed?token=${encodeURIComponent(first.sealed_pending.token)}`,
              ),
            ),
          ).items
        : [];
      return { first: first.items, second };
    };
    const asTeen = await bothPasses(rafi, 'stairs cupboard');
    expect([...asTeen.first, ...asTeen.second].map((i) => i.document_id)).toContain(mine.id);
    await h.decider(olivia);
    await ok(send(olivia, 'POST', `/api/v1/members/${rafi.member_id}/role`, { role: 'viewer' }));
    const asViewer = await bothPasses(rafi, 'stairs cupboard');
    expect(asViewer).toEqual({ first: [], second: [] });
    // Nor does leaving its words out say anything: found once, by its
    // title, whatever the location holds — never a second time by the pass
    // that looks inside their own documents.
    for (const q of ['diary -stairs', 'diary -bedroom']) {
      const left = await bothPasses(rafi, q);
      expect(
        left.first.map((i) => i.document_id),
        q,
      ).toEqual([mine.id]);
      expect(left.second, q).toEqual([]);
    }
    const theirs = await ok(get(rafi, `/api/v1/documents/${mine.id}`));
    expect(json<DocumentView>(theirs).physical_location).toBeNull();
    expect(json<DocumentView>(theirs).notes).toBe('My own words');
  });

  it('a locked or paused sign-in is never deleted by anybody signed in unless its lock is kept (0059)', async () => {
    // The database's own wall behind the API's: an owner, asking as
    // themselves, deletes Kemal's locked sign-in without keeping its lock.
    const pool = createPool(h.appUrl, 1);
    const client = await pool.connect();
    const ownerAccount = (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [olivia.member_id],
      )
    ).rows[0]?.account_id;
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.role', 'owner', true), set_config('app.account_id', $2, true),
                set_config('app.member_id', $3, true)`,
        [olivia.household_id, ownerAccount, olivia.member_id],
      );
      const refused = await client
        .query('delete from account_household where member_id = $1', [kemal.member_id])
        .then(
          () => null,
          (e: { code?: string }) => e.code,
        );
      expect(refused).toBe('FDV05');
      await client.query('rollback');
      // Nor may anybody but an owner change what is kept with a person: an
      // adult, of their own record.
      const saraAccount = (
        await admin.query<{ account_id: string }>(
          'select account_id from account_household where member_id = $1',
          [sara.member_id],
        )
      ).rows[0]?.account_id;
      await client.query('begin');
      await client.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.role', 'adult', true), set_config('app.account_id', $2, true),
                set_config('app.member_id', $3, true)`,
        [olivia.household_id, saraAccount, sara.member_id],
      );
      const planted = await client
        .query(
          `update member set former_suspended_at = now(), former_suspend_reason = 'restored'
            where id = $1`,
          [sara.member_id],
        )
        .then(
          (r) => r.rowCount,
          (e: { code?: string }) => e.code,
        );
      expect(planted).toBe('42501');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await pool.end();
    }
    // Through the API, were the lock ever not kept (a planted rule throws
    // away what the vault keeps with Kemal): the wall answers, in a plain
    // sentence, never a 500, and the sign-in stays.
    await admin.query(`create function public.forget_kept() returns trigger language plpgsql as $$
      begin
        new.former_suspended_at := null; new.former_suspended_by := null;
        new.former_suspended_until := null; new.former_suspend_reason := null;
        new.former_suspend_note := null;
        return new;
      end $$`);
    await admin.query(
      `create trigger forget_kept before update on member
         for each row execute function public.forget_kept()`,
    );
    try {
      await fresh(olivia);
      const refused = await send(olivia, 'DELETE', `/api/v1/members/${kemal.member_id}/sign-in`);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(json<{ error: { code: string; message: string } }>(refused).error).toMatchObject({
        code: 'sign_in_suspended',
        message:
          'That sign-in is locked or paused. An owner unlocks it, or turns it back on, first.',
      });
    } finally {
      await admin.query('drop trigger forget_kept on member');
      await admin.query('drop function public.forget_kept()');
    }
    expect(
      (await admin.query('select 1 from account_household where member_id = $1', [kemal.member_id]))
        .rows,
    ).toHaveLength(1);
  });

  it("writing another person's identity details is an owner power: never with a password alone", async () => {
    const card = async () =>
      json<{ versions: { shared: number } }>(
        await ok(send(olivia, 'GET', `/api/v1/members/${ahmed.member_id}/identity`)),
      ).versions.shared;
    const write = (who: Tokens, version: number, name = 'Overwritten') =>
      send(who, 'PUT', `/api/v1/members/${ahmed.member_id}/identity`, {
        part: 'shared',
        version,
        fields: { given_name: name, ids: [{ id: 'd1', kind: 'driving_licence' }] },
      });
    const before = await card();
    // An owner with only a password, however fresh: refused outright.
    await fresh(peter);
    const byPassword = await write(peter, before);
    expect([byPassword.statusCode, codeOf(byPassword)]).toEqual([403, 'totp_required_for_owner']);
    // An owner with two-step sign-in, but no passkey or code lately: asked for one.
    await admin.query(
      `update session set verified_at = now(), factor_verified_at = now() - interval '10 minutes'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [olivia.member_id],
    );
    const stale = await write(olivia, before);
    expect([stale.statusCode, codeOf(stale)]).toEqual([403, 'step_up_required']);
    expect(await card()).toBe(before);
    // With a code just given: written.
    await fresh(olivia);
    await ok(write(olivia, before));
    expect(await card()).toBe(before + 1);
    // One's own takes nothing more, as before.
    await fresh(ahmed);
    await admin.query(
      `update session set factor_verified_at = null
        where account_id = (select account_id from account_household where member_id = $1)`,
      [ahmed.member_id],
    );
    await ok(write(ahmed, before + 1, 'Ahmed, by himself'));
    // Put back as the rest of this file planted it.
    await fresh(olivia);
    await ok(
      send(olivia, 'PUT', `/api/v1/members/${ahmed.member_id}/identity`, {
        part: 'shared',
        version: before + 2,
        fields: {
          given_name: 'Ahmed',
          ids: [{ id: 'd1', kind: 'driving_licence', number: LICENCE }],
        },
      }),
    );
  });

  it("a push address whose sign-in has ended is free again; somebody else's live one is not (C-01)", async () => {
    const deviceOf = async (endpoint: string) =>
      (
        await admin.query<{ account_id: string; p256dh: string }>(
          'select account_id, p256dh from device where endpoint = $1',
          [endpoint],
        )
      ).rows;
    const accountOf = async (t: Tokens) =>
      (
        await admin.query<{ account_id: string }>(
          'select account_id from account_household where member_id = $1',
          [t.member_id],
        )
      ).rows[0]?.account_id;
    // Ahmed turns notifications on in a shared browser, then his sign-in
    // there ends without signing out: revoked, as a restore does, or run out.
    for (const [taker, end] of [
      [sara, `revoked_at = now()`],
      [jane, `expires_at = now() - interval '1 second'`],
    ] as const) {
      const there = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'ahmed-541@example.test', password: 'another correct horse' },
        ...peer(),
      });
      expect(there.statusCode, there.body).toBe(200);
      const shared = json<Tokens>(there);
      const endpoint = `https://ntfy.example.test/shared${randomUUID().slice(0, 8)}`;
      await ok(
        send(shared, 'POST', '/api/v1/devices', {
          kind: 'unified_push',
          endpoint,
          keys: { p256dh: 'ahmed-shared-p256dh', auth: 'ahmed-shared-auth' },
        }),
        201,
      );
      const sid = (
        JSON.parse(
          Buffer.from(shared.access_token.split('.')[1] as string, 'base64url').toString(),
        ) as {
          sid: string;
        }
      ).sid;
      // Still live: still his.
      const refused = await send(taker, 'POST', '/api/v1/devices', {
        kind: 'unified_push',
        endpoint,
        keys: { p256dh: 'taker-p256dh', auth: 'taker-auth' },
      });
      expect([refused.statusCode, codeOf(refused)]).toEqual([409, 'device_taken']);
      await admin.query(`update session set ${end} where id = $1`, [sid]);
      // Ended: Sara (an adult), and Jane (a guest, limited), take it over.
      await ok(
        send(taker, 'POST', '/api/v1/devices', {
          kind: 'unified_push',
          endpoint,
          keys: { p256dh: 'taker-p256dh', auth: 'taker-auth' },
        }),
        201,
      );
      expect(await deviceOf(endpoint)).toEqual([
        { account_id: await accountOf(taker), p256dh: 'taker-p256dh' },
      ]);
    }
    // Ahmed's own, live, is never taken over, by anybody.
    const live = await send(sara, 'POST', '/api/v1/devices', {
      kind: 'unified_push',
      endpoint: ids.deviceEndpoint,
      keys: { p256dh: 'sara-p256dh', auth: 'sara-auth' },
    });
    expect([live.statusCode, codeOf(live)]).toEqual([409, 'device_taken']);
    expect(await deviceOf(ids.deviceEndpoint as string)).toEqual([
      { account_id: await accountOf(ahmed), p256dh: 'ahmed-p256dh' },
    ]);
  });

  it("with the household's rule off, no link, recipient or route serves an Only me document, and Keep is refused; on again, it works again (5.41)", async () => {
    const priv = doc.ahmedPrivate as { id: string };
    const tax = doc.ahmedTax as { id: string };
    const served = async (cookie: string) => {
      const items = await h.app.inject({
        url: '/api/v1/shared/items',
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      const content = await h.app.inject({
        url: `/api/v1/shared/items/${priv.id}/content`,
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      return {
        items: items.statusCode === 200 && items.body.includes(priv.id),
        content: content.statusCode === 200,
      };
    };
    /** What the database gives the link, asking as itself. */
    const asTheLink = async (shareId: string) => {
      const pool = createPool(h.appUrl, 1);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'link', true),
                  set_config('app.share_id', $2, true)`,
          [olivia.household_id, shareId],
        );
        const { rows } = await client.query<{ n: number }>(
          'select count(*)::int as n from document where id = $1',
          [priv.id],
        );
        return rows[0]?.n;
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
        await pool.end();
      }
    };
    // Ahmed's own link to his Only me document, open in a browser.
    await fresh(ahmed);
    const made = json<{ link_token: string; share: { id: string } }>(
      await ok(
        send(ahmed, 'POST', `/api/v1/documents/${priv.id}/share`, { recipient_label: 'the GP' }),
        201,
      ),
    );
    const cookie = sessionOf(await ok(unlockLink(made.link_token)));
    expect(await served(cookie)).toEqual({ items: true, content: true });

    await fresh(olivia);
    const off = await ok(
      send(olivia, 'PUT', '/api/v1/household/sharing', { only_me_shareable: false }),
    );
    // Off, and nothing of anybody's links (F3).
    expect(json(off)).toEqual({ only_me_shareable: false, can_change: true });
    // Nothing serves it: the session open on it, a new open, the database.
    expect(await served(cookie)).toEqual({ items: false, content: false });
    expect((await unlockLink(made.link_token)).statusCode).not.toBe(200);
    expect(await asTheLink(made.share.id)).toBe(0);
    // Nor were its pause missed.
    await admin.query(
      'update share_link set paused_at = null, paused_reason = null where id = $1',
      [made.share.id],
    );
    expect(await served(cookie)).toEqual({ items: false, content: false });
    expect((await unlockLink(made.link_token)).statusCode).not.toBe(200);
    expect(await asTheLink(made.share.id)).toBe(0);
    await admin.query(
      `update share_link set paused_at = now(), paused_reason = 'only_me_not_shared' where id = $1`,
      [made.share.id],
    );
    // Nobody makes one, its owner included.
    await fresh(ahmed);
    const refused = await send(ahmed, 'POST', `/api/v1/documents/${priv.id}/share`, {});
    expect([refused.statusCode, codeOf(refused)]).toEqual([409, 'only_me_not_shared']);
    // Keep is refused: making a document with a link of his Only me, his
    // links end, or nothing changes.
    await fresh(ahmed);
    const taxLink = json<{ share: { id: string } }>(
      await ok(send(ahmed, 'POST', `/api/v1/documents/${tax.id}/share`, {}), 201),
    );
    await fresh(ahmed);
    const kept = await send(ahmed, 'POST', `/api/v1/documents/${tax.id}/visibility`, {
      visibility: 'private',
      own_links: 'keep',
    });
    expect([kept.statusCode, codeOf(kept)]).toEqual([409, 'only_me_not_shared']);
    expect(
      (await admin.query('select visibility from document where id = $1', [tax.id])).rows[0],
    ).not.toEqual({ visibility: 'private' });
    await fresh(ahmed);
    await ok(send(ahmed, 'DELETE', `/api/v1/shares/${taxLink.share.id}`), 204);

    // On again: the link works again.
    await fresh(olivia);
    await ok(send(olivia, 'PUT', '/api/v1/household/sharing', { only_me_shareable: true }));
    const back = sessionOf(await ok(unlockLink(made.link_token)));
    expect(await served(back)).toEqual({ items: true, content: true });
    // Taken back, so what follows finds the vault as it was.
    await fresh(ahmed);
    await ok(send(ahmed, 'DELETE', `/api/v1/shares/${made.share.id}`), 204);
  });

  it('a locked member and a guest whose sign-in ended cannot sign in again, nor refresh', async () => {
    const signIn = (email: string, password: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email, password },
        ...peer(),
      });
    const locked = await signIn('kemal-541@example.test', 'another correct horse');
    expect(locked.statusCode).toBe(403);
    expect(locked.body).not.toContain('access_token');
    const ended = await signIn('gil-541@example.test', 'Gil the guest’s own password');
    expect([ended.statusCode, codeOf(ended)]).toEqual([403, 'access_ended']);
    for (const t of [kemal, gil]) {
      const refreshed = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refresh_token: t.refresh_token },
        ...peer(),
      });
      expect(refreshed.statusCode).toBe(401);
    }
  });

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  }, 30_000);

  it('the Documents table sorts, filters and counts by nothing the caller may not see (the Phase 6 exit)', async () => {
    const table = async (who: Tokens, query: string) => {
      const res = await send(who, 'GET', `/api/v1/documents?${query}`);
      const body =
        res.statusCode === 200
          ? json<{ items: Array<{ id: string }>; total: number }>(res)
          : { items: [], total: -1 };
      return { status: res.statusCode, ids: body.items.map((d) => d.id), total: body.total };
    };
    const priv = doc.ahmedPrivate as { id: string };
    const tax = doc.ahmedTax as { id: string };
    // The test of the test: Ahmed finds his own by its tag and his collection.
    expect(await table(ahmed, `sort=title&tag=${AHMED_TAG}`)).toEqual({
      status: 200,
      ids: [priv.id],
      total: 1,
    });
    expect(await table(ahmed, `sort=title&collection_id=${ids.ahmedOnly as string}`)).toEqual({
      status: 200,
      ids: [priv.id],
      total: 1,
    });
    // …and by his detail tag's label, and the whole tag in other letters (0.9.0, T1).
    for (const q of [
      `sort=title&tag_label=${encodeURIComponent(AHMED_LABEL.toUpperCase())}`,
      `sort=title&tag=${encodeURIComponent(AHMED_DETAIL_TAG.toUpperCase())}`,
    ]) {
      expect(await table(ahmed, q)).toEqual({ status: 200, ids: [priv.id], total: 1 });
    }
    // …and the family finds the tax return by where it is kept.
    expect(
      (await table(olivia, `sort=title&location=${encodeURIComponent(LOCATION)}`)).ids,
    ).toContain(tax.id);

    const others: Array<[string, Tokens]> = [
      ['an owner', olivia],
      ['a password-only owner', peter],
      ['another adult', sara],
      ['a teen', tariq],
      ['a limited viewer', vera],
      ['a guest', jane],
    ];
    const problems: string[] = [];
    for (const [name, who] of others) {
      // Neither his Only me document's tag nor his collection gives a row, or a count.
      for (const q of [
        `sort=title&tag=${AHMED_TAG}`,
        `sort=title&tag=${BATCH_TAG}`,
        `sort=title&tag_label=${encodeURIComponent(AHMED_LABEL)}`,
        `sort=title&tag=${encodeURIComponent(AHMED_DETAIL_TAG)}`,
        `sort=title&collection_id=${ids.ahmedOnly as string}`,
      ]) {
        const got = await table(who, q);
        if (got.status >= 500 || got.ids.length > 0 || got.total > 0) {
          problems.push(`${name}: ${q} → ${got.status}, ${got.total}`);
        }
      }
      // Every sort is of the same documents: what the caller may see, never his.
      for (const sort of ['title', 'status', 'collections', 'visibility', 'person', 'expires']) {
        const got = await table(who, `sort=${sort}&limit=200`);
        if (got.status !== 200 || got.ids.includes(priv.id) || got.total !== got.ids.length) {
          problems.push(
            `${name}: sort=${sort} → ${got.status}, ${got.total} for ${got.ids.length}`,
          );
        }
      }
      // Where the original is kept: a viewer, limited or not, and a guest
      // neither sort nor filter by it (5.41), and so learn nothing of it.
      const viewer = name === 'a limited viewer' || name === 'a guest';
      for (const q of ['sort=location', `sort=title&location=${encodeURIComponent(LOCATION)}`]) {
        const got = await table(who, q);
        if (viewer ? got.status !== 422 : got.status !== 200) {
          problems.push(`${name}: ${q} → ${got.status}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('how many uploads wait counts the caller’s own alone: an owner is given nothing of another’s (Q3)', async () => {
    const waiting = async (who: Tokens) => {
      const res = await send(who, 'GET', '/api/v1/batches/counts');
      return res.statusCode === 200 ? json<{ waiting: number }>(res).waiting : -res.statusCode;
    };
    // The test of the test: Ahmed's file waits, and is counted for him.
    expect(await waiting(ahmed)).toBeGreaterThan(0);
    // Nobody else in this household has sent anything into a batch of
    // their own: whatever they are given of his is a leak.
    const others: Array<[string, Tokens, number]> = [
      ['an owner', olivia, 0],
      ['a password-only owner', peter, 0],
      ['another adult', sara, 0],
      ['a teen', tariq, 0],
      ['a limited viewer', vera, -403],
      ['a guest', jane, -403],
    ];
    const got = await Promise.all(others.map(async ([name, who]) => [name, await waiting(who)]));
    expect(got).toEqual(others.map(([name, , want]) => [name, want]));
  });

  it('a duplicate or a renewal names, and is added to, only a document the uploader may change (0.8.0, S1)', async () => {
    // Three passports of a boat's crew, each with a number: Ahmed's Only
    // me; the family's, which an adult may change and a teen may not; and
    // Tariq's own.
    const ahmedBoat = await make('ahmedBoat', ahmed, {
      title: 'Ahmed boat papers 541',
      type_key: 'passport',
      visibility: 'private',
      owner_member_id: ahmed.member_id,
      identifier: 'BOAT-541-AHMED',
    });
    const familyBoat = await make('familyBoat', olivia, {
      title: 'Family boat licence 541',
      type_key: 'passport',
      visibility: 'household',
      owner_member_id: olivia.member_id,
      identifier: 'BOAT-541-FAMILY',
    });
    const tariqBoat = await make('tariqBoat', tariq, {
      title: 'Tariq boat card 541',
      type_key: 'passport',
      visibility: 'household',
      owner_member_id: tariq.member_id,
      identifier: 'BOAT-541-TARIQ',
    });
    /** A file in the uploader's own batch, read as proposing a passport with this number. */
    const item = async (who: Tokens, batch: string, bytes: Buffer, number: string) => {
      const form = new FormData();
      form.append('file', bytes, { filename: 'boat.pdf', contentType: 'application/pdf' });
      const id = json<{ id: string }>(
        await ok(
          h.app.inject({
            method: 'POST',
            url: `/api/v1/batches/${batch}/items`,
            headers: { ...h.as(who), ...form.getHeaders() },
            payload: form.getBuffer(),
            ...peer(),
          }),
          201,
        ),
      ).id;
      await withSystem(h.db, olivia.household_id, async (trx) => {
        const f = await trx
          .selectFrom('incoming_file')
          .select(['file_key_wrapped', 'wrapped_by_scope'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
        const fileKey = unwrapKey(
          f.file_key_wrapped,
          await keys.unwrapById(trx, f.wrapped_by_scope),
          `incoming:${id}`,
        );
        const proposal = {
          type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
          identifier: { value: number, confidence: 0.95, cue: 'number_label' },
        };
        await trx
          .updateTable('incoming_file')
          .set({
            read_state: 'read',
            proposals_sealed: sealBytes(
              fileKey,
              Buffer.from(JSON.stringify({ v: 1, proposal })),
              itemProposalsBinding(id),
            ),
          })
          .where('id', '=', id)
          .execute();
      });
      return id;
    };
    const batchOf = async (who: Tokens) =>
      json<{ id: string }>(
        await ok(send(who, 'POST', '/api/v1/batches', { name: 'The boat papers' }), 201),
      ).id;
    type Item = { id: string; duplicate: unknown; renewals: Array<{ document_id: string }> };
    const items = async (who: Tokens, batch: string) => {
      const res = await ok(send(who, 'GET', `/api/v1/batches/${batch}`));
      return { body: res.body, items: json<{ items: Item[] }>(res).items };
    };
    const named = (list: Item[], id: string) =>
      (list.find((i) => i.id === id)?.renewals ?? []).map((r) => r.document_id);

    // Sara, another adult: a copy of Ahmed's Only me file, read as his
    // number, and a renewal of the family's.
    const saras = await batchOf(sara);
    const copy = await item(sara, saras, PDF(ahmedBoat.marker), 'BOAT-541-AHMED');
    const renewal = await item(sara, saras, PDF('SARA-BOAT-RENEWAL'), 'BOAT-541-FAMILY');
    const seen = await items(sara, saras);
    expect(seen.items.find((i) => i.id === copy)?.duplicate ?? null).toBeNull();
    expect(named(seen.items, copy)).toEqual([]);
    for (const secret of [ahmedBoat.id, ahmedBoat.title, ahmedBoat.version]) {
      expect(seen.body.includes(secret), secret).toBe(false);
    }
    // The test of the test: the family's, which she may change, is named.
    expect(named(seen.items, renewal)).toEqual([familyBoat.id]);
    // Added as a new version of Ahmed's: not found, and nothing of his changed.
    const into = await send(sara, 'POST', `/api/v1/batches/${saras}/items/${copy}/accept`, {
      into_document_id: ahmedBoat.id,
    });
    expect([into.statusCode, into.body.includes(ahmedBoat.title)]).toEqual([404, false]);

    // Tariq, a teen: the family's he can see but not change is never
    // named, nor taken; his own is.
    const his = await batchOf(tariq);
    const notHis = await item(tariq, his, PDF('TARIQ-BOAT-1'), 'BOAT-541-FAMILY');
    const own = await item(tariq, his, PDF('TARIQ-BOAT-2'), 'BOAT-541-TARIQ');
    const teen = await items(tariq, his);
    expect(named(teen.items, notHis)).toEqual([]);
    expect(named(teen.items, own)).toEqual([tariqBoat.id]);
    const refused = await send(tariq, 'POST', `/api/v1/batches/${his}/items/${notHis}/accept`, {
      into_document_id: familyBoat.id,
    });
    expect(refused.statusCode).toBe(403);
    // Nobody's document gained a version but by its own: one each still.
    const versions = await admin.query<{ document_id: string; n: number }>(
      `select document_id, count(*)::int as n from document_version
        where document_id = any($1) group by document_id order by document_id`,
      [[ahmedBoat.id, familyBoat.id, tariqBoat.id]],
    );
    expect(versions.rows.map((r) => r.n)).toEqual([1, 1, 1]);
  });

  it('every route the router has has a rule, and every rule a route', () => {
    const routes = routeTable(h).map((r) => `${r.method} ${r.url}`);
    expect(routes.length).toBeGreaterThan(170);
    expect(
      routes.filter((r) => !(r in RULES)),
      'routes with no rule',
    ).toEqual([]);
    expect(
      Object.keys(RULES).filter((r) => !routes.includes(r)),
      'rules with no route',
    ).toEqual([]);
    // And every parameter names a kind of thing this file knows.
    const unknown = routeTable(h).flatMap((r) =>
      paramsOf(r.url)
        .filter((p) => p.kind === null)
        .map((p) => `${r.method} ${r.url} ${p.name}`),
    );
    expect(unknown, 'parameters of no known kind').toEqual([]);
  });

  it('every attacker gets only what its rules allow, on every route', async () => {
    const attackers = attackerList();
    const routes = routeTable(h).filter((r) => `${r.method} ${r.url}` in RULES);
    const results: Result[] = [];
    for (const a of attackers) {
      for (const t of [...attackers.map((x) => x.tokens), olivia]) if (t) await fresh(t);
      // What ends or changes the caller last, and signing out last of all.
      const lastly = (r: Route) =>
        !RULES[`${r.method} ${r.url}`]?.last ? 0 : r.url === '/api/v1/auth/logout' ? 2 : 1;
      const order = [...routes].sort((x, y) => lastly(x) - lastly(y));
      let checkedStill = false;
      for (const route of order) {
        const key = `${route.method} ${route.url}`;
        const rule = RULES[key] as Rule;
        if (rule.skip?.[a.name]) continue;
        if (rule.last && !checkedStill) {
          // Still the attacker it was: nothing so far ended its way in.
          results.push(await stillIn(a));
          checkedStill = true;
        }
        const params = paramsOf(route.url);
        const objectParam = params.some((p) => p.kind !== null && OBJECT_KINDS.has(p.kind));
        const expected = expectation(a, rule, objectParam);
        for (const fill of fillsFor(a, params, rule)) {
          const queries = rule.queries ? rule.queries(fill) : [rule.query?.(fill)];
          for (const query of queries) {
            for (const body of rule.bodies ? rule.bodies(fill) : [rule.body?.(fill)]) {
              const res = await attack(a, route, rule, fill, body, query);
              results.push(judge(a, key, rule, expected, res));
            }
          }
        }
      }
    }
    const failed = results.filter((r) => r.problem);
    expect(
      failed.map((r) => `${r.attacker} ${r.route} → ${r.status} ${r.code ?? ''}: ${r.problem}`),
    ).toEqual([]);
    // Every attacker tried every route it was not excused from.
    expect(results.length).toBeGreaterThan(attackers.length * routes.length);

    // E541-01: the password-only owner took Kemal's sign-in (locked) and
    // Lina's (paused after a restore) away, and gave both back — and both
    // are still so: neither can sign in, and only an owner power ends it.
    const restored = await admin.query<{ object_id: string; detail: { kept?: string } }>(
      `select object_id, detail from audit_event
        where action = 'member.sign_in_restored' and object_id = any($1)`,
      [[ids.kemalMember, ids.linaMember]],
    );
    expect(Object.fromEntries(restored.rows.map((r) => [r.object_id, r.detail.kept]))).toEqual({
      [ids.kemalMember as string]: 'locked',
      [ids.linaMember as string]: 'restored',
    });
    const suspended = await admin.query<{ member_id: string; suspend_reason: string | null }>(
      'select member_id, suspend_reason from account_household where member_id = any($1)',
      [[ids.kemalMember, ids.linaMember]],
    );
    expect(Object.fromEntries(suspended.rows.map((r) => [r.member_id, r.suspend_reason]))).toEqual({
      [ids.kemalMember as string]: 'locked',
      [ids.linaMember as string]: 'restored',
    });
    for (const email of ['kemal-541@example.test', 'lina-541@example.test']) {
      const again = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email, password: 'another correct horse' },
        ...peer(),
      });
      expect(again.statusCode, email).toBe(403);
    }
    // And the other owners were told, as for a lock.
    const told = alertsSent(h).map((a) => String(a.subject));
    expect(told).toContain("Peter gave Kemal's sign-in back, still locked");
    expect(told).toContain("Peter gave Lina's sign-in back, still paused");
    // E541-02: Ahmed's phone is still his, whoever sent its address.
    const phone = await admin.query<{ member_id: string; p256dh: string }>(
      `select a.member_id, d.p256dh from device d
         join account_household a on a.account_id = d.account_id
        where d.id = $1`,
      [ids.device],
    );
    expect(phone.rows).toEqual([{ member_id: ahmed.member_id, p256dh: 'ahmed-p256dh' }]);
    // I4: every attacker's forgetting forgot only its own: Ahmed's rules and count are his still.
    const learned = await admin.query<{ rules: number; outcomes: number }>(
      `select (select count(*)::int from intake_rule where member_id = $1) as rules,
              (select count(*)::int from intake_outcome where member_id = $1) as outcomes`,
      [ahmed.member_id],
    );
    expect(learned.rows[0]).toEqual({ rules: 2, outcomes: 1 });
    // S4 (the 0.8.0 exit): every attacker sent Ahmed's code to confirm its
    // own address, and nobody's address was confirmed by it; his code is
    // his still, as it was made.
    const addresses = await admin.query<{
      member_id: string;
      confirmed: boolean;
      code_hash: Buffer | null;
    }>('select member_id, confirmed_at is not null as confirmed, code_hash from mail_in_address');
    expect(addresses.rows.filter((r) => r.confirmed)).toEqual([]);
    const his = addresses.rows.find((r) => r.member_id === ahmed.member_id);
    expect(his?.code_hash?.toString('hex')).toBe(ids.mailInCodeHex);
  }, 600_000);

  it('after the sweep, his Only me document carries its tags still, unrenamed and undeleted (0.9.0, T1)', async () => {
    const priv = doc.ahmedPrivate as { id: string };
    const mine = await send(ahmed, 'GET', `/api/v1/documents/${priv.id}`);
    expect(mine.statusCode).toBe(200);
    expect(json<DocumentView>(mine).tags).toEqual([AHMED_TAG, AHMED_DETAIL_TAG]);
    // Nobody's rename or delete wrote a line about it.
    const lines = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_event
        where action = 'document.tags_changed' and object_id = $1`,
      [priv.id],
    );
    expect(lines.rows[0]?.n).toBe(0);
    // And his own list of tags still has them, with his label and value.
    const listed = await send(ahmed, 'GET', `/api/v1/tags?q=${encodeURIComponent(AHMED_LABEL)}`);
    expect(json<{ items: unknown[] }>(listed).items).toEqual([
      { tag: AHMED_DETAIL_TAG, count: 1, label: AHMED_LABEL, value: AHMED_VALUE, changeable: 1 },
    ]);
  });

  it('no identity value, note, detail, suggestion, page text or location reaches the activity log, a push or an email', async () => {
    // On top of everything above, a scenario that touches each of them.
    const FAMILY_NOTE = 'Filed with the green folder of receipts, ask Ahmed first.';
    const SUGGESTED = '533401872';
    const PASSPORT_PAGE = [
      'PASSPORT',
      'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND',
      'Passport No.',
      SUGGESTED,
      'Surname',
      'KHAN',
      'Given names',
      'AHMED',
      'Nationality',
      'BRITISH CITIZEN',
      'Place of birth',
      'LEEDS',
      'Date of issue',
      '14 MAR 2021',
      'Date of expiry',
      '14 MAR 2031',
      'Authority',
      'HMPO',
    ].join('\n');
    const since = h.jobs.length;
    // Phones to push to: Olivia's and Ahmed's (registered above).
    await ok(
      send(olivia, 'POST', '/api/v1/devices', {
        kind: 'unified_push',
        endpoint: `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`,
        keys: { p256dh: 'olivia-p256dh', auth: 'olivia-auth' },
      }),
      201,
    );
    // Identity: Olivia writes Ahmed's licence (again: the sweep's owner
    // wrote over it) and shows it; Ahmed shows his own passport; the
    // audience widens, with every adult told.
    const card = json<{ versions: { shared: number } }>(
      await ok(send(olivia, 'GET', `/api/v1/members/${ahmed.member_id}/identity`)),
    );
    await ok(
      send(olivia, 'PUT', `/api/v1/members/${ahmed.member_id}/identity`, {
        part: 'shared',
        version: card.versions.shared,
        fields: {
          given_name: 'Ahmed',
          ids: [{ id: 'd1', kind: 'driving_licence', number: LICENCE }],
        },
      }),
    );
    await fresh(olivia);
    const shown = await ok(
      send(olivia, 'POST', `/api/v1/members/${ahmed.member_id}/identity/reveal`, {
        part: 'shared',
        keys: ['ids.d1'],
      }),
    );
    expect(shown.body).toContain(LICENCE);
    await fresh(ahmed);
    const own = await ok(
      send(ahmed, 'POST', `/api/v1/members/${ahmed.member_id}/identity/reveal`, {
        part: 'only_me',
        keys: ['ids.p1'],
      }),
    );
    expect(own.body).toContain(PASSPORT);
    // (Not while anybody cannot be told, A34: Kemal's lock ends first, and
    // Lina's pause.)
    await fresh(olivia);
    await ok(send(olivia, 'DELETE', `/api/v1/members/${kemal.member_id}/lock`), 204);
    await fresh(olivia);
    await ok(send(olivia, 'POST', `/api/v1/members/${ids.linaMember}/resume`, {}), 204);
    await fresh(olivia);
    const widened = await send(olivia, 'PUT', '/api/v1/household/identity-audience', {
      audience: 'adults',
    });
    expect(widened.statusCode, widened.body).toBeLessThan(300);
    // Notes and details: Ahmed's Only me note and detail changed; a family note.
    const priv = doc.ahmedPrivate as { id: string };
    await fresh(ahmed);
    await ok(
      send(ahmed, 'PATCH', `/api/v1/documents/${priv.id}`, {
        notes: `${NOTE} And the gate code.`,
        extra: { vin: DETAIL },
      }),
    );
    await ok(
      send(olivia, 'PATCH', `/api/v1/documents/${(doc.ahmedTax as { id: string }).id}`, {
        notes: FAMILY_NOTE,
        physical_location: LOCATION,
      }),
    );
    // Suggestions from a page read: a passport scan the owner files.
    const scan = json<DocumentView>(
      await ok(send(olivia, 'POST', '/api/v1/documents', { title: 'A scan' }), 201),
    );
    const scanVersion = await upload(olivia, scan.id, 'FILE-SCAN');
    await admin.query(
      'insert into document_text (version_id, household_id, document_id, content) values ($1, $2, $3, $4)',
      [scanVersion, olivia.household_id, scan.id, PASSPORT_PAGE],
    );
    await admin.query("update document_version set ocr_status = 'done' where id = $1", [
      scanVersion,
    ]);
    const proposed = await ok(send(olivia, 'GET', `/api/v1/documents/${scan.id}/suggestions`));
    expect(proposed.body).toContain(SUGGESTED);
    // Ahmed's own pages, through his own request.
    await ok(send(ahmed, 'GET', `/api/v1/documents/${priv.id}/suggestions`));
    // A link with a code emailed for it.
    await fresh(olivia);
    const coded = json<{ link_token: string }>(
      await ok(
        send(olivia, 'POST', `/api/v1/documents/${(doc.deed as { id: string }).id}/share`, {
          code_email: 'attorney-codes-541@example.test',
        }),
        201,
      ),
    );
    await ok(
      h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/code',
        payload: { token: coded.link_token },
        ...peer(),
      }),
    );
    // A lock and its end; a reset an owner starts, by mail; a forgotten password.
    await fresh(olivia);
    await ok(send(olivia, 'POST', `/api/v1/members/${sara.member_id}/lock`, {}));
    await fresh(olivia);
    await ok(send(olivia, 'DELETE', `/api/v1/members/${sara.member_id}/lock`), 204);
    await fresh(olivia);
    const reset = await ok(
      send(olivia, 'POST', `/api/v1/members/${ahmed.member_id}/password-reset`, {}),
    );
    expect(json<{ path: string }>(reset).path).toBe('mail');
    await ok(
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        payload: { email: 'sara-541@example.test' },
        ...peer(),
      }),
      202,
    );

    // Everything the API queued — alerts, pushes, emails, opened as the
    // worker opens them — and every line of the activity log.
    const fresher = h.jobs.slice(since);
    const pushes = h.jobs.filter((j) => j.name === 'push.send');
    const alerts = alertsSent(h);
    const mails = mailSent(h);
    const audit = (
      await admin.query<{ line: string }>(
        'select row_to_json(a)::text as line from audit_event a where household_id = $1',
        [olivia.household_id],
      )
    ).rows.map((r) => r.line);
    expect(fresher.filter((j) => j.name === 'alert.send').length).toBeGreaterThan(3);
    expect(fresher.filter((j) => j.name === 'mail.to_address').length).toBeGreaterThan(0);
    expect(pushes.length).toBeGreaterThan(0);
    expect(audit.length).toBeGreaterThan(100);
    const everything = [
      ['the queue', JSON.stringify(h.jobs)],
      ['the alerts', JSON.stringify(alerts)],
      ['the pushes', JSON.stringify(pushes)],
      ['the emails', JSON.stringify(mails)],
      ['the activity log', audit.join('\n')],
    ] as const;
    for (const [where, text] of everything) {
      for (const secret of [
        PASSPORT,
        LICENCE,
        NOTE,
        FAMILY_NOTE,
        DETAIL,
        PAGE_WORD,
        SUGGESTED,
        LOCATION,
        'shoebox',
        // The folder Ahmed's file came from (0.8.0, S2).
        'AHMED-FOLDER-541',
      ]) {
        expect(text.includes(secret), `${where} holds ${secret}`).toBe(false);
      }
    }
    // F529-11: and the queue holds no working link, while the reset's
    // email, opened, carries one that works.
    expect(JSON.stringify(h.jobs)).not.toMatch(/reset#/);
    const link = alerts
      .filter((a) => typeof a.url === 'string')
      .map((a) => a.url as string)
      .at(-1) as string;
    expect(link).toMatch(/\/reset#[A-Za-z0-9_-]{43}$/);
    const works = await h.app.inject({
      method: 'POST',
      url: '/api/v1/password-resets/lookup',
      payload: { token: link.slice(link.lastIndexOf('#') + 1) },
      ...peer(),
    });
    expect(works.statusCode).toBe(200);
  });

  // ------------------------------------------------------------ the sweep

  interface AttackerDef {
    name: Attacker;
    /** Signed in, as this role; null for one with only a link's or a request's cookie. */
    tokens: Tokens | null;
    role: string | null;
    /** Its tokens no longer work: anything but a public route is 401. */
    stale: boolean;
    cookies: Record<string, string>;
    victims: Partial<Record<Kind, string[]>>;
    /** What no answer to it may contain. */
    forbidden: string[];
  }

  interface Result {
    attacker: Attacker;
    route: string;
    url?: string;
    expected: string;
    status: number;
    code?: string;
    problem?: string;
  }

  const secretsOf = (...names: string[]) =>
    names.flatMap((n) => {
      const d = doc[n] as { id: string; version: string; title: string; marker: string };
      return [d.id, d.version, d.title, d.marker];
    });

  function attackerList(): AttackerDef[] {
    const priv = doc.ahmedPrivate as { id: string; version: string };
    const base = [
      PASSPORT,
      LICENCE,
      NOTE,
      DETAIL,
      PAGE_WORD,
      ...secretsOf('ahmedPrivate', 'oliviaPrivate'),
      ids.ahmedOnly as string,
      'Ahmed only',
      ids.export as string,
      ids.device as string,
      ids.session as string,
      ids.reminder as string,
      ids.uploadKey as string,
      'FILE-SENT-FOR-REVIEW',
      // Ahmed's batch, and the file in it: nobody's but his (I1, Q3).
      ids.batch as string,
      ids.batchItem as string,
      'AHMED-BATCH-541',
      'AHMED-BATCH-SHELF',
      'ahmed-batch-file-541',
      // What his item's pages proposed, and its words (I2).
      'AHMED-PROPOSED-NUMBER-541',
      'AHMED-PROPOSED-ISSUER-541',
      'AHMED-ITEM-WORDS-541',
      // The folder his file came from (0.8.0, S2), and the tag it proposes.
      'AHMED-FOLDER-541',
      'ahmed folder',
      // What the vault learned from his corrections (I4).
      AHMED_LEARNED,
      'boat_licence_541',
      // A tag on his Only me document, and his batch's default tag (the Phase 6 exit).
      AHMED_TAG,
      BATCH_TAG,
      // A detail tag's label and value on it (0.9.0, T1).
      AHMED_LABEL,
      AHMED_VALUE,
      // A note that the scanner folder could not add his file (S3).
      ids.watchNotice as string,
      'ahmed-scan-541',
      // A note that an attachment of his email could not be added (S4).
      'ahmed-mail-541',
      // His computer's key, and what the vault keeps of it (0.8.0, D1): nobody's to see.
      ids.deviceKey as string,
      ids.deviceKeyHex as string,
      ids.deviceKeyBase64 as string,
      // And what it sent: its file's name and its day's batch (his alone).
      'ahmed-computer-file-541',
      ids.deviceBatch as string,
      // His code to confirm his address for email in, and what the vault keeps of it (S4).
      ids.mailInCode as string,
      ids.mailInCodeHex as string,
      ids.mailInCodeBase64 as string,
    ];
    /** His computer's name: his, and the owners' (who see the household's computers by name). */
    const computer = [AHMED_COMPUTER];
    const outsideGrant = [
      ...secretsOf('will', 'deed', 'carInsurance'),
      ids.attorney as string,
      'For the attorney',
    ];
    const all = (names: string[]) => ({
      document: names.map((n) => (doc[n] as { id: string }).id),
      version: names.map((n) => (doc[n] as { version: string }).version),
    });
    const common: Partial<Record<Kind, string[]>> = {
      member: [ahmed.member_id],
      photo: [randomUUID()],
      share: [ids.share as string],
      uploadRequest: [ids.uploadRequest as string],
      incoming: [ids.incomingFile as string],
      reminder: [ids.reminder as string],
      export: [ids.export as string],
      vault: [ids.vault as string],
      device: [ids.device as string],
      ownerChange: [randomUUID()],
      invitation: [ids.invitation as string],
      session: [ids.session as string],
      passkey: [randomUUID()],
      typeKey: [ids.typeKey as string],
      suggestionKey: ['home_owner_needs_deed'],
      uploadKey: [ids.uploadKey as string],
      dropFile: [ids.dropFile as string],
      deviceEndpoint: [ids.deviceEndpoint as string],
      batch: [ids.batch as string],
      batchItem: [ids.batchItem as string],
      watchNotice: [ids.watchNotice as string],
      pairedDevice: [ids.pairedDevice as string],
      mailInCode: [ids.mailInCode as string],
    };
    const viewerLike = (name: Attacker, tokens: Tokens, stale = false): AttackerDef => ({
      name,
      tokens,
      role: 'viewer',
      stale,
      cookies: {},
      victims: {
        ...common,
        ...all(['ahmedPrivate', 'deed', 'will', 'oliviaPrivate', 'carInsurance']),
        collection: [ids.attorney as string, ids.ahmedOnly as string],
      },
      forbidden: [...base, ...outsideGrant, ...computer, LOCATION],
    });
    const list: AttackerDef[] = [
      viewerLike('restrictedViewer', vera),
      viewerLike('guest', jane),
      viewerLike('endedGuest', gil, true),
      {
        ...viewerLike('guestWithNoRow', ned),
        victims: {
          ...common,
          ...all(['ahmedTax', 'ahmedPrivate', 'deed']),
          collection: [ids.attorney as string],
        },
        forbidden: [...base, ...outsideGrant, ...secretsOf('ahmedTax'), ...computer, LOCATION],
      },
      {
        name: 'linkRecipient',
        tokens: null,
        role: null,
        stale: false,
        cookies: { fdv_share: shareCookie },
        victims: {
          ...common,
          ...all(['deed', 'ahmedPrivate', 'ahmedTax']),
          collection: [ids.attorney as string],
        },
        forbidden: [
          ...base,
          ...secretsOf('deed', 'carInsurance', 'ahmedTax'),
          ...computer,
          LOCATION,
        ],
      },
      {
        name: 'uploadSender',
        tokens: null,
        role: null,
        stale: false,
        cookies: dropCookie,
        victims: {
          ...common,
          ...all(['ahmedPrivate', 'ahmedTax']),
          collection: [ids.attorney as string],
          dropFile: [ids.incomingFile as string],
        },
        forbidden: [...base, ...outsideGrant, ...secretsOf('ahmedTax'), ...computer, LOCATION],
      },
      {
        name: 'lockedMember',
        tokens: kemal,
        role: 'adult',
        stale: true,
        cookies: {},
        victims: {
          ...common,
          ...all(['ahmedPrivate', 'ahmedTax']),
          collection: [ids.attorney as string],
        },
        forbidden: [...base, ...outsideGrant, ...secretsOf('ahmedTax'), ...computer, LOCATION],
      },
      {
        name: 'otherAdult',
        tokens: sara,
        role: 'adult',
        stale: false,
        cookies: {},
        victims: {
          ...common,
          ...all(['ahmedPrivate', 'oliviaPrivate']),
          collection: [ids.ahmedOnly as string],
        },
        forbidden: [...base, ...computer],
      },
      {
        name: 'passwordOnlyOwner',
        tokens: peter,
        role: 'owner',
        stale: false,
        cookies: {},
        victims: {
          ...common,
          ...all(['ahmedPrivate', 'oliviaPrivate']),
          collection: [ids.ahmedOnly as string],
        },
        forbidden: base,
      },
    ];
    return list.map((a) => ({
      ...a,
      victims: { ...a.victims, version: a.victims.version ?? [priv.version] },
    }));
  }

  /** The requests one attacker makes of one route: a victim of each kind, in turn. */
  function fillsFor(a: AttackerDef, params: Param[], rule?: Rule): Fill[] {
    const randomToken = () => Buffer.from(randomUUID() + randomUUID()).toString('base64url');
    // The rule's own victims for this attacker, where it names any.
    const victims: Partial<Record<Kind, string[]>> = { ...a.victims };
    for (const [kind, names] of Object.entries(rule?.victims?.[a.name] ?? {})) {
      victims[kind as Kind] = names.map((n) => ids[n] as string);
    }
    const one = (kind: Kind, i: number): string => {
      const list = victims[kind];
      if (list && list.length > 0) return list[Math.min(i, list.length - 1)] as string;
      switch (kind) {
        case 'page':
          return '1';
        case 'shareToken':
          return a.name === 'linkRecipient' ? linkToken : randomToken();
        case 'dropToken':
          return a.name === 'uploadSender' ? (ids.dropToken as string) : randomToken();
        default:
          return randomToken();
      }
    };
    const kinds = Object.keys(PARAM_KIND_DEFAULTS) as Kind[];
    const n = Math.max(1, ...params.map((p) => (p.kind ? (victims[p.kind]?.length ?? 1) : 1)));
    return Array.from({ length: n }, (_, i) => {
      const fill = Object.fromEntries(kinds.map((k) => [k, one(k, 0)])) as Fill;
      for (const p of params) if (p.kind) fill[p.kind] = one(p.kind, i);
      return fill;
    });
  }

  async function attack(
    a: AttackerDef,
    route: Route,
    rule: Rule,
    fill: Fill,
    body: unknown,
    query: string | undefined,
  ) {
    const url =
      route.url
        .split('/')
        .map((seg, i, all) => {
          if (!seg.startsWith(':')) return seg;
          const kind = kindOf(all[i - 1] ?? '', seg);
          return encodeURIComponent(kind ? fill[kind] : 'x');
        })
        .join('/') + (query ? `?${query}` : '');
    const headers: Record<string, string> = {};
    if (a.tokens) headers.authorization = `Bearer ${a.tokens.access_token}`;
    let payload: unknown;
    if (rule.file) {
      const form = new FormData();
      if (rule.file === 'pdf') {
        form.append('file', PDF('ATTACKER'), {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        });
      } else {
        form.append('file', PHOTO_BYTES, { filename: 'a.jpg', contentType: 'image/jpeg' });
      }
      Object.assign(headers, form.getHeaders(), { 'idempotency-key': randomUUID() });
      payload = form.getBuffer();
    } else {
      payload = body;
    }
    const res = await h.app.inject({
      method: route.method as 'GET',
      url,
      headers,
      cookies: a.cookies,
      ...(payload === undefined ? {} : { payload: payload as never }),
      ...peer(),
    });
    return Object.assign(res, { requested: url });
  }

  /** What an attacker should be answered on a route. */
  function expectation(a: AttackerDef, rule: Rule, objectParam: boolean): string {
    switch (rule.who) {
      case 'public':
        return 'answered';
      case 'link':
        return a.name === 'linkRecipient' ? (objectParam ? 'refused' : 'answered') : 'refused';
      case 'drop':
        return a.name === 'uploadSender' ? (objectParam ? 'refused' : 'answered') : 'refused';
      case 'device':
        return 'unauthenticated';
      default:
        if (!a.tokens || a.stale) return 'unauthenticated';
        if (!roleAllowed(rule.who, a.role as string)) return 'refused';
        if (rule.who === 'ownerPower' && a.name === 'passwordOnlyOwner') return 'twoStep';
        if (objectParam && !rule.theirs?.[a.name]) return 'refused';
        return 'answered';
    }
  }

  function judge(
    a: AttackerDef,
    route: string,
    rule: Rule,
    expected: string,
    res: LightMyRequestResponse & { requested: string },
  ): Result {
    const body = res.rawPayload.toString('latin1');
    let code: string | undefined;
    try {
      code = (JSON.parse(res.body) as { error?: { code?: string } }).error?.code;
    } catch {
      code = undefined;
    }
    const r: Result = {
      attacker: a.name,
      route,
      url: res.requested,
      expected,
      status: res.statusCode,
      ...(code ? { code } : {}),
    };
    const s = res.statusCode;
    const leaks = a.forbidden.filter((secret) => secret && body.includes(secret));
    // Somebody signed in told to sign in again, on a route that asks for a
    // sign-in: the sweep ended its session, and the route was not tried. (A
    // wrong password or passkey is 401 too, and is a refusal.)
    const signedIn = a.tokens !== null && !a.stale;
    const sessionRoute = !['public', 'link', 'drop', 'device'].includes(rule.who);
    if (s >= 500) r.problem = 'a server error';
    else if (s === 429) r.problem = 'rate limited: the route was not tried';
    else if (leaks.length > 0) r.problem = `leaks ${leaks.join(', ')}`;
    else if (signedIn && sessionRoute && s === 401 && SIGN_IN_AGAIN.has(code ?? '')) {
      r.problem = 'its session ended';
    } else if (expected === 'unauthenticated' && s !== 401) r.problem = 'not 401';
    else if (expected === 'twoStep' && !(s === 403 && code === 'totp_required_for_owner')) {
      r.problem = 'not refused for want of two-step sign-in';
    } else if (expected === 'refused' && s < 400) r.problem = 'not refused';
    return r;
  }

  /** The attacker is as it was: signed in still, or its cookie still opening its link or request. */
  async function stillIn(a: AttackerDef): Promise<Result> {
    const url =
      a.name === 'linkRecipient'
        ? '/api/v1/shared/items'
        : a.name === 'uploadSender'
          ? '/api/v1/drop/session'
          : '/api/v1/me';
    const res = await h.app.inject({
      url,
      headers: a.tokens ? h.as(a.tokens) : {},
      cookies: a.cookies,
      ...peer(),
    });
    const want = a.stale ? 401 : 200;
    return {
      attacker: a.name,
      route: `still in: GET ${url}`,
      expected: String(want),
      status: res.statusCode,
      ...(res.statusCode === want ? {} : { problem: 'the sweep changed the attacker' }),
    };
  }
});

interface Route {
  method: string;
  url: string;
}
interface Param {
  name: string;
  kind: Kind | null;
}

/** Every kind, for a fill that names one of each. */
const PARAM_KIND_DEFAULTS: Record<Kind, true> = {
  document: true,
  version: true,
  collection: true,
  member: true,
  photo: true,
  share: true,
  uploadRequest: true,
  incoming: true,
  reminder: true,
  export: true,
  vault: true,
  device: true,
  ownerChange: true,
  invitation: true,
  invitationToken: true,
  session: true,
  passkey: true,
  typeKey: true,
  suggestionKey: true,
  shareToken: true,
  resetToken: true,
  uploadKey: true,
  dropFile: true,
  dropToken: true,
  page: true,
  deviceEndpoint: true,
  batch: true,
  batchItem: true,
  watchNotice: true,
  pairedDevice: true,
  mailInCode: true,
};

function kindOf(before: string, param: string): Kind | null {
  if (param === ':n') return 'page';
  return PARAM_KINDS[`${before}/${param}`] ?? null;
}

function paramsOf(url: string): Param[] {
  const segs = url.split('/');
  return segs.flatMap((seg, i) =>
    seg.startsWith(':') ? [{ name: seg, kind: kindOf(segs[i - 1] ?? '', seg) }] : [],
  );
}

/**
 * Every route the API answers, as Fastify's router holds it: one tree a
 * method, so that two routes sharing a node under different parameter
 * names (DELETE /invitations/:id, GET /invitations/:token) stay two.
 */
function routeTable(h: Harness): Array<{ method: string; url: string }> {
  const out: Array<{ method: string; url: string }> = [];
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const tree = h.app.printRoutes({ method: method as 'GET', commonPrefix: false });
    const stack: string[] = [];
    for (const line of tree.split('\n')) {
      const m = /^([│ ]*)(?:├── |└── )(.*?)(?: \(([A-Z, ]+)\))?$/.exec(line.replace(/\r$/, ''));
      if (!m) continue;
      const depth = (m[1] as string).length / 4;
      stack.length = depth;
      stack.push(m[2] as string);
      if (
        (m[3] ?? '')
          .split(',')
          .map((s) => s.trim())
          .includes(method)
      ) {
        out.push({ method, url: stack.join('') });
      }
    }
  }
  return out;
}

/**
 * The Smart exit, as measured (0.8.0, S5): docs/smart-exit.md records what
 * apps/api/src/smart-exit.test.ts found on its two corpora — the first 200
 * papers, which the rules were adjusted on, and a second set held out. This
 * holds the record to itself and to the exit: no Ready item wrong, no more
 * papers needing typing than were measured, and whether the target is met
 * said as the numbers say it — so a worse number written there fails here.
 */
describe('the Smart exit, as recorded (0.8.0, S5)', () => {
  interface Counts {
    files: number;
    ready: number;
    check: number;
    unrecognised: number;
    problem: number;
    manual: number;
    wrong_ready: number;
  }
  interface Corpus {
    seed: number;
    set: 'tune' | 'held-out';
    target_met: boolean;
    with_folders: Counts;
    without_folders: Counts;
  }
  interface Recorded {
    files: number;
    target_met: boolean;
    first: Corpus;
    second: Corpus;
  }
  /**
   * Needing typing, with folders, as measured on 16 October 2026: the
   * ceiling for each until it is measured again.
   */
  const MEASURED_MANUAL = { first: 6, second: 53 } as const;
  const md = readFileSync(new URL('../../../docs/smart-exit.md', import.meta.url), 'utf8');
  const block = /```json\n([\s\S]*?)\n```/.exec(md)?.[1];
  const recorded = JSON.parse(block ?? 'null') as Recorded;
  const corpora = [
    ['first', 'First (tune)', recorded.first],
    ['second', 'Second (held out)', recorded.second],
  ] as const;

  it('no Ready item is wrong, in either corpus, with folders or without', () => {
    for (const [, , c] of corpora) {
      expect(c.with_folders.wrong_ready).toBe(0);
      expect(c.without_folders.wrong_ready).toBe(0);
    }
  });

  it('every paper is counted once; the first corpus is the tune set and the second held out', () => {
    expect(recorded.first.set).toBe('tune');
    expect(recorded.second.set).toBe('held-out');
    expect(recorded.first.with_folders.files).toBe(200);
    expect(recorded.second.with_folders.files).toBeGreaterThanOrEqual(100);
    for (const [, , c] of corpora) {
      for (const run of [c.with_folders, c.without_folders]) {
        expect(run.ready + run.check + run.unrecognised + run.problem).toBe(run.files);
      }
      expect(c.without_folders.files).toBe(c.with_folders.files);
    }
    expect(recorded.files).toBe(
      recorded.first.with_folders.files + recorded.second.with_folders.files,
    );
  });

  it('no more papers need typing than were measured, and the record says whether the target is met', () => {
    for (const [key, name, c] of corpora) {
      const manual = c.with_folders.manual;
      expect(manual).toBeLessThanOrEqual(MEASURED_MANUAL[key]);
      // Folders never make it worse.
      expect(manual).toBeLessThanOrEqual(c.without_folders.manual);
      expect(c.target_met).toBe(manual < 10);
      // The table says what the record does.
      const row = (run: string, n: Counts) =>
        new RegExp(
          `\\| ${name.replace(/[()]/g, '\\$&')} +\\| ${run} +\\| +${n.files} \\| +${n.ready} \\| +${n.check} \\| +${n.unrecognised} \\| +${n.problem} \\| +${n.manual} \\| +${n.wrong_ready} \\|`,
        );
      expect(md).toMatch(row('With folders', c.with_folders));
      expect(md).toMatch(row('Without folders', c.without_folders));
    }
    // Met only where it is met on what the rules have not seen.
    expect(recorded.target_met).toBe(recorded.second.target_met);
  });
});
