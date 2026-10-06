/**
 * The household activity log, in sentences (SHR-07).
 *
 * *Sarah downloaded "Home insurance policy" — yesterday, 4:12pm.*
 *
 * This is what makes a shared vault trustworthy between adults: not
 * restrictions, but visibility. Which means the log has to be readable by
 * somebody who has never heard the words "audit event". Three rules:
 *
 *  1. **A sentence, not a row.** Somebody did something to something, at a
 *     time. If an action cannot be said in a sentence it does not belong
 *     in this list.
 *  2. **Nothing a person cannot already see.** A private document's name
 *     never appears to anybody but its owner, and an event nobody can be
 *     told about is left out rather than shown with the details removed —
 *     "somebody did something to a document" is worse than silence.
 *  3. **No jargon and no ids.** The renderer is given names; if it has
 *     none it says "Somebody" and carries on rather than printing a uuid.
 */

import { shareEndWords } from './shares.js';

export interface ActivityEvent {
  id: number;
  at: string;
  action: string;
  /** The person, already resolved to a name. */
  actor: string | null;
  /** Who, as an id: two people with the same name are still two (0.4.12). */
  actor_id?: string | null;
  /**
   * The member who did it, where they are one of the household's: a line
   * about a person says "their photo" when it was theirs (5.17c).
   */
  actor_member_id?: string | null;
  /** For things nobody signed in for: "shared link (the letting agent)". */
  actor_label: string | null;
  object_type: string | null;
  object_id: string | null;
  /** The document's title, when the event is about one and it can be named. */
  object_title: string | null;
  /**
   * The collection's name as it is now, when the event is about a collection or a
   * document in one (5.14). The line is shown only to whoever may see the
   * collection, so its name is theirs to read; the log itself keeps only its id.
   */
  collection_name?: string | null;
  detail: Record<string, unknown>;
  /**
   * The household's time zone, for a line that names a moment (5.26: from
   * when a wider audience reads identity details): said on its clock, as
   * everything else is. UTC when not given.
   */
  timezone?: string | null;
}

export interface ActivityLine {
  id: number;
  at: string;
  /** The whole sentence, minus the time. */
  text: string;
  /** For the UI to lead the eye: the few that are worth noticing. */
  notable: boolean;
  /** Where tapping it should go, when there is somewhere. */
  document_id: string | null;
}

const quoted = (title: string | null) => (title ? `“${title}”` : 'a document');

/**
 * One event as a sentence, or null when this event should not be shown at
 * all. The caller has already decided visibility; this decides sayability.
 */
