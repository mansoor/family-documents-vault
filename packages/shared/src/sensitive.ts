import type { Visibility } from './documents.js';
import type { Role } from './roles.js';
import { GROWN_UP_AGE, OWN_SIGN_IN_AGE } from './sign-up.js';
import { ageOn } from './suggestions.js';

/**
 * What Sensitive protects (0.9.0, H1a of plan-health): beyond what goes to
 * an AI reader outside the house (AIR3) and how notifications are worded
 * (H2), a sensitive paper (`sensitiveOf`)
 *
 *  - starts as Only me when it is a teen's own, or a grown-up child's own
 *    (`keepsOwnSensitive`, `sensitiveStartingVisibility`), with a plain
 *    note why (`SENSITIVE_ONLY_ME_NOTE`);
 *  - is asked about before it goes outside the family by a link
 *    (`409 sensitive_confirm` without `confirm_sensitive: true`), a
 *    collection's link that keeps up with it included;
 *  - shows no snippet in search, is "a sensitive document" in the activity
 *    log's words, and is "A document" on a link's page unless its sharer
 *    chose to show its title (`show_title`).
 */

/**
 * The relationships, as the family writes them on a person, that make a
 * grown-up somebody's child (H1a): the whole word child, son or daughter
 * anywhere in it, in any case — "Son", "our adopted son", "eldest
 * daughter", "son (Ali)". A relationship is free text. Never a step-child,
 * a child-in-law or a godchild ("stepson", "step daughter", "son-in-law",
 * "god son"); nor a grandchild or a nephew, whose words are others.
 */
const CHILD_WORD = /\b(child|son|daughter)\b/;
const NOT_A_CHILD = /\bstep|in[\s-]*law\b|\bgod[\s-]*(child|son|daughter)\b/;

/** Whether a person's relationship to the family says they are a child of it (H1a). */
export function isChildRelationship(relationship: string | null | undefined): boolean {
  const words = (relationship ?? '').trim().toLowerCase();
  if (!words || NOT_A_CHILD.test(words)) return false;
  return CHILD_WORD.test(words);
}

/** Who adds a paper, as the rule asks of them (H1a). */
export interface SensitiveUploader {
  role: Role;
  /** Their own date of birth (YYYY-MM-DD), where the family has said it. */
  date_of_birth?: string | null | undefined;
  /** Their relationship to the family, as written on them. */
  relationship?: string | null | undefined;
}

/**
 * Whether somebody's own sensitive papers start as Only me (0.9.0, H1a):
 * a teen's — signed in as a teen, or 13 to 17 by their date of birth — and
 * a grown-up child's: a child of the family (`isChildRelationship`) who is
 * 18 or over, or, with no date of birth, who signs in as an adult (never an
 * owner: a sign-in of their own, and a role only a grown-up has). Anybody
 * else chooses as before. Ages on the household's calendar (`today`), as
 * `ageOn` counts them.
 */
export function keepsOwnSensitive(who: SensitiveUploader, today: string): boolean {
  if (who.role === 'teen') return true;
  const age = ageOn(who.date_of_birth ?? null, today);
  if (age !== null && age >= OWN_SIGN_IN_AGE && age < GROWN_UP_AGE) return true;
  if (!isChildRelationship(who.relationship)) return false;
  return age === null ? who.role === 'adult' : age >= GROWN_UP_AGE;
}

/**
 * Who can see a new paper before anybody chooses, with H1a's rule on top
 * of whatever the kind, the batch or the role made it (`base`): Only me
 * when it is sensitive, it is the uploader's own (whose it is: them), and
 * `keepsOwnSensitive` says so for them. Never wider than `base`: anything
 * else is `base` as it was. A parent's paper *about* a teen is the
 * parent's, not the teen's own, and follows the parent's choice.
 */
export function sensitiveStartingVisibility(
  base: Visibility,
  o: { sensitive: boolean; own: boolean; keeps: boolean },
): Visibility {
  return o.sensitive && o.own && o.keeps ? 'private' : base;
}

/** Said on the capture and confirm cards when a paper starts as Only me by H1a's rule. */
export const SENSITIVE_ONLY_ME_NOTE =
  'This is sensitive and it’s yours, so it starts as Only me: only you can see it. You can change who can see it before you save.';

/**
 * `409 sensitive_confirm` (H1a): a sensitive document shared outside the
 * family by a link, without `confirm_sensitive: true`. Said in the confirm
 * dialog too.
 */
export const SENSITIVE_SHARE_CONFIRM =
  'This document is sensitive. A link lets somebody outside the family open it. Share it anyway?';

