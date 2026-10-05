import { describe, expect, it } from 'vitest';
import {
  restrictionSummary,
  youCanSee,
  type NamedGrant,
  type RestrictionCounts,
} from './restrictions.js';

const base: RestrictionCounts = {
  people: 0,
  types: 0,
  collections: 0,
  include_adults_only: false,
  include_no_person_docs: false,
  expires_at: null,
};
const say = (r: Partial<RestrictionCounts>) => restrictionSummary({ ...base, ...r }, 'UTC');

describe('a restriction in a sentence (5.32)', () => {
  it('counts what it names', () => {
    expect(say({ people: 1, types: 2, collections: 1 })).toBe(
      "Restricted: sees 1 person's documents of 2 kinds and 1 collection.",
    );
    expect(say({ types: 3, include_no_person_docs: true })).toBe(
      "Restricted: sees everyone's documents of 3 kinds and those that belong to no one.",
    );
    expect(say({})).toBe('Restricted: sees nothing of anyone else’s.');
  });

  it('a kind or a person named and deleted since is said to give nothing, never "any" (N532T-01)', () => {
    // People named, and every kind named deleted: nothing by person or kind.
    expect(say({ people: 2, types: 0, limits_people: true, limits_types: true })).toBe(
      'Restricted: sees nothing of anyone else’s. Every kind it named has been deleted, so it gives no documents by person or kind.',
    );
    // With the checkbox too, and a collection left: only the collection.
    expect(
      say({
        people: 1,
        limits_people: true,
        limits_types: true,
        include_no_person_docs: true,
        collections: 1,
      }),
    ).toBe(
      'Restricted: sees 1 collection. Every kind it named has been deleted, so it gives no documents by person or kind.',
    );
    // Kinds named, and every person named removed: not "everyone's".
    expect(say({ people: 0, types: 1, limits_people: true, limits_types: true })).toBe(
      'Restricted: sees nothing of anyone else’s. Everyone it named has been removed, so it gives none of their documents.',
    );
    // Nobody's documents still come with the checkbox, of the kinds named.
    expect(
      say({
        people: 0,
        types: 1,
        limits_people: true,
        limits_types: true,
        include_no_person_docs: true,
      }),
    ).toBe(
      'Restricted: sees documents of 1 kind that belong to no one. Everyone it named has been removed, so it gives none of their documents.',
    );
    // Without the flags, as many as are counted: as before.
    expect(say({ types: 1 })).toBe("Restricted: sees everyone's documents of 1 kind.");
  });
});

describe('what a restricted viewer can see, in their words (5.33)', () => {
  const none: NamedGrant = {
    people: [],
    types: [],
    collections: [],
    include_no_person_docs: false,
    expires_at: null,
  };
  const see = (r: Partial<NamedGrant>, now = Date.parse('2026-10-04T12:00:00Z')) =>
    youCanSee({ ...none, ...r }, 'UTC', now);

  it('names the people, the kinds and the collections, and their own', () => {
    expect(see({ people: [{ display_name: 'Ahmed' }], types: [{ label: 'Tax return' }] })).toBe(
      'You can see: Tax return documents for Ahmed and your own.',
    );
    expect(
      see({
        people: [{ display_name: 'Ahmed' }, { display_name: 'Sara' }],
        collections: [{ name: 'For the accountant' }],
      }),
    ).toBe(
      'You can see: documents for Ahmed and Sara, the collection “For the accountant” and your own.',
    );
    expect(see({ types: [{ label: 'Will' }], include_no_person_docs: true })).toBe(
      'You can see: Will documents, Will documents that belong to no one and your own.',
    );
    expect(see({})).toBe('You can see: only your own documents.');
  });

  it('a kind or a person deleted since is never read as "any" (R532-01)', () => {
    // Every kind named gone: nothing by person or kind, nobody's included.
    expect(
      see({
        people: [{ display_name: 'Ahmed' }],
        limits_types: true,
        include_no_person_docs: true,
      }),
    ).toBe('You can see: only your own documents.');
    // Everyone named gone: nobody's still, of the kinds named.
    expect(
      see({ types: [{ label: 'Will' }], limits_people: true, include_no_person_docs: true }),
    ).toBe('You can see: Will documents that belong to no one and your own.');
  });

  it('says when it ends, and that it has', () => {
    expect(see({ people: [{ display_name: 'Ahmed' }], expires_at: '2026-10-05T09:00:00Z' })).toBe(
      'You can see: documents for Ahmed and your own. Until Monday 5 October at 09:00.',
    );
    expect(see({ people: [{ display_name: 'Ahmed' }], expires_at: '2026-10-04T11:00:00Z' })).toBe(
      'An owner limited what you can see, and it has ended: you see nothing for now.',
    );
  });
});