export function describeEvent(e: ActivityEvent): ActivityLine | null {
  const who = e.actor ?? (e.actor_label ? capitalise(e.actor_label) : 'Somebody');
  const doc = quoted(e.object_title);
  const detail = e.detail ?? {};
  /** A kind of document or a field, by the name it had then (0.5.10). */
  const kind = text(detail.label) ? `“${text(detail.label)}”` : null;
  /** A collection, by the name it has now (0.5.12). */
  const collection = e.collection_name ? `the collection “${e.collection_name}”` : 'a collection';
  const documentId = e.object_type === 'document' ? e.object_id : null;
  const line = (text: string, notable = false): ActivityLine => ({
    id: e.id,
    at: e.at,
    text,
    notable,
    document_id: documentId,
  });

  switch (e.action) {
    // ------------------------------------------------------- documents
    case 'document.created':
      return line(`${who} added ${doc}`);
    case 'document.updated':
      return line(`${who} edited ${doc}`);
    // 5.35: its note written, changed or taken away. The log never holds
    // what a note says, only which of those it was.
    case 'document.notes_changed':
      return detail.change === 'added'
        ? line(`${who} added a note to ${doc}`)
        : detail.change === 'removed'
          ? line(`${who} took the note off ${doc}`)
          : line(`${who} changed the note on ${doc}`);
    case 'document.version_added':
      return line(`${who} uploaded a new copy of ${doc}`);
    case 'document.downloaded':
      return line(`${who} downloaded ${doc}`);
    // Every page fetched is audited; the log folds a sitting into one line.
    case 'document.viewed':
      return line(`${who} looked at ${doc}`);
    // A phone keeping Essentials (0.4.13): filled once per version, and
    // what was opened on it, reported when it next had a connection.
    case 'document.cached_offline':
      return line(`${possessive(who)} phone kept ${doc} for offline use`);
    case 'document.opened_offline': {
      const without = detail.online === true ? '' : ' without a connection';
      return detail.mode === 'show'
        ? line(`${who} showed ${doc} from their phone${without}`)
        : line(`${who} opened ${doc} on their phone${without}`);
    }
    case 'document.deleted':
      return line(`${who} moved ${doc} to the Trash`);
    case 'document.restored':
      // 5.24: bringing it back is how whoever filed it keeps it.
      return detail.cancelled_purge === true
        ? line(`${who} took ${doc} out of the Trash, so it will not be removed for good`, true)
        : line(`${who} took ${doc} out of the Trash`);
    // 5.24: an owner asked to remove somebody else's document for good; who
    // filed it may bring it back for 24 hours.
    case 'document.purge_requested':
      return line(`${who} asked to remove ${doc} for good`, true);
    // 5.24: removed for good. The line carries no title, and the document
    // has no row to name it by: only whoever could see it is shown it (its
    // tombstone says who), and there is nowhere for it to go.
    case 'document.purged':
      return { ...line(`${who} removed a document for good`, true), document_id: null };
    case 'document.visibility_changed': {
      const to = text(detail.to);
      const words =
        to === 'private'
          ? 'only they can see'
          : to === 'adults'
            ? 'only the adults can see'
            : 'everyone in the family can see';
      return line(`${who} made ${doc} something ${words}`, to === 'private');
    }

    // ------------------------------------------- kinds of document (0.5.10)
    // What the family calls its papers is the family's: said to everyone
    // who reads the log, by the name it had when it happened.
    case 'document_type.created':
      return line(
        kind ? `${who} added a kind of document, ${kind}` : `${who} added a kind of document`,
      );
    case 'document_type.updated': {
      const to = text(detail.default_visibility);
      if (!to) return line(`${who} changed ${kind ?? 'a kind of document'}`);
      // Who sees the next one filed: letting more people see it is news.
      return line(
        `${who} made new ${kind ? `${kind} documents` : 'documents of a kind'} ${reachWords(to)}`,
        detail.widened === true,
      );
    }
    case 'document_type.archived':
      return detail.builtin === true
        ? line(`${who} stopped offering ${kind ?? 'a kind of document'}`)
        : line(`${who} archived ${kind ?? 'a kind of document'}`);
    case 'document_type.restored':
      return detail.builtin === true
        ? line(`${who} offered ${kind ?? 'a kind of document'} again`)
        : line(`${who} brought back ${kind ?? 'a kind of document'}`);
    case 'document_type.deleted':
      return line(`${who} deleted ${kind ?? 'a kind of document'}`);
    case 'document_attribute.created':
      return line(
        kind
          ? `${who} added ${kind} to the fields a kind of document can ask for`
          : `${who} added a field a kind of document can ask for`,
      );

    // ------------------------------------------ collections of documents (0.5.12)
    // Said only to whoever may see the collection, and a document's line only to
    // whoever may also see the document: one line per document, so none
    // names a document its reader is not given.
    case 'collection.created':
      return line(`${who} made ${collection}`);
    case 'collection.renamed':
      return line(
        e.collection_name
          ? `${who} renamed a collection, now “${e.collection_name}”`
          : `${who} renamed a collection`,
      );
    case 'collection.updated':
      return line(`${who} changed ${collection}`);
    case 'collection.deleted':
      return line(`${who} deleted ${collection}`);
    case 'collection.item_added':
      return line(`${who} added ${doc} to ${collection}`);
    case 'collection.item_removed':
      return line(`${who} took ${doc} out of ${collection}`);

    // ---------------------------------------------------------- people
    case 'member.added':
      // A guest (5.34) is never said to be of the family.
      return detail.kind === 'guest'
        ? line(`${who} added ${nameOf(detail, 'display_name')} as a guest from outside the family`)
        : line(`${who} added ${nameOf(detail, 'display_name')} to the family`);
    // A guest who never signed in, removed (the 5.34 review): by the name
    // they had, as the person is gone.
    case 'member.removed':
      return line(
        `${who} removed ${nameOf(detail, 'display_name')}, a guest who never signed in`,
        true,
      );
    // A guest's sign-in renewed (5.34, A28): until when, on the household's clock.
    case 'member.access_renewed': {
      const until = text(detail.access_expires_at);
      return line(
        `${who} renewed the sign-in of ${personOf(e)}${until ? ` until ${dayWords(until, e.timezone, true)}` : ''}`,
        true,
      );
    }
    case 'member.role_changed':
      return line(
        `${who} changed what ${e.object_title ?? 'somebody'} can do: ${roleWords(detail.to)}`,
        true,
      );
    case 'member.stepped_down':
      return line(`${who} stepped down to ${roleWords(detail.to)}`, true);
    case 'member.sign_in_removed':
      return line(`${who} took away ${e.object_title ?? 'somebody'}’s sign-in`, true);
    // A person's photo (5.17c): never the picture, a crop or a file's name.
    case 'member.photo_changed': {
      const own = isOwn(e);
      if (detail.replaced === true) {
        return line(
          own ? `${who} changed their photo` : `${who} changed ${possessive(personOf(e))} photo`,
        );
      }
      return line(own ? `${who} added their photo` : `${who} added a photo of ${personOf(e)}`);
    }
    case 'member.photo_removed':
      return line(
        isOwn(e) ? `${who} removed their photo` : `${who} removed ${possessive(personOf(e))} photo`,
      );
    // A person's details (5.25): which of them changed, never what they
    // were or are. The name the line gives is the one they have now.
    case 'member.updated': {
      const what = detailWords(detail.fields);
      return line(
        isOwn(e)
          ? `${who} changed their ${what}`
          : `${who} changed ${possessive(personOf(e))} ${what}`,
      );
    }
    // An owner's look at somebody's sign-in (5.25): news, to the owners and
    // to them, and never what the card said.
    case 'member.account_viewed':
      return line(
        isOwn(e)
          ? `${who} looked at their own sign-in`
          : `${who} looked at ${possessive(personOf(e))} sign-in`,
        true,
      );
    // A person's identity details (5.26): never a value, and never which
    // fields to anybody but the owners, the person and whoever did it.
    case 'identity.viewed':
      return line(
        isOwn(e)
          ? `${who} looked at their own identity details`
          : `${who} looked at ${possessive(personOf(e))} identity details`,
      );
    case 'identity.revealed': {
      const n = Array.isArray(detail.keys) ? detail.keys.length : 0;
      const what = n === 1 ? 'one' : n > 1 ? String(n) : 'some';
      // A38: the person sees each time somebody else shows their numbers.
      return isOwn(e)
        ? line(`${who} showed ${what} of their own identity numbers`)
        : line(`${who} showed ${what} of ${possessive(personOf(e))} identity numbers`, true);
    }
    case 'identity.updated': {
      const onlyMe = detail.part === 'only_me' ? ' Only me' : '';
      return line(
        isOwn(e)
          ? `${who} changed their own${onlyMe} identity details`
          : `${who} changed ${possessive(personOf(e))} identity details`,
      );
    }
    // Whether the household's Only me documents can be shared outside the
    // family (5.41): that, and nothing of anybody's links (F3).
    case 'household.only_me_sharing_changed':
      return line(
        `${who} turned ${detail.only_me_shareable === true ? 'on' : 'off'} sharing Only me documents outside the family`,
        true,
      );
    // Who sees other people's identity details (A34): wider only after
    // notice, and the line says from when.
    case 'identity.audience_changed': {
      const to = audienceWords(detail.to);
      const until = text(detail.notice_until);
      if (until && to) {
        return line(
          `${who} asked to let ${to} see identity details from ${dayWords(until, e.timezone)}`,
          true,
        );
      }
      const withdrawn = audienceWords(detail.withdrawn);
      if (detail.to === detail.from && withdrawn) {
        return line(`${who} withdrew letting ${withdrawn} see identity details`, true);
      }
      return to
        ? line(`${who} made identity details visible to ${to} only`, true)
        : line(`${who} changed who can see identity details`, true);
    }
    // A sign-in locked by an owner, and unlocked, or turned back on after a
    // restore (5.28): to the owners, the person and whoever did it, nobody
    // else — never the note the owner wrote.
    case 'member.locked': {
      const until = text(detail.until);
      const end = until ? ` until ${dayWords(until, e.timezone)}` : '';
      const links = detail.end_links === true ? ', and ended their links for good' : '';
      return line(`${who} locked ${possessive(personOf(e))} sign-in${end}${links}`, true);
    }
    // A password reset an owner started (5.29): which way it went, never a
    // link — to the owners, the person and whoever did it, nobody else.
    case 'member.reset_started': {
      const whose = possessive(personOf(e));
      const stopped = detail.stop_now === true ? ', and stopped their password now' : '';
      if (detail.path === 'mail') {
        return line(`${who} sent ${whose} sign-in address a password reset${stopped}`, true);
      }
      if (detail.path === 'handover') {
        return line(`${who} made a one-time link to reset ${whose} password${stopped}`, true);
      }
      return line(
        `${who} asked for ${whose} password to be reset by whoever runs the vault${stopped}`,
        true,
      );
    }
    case 'member.unlocked':
      return detail.reason === 'restored'
        ? line(`${who} turned ${possessive(personOf(e))} sign-in back on after the restore`, true)
        : line(`${who} unlocked ${possessive(personOf(e))} sign-in`, true);
    // Signed out everywhere by an owner (5.30, A53), and what a change of
    // role ended besides the role: to the owners, the person and whoever
    // did it, nobody else.
    case 'member.signed_out_everywhere':
      return isOwn(e)
        ? line(`${who} signed out of every other device`, true)
        : line(`${who} signed ${personOf(e)} out everywhere`, true);
    // One's own role changes only by stepping down.
    case 'member.offline_ended':
      return isOwn(e)
        ? line(`${who} stepped down, so their phone stops keeping Essentials`)
        : line(
            `${who} changed ${possessive(personOf(e))} role, so their phone stops keeping Essentials`,
          );
    case 'member.requests_closed': {
      const n = typeof detail.requests === 'number' ? detail.requests : 0;
      const what = n === 1 ? 'request' : n > 1 ? `${n} requests` : 'requests';
      return isOwn(e)
        ? line(`${who} stepped down, so their ${what} to send documents closed`)
        : line(
            `${who} changed ${possessive(personOf(e))} role, so their ${what} to send documents closed`,
          );
    }
    // What a viewer can see, limited by an owner (5.33): to the owners, the
    // person and whoever did it. Never what it gives — whose, which kinds,
    // which collections — only that it was made, changed or taken off.
    case 'access.restricted': {
      const until = text(detail.expires_at);
      const end = until ? ` until ${dayWords(until, e.timezone)}` : '';
      const adults = detail.include_adults_only === true ? ' (Adults only documents included)' : '';
      const how = detail.via === 'invitation' ? ', as they accepted their invitation' : '';
      return line(`${who} limited what ${personOf(e)} can see${end}${adults}${how}`, true);
    }
    case 'access.changed':
      return detail.reconfirmed === true && detail.changed !== true
        ? line(`${who} confirmed what ${personOf(e)} can see`, true)
        : line(`${who} changed what ${personOf(e)} can see`, true);
    case 'access.removed':
      return line(`${who} took the limits off what ${personOf(e)} can see`, true);
    case 'member.deceased':
      return detail.deceased === true
        ? line(`${who} recorded that ${personOf(e)} has passed away`, true)
        : line(`${who} took back the record that ${personOf(e)} has passed away`, true);
    case 'invitation.created': {
      // A guest's (5.34): from outside the family, until a day.
      if (detail.kind === 'guest') {
        const until = text(detail.access_expires_at);
        return line(
          `${who} invited ${nameOf(detail, 'email')} to sign in as a guest${until ? ` until ${dayWords(until, e.timezone, true)}` : ''}`,
          true,
        );
      }
      return line(`${who} invited ${nameOf(detail, 'email')} to sign in`, true);
    }
    case 'invitation.accepted':
      return line(`${nameOf(detail, 'email')} accepted their invitation and can now sign in`, true);
    case 'invitation.revoked':
      return line(`${who} cancelled the invitation to ${nameOf(detail, 'email')}`);

    // ------------------------------------------------------- ownership
    case 'owner_change.requested':
      return line(`${who} asked for an owner’s role to be taken away`, true);
    case 'owner_change.refused':
      return line(`${who} refused to stop being an owner`, true);
    case 'owner_change.withdrawn':
      return line(`${who} withdrew a request about an owner’s role`);

    // ---------------------------------------------------------- shares
    // 5.19: a link to a collection is a line about the collection, said
    // only to whoever may see it, by its name now and never with how many
    // documents went; each document's download or look is a line about
    // that document, as for any link.
    case 'share.created': {
      const to = e.object_type === 'collection' ? collection : doc;
      const follows =
        e.object_type === 'collection' && detail.follow_collection === true
          ? ', which keeps up with it'
          : '';
      return line(
        `${who} made a ${detail.permission === 'view' ? 'view-only ' : ''}link to ${to}${text(detail.recipient_label) ? ` for ${text(detail.recipient_label)}` : ''}${follows}`,
        true,
      );
    }
    case 'share.opened':
      return line(`${who} opened ${e.object_type === 'collection' ? collection : doc}`);
    // 5.19: put in a collection whose link keeps up with it, so sent out too.
    case 'share.followed':
      return line(
        `${who} put ${doc} in ${collection}, and a link that keeps up with it sent it outside the family`,
        true,
      );
    case 'share.downloaded':
      return line(`${who} downloaded ${doc}`);
    // 5.18: a view-only link's pages, looked at; once a session, as a download is.
    case 'share.viewed':
      return line(`${who} looked at the pages of ${doc}`);
    case 'share.revoked': {
      const to = e.object_type === 'collection' ? collection : doc;
      // 5.19: a collection deleted, or made Only me, ends its links.
      if (detail.why === 'collection_deleted') {
        return line(`A link to ${to} stopped working: ${who} deleted the collection`);
      }
      if (detail.why === 'collection_only_me') {
        return line(`A link to ${to} stopped working: ${who} made the collection Only me`);
      }
      return line(`${who} took back a link to ${to}`);
    }
    // 0.5.14: the tenth wrong PIN, written down once; the tries before it
    // are counted, never logged. Since 5.20 a password or a code counts
    // against the same ten.
    case 'share.locked':
      return line(
        `A link to ${e.object_type === 'collection' ? collection : doc} stopped working: its PIN, password or code was wrong ten times`,
        true,
      );
    // 5.20: a code emailed for a link, to the address its sharer typed,
    // which the log has only masked.
    case 'share.code_sent':
      return line(
        `A code to open a link to ${e.object_type === 'collection' ? collection : doc} was emailed${text(detail.to) ? ` to ${text(detail.to)}` : ''}`,
      );
    case 'share.resumed':
      return line(
        `${who} turned a link to ${e.object_type === 'collection' ? collection : doc} back on after a restore`,
        true,
      );

    // ---------------------------------- asking to be sent documents (5.21)
    // Shown to whoever reviews the request only; never its title, and
    // never a file's name.
    case 'upload_request.created': {
      const whom = text(detail.recipient_label);
      return line(`${who} asked ${whom || 'somebody outside the family'} to send documents`, true);
    }
    case 'upload_request.revoked':
      return line(`${who} took back a request to send documents`);
    case 'upload_request.opened':
      return line(`${who} opened a request to send documents`);
    case 'upload_request.code_sent':
      return line(
        `A code was sent to ${text(detail.sent_to) || 'the address given'} for a request to send documents`,
      );
    case 'upload_request.locked':
      return line(
        'A request to send documents stopped working: a password or code was typed wrong ten times',
        true,
      );
    case 'upload_request.submitted': {
      const n = typeof detail.files === 'number' ? detail.files : 0;
      return line(
        n > 0 ? `${who} sent ${n === 1 ? 'a file' : `${n} files`}` : `${who} sent files`,
        true,
      );
    }
    case 'upload_request.resumed':
      return line(`${who} turned a request to send documents back on after a restore`, true);
    case 'upload_request.closed':
      return line(
        'A request to send documents was closed: whoever asked can no longer ask for documents',
      );

    // --------------------------------------- what came in, looked at (5.23)
    // Shown to whoever reviews the request only, as its own lines are;
    // whom it was from in the family's words, never a file's name.
    case 'incoming.accepted':
      return line(`${who} filed a document ${sentBy(detail)}`, true);
    case 'incoming.rejected':
      return line(`${who} refused a file ${sentBy(detail)}`);
    case 'incoming.downloaded':
      return line(`${who} saved a copy of a file ${sentBy(detail)}, to look at it`);
    case 'incoming.purged': {
      const n = typeof detail.files === 'number' ? detail.files : 0;
      return line(
        `${n === 1 ? 'A file' : `${n || 'Some'} files`} ${sentBy(detail)} ${n === 1 ? 'was' : 'were'} removed: nobody filed ${n === 1 ? 'it' : 'them'} within 30 days`,
      );
    }
    case 'incoming.moved': {
      const n = typeof detail.files === 'number' ? detail.files : 0;
      return line(
        `${n === 1 ? 'A file' : `${n || 'Some'} files`} ${sentBy(detail)} ${n === 1 ? 'was' : 'were'} given to the owners to look at: whoever asked for ${n === 1 ? 'it' : 'them'} can no longer`,
        true,
      );
    }

    // ------------------------------------------------------- the vault
    case 'household.created':
      return line(`${who} set up the vault`);
    case 'household.profile_updated':
      return line(`${who} changed the household details`);
    case 'vault.added':
      return line(`${who} added somewhere new to keep the files`, true);
    case 'vault.activated':
      return line(`${who} changed where the files are kept`, true);
    case 'vault.removed':
      return line(`${who} removed a place files were kept`, true);
    case 'notifications.smtp_saved':
      return line(`${who} changed how the vault sends email`);
    case 'export.requested':
      return line(`${who} asked for a copy of everything`, true);
    case 'export.downloaded':
      return line(`${who} downloaded a copy of everything`, true);

    // ---------------------------------------------------- signing in
    case 'auth.signed_in':
      return line(`${who} signed in`);
    case 'auth.session_revoked':
      return line(`${who} signed a device out`);
    case 'auth.totp_enabled':
      return line(`${who} switched on two-step sign-in`, true);
    case 'auth.totp_disabled':
      return line(`${who} switched off two-step sign-in`, true);
    case 'credential.passkey_added':
      return line(`${who} added a passkey`, true);
    case 'credential.passkey_removed':
      return line(`${who} removed a passkey`, true);

    // Everything else — step-ups, reminder housekeeping, suggestions
    // being dismissed — is real and audited, and is not news. The chain
    // keeps them; this list does not.
    default:
      return null;
  }
}

