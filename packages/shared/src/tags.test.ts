import { describe, expect, it } from 'vitest';
import {
  groupTags,
  looksSecret,
  normaliseTag,
  normaliseTags,
  secretTagWarning,
  TAG_MAX,
  tagDetail,
  tagKey,
  tagLabelKey,
  TAGS_MAX,
  tagsProblem,
  tagSuggestions,
  tagWords,
} from './tags.js';

describe('tags (0.9.0, T1)', () => {
  it('splits a detail tag at its first ": ", label and value trimmed', () => {
    expect(tagDetail('locker: 12')).toEqual({ label: 'locker', value: '12' });
    expect(tagDetail('  Policy  holder :   Ahmed  ')).toEqual({
      label: 'Policy holder',
      value: 'Ahmed',
    });
    // Only the first ": " splits: the rest is the value's.
    expect(tagDetail('note: see: page 2')).toEqual({ label: 'note', value: 'see: page 2' });
    // Both halves, or it is a plain tag.
    for (const plain of ['locker:', ': 12', 'locker:12', 'locker', '12:30', 'locker :']) {
      expect(tagDetail(plain)).toBeNull();
    }
    // A time with no space is no split; "a:b: c" splits at its ": ".
    expect(tagDetail('a:b: c')).toEqual({ label: 'a:b', value: 'c' });
  });

  it('keeps a plain tag in lower case, as always, and a detail value as written', () => {
    expect(normaliseTag('  Travel  ')).toBe('travel');
    expect(normaliseTag('Tax   2024')).toBe('tax 2024');
    expect(normaliseTag('Agent :  Sam   Lee')).toBe('agent: Sam Lee');
    expect(normaliseTag('LOCKER: 12')).toBe('locker: 12');
    expect(normaliseTag('   ')).toBe('');
  });

  it('a tag already kept without ": " is kept exactly as it was', () => {
    // What every vault before 0.9.0 wrote: trimmed and in lower case.
    for (const old of ['travel', 'id', 'house', 'tax', '2024', 'contract-batch', 'bills']) {
      expect(normaliseTag(old)).toBe(old);
      expect(tagDetail(old)).toBeNull();
      expect(tagWords(old)).toEqual({ text: old, spoken: old, label: null, value: null });
    }
    // And an older tag with ": " in it is a detail tag now, as it was written.
    expect(normaliseTag('locker: 12')).toBe('locker: 12');
  });

  it('treats tags that differ only in case as one on a document, keeping the first spelling', () => {
    expect(normaliseTags(['Travel', 'travel', ' ID '])).toEqual(['travel', 'id']);
    expect(normaliseTags(['agent: Sam Lee', 'Agent: sam lee', 'agent:  SAM LEE'])).toEqual([
      'agent: Sam Lee',
    ]);
    expect(normaliseTags(['', '  ', 'a'])).toEqual(['a']);
    expect(tagKey('Agent: Sam Lee')).toBe('agent: sam lee');
    expect(tagLabelKey(' Locker: ')).toBe('locker');
  });

  it('refuses in plain words a tag too long, and too many', () => {
    expect(tagsProblem(['x'.repeat(TAG_MAX)])).toBeNull();
    expect(tagsProblem([`${'x'.repeat(TAG_MAX)}  `])).toBeNull();
    expect(tagsProblem(['x'.repeat(TAG_MAX + 1)])).toBe(
      `A tag can be ${TAG_MAX} characters at most: “${'x'.repeat(24)}…” is ${TAG_MAX + 1}.`,
    );
    const many = Array.from({ length: TAGS_MAX + 1 }, (_, i) => `t${i}`);
    expect(tagsProblem(many)).toBe(
      `A document can carry ${TAGS_MAX} tags at most: this would be ${TAGS_MAX + 1}.`,
    );
    // Counted once they are one: the same tag twice is one.
    expect(tagsProblem([...many.slice(0, TAGS_MAX), 'T0'])).toBeNull();
  });

  it('shows a detail tag as "Locker · 12", read aloud as "Locker: 12"', () => {
    expect(tagWords('locker: 12')).toEqual({
      text: 'Locker · 12',
      spoken: 'Locker: 12',
      label: 'Locker',
      value: '12',
    });
    expect(tagWords('policy holder: Ahmed').text).toBe('Policy holder · Ahmed');
  });

  it('says when a label looks like a secret, and only then', () => {
    for (const secret of [
      'password: hunter2',
      'PIN: 4821',
      'pin code: 1234',
      'passcode: 0000',
      'Security code: 123',
      'wifi password: x',
      'card pin: 1',
      'pin 4821',
    ]) {
      expect(looksSecret(secret), secret).toBe(true);
    }
    for (const fine of ['locker: 12', 'pinboard: hall', 'pin', 'passport', 'travel', 'pins']) {
      expect(looksSecret(fine), fine).toBe(false);
    }
    expect(secretTagWarning('pin: 4821')).toMatch(/^“Pin” looks like a secret\./);
    expect(secretTagWarning('pin: 4821')).toMatch(/keep passwords and PINs in an Only me note/);
  });

  it('offers the values used for a label after "label: ", and tags by their start', () => {
    const known = [
      { tag: 'locker: 12', count: 3 },
      { tag: 'locker: 7', count: 1 },
      { tag: 'agent: Sam Lee', count: 2 },
      { tag: 'travel', count: 5 },
      { tag: 'tax', count: 4 },
    ];
    expect(tagSuggestions('locker: ', known, [])).toEqual(['locker: 12', 'locker: 7']);
    expect(tagSuggestions('Locker: 1', known, [])).toEqual(['locker: 12']);
    expect(tagSuggestions('locker: 12', known, [])).toEqual([]);
    expect(tagSuggestions('agent: s', known, [])).toEqual(['agent: Sam Lee']);
    expect(tagSuggestions('t', known, [])).toEqual(['travel', 'tax']);
    expect(tagSuggestions('lo', known, ['locker: 12'])).toEqual(['locker: 7']);
    expect(tagSuggestions('', known, [])).toEqual([]);
  });

  it('groups detail tags by label for Settings', () => {
    const g = groupTags([
      { tag: 'travel', count: 2 },
      { tag: 'locker: 7', count: 1 },
      { tag: 'locker: 12', count: 3 },
      { tag: 'agent: Sam Lee', count: 1 },
    ]);
    expect(g.plain.map((t) => t.tag)).toEqual(['travel']);
    expect(g.labels.map((l) => [l.label, l.count, l.tags.map((t) => t.tag)])).toEqual([
      ['Agent', 1, ['agent: Sam Lee']],
      ['Locker', 4, ['locker: 12', 'locker: 7']],
    ]);
  });
});
