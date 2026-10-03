import { describe, expect, it } from 'vitest';
import {
  describeEvent,
  describeEvents,
  whenExactly,
  whenWords,
  type ActivityEvent,
} from './activity.js';

const base: ActivityEvent = {
  id: 1,
  at: '2026-09-22T16:12:00.000Z',
  action: 'document.downloaded',
  actor: 'Sarah',
  actor_label: null,
  object_type: 'document',
  object_id: 'doc-1',
  object_title: 'Home insurance policy',
  detail: {},
};

const ev = (over: Partial<ActivityEvent>) => ({ ...base, ...over });

describe('the activity log, in sentences', () => {
  it('reads like the design says it should', () => {
    expect(describeEvent(base)?.text).toBe('Sarah downloaded “Home insurance policy”');
  });

  it('says who opened a shared link, since nobody signed in', () => {
    const line = describeEvent(
      ev({ action: 'share.opened', actor: null, actor_label: 'shared link (the letting agent)' }),
    );
    expect(line?.text).toBe('Shared link (the letting agent) opened “Home insurance policy”');
  });

  it('says once that a link locked itself, and who turned one back on (0.5.14)', () => {
    const locked = describeEvent(
      ev({ action: 'share.locked', actor: null, actor_label: 'shared link (the letting agent)' }),
    );
    // 5.20: a password or a code counts against the same ten.
    expect(locked?.text).toBe(
      'A link to “Home insurance policy” stopped working: its PIN, password or code was wrong ten times',
    );
    expect(locked?.notable).toBe(true);
    expect(describeEvent(ev({ action: 'share.resumed' }))?.text).toBe(
      'Sarah turned a link to “Home insurance policy” back on after a restore',
    );
  });

  it('says a code was emailed, to an address it only ever has masked (5.20)', () => {
    const sent = describeEvent(
      ev({
        action: 'share.code_sent',
        actor: null,
        actor_label: 'shared link (Jane)',
        detail: { share_id: 's-1', to: 'j•••@e•••.com' },
      }),
    );
    expect(sent?.text).toBe(
      'A code to open a link to “Home insurance policy” was emailed to j•••@e•••.com',
    );
  });

  it('says who looked at, showed or changed somebody’s identity details, and never a value; who sees them, and from when (5.26)', () => {
    const sara = { object_type: 'member', object_id: 'm-sara', object_title: 'Sara' };
    const said = (action: string, actorMember: string, detail: Record<string, unknown> = {}) =>
      describeEvent(
        ev({
          action,
          actor: actorMember === 'm-sara' ? 'Sara' : 'Mansoor',
          ...sara,
          actor_member_id: actorMember,
          detail,
        }),
      );
    expect(said('identity.viewed', 'm-mansoor')?.text).toBe(
      'Mansoor looked at Sara’s identity details',
    );
    // A38: somebody else showing her numbers is news, said with no value.
    expect(
      said('identity.revealed', 'm-mansoor', { part: 'shared', keys: ['ids.p1'], number: 'P-1' }),
    ).toMatchObject({ text: 'Mansoor showed one of Sara’s identity numbers', notable: true });
    expect(said('identity.revealed', 'm-sara', { keys: ['ids.p1', 'ids.d1'] })).toMatchObject({
      text: 'Sara showed 2 of their own identity numbers',
      notable: false,
    });
    expect(
      said('identity.updated', 'm-mansoor', { part: 'shared', keys: ['given_name'] })?.text,
    ).toBe('Mansoor changed Sara’s identity details');
    expect(said('identity.updated', 'm-sara', { part: 'only_me' })?.text).toBe(
      'Sara changed their own Only me identity details',
    );
    const household = { object_type: 'household', object_id: 'h', object_title: null };
    const audience = (detail: Record<string, unknown>) =>
      describeEvent(
        ev({ action: 'identity.audience_changed', actor: 'Mansoor', ...household, detail }),
      );
    expect(
      audience({ from: 'owners_and_self', to: 'adults', notice_until: '2026-10-05T14:00:00.000Z' }),
    ).toMatchObject({
      text: 'Mansoor asked to let all adults see identity details from 5 October',
      notable: true,
    });
    expect(audience({ from: 'family', to: 'owners_and_self' })?.text).toBe(
      'Mansoor made identity details visible to the owners and each person only',
    );
    expect(audience({ from: 'adults', to: 'adults', withdrawn: 'family' })?.text).toBe(
      'Mansoor withdrew letting everyone in the family see identity details',
    );
    expect(audience({})?.text).toBe('Mansoor changed who can see identity details');
  });

  it('says which of a person’s details changed, never what they were or are; a passing is news (5.25)', () => {
    const aisha = { object_type: 'member', object_id: 'm-aisha', object_title: 'Aisha Khan' };
    const said = (action: string, actorMember: string, detail: Record<string, unknown>) =>
      describeEvent(
        ev({
          action,
          actor: actorMember === 'm-aisha' ? 'Aisha Khan' : 'Mansoor',
          ...aisha,
          actor_member_id: actorMember,
          detail,
        }),
      );
    expect(said('member.updated', 'm-mansoor', { fields: ['relationship'] })?.text).toBe(
      'Mansoor changed Aisha Khan’s relationship',
    );
    expect(
      said('member.updated', 'm-mansoor', { fields: ['display_name', 'date_of_birth'] })?.text,
    ).toBe('Mansoor changed Aisha Khan’s name and date of birth');
    expect(
      said('member.updated', 'm-aisha', {
        fields: ['display_name', 'date_of_birth', 'relationship'],
      })?.text,
    ).toBe('Aisha Khan changed their name, date of birth and relationship');
    // Anything else in it is not said, and no values are.
    expect(said('member.updated', 'm-mansoor', { fields: ['email', 42] })?.text).toBe(
      'Mansoor changed Aisha Khan’s details',
    );
    expect(said('member.updated', 'm-mansoor', {})?.notable).toBe(false);
    const passed = said('member.deceased', 'm-mansoor', { deceased: true });
    expect(passed).toMatchObject({
      text: 'Mansoor recorded that Aisha Khan has passed away',
      notable: true,
    });
    expect(said('member.deceased', 'm-mansoor', { deceased: false })).toMatchObject({
      text: 'Mansoor took back the record that Aisha Khan has passed away',
      notable: true,
    });
    // An owner's look at a sign-in: news, and nothing of what it showed.
    expect(said('member.account_viewed', 'm-mansoor', { email: 'x@example.test' })).toMatchObject({
      text: 'Mansoor looked at Aisha Khan’s sign-in',
      notable: true,
    });
    expect(said('member.account_viewed', 'm-aisha', {})?.text).toBe(
      'Aisha Khan looked at their own sign-in',
    );
  });

  it('says whose photo was added, changed or removed, and never anything of the picture (5.17c)', () => {
    const aisha = { object_type: 'member', object_id: 'm-aisha', object_title: 'Aisha' };
    const photo = (action: string, actorMember: string, detail: Record<string, unknown> = {}) =>
      describeEvent(
        ev({
          action,
          actor: actorMember === 'm-aisha' ? 'Aisha' : 'Mansoor',
          ...aisha,
          actor_member_id: actorMember,
          detail,
        }),
      )?.text;
    expect(photo('member.photo_changed', 'm-mansoor', { replaced: false })).toBe(
      'Mansoor added a photo of Aisha',
    );
    expect(photo('member.photo_changed', 'm-mansoor', { replaced: true })).toBe(
      'Mansoor changed Aisha’s photo',
    );
    expect(photo('member.photo_changed', 'm-aisha', { replaced: false })).toBe(
      'Aisha added their photo',
    );
    expect(photo('member.photo_changed', 'm-aisha', { replaced: true })).toBe(
      'Aisha changed their photo',
    );
    expect(photo('member.photo_removed', 'm-mansoor')).toBe('Mansoor removed Aisha’s photo');
    expect(photo('member.photo_removed', 'm-aisha')).toBe('Aisha removed their photo');
    // Nobody resolved, nobody named: still a sentence, and no id.
    const nobody = describeEvent(
      ev({
        action: 'member.photo_removed',
        actor: null,
        object_type: 'member',
        object_id: 'm-x',
        object_title: null,
      }),
    );
    expect(nobody?.text).toBe('Somebody removed somebody’s photo');
    expect(nobody?.document_id).toBeNull();
  });

  it('says a view-only link, and that its pages were looked at (5.18)', () => {
    expect(
      describeEvent(
        ev({ action: 'share.created', detail: { permission: 'view', recipient_label: 'the GP' } }),
      )?.text,
    ).toBe('Sarah made a view-only link to “Home insurance policy” for the GP');
    expect(
      describeEvent(ev({ action: 'share.created', detail: { permission: 'download' } }))?.text,
    ).toBe('Sarah made a link to “Home insurance policy”');
    expect(
      describeEvent(
        ev({ action: 'share.viewed', actor: null, actor_label: 'shared link (the GP)' }),
      )?.text,
    ).toBe('Shared link (the GP) looked at the pages of “Home insurance policy”');
  });

  it('says a collection was shared, and what followed it out, never how many (5.19)', () => {
    const aCollection = (over: Partial<ActivityEvent>) =>
      ev({
        object_type: 'collection',
        object_id: 'col-1',
        object_title: null,
        collection_name: 'For the lawyer',
        ...over,
      });
    expect(
      describeEvent(
        aCollection({
          action: 'share.created',
          detail: {
            recipient_label: 'Jane Smith',
            follow_collection: true,
            document_ids: ['doc-1', 'doc-2'],
          },
        }),
      )?.text,
    ).toBe(
      'Sarah made a link to the collection “For the lawyer” for Jane Smith, which keeps up with it',
    );
    expect(
      describeEvent(
        aCollection({
          action: 'share.opened',
          actor: null,
          actor_label: 'shared link (Jane Smith)',
        }),
      )?.text,
    ).toBe('Shared link (Jane Smith) opened the collection “For the lawyer”');
    expect(describeEvent(aCollection({ action: 'share.revoked' }))?.text).toBe(
      'Sarah took back a link to the collection “For the lawyer”',
    );
    expect(
      describeEvent(aCollection({ action: 'share.revoked', detail: { why: 'collection_deleted' } }))
        ?.text,
    ).toBe(
      'A link to the collection “For the lawyer” stopped working: Sarah deleted the collection',
    );
    expect(
      describeEvent(aCollection({ action: 'share.revoked', detail: { why: 'collection_only_me' } }))
        ?.text,
    ).toBe(
      'A link to the collection “For the lawyer” stopped working: Sarah made the collection Only me',
    );
    expect(describeEvent(aCollection({ action: 'share.resumed' }))?.text).toBe(
      'Sarah turned a link to the collection “For the lawyer” back on after a restore',
    );
    const followed = describeEvent(
      ev({ action: 'share.followed', collection_name: 'For the lawyer' }),
    );
    expect(followed).toMatchObject({
      text: 'Sarah put “Home insurance policy” in the collection “For the lawyer”, and a link that keeps up with it sent it outside the family',
      notable: true,
      document_id: 'doc-1',
    });
    // No line says how many went, nor gives an id.
    const said = describeEvent(
      aCollection({ action: 'share.created', detail: { document_ids: ['doc-1', 'doc-2'] } }),
    )?.text;
    expect(said).not.toMatch(/doc-|2|two/);
  });

  it('says an owner asked to remove a document for good, removed one, and that bringing it back kept it (5.24)', () => {
    const asked = describeEvent(ev({ action: 'document.purge_requested' }));
    expect(asked).toMatchObject({
      text: 'Sarah asked to remove “Home insurance policy” for good',
      notable: true,
      document_id: 'doc-1',
    });
    // Removed: no title (its row has gone, and the line carries none), and
    // nowhere to go.
    const removed = describeEvent(
      ev({ action: 'document.purged', object_title: null, detail: { versions: 2 } }),
    );
    expect(removed).toMatchObject({
      text: 'Sarah removed a document for good',
      notable: true,
      document_id: null,
    });
    expect(
      describeEvent(ev({ action: 'document.restored', detail: { cancelled_purge: true } })),
    ).toMatchObject({
      text: 'Sarah took “Home insurance policy” out of the Trash, so it will not be removed for good',
      notable: true,
    });
    expect(describeEvent(ev({ action: 'document.restored' }))).toMatchObject({
      text: 'Sarah took “Home insurance policy” out of the Trash',
      notable: false,
    });
  });

  it('never prints an id when it has no name', () => {
    const line = describeEvent(ev({ actor: null, actor_label: null, object_title: null }));
    expect(line?.text).toBe('Somebody downloaded a document');
    expect(line?.text).not.toMatch(/doc-1/);
  });

  it('leads the eye to the few that are worth noticing', () => {
    expect(describeEvent(base)?.notable).toBe(false);
    expect(describeEvent(ev({ action: 'vault.activated' }))?.notable).toBe(true);
    expect(describeEvent(ev({ action: 'export.requested' }))?.notable).toBe(true);
    expect(
      describeEvent(ev({ action: 'document.visibility_changed', detail: { to: 'private' } }))
        ?.notable,
    ).toBe(true);
    expect(
      describeEvent(ev({ action: 'document.visibility_changed', detail: { to: 'household' } }))
        ?.notable,
    ).toBe(false);
  });

  it('says what a visibility change means, not which enum it set', () => {
    const said = (to: string) =>
      describeEvent(ev({ action: 'document.visibility_changed', detail: { to } }))?.text;
    expect(said('private')).toMatch(/something only they can see/);
    expect(said('adults')).toMatch(/only the adults can see/);
    expect(said('household')).toMatch(/everyone in the family can see/);
    expect(said('private')).not.toMatch(/private|adults|household/);
  });

  it('says roles in words', () => {
    expect(
      describeEvent(
        ev({ action: 'member.role_changed', object_title: 'Sam', detail: { to: 'owner' } }),
      )?.text,
    ).toBe('Sarah changed what Sam can do: an owner');
  });

  it('leaves out what cannot be said in a sentence, rather than half-saying it', () => {
    // These are audited and stay in the chain; they are not news.
    for (const action of ['auth.stepped_up', 'reminder.snoozed', 'suggestion.dismiss']) {
      expect(describeEvent(ev({ action })), action).toBeNull();
    }
  });

  it('points at the document when there is one to open', () => {
    expect(describeEvent(base)?.document_id).toBe('doc-1');
    expect(describeEvent(ev({ object_type: 'member', object_id: 'm-1' }))?.document_id).toBeNull();
  });
});