/** The same, for a collection's link with sensitive documents ticked (H1a). */
export const sensitiveCollectionShareConfirm = (n: number): string =>
  n === 1
    ? 'One of the documents ticked is sensitive. A link lets somebody outside the family open it. Share it anyway?'
    : `${n} of the documents ticked are sensitive. A link lets somebody outside the family open them. Share them anyway?`;

/**
 * The same, for a sensitive document put in a collection whose link keeps
 * up with it (H1a): it would go out by that link too.
 */
export const SENSITIVE_FOLLOW_CONFIRM =
  'This collection has a link that keeps up with it, so a sensitive document put in it goes to somebody outside the family too. Put it in anyway?';

/** `409 sensitive_confirm` (H1a): a paused link turned back on that gives sensitive documents. */
export const sensitiveResumeConfirm = (n: number): string =>
  n === 1
    ? 'This link gives a sensitive document to somebody outside the family. Turn it back on anyway?'
    : `This link gives ${n} sensitive documents to somebody outside the family. Turn it back on anyway?`;

/**
 * A document made sensitive while links outside the family still give it
 * (H1a): asked after the edit is saved. Never blocks the edit.
 */
export const sensitiveStillSharedWords = (links: number): string =>
  `This paper is shared outside the family by ${links === 1 ? 'a link' : `${links} links`}. Keep ${links === 1 ? 'it' : 'them'}, or end ${links === 1 ? 'it' : 'them'} now?`;

/** A kind made sensitive by default while its documents are still shared (H1a). */
export const kindStillSharedWords = (documents: number): string =>
  documents === 1
    ? 'One document of this kind is now sensitive and is still shared outside the family by a link. See Sharing to keep or end it.'
    : `${documents} documents of this kind are now sensitive and are still shared outside the family by links. See Sharing to keep or end them.`;

/**
 * What ending a sensitive document's sharing did (POST
 * /documents/{id}/stop-sharing): links of its own taken back, collections'
 * links made to leave it out, and any kept — a collection's link the caller
 * cannot see.
 */
export interface StopSharing {
  ended: number;
  left_out: number;
  kept: number;
}

/** What ending it did, in words. */
export function stopSharingWords(r: StopSharing): string {
  const parts: string[] = [];
  if (r.ended > 0) parts.push(r.ended === 1 ? 'Ended its link' : `Ended its ${r.ended} links`);
  if (r.left_out > 0) {
    parts.push(
      r.left_out === 1
        ? 'took it out of a collection’s link (the rest of the collection still goes)'
        : `took it out of ${r.left_out} collections’ links (the rest of each collection still goes)`,
    );
  }
  const done = parts.length > 0 ? `${parts.join(', and ')}.` : 'Nothing was shared any more.';
  const said = done.charAt(0).toUpperCase() + done.slice(1);
  return r.kept > 0
    ? `${said} ${r.kept === 1 ? 'One link' : `${r.kept} links`} you can’t see stayed: ask whoever made ${r.kept === 1 ? 'it' : 'them'}.`
    : said;
}

/**
 * Said where a sensitive document was put in a collection without the
 * confirm (a batch's item, a checklist's add): kept in the family — its
 * link that keeps up with it does not take it.
 */
export const sensitiveNotFollowed = (title: string | null): string =>
  `${title ? `“${title}”` : 'A document'} is sensitive, so the collection’s link outside the family doesn’t include it. Share it on its own if you mean to.`;

/** A sensitive document, as the activity log says it in place of its title (H1a). */
export const SENSITIVE_IN_WORDS = 'a sensitive document';

/** A link's page, for a document whose title its sharer chose not to show (H1a). */
export const UNTITLED_ON_LINK = 'A document';

/** The share sheet's choice (H1a): `show_title` on a link. */
export const SHOW_TITLE_LABEL = 'Show its title on the link page';

/** Said under it, for a sensitive document. */
export const SHOW_TITLE_SENSITIVE_HINT =
  'It’s sensitive, so the page says “A document” unless you show its title.';

/** Said under it, for a collection's link: what it covers, now and later. */
export const SHOW_TITLE_COLLECTION_HINT =
  'Each sensitive one is “A document” on the link’s page unless you show its title — and so is each sensitive one put in the collection later.';

/**
 * Said with the choice (H1a): a title left off the page is not left out of
 * the file itself.
 */
export const DOWNLOAD_KEEPS_DETAILS =
  'A file they download keeps its own details, such as a PDF’s title or a photo’s data. A link to view only shows the pages, without them.';

/**
 * Whether a link's page shows a document's title (H1a): the sharer's
 * choice where they made one (`show_title`); else — a link made before
 * the choice, or with nothing said — not for a sensitive document, and
 * yes for any other.
 */
export function linkShowsTitle(showTitle: boolean | null | undefined, sensitive: boolean): boolean {
  if (showTitle === true || showTitle === false) return showTitle;
  return !sensitive;
}
