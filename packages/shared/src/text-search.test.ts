import { describe, expect, it } from 'vitest';
import { matchText, parseQuery, words } from './text-search.js';

const TEXT =
  'Policy number 4471-QB, effective from 1 March 2026. Insured: Mansoor Seikh. ' +
  'Covers the dwelling and personal property up to £250,000. Excess £500 per claim. ' +
  'Renewal date 1 March 2027. Contact Riverside Mutual on 0800 555 0110.';

const match = (q: string, text = TEXT) => matchText(text, parseQuery(q));

describe('parseQuery', () => {
  it('ANDs words and keeps quoted phrases together', () => {
    expect(parseQuery('policy number')).toEqual({
      groups: [['policy'], ['number']],
      exclude: [],
    });
    expect(parseQuery('"renewal date" policy')).toEqual({
      groups: [['renewal date'], ['policy']],
      exclude: [],
    });
  });

  it('makes `or` join its neighbours, as websearch_to_tsquery does', () => {
    expect(parseQuery('passport or visa')).toEqual({
      groups: [['passport', 'visa']],
      exclude: [],
    });
    expect(parseQuery('mansoor passport or visa')).toEqual({
      groups: [['mansoor'], ['passport', 'visa']],
      exclude: [],
    });
  });

  it('takes `-` as "not this"', () => {
    expect(parseQuery('policy -renewal')).toEqual({ groups: [['policy']], exclude: ['renewal'] });
  });

  it('is not confused by punctuation, case or a stray quote', () => {
    expect(words('Policy 4471-QB.')).toEqual(['policy', '4471', 'qb']);
    expect(parseQuery('  POLICY   ')).toEqual({ groups: [['policy']], exclude: [] });
    expect(parseQuery('"unclosed')).toEqual({ groups: [['unclosed']], exclude: [] });
    expect(parseQuery('')).toEqual({ groups: [], exclude: [] });
  });
});

describe('matchText', () => {
  it('finds every word of the query, in any order', () => {
    expect(match('policy number')).not.toBeNull();
    expect(match('number policy')).not.toBeNull();
    expect(match('policy elephant')).toBeNull();
  });

  it('an empty query matches nothing rather than everything', () => {
    expect(match('')).toBeNull();
    expect(match('   ')).toBeNull();
  });

  it('matches whole words only, so "art" is not found inside "part"', () => {
    expect(matchText('spare part', parseQuery('art'))).toBeNull();
    expect(matchText('spare part', parseQuery('part'))).not.toBeNull();
  });

  it('a phrase must appear as a phrase', () => {
    expect(match('"renewal date"')).not.toBeNull();
    expect(match('"date renewal"')).toBeNull();
  });

  it('honours or and not', () => {
    expect(match('4471 or 9999')).not.toBeNull();
    expect(match('9999 or 8888')).toBeNull();
    expect(match('policy -riverside')).toBeNull();
    expect(match('policy -elephant')).not.toBeNull();
  });

  it('wraps what matched, in the original spelling, with context around it', () => {
    const m = match('4471');
    expect(m?.snippet).toContain('<em>4471</em>');
    // The case and punctuation of the document survive.
    expect(m?.snippet).toContain('Policy number');
    expect(m?.hits).toBe(1);
  });

  it('marks every occurrence and counts them', () => {
    const m = matchText('Rent due. Rent paid. Rent again.', parseQuery('rent'));
    expect(m?.hits).toBe(3);
    expect(m?.snippet.match(/<em>Rent<\/em>/g)).toHaveLength(3);
  });

  it('trims a long document to a window, with ellipses where it cut', () => {
    const long = `${'word '.repeat(200)}needle ${'word '.repeat(200)}`;
    const m = matchText(long, parseQuery('needle'));
    expect(m?.snippet.startsWith('…')).toBe(true);
    expect(m?.snippet.endsWith('…')).toBe(true);
    expect(m?.snippet).toContain('<em>needle</em>');
    expect(words((m?.snippet ?? '').replace(/<\/?em>/g, ''))).toHaveLength(18);
  });

  it('a match at the very start is not padded with a leading ellipsis', () => {
    const m = matchText('Needle in a haystack of words', parseQuery('needle'));
    expect(m?.snippet.startsWith('<em>Needle</em>')).toBe(true);
  });

  it('does not escape the text: the client does that, then re-allows <em>', () => {
    // Same contract as ts_headline, whose output is handled identically.
    const m = matchText('a <script> tag and a needle', parseQuery('needle'));
    expect(m?.snippet).toContain('<script>');
  });
});