/** Page views this close together are one sitting with a document, and one line. */
export const SITTING_MS = 10 * 60 * 1000;

/**
 * Events, newest first, as the lines a person reads (0.4.12). Every page
 * fetched is audited, and paging through a passport is not five things
 * that happened: the views of one document by one person, each within ten
 * minutes of the next and with nothing shown in between, are one line —
 * the most recent, since the list reads from now backwards.
 */
export function describeEvents(events: ActivityEvent[]): ActivityLine[] {
  const lines: ActivityLine[] = [];
  let sitting: { actor: string | null; doc: string | null; at: number } | null = null;
  for (const e of events) {
    const at = Date.parse(e.at);
    if (
      e.action === 'document.viewed' &&
      sitting &&
      sitting.actor === (e.actor_id ?? null) &&
      sitting.doc === e.object_id &&
      sitting.at - at <= SITTING_MS
    ) {
      sitting.at = at;
      continue;
    }
    const line = describeEvent(e);
    if (!line) continue;
    lines.push(line);
    sitting =
      e.action === 'document.viewed' ? { actor: e.actor_id ?? null, doc: e.object_id, at } : null;
  }
  return lines;
}

/** The person a line about a member is about, by name. */
function personOf(e: ActivityEvent): string {
  return e.object_title ?? 'somebody';
}

