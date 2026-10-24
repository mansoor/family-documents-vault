import { describe, expect, it } from 'vitest';
import { describeEvent } from './activity.js';
import {
  CHECKLIST_BY_TITLE_NOTE,
  CHECKLIST_NO_LONGER_NEEDED_NOTE,
  checkChecklist,
  readChecklist,
  type ChecklistContext,
  type ChecklistDoc,
} from './checklist.js';
import { STATUS_ORDER, statusRank } from './document-table.js';
import { deriveStatus, NO_LONGER_NEEDED_LABEL } from './documents.js';
import { FIXTURE_KINDS } from './testdata/index.js';
import { statusTone } from './tokens.js';

/**
 * No longer needed (0.9.0): its status says so whatever its expiry, plainly
 * and never in warning; it is last of the statuses; a checklist line asking
 * for a current or valid one passes it by, and a plain line finds it with
 * a note; and the activity log says it in a sentence.
 */

const VISA = { key: 'visa', expiry_driver: 'expires_on', reminder_leads: [120, 30] };
const on = (date: string) => ({ date, precision: 'day' as const });

describe('its status', () => {
  it('is No longer needed, expired or expiring or lacking a detail', () => {
    for (const expires of [on('2026-01-01'), on('2026-11-01'), on('2030-01-01'), null]) {
      expect(
        deriveStatus(
          { type: VISA, owner_member_id: 'm', expires, no_longer_needed: true },
          '2026-10-23',
        ),
      ).toEqual({ value: 'no_longer_needed', label: NO_LONGER_NEEDED_LABEL });
    }
    // Needed, it is what its expiry says, as before.
    expect(
      deriveStatus({ type: VISA, owner_member_id: 'm', expires: on('2026-01-01') }, '2026-10-23')
        .value,
    ).toBe('expired');
  });

  it('is said plainly — neutral, never a warning — and sorts last but what is missing', () => {
    expect(statusTone({ value: 'no_longer_needed', label: 'No longer needed' })).toEqual({
      tone: 'neutral',
      icon: 'info',
      words: 'No longer needed',
    });
    expect(statusRank('no_longer_needed')).toBeGreaterThan(statusRank('valid'));
    expect(STATUS_ORDER.at(-1)).toBe('missing');
  });
});

describe('a checklist (C1, C2)', () => {
  const ctx: ChecklistContext = {
    types: FIXTURE_KINDS,
    people: [{ id: 'm-mansoor', name: 'Mansoor' }],
    me: 'm-mansoor',
    today: '2026-10-23',
  };
  const opts = { today: ctx.today, audience: 'everyone', people: ctx.people, types: FIXTURE_KINDS };
  const doc = (o: Partial<ChecklistDoc> & { id: string }): ChecklistDoc => ({
    title: o.id,
    type_key: 'passport',
    owner_member_id: 'm-mansoor',
    visibility: 'household',
    issued: null,
    expires: null,
    created_at: '2026-10-01T00:00:00.000Z',
    tax_year: null,
    in_collection: false,
    ...o,
  });
  const unneeded = doc({
    id: 'old-pp',
    title: 'Mansoor’s old passport',
    issued: on('2024-01-01'),
    expires: on('2034-01-01'),
    no_longer_needed: true,
  });

  it('"current passport" passes by one no longer needed, however long it has left', () => {
    const [current] = checkChecklist(
      readChecklist("Mansoor's current passport", ctx).items,
      [unneeded],
      opts,
    );
    expect(current?.matches).toEqual([]);
    expect(current?.missing).toEqual(['a current passport, Mansoor’s']);
    for (const words of ["Mansoor's valid passport", "Mansoor's passport, still valid"]) {
      expect(checkChecklist(readChecklist(words, ctx).items, [unneeded], opts)[0]?.matches).toEqual(
        [],
      );
    }
    // One still needed is found as before.
    const needed = doc({ id: 'pp', issued: on('2024-02-01'), expires: on('2034-02-01') });
    expect(
      checkChecklist(
        readChecklist("Mansoor's current passport", ctx).items,
        [unneeded, needed],
        opts,
      )[0]?.matches.map((m) => [m.document_id, m.ticked]),
    ).toEqual([['pp', true]]);
  });

  it('a plain line still finds it, and says it is no longer needed', () => {
    const [plain] = checkChecklist(
      readChecklist("Mansoor's passport", ctx).items,
      [unneeded],
      opts,
    );
    expect(plain?.matches.map((m) => [m.document_id, m.ticked, m.note])).toEqual([
      ['old-pp', true, CHECKLIST_NO_LONGER_NEEDED_NOTE],
    ]);
  });

  it('by its title: "current" passes it by, a plain line finds it with both notes', () => {
    const ead = doc({ id: 'ead', title: 'Mansoor’s Zorblat card', type_key: 'visa' });
    const marked = { ...ead, no_longer_needed: true };
    const plain = checkChecklist(readChecklist('zorblat card', ctx).items, [marked], opts)[0];
    expect(plain?.matches.map((m) => m.note)).toEqual([
      `${CHECKLIST_NO_LONGER_NEEDED_NOTE} · ${CHECKLIST_BY_TITLE_NOTE}`,
    ]);
    const current = checkChecklist(
      readChecklist('current zorblat card', ctx).items,
      [marked],
      opts,
    )[0];
    expect(current?.matches ?? []).toEqual([]);
  });
});

describe('the activity log', () => {
  const event = (action: string) => ({
    id: 1,
    at: '2026-10-23T10:00:00Z',
    action,
    actor: 'Mansoor',
    actor_label: null,
    object_type: 'document',
    object_id: 'ead',
    object_title: 'EAD card',
    detail: {},
  });
  it('says each in a sentence, and never why nor what replaced it', () => {
    expect(describeEvent(event('document.no_longer_needed'))?.text).toBe(
      'Mansoor marked “EAD card” no longer needed',
    );
    expect(describeEvent(event('document.needed_again'))?.text).toBe(
      'Mansoor marked “EAD card” needed again',
    );
  });
});
