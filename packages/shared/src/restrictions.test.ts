import { describe, expect, it } from 'vitest';
import { restrictionSummary, type RestrictionCounts } from './restrictions.js';

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
