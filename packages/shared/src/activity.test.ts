import { describe, expect, it } from 'vitest';
import { describeEvent, describeEvents, whenWords, type ActivityEvent } from './activity.js';

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