describe('when things happened, in words', () => {
  const now = new Date('2026-09-22T20:00:00');
  it('uses the words people use', () => {
    expect(whenWords('2026-09-22T16:12:00', now)).toBe('today, 4:12pm');
    expect(whenWords('2026-09-21T16:12:00', now)).toBe('yesterday, 4:12pm');
    expect(whenWords('2026-09-18T09:05:00', now)).toBe('Friday, 9:05am');
    expect(whenWords('2026-08-02T09:05:00', now)).toBe('2 August, 9:05am');
    expect(whenWords('2025-08-02T09:05:00', now)).toBe('2 August 2025');
  });

  it('exactly, for a table or a history: the date and the time, however long ago (5.1)', () => {
    expect(whenExactly('2026-09-22T16:12:00')).toBe('22 Sept 2026, 4:12pm');
    expect(whenExactly('2025-08-02T09:05:00')).toBe('2 Aug 2025, 9:05am');
  });

  it('counts calendar days, so late last night is yesterday and not today', () => {
    const oneAm = new Date('2026-09-22T01:00:00');
    expect(whenWords('2026-09-21T23:30:00', oneAm)).toMatch(/^yesterday/);
  });
});

describe('a sitting with a document is one line (0.4.12)', () => {
  const at = (minutes: number) =>
    new Date(Date.UTC(2026, 8, 25, 12, 0) - minutes * 60_000).toISOString();
  const view = (id: number, minutesAgo: number, over: Partial<ActivityEvent> = {}) =>
    ev({ id, at: at(minutesAgo), action: 'document.viewed', actor_id: 'acct-sarah', ...over });

  it('pages looked through in one go are one line, the most recent', () => {
    const lines = describeEvents([view(5, 0), view(4, 1), view(3, 2), view(2, 9), view(1, 18)]);
    expect(lines.map((l) => [l.id, l.text])).toEqual([
      [5, 'Sarah looked at “Home insurance policy”'],
    ]);
  });

  it('a gap of more than ten minutes starts another sitting', () => {
    const lines = describeEvents([view(3, 0), view(2, 5), view(1, 16)]);
    expect(lines.map((l) => l.id)).toEqual([3, 1]);
  });

  it('another person, another document, or something shown in between is not the same sitting', () => {
    const lines = describeEvents([
      view(6, 0),
      view(5, 1, { actor_id: 'acct-other-sarah' }),
      view(4, 2, { object_id: 'doc-2', object_title: 'Passport' }),
      view(3, 3),
      ev({ id: 2, at: at(4), action: 'document.downloaded', actor_id: 'acct-sarah' }),
      view(1, 5),
    ]);
    expect(lines.map((l) => l.id)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('what is never shown does not break a sitting', () => {
    const lines = describeEvents([
      view(3, 0),
      ev({ id: 2, at: at(1), action: 'auth.step_up' }),
      view(1, 2),
    ]);
    expect(lines.map((l) => l.id)).toEqual([3]);
  });
});

describe('a phone keeping Essentials (0.4.13)', () => {
  it('says the phone kept it', () => {
    expect(describeEvent(ev({ action: 'document.cached_offline' }))?.text).toBe(
      'Sarah’s phone kept “Home insurance policy” for offline use',
    );
    expect(describeEvent(ev({ action: 'document.cached_offline', actor: 'Chris' }))?.text).toBe(
      'Chris’ phone kept “Home insurance policy” for offline use',
    );
  });

  it('says what was opened on it, and whether there was a connection', () => {
    const opened = (detail: Record<string, unknown>) =>
      describeEvent(ev({ action: 'document.opened_offline', detail }))?.text;
    expect(opened({ mode: 'view', online: false })).toBe(
      'Sarah opened “Home insurance policy” on their phone without a connection',
    );
    expect(opened({ mode: 'view', online: true })).toBe(
      'Sarah opened “Home insurance policy” on their phone',
    );
    expect(opened({ mode: 'show', online: false })).toBe(
      'Sarah showed “Home insurance policy” from their phone without a connection',
    );
  });
});

describe('kinds of document (0.5.10)', () => {
  const kind = (action: string, detail: Record<string, unknown>) =>
    describeEvent(
      ev({ action, object_type: 'document_type', object_id: null, object_title: null, detail }),
    );

  it('names the kind as it was called then, and never links to a document', () => {
    const made = kind('document_type.created', { key: 'h_abcdefghij', label: 'Allotment' });
    expect(made).toMatchObject({
      text: 'Sarah added a kind of document, “Allotment”',
      notable: false,
      document_id: null,
    });
    expect(kind('document_type.archived', { label: 'Allotment' })?.text).toBe(
      'Sarah archived “Allotment”',
    );
    expect(kind('document_type.archived', { label: 'Pet records', builtin: true })?.text).toBe(
      'Sarah stopped offering “Pet records”',
    );
    expect(kind('document_type.restored', { label: 'Pet records', builtin: true })?.text).toBe(
      'Sarah offered “Pet records” again',
    );
    expect(kind('document_type.deleted', {})?.text).toBe('Sarah deleted a kind of document');
  });

  it('letting more people see a kind is news; keeping it to fewer is not', () => {
    const widened = kind('document_type.updated', {
      label: 'Will',
      from: 'adults',
      default_visibility: 'household',
      widened: true,
    });
    expect(widened).toMatchObject({
      text: 'Sarah made new “Will” documents visible to everyone in the family',
      notable: true,
    });
    const narrowed = kind('document_type.updated', {
      label: 'Will',
      from: 'household',
      default_visibility: 'adults',
      widened: false,
    });
    expect(narrowed).toMatchObject({
      text: 'Sarah made new “Will” documents visible to the adults only',
      notable: false,
    });
    expect(kind('document_type.updated', { label: 'Will' })?.text).toBe('Sarah changed “Will”');
  });
});

describe('collections of documents (0.5.12)', () => {
  const about = (
    action: string,
    collection_name: string | null,
    over: Partial<ActivityEvent> = {},
  ) => describeEvent(ev({ action, collection_name, ...over }));

  it("names the collection as it is called now, and a document in it by the document's title", () => {
    const collectionLine = {
      object_type: 'collection',
      object_id: 'collection-1',
      object_title: null,
    };
    expect(about('collection.created', 'Holiday', collectionLine)).toMatchObject({
      text: 'Sarah made the collection “Holiday”',
      notable: false,
      document_id: null,
    });
    expect(about('collection.renamed', 'Holiday 2027', collectionLine)?.text).toBe(
      'Sarah renamed a collection, now “Holiday 2027”',
    );
    expect(about('collection.updated', 'Holiday', collectionLine)?.text).toBe(
      'Sarah changed the collection “Holiday”',
    );
    expect(about('collection.deleted', 'Holiday', collectionLine)?.text).toBe(
      'Sarah deleted the collection “Holiday”',
    );
    // A document put in one, or taken out, points at the document.
    expect(about('collection.item_added', 'Holiday')).toMatchObject({
      text: 'Sarah added “Home insurance policy” to the collection “Holiday”',
      document_id: 'doc-1',
    });
    expect(about('collection.item_removed', 'Holiday')?.text).toBe(
      'Sarah took “Home insurance policy” out of the collection “Holiday”',
    );
  });

  it('with no name to give, says "a collection" rather than an id', () => {
    for (const action of [
      'collection.created',
      'collection.renamed',
      'collection.updated',
      'collection.deleted',
    ]) {
      const line = about(action, null, { object_type: 'collection', object_id: 'collection-1' });
      expect(line?.text, action).toMatch(/a collection$/);
      expect(line?.text, action).not.toContain('collection-1');
    }
  });
});
