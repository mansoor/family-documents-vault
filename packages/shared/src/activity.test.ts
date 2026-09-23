import { describe, expect, it } from 'vitest';
import { describeEvent, whenWords, type ActivityEvent } from './activity.js';

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