/** Whether the person a line is about did it themselves. */
function isOwn(e: ActivityEvent): boolean {
  return (
    e.object_type === 'member' && e.actor_member_id != null && e.actor_member_id === e.object_id
  );
}

/** "Sarah’s", "Chris’", "Somebody’s". */
function possessive(who: string): string {
  return /s$/i.test(who) ? `${who}’` : `${who}’s`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A detail field as a string, or empty: never "[object Object]". */
function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nameOf(detail: Record<string, unknown>, key: string): string {
  const v = detail[key];
  return typeof v === 'string' && v.length > 0 ? v : 'somebody';
}

/** Whom a file sent in came from (5.23), as the request named them: "sent by Jane, accountant". */
function sentBy(detail: Record<string, unknown>): string {
  const from = text(detail.from).trim();
  return from ? `sent by ${from}` : 'sent through a request';
}

/** Who a new document of a kind is shown to, after "visible to" (0.5.10). */
function reachWords(visibility: string): string {
  switch (visibility) {
    case 'household':
      return 'visible to everyone in the family';
    case 'adults':
      return 'visible to the adults only';
    case 'private':
      return 'private to the person each belongs to';
    default:
      return 'visible to somebody else';
  }
}

/** "name", "date of birth and relationship": the details a line says changed (5.25). */
function detailWords(fields: unknown): string {
  const names: Record<string, string> = {
    display_name: 'name',
    date_of_birth: 'date of birth',
    relationship: 'relationship',
  };
  const said = (Array.isArray(fields) ? fields : [])
    .map((f) => (typeof f === 'string' ? names[f] : undefined))
    .filter((w): w is string => w !== undefined);
  if (said.length === 0) return 'details';
  if (said.length === 1) return said[0] as string;
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1] as string}`;
}

/** Who an identity audience is, after "visible to" (5.26); '' for one never heard of. */
function audienceWords(audience: unknown): string {
  switch (audience) {
    case 'owners_and_self':
      return 'the owners and each person';
    case 'adults':
      return 'all adults';
    case 'family':
      return 'everyone in the family';
    default:
      return '';
  }
}

/** "5 October at 14:00": a moment, on the household's clock (the 5.26 review). */
function dayWords(iso: string, timezone: string | null | undefined, year = false): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'later';
  try {
    return shareEndWords(at, timezone || 'UTC', { weekday: false, year });
  } catch {
    return shareEndWords(at, 'UTC', { weekday: false, year });
  }
}

function roleWords(role: unknown): string {
  switch (role) {
    case 'owner':
      return 'an owner';
    case 'adult':
      return 'an adult';
    case 'teen':
      return 'a teen';
    case 'viewer':
      return 'a viewer';
    default:
      return 'something else';
  }
}

/**
 * "yesterday, 4:12pm" — the design's own phrasing. Anything inside a week
 * is said in words, because that is how people talk about last Tuesday.
 */
export function whenWords(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = clockTime(at);
  const days = daysBetween(at, now);
  if (days === 0) return `today, ${time}`;
  if (days === 1) return `yesterday, ${time}`;
  if (days < 7) return `${at.toLocaleDateString('en-GB', { weekday: 'long' })}, ${time}`;
  if (at.getFullYear() === now.getFullYear()) {
    return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}, ${time}`;
  }
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * "26 Sep 2026, 3:12pm" — a moment exactly, date and time always both: for
 * a table or a history, where lines are compared rather than read aloud.
 * On the household's clock when given its time zone (5.35: who last edited
 * a note, and when); else this device's. A zone this device does not know
 * reads as UTC rather than failing.
 */
export function whenExactly(iso: string, timezone?: string | null): string {
  const at = new Date(iso);
  const zone = timezone ? knownZone(timezone) : undefined;
  const date = at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(zone ? { timeZone: zone } : {}),
  });
  return `${date}, ${clockTime(at, zone)}`;
}

/** A time zone this device can say times in, or UTC. */
function knownZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/** "4:12pm": the time as the design writes it. */
function clockTime(at: Date, timeZone?: string): string {
  return at
    .toLocaleTimeString('en-GB', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      ...(timeZone ? { timeZone } : {}),
    })
    .replace(/\s/g, '')
    .toLowerCase();
}

/** Calendar days apart, not 24-hour periods: 11pm to 1am is yesterday. */
function daysBetween(a: Date, b: Date): number {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(b) - startOf(a)) / 86400000);
}
