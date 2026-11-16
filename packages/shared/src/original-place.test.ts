import { describe, expect, it } from 'vitest';
import { missingFields } from './documents.js';
import { folderLabelUrl, placeWords, whereKeptWords } from './original-place.js';

/** Where the original is, as a place in a cabinet (0.9.0, C3). */
describe('a place in a cabinet', () => {
  const place = { path: ['Study cabinet', 'Drawer 2', 'Tax 2025'] as [string, string, string] };

  it('is said as one line, then the words written for it after a middle dot', () => {
    expect(placeWords(place)).toBe('Study cabinet › Drawer 2 › Tax 2025');
    expect(
      whereKeptWords({ original_place: place, physical_location: ' behind the divider ' }),
    ).toBe('Study cabinet › Drawer 2 › Tax 2025 · behind the divider');
    expect(whereKeptWords({ original_place: place, physical_location: null })).toBe(
      'Study cabinet › Drawer 2 › Tax 2025',
    );
    expect(whereKeptWords({ physical_location: 'Fire safe' })).toBe('Fire safe');
    expect(whereKeptWords({ original_place: null, physical_location: '  ' })).toBeNull();
  });

  it('is where the original is, for a kind that needs to know: with the words, or without them', () => {
    const kind = {
      key: 'deed',
      expiry_driver: null,
      core: { physical_location: { shown: true, required: true } },
    };
    expect(missingFields(kind, {}).map((m) => m.key)).toEqual(['physical_location']);
    expect(missingFields(kind, { original_place: ['A', 'B', 'C'] })).toEqual([]);
    expect(missingFields(kind, { original_place: place })).toEqual([]);
    expect(missingFields(kind, { physical_location: 'Safe' })).toEqual([]);
  });

  it('prints a label whose code is the vault’s own address for the folder, and nothing else', () => {
    expect(folderLabelUrl('https://vault.example', 'f-tax_25')).toBe(
      'https://vault.example/folder/f-tax_25',
    );
    expect(folderLabelUrl('https://vault.example/', 'a b')).toBe(
      'https://vault.example/folder/a%20b',
    );
  });
});
