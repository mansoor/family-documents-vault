import { describe, expect, it } from 'vitest';
import {
  folderQuestionWords,
  mergeFolderFilters,
  type CabinetFolder,
  type CabinetLevel,
} from './cabinet.js';
import { addToDrawing, drawCabinet, mergeSameIssuers, type CabinetGroup } from './cabinet-draw.js';
import {
  dividerAsks,
  dividerKeyOf,
  paperBehind,
  shownDividers,
  type DividerPaper,
} from './cabinet-dividers.js';
import {
  apartPair,
  isIssuerKey,
  issuerGroupsOf,
  aliasMap,
  issuerRoot,
  joinAliases,
  leavingKey,
  NO_ISSUER,
  separateAliases,
  type AliasRow,
  NO_ISSUER_GIVEN,
  sameAsSuggestions,
  storedIssuerKey,
  type IssuerName,
} from './issuer-groups.js';
import { issuerKey } from './issuers.js';

/**
 * Who issued it as a cabinet level (0.9.0-dev.91): the key the vault keeps,
 * the household's "Same as" list, its suggestions, and drawing and dividing
 * by it — what the vault, the client's fake and the web share.
 */

const names: IssuerName[] = [
  { key: 'barclays', name: 'Barclays', count: 14 },
  { key: 'barclays bank uk', name: 'Barclays Bank UK', count: 3 },
  { key: 'hsbc', name: 'HSBC', count: 2 },
  { key: 'hsbc uk', name: 'HSBC UK', count: 2 },
  { key: 'santander', name: 'Santander', count: 1 },
  { key: 'santander consumer finance', name: 'Santander Consumer Finance', count: 4 },
  { key: 'aviva', name: 'Aviva', count: 1 },
];

describe('the key the vault keeps', () => {
  it('is issuerKey’s, the text itself where nothing is left, null for none, and never too long for its index', () => {
    for (const v of [
      'Barclays Bank UK PLC',
      'The Co-operative Bank p.l.c.',
      'Société Générale',
      'İstanbul Bankası',
      'Zürich Insurance Group',
      '東京電力',
      'بنك مسقط',
    ]) {
      expect(storedIssuerKey(v)).toBe(issuerKey(v));
      expect(isIssuerKey(storedIssuerKey(v) as string)).toBe(true);
    }
    for (const v of ['', '   ', null, undefined]) expect(storedIssuerKey(v)).toBeNull();
    // Nothing left to compare: the text itself, so it is never "No issuer given".
    expect(storedIssuerKey('Ltd')).toBe('ltd');
    expect(storedIssuerKey('  —  ')).toBe('—');
    expect(storedIssuerKey('---, ---')).toBe('--- ---');
    expect(storedIssuerKey(',')).toBe('-');
    for (const v of ['Ltd', '—', '---, ---', ',']) {
      expect(isIssuerKey(storedIssuerKey(v) as string), v).toBe(true);
    }
    // A ligature or a sign folds into several characters: cut, never refused.
    const long = storedIssuerKey('ﷺ'.repeat(200)) as string;
    expect(Array.from(long).length).toBeLessThanOrEqual(400);
    expect(isIssuerKey(long)).toBe(true);
  });

  it('is told from what is not one', () => {
    expect(isIssuerKey('barclays bank uk')).toBe(true);
    expect(isIssuerKey('ltd.')).toBe(true);
    for (const v of [
      '',
      'Barclays',
      'barclays  bank',
      ' barclays',
      'barclays,hsbc',
      'a\tb',
      NO_ISSUER,
    ]) {
      expect(isIssuerKey(v), v).toBe(false);
    }
  });
});

describe('the household’s “Same as” list', () => {
  it('groups each key under the one it is said to be, named by its own key’s spelling', () => {
    const groups = issuerGroupsOf(names, new Map([['barclays bank uk', 'barclays']]));
    const barclays = groups.find((g) => g.key === 'barclays');
    expect(barclays).toEqual({
      key: 'barclays',
      name: 'Barclays',
      count: 17,
      members: [{ key: 'barclays bank uk', name: 'Barclays Bank UK', count: 3 }],
    });
    expect(groups.map((g) => g.name)).toEqual([
      'Aviva',
      'Barclays',
      'HSBC',
      'HSBC UK',
      'Santander',
      'Santander Consumer Finance',
    ]);
    // Its own key on no paper the reader can read: known by, and named
    // after, the key they have most papers of — never told its own.
    const unseen = issuerGroupsOf(
      [...names.slice(1, 2), { key: 'barclays uk', name: 'Barclays UK', count: 1 }],
      new Map([
        ['barclays bank uk', 'barclays'],
        ['barclays uk', 'barclays'],
      ]),
    );
    expect(unseen).toEqual([
      {
        key: 'barclays bank uk',
        name: 'Barclays Bank UK',
        count: 4,
        members: [{ key: 'barclays uk', name: 'Barclays UK', count: 1 }],
      },
    ]);
    expect(JSON.stringify(unseen)).not.toContain('"barclays"');
  });

  it('suggests by leading words, the smaller into the bigger, never two said separate', () => {
    const groups = issuerGroupsOf(names, new Map());
    const pairs = (apart: Array<[string, string]> = [], aliases = new Map<string, string>()) =>
      sameAsSuggestions(groups, apart, aliases).map((s) => `${s.from.key} → ${s.to.key}`);
    expect(pairs()).toEqual([
      'barclays bank uk → barclays',
      'santander → santander consumer finance',
      'hsbc uk → hsbc',
    ]);
    // Said separate, either way round: not again.
    expect(pairs([apartPair('santander consumer finance', 'santander')])).toEqual([
      'barclays bank uk → barclays',
      'hsbc uk → hsbc',
    ]);
    // Kept apart by keys whose groups are known by others now: still apart.
    const known = issuerGroupsOf(
      names.filter((n) => n.key !== 'santander'),
      new Map([['santander uk', 'santander']]),
    );
    expect(
      sameAsSuggestions(
        known,
        [apartPair('santander', 'santander consumer finance')],
        new Map([['santander uk', 'santander']]),
      ).some((s) => s.to.key === 'santander consumer finance'),
    ).toBe(false);
    // Joined already: nothing to suggest.
    const joined = issuerGroupsOf(names, new Map([['barclays bank uk', 'barclays']]));
    expect(sameAsSuggestions(joined).some((s) => s.from.key === 'barclays bank uk')).toBe(false);
  });

  it('stays one level deep: a group joined to another moves whole, and comes back whole', () => {
    let rows: AliasRow[] = joinAliases([], 'hsbc uk', 'hsbc');
    expect(rows).toEqual([{ from: 'hsbc uk', to: 'hsbc', path: [] }]);
    rows = joinAliases(rows, 'hsbc', 'barclays');
    expect(rows).toEqual([
      { from: 'hsbc uk', to: 'barclays', path: ['hsbc'] },
      { from: 'hsbc', to: 'barclays', path: [] },
    ]);
    // Joined through a key said to be the same as another: its group's own key.
    rows = joinAliases(rows, 'santander', 'hsbc uk');
    const aliases = aliasMap(rows);
    expect(aliases.get('santander')).toBe('barclays');
    // One already: nothing changes.
    expect(joinAliases(rows, 'hsbc', 'hsbc uk')).toEqual(rows);
    for (const to of aliases.values()) expect(aliases.has(to)).toBe(false);
    expect(issuerRoot('hsbc uk', aliases)).toBe('barclays');
    expect(issuerRoot('aviva', aliases)).toBe('aviva');
    // HSBC separated from Barclays: HSBC UK, which it brought, comes back with it.
    expect(leavingKey(aliases, 'barclays', 'hsbc')).toBe('hsbc');
    expect(leavingKey(aliases, 'hsbc', 'aviva')).toBeNull();
    const apart = separateAliases(rows, 'hsbc');
    expect(aliasMap(apart)).toEqual(
      new Map([
        ['hsbc uk', 'hsbc'],
        ['santander', 'barclays'],
      ]),
    );
    expect(apart.find((r) => r.from === 'hsbc uk')?.path).toEqual([]);
    // Two levels of joins, undone one at a time.
    let deep = joinAliases(joinAliases(joinAliases([], 'y', 'm'), 'm', 'f'), 'f', 't');
    expect(aliasMap(deep)).toEqual(
      new Map([
        ['y', 't'],
        ['m', 't'],
        ['f', 't'],
      ]),
    );
    deep = separateAliases(deep, 'f');
    expect(aliasMap(deep)).toEqual(
      new Map([
        ['y', 'f'],
        ['m', 'f'],
      ]),
    );
    deep = separateAliases(deep, 'm');
    expect(aliasMap(deep)).toEqual(new Map([['y', 'm']]));
  });

  it('brings back what a key brought, however deep the joins since', () => {
    // A joins B; B joins C; C joins D.
    const abcd = joinAliases(joinAliases(joinAliases([], 'a', 'b'), 'b', 'c'), 'c', 'd');
    expect(abcd).toEqual([
      { from: 'a', to: 'd', path: ['c', 'b'] },
      { from: 'b', to: 'd', path: ['c'] },
      { from: 'c', to: 'd', path: [] },
    ]);
    // B, from the middle: A goes back with it, and C stays with D.
    expect(separateAliases(abcd, 'b')).toEqual([
      { from: 'a', to: 'b', path: [] },
      { from: 'c', to: 'd', path: [] },
    ]);
    // C, the top: A and B go back with it, A still remembering B.
    const top = separateAliases(abcd, 'c');
    expect(top).toEqual([
      { from: 'a', to: 'c', path: ['b'] },
      { from: 'b', to: 'c', path: [] },
    ]);
    // And then B from C: A goes with B.
    expect(separateAliases(top, 'b')).toEqual([{ from: 'a', to: 'b', path: [] }]);
    // A itself, from anywhere: it alone leaves.
    expect(aliasMap(separateAliases(abcd, 'a'))).toEqual(
      new Map([
        ['b', 'd'],
        ['c', 'd'],
      ]),
    );
  });
});

describe('a cabinet drawn by who issued it', () => {
  const groups: CabinetGroup[] = [
    {
      person: 'me',
      category: 'financial',
      type_key: 'bank_statement',
      year: 2026,
      issuer: 'barclays',
      n: 3,
    },
    {
      person: 'me',
      category: 'financial',
      type_key: 'bank_statement',
      year: 2026,
      issuer: 'hsbc',
      n: 1,
    },
    { person: 'me', category: 'financial', type_key: 'payslip', year: 2026, issuer: null, n: 2 },
    { person: 'me', category: null, type_key: null, year: 2026, n: 1 },
  ];
  const named = {
    person: () => 'Me',
    kind: (k: string) => k,
    issuer: (k: string) => ({ barclays: 'Barclays', hsbc: 'HSBC' })[k] ?? k,
    personOrder: () => 0,
  };
  let n = 0;
  const id = () => `n${++n}`;

  it('makes a group for each issuer and one for none given, last, never leaving them out', () => {
    const d = drawCabinet(['issuer', 'person'], groups, named, id);
    const drawers = d.layout.cabinets[0]?.drawers ?? [];
    expect(drawers.map((x) => x.name)).toEqual(['Barclays', 'HSBC', NO_ISSUER_GIVEN]);
    expect(drawers.map((x) => x.folders[0]?.filter.issuer)).toEqual([
      'barclays',
      'hsbc',
      NO_ISSUER,
    ]);
    expect(d.left_out).toBe(0);
    // Topic keeps its rule: a paper with none has no folder yet.
    expect(drawCabinet(['topic', 'issuer'], groups, named, id).left_out).toBe(1);
  });

  it('grows a folder for an issuer new to it, in its order', () => {
    const d = drawCabinet(['topic', 'issuer', 'person'], groups.slice(0, 1), named, id);
    const grown = addToDrawing(
      d.layout,
      [
        {
          person: 'me',
          category: 'financial',
          type_key: 'loan',
          year: 2026,
          issuer: 'aviva',
          n: 1,
        },
      ],
      { ...named, issuer: (k: string) => (k === 'aviva' ? 'Aviva' : named.issuer(k)) },
      id,
    );
    expect(grown.added).toBe(1);
    expect(grown.layout.cabinets[0]?.drawers.map((x) => x.name)).toEqual(['Aviva', 'Barclays']);
  });

  it('asks its folders in words by the household’s names', () => {
    const words = (issuer: string) =>
      folderQuestionWords({ issuer, category: 'financial' }, { ...named, issuer: named.issuer });
    expect(words('barclays')).toBe('Financial papers from Barclays.');
    expect(words(NO_ISSUER)).toBe('Financial papers with no issuer given.');
    expect(words(`barclays,${NO_ISSUER}`)).toBe(
      'Financial papers from Barclays or with no issuer given.',
    );
    // Two folders of issuers merge into one asking both.
    expect(mergeFolderFilters({ issuer: 'barclays' }, { issuer: 'hsbc' })).toEqual({
      issuer: 'barclays,hsbc',
    });
  });
});

describe('a folder divided by who issued it', () => {
  const folder: Pick<CabinetFolder, 'filter' | 'dividers'> = {
    filter: { category: 'financial' },
    dividers: { levels: ['issuer'], ranges: [] },
  };
  const paper = (issuer: string | null): DividerPaper => ({
    day: '2026-03-01',
    type_key: 'bank_statement',
    category: 'financial',
    person: 'me',
    issuer,
  });

  it('keys each paper by its issuer, none given as an empty step', () => {
    expect(dividerKeyOf(folder, paper('barclays'))).toBe('issuer:barclays');
    expect(dividerKeyOf(folder, paper(null))).toBe('issuer:');
  });

  it('names its dividers as the household names them, none given last, one group passed over', () => {
    const counts = new Map([
      ['issuer:', 2],
      ['issuer:hsbc', 1],
      ['issuer:barclays', 3],
    ]);
    const shown = shownDividers(folder, counts, {
      person: (x) => x,
      kind: (x) => x,
      issuer: (k) => ({ barclays: 'Barclays', hsbc: 'HSBC' })[k] ?? k,
    });
    expect(shown.map((d) => [d.key, d.name, d.count])).toEqual([
      ['issuer:barclays', 'Barclays', 3],
      ['issuer:hsbc', 'HSBC', 1],
      ['issuer:', NO_ISSUER_GIVEN, 2],
    ]);
    expect(shown[0]?.path).toEqual([{ level: 'issuer', key: 'issuer:barclays', name: 'Barclays' }]);
    // One issuer only: passed over, one plain list.
    expect(shownDividers(folder, new Map([['issuer:hsbc', 4]])).map((d) => d.key)).toEqual(['all']);
  });

  it('asks one divider as the vault and the fakes read it', () => {
    const ask = dividerAsks(folder, 'issuer:barclays');
    expect(ask).toEqual({ atoms: [{ level: 'issuer', value: 'barclays' }] });
    expect(paperBehind(ask as never, paper('barclays'))).toBe(true);
    expect(paperBehind(ask as never, paper('hsbc'))).toBe(false);
    const none = dividerAsks(folder, 'issuer:');
    expect(paperBehind(none as never, paper(null))).toBe(true);
    expect(dividerAsks(folder, 'kind:bank_statement')).toBeNull();
  });
});

describe('a drawn cabinet made one where issuers were said to be the same', () => {
  const root = (k: string) => (k === 'barclays bank uk' ? 'barclays' : k);
  const folder = (
    id: string,
    issuer: string,
    more: Partial<CabinetFolder> = {},
  ): CabinetFolder => ({
    id,
    name: id,
    hidden: false,
    filter: { notes: 'exclude', category: 'financial', issuer },
    dividers: { levels: ['year'], ranges: [] },
    ...more,
  });

  it('merges the folders of one issuer, the survivor the reader’s, pins and ranges kept', () => {
    const layout = {
      levels: ['topic', 'person', 'issuer'] as CabinetLevel[],
      cabinets: [
        {
          id: 'c',
          name: 'Financial',
          hidden: false,
          drawn: { value: 'financial' },
          drawers: [
            {
              id: 'd',
              name: 'Me',
              hidden: false,
              folders: [
                folder('uk', 'barclays bank uk', {
                  hidden: true,
                  dividers: {
                    levels: ['year'],
                    ranges: [{ name: 'Old', from: '2010', to: '2015' }],
                  },
                }),
                folder('b', 'barclays', { hidden: true }),
                folder('h', 'hsbc'),
              ],
            },
          ],
        },
      ],
    };
    const m = mergeSameIssuers(layout, root, (k) => k === 'barclays');
    expect(m.changed).toBe(true);
    const fs = m.layout.cabinets[0]?.drawers[0]?.folders ?? [];
    expect(fs.map((f) => f.id)).toEqual(['b', 'h']);
    expect(fs[0]?.hidden).toBe(true);
    expect(fs[0]?.dividers?.ranges.map((r) => r.name)).toEqual(['Old']);
    expect(m.moved).toEqual([{ from: 'uk', to: 'b' }]);
    // Again: nothing more to merge.
    expect(mergeSameIssuers(m.layout, root).changed).toBe(false);
  });

  it('merges whole cabinets of one issuer, and their drawers of one value', () => {
    const cabinet = (id: string, value: string) => ({
      id,
      name: id,
      hidden: false,
      drawn: { value },
      drawers: [
        {
          id: `${id}-2026`,
          name: '2026',
          hidden: false,
          folders: [
            {
              ...folder(`${id}-me`, value),
              filter: {
                notes: 'exclude' as const,
                issuer: value,
                dated_from: '2026-01-01',
                dated_to: '2026-12-31',
                member_id: 'me',
              },
            },
          ],
        },
      ],
    });
    const layout = {
      levels: ['issuer', 'year', 'person'] as CabinetLevel[],
      cabinets: [cabinet('uk', 'barclays bank uk'), cabinet('b', 'barclays')],
    };
    const m = mergeSameIssuers(layout, root);
    expect(m.layout.cabinets.map((c) => c.id)).toEqual(['uk']);
    expect(m.layout.cabinets[0]?.drawers.map((d) => d.id)).toEqual(['uk-2026']);
    expect(m.layout.cabinets[0]?.drawers[0]?.folders.map((f) => f.id)).toEqual(['uk-me']);
    expect(m.moved).toEqual([{ from: 'b-me', to: 'uk-me' }]);
  });

  it('leaves a layout with no levels, or with nothing said to be one, as it is', () => {
    const none = { levels: null, cabinets: [] };
    expect(mergeSameIssuers(none, root).layout).toBe(none);
    const layout = drawCabinet(
      ['topic', 'issuer'],
      [{ person: 'me', category: 'financial', type_key: null, year: 2026, issuer: 'hsbc', n: 1 }],
      { person: (x) => x, kind: (x) => x, personOrder: () => 0 },
      () => `n${Math.random()}`,
    ).layout;
    expect(mergeSameIssuers(layout, root).changed).toBe(false);
  });
});

describe('a drawing past what a cabinet may hold, by a level of many values', () => {
  it('stops at one past the most cabinets, and is said to be too big', () => {
    const groups: CabinetGroup[] = Array.from({ length: 300 }, (_, i) => ({
      person: 'me',
      category: 'financial',
      type_key: null,
      year: 2026,
      issuer: `issuer ${i}`,
      n: 1,
    }));
    let n = 0;
    const d = drawCabinet(
      ['issuer', 'year', 'person'],
      groups,
      { person: (x) => x, kind: (x) => x, personOrder: () => 0 },
      () => `n${++n}`,
    );
    expect(d.layout.cabinets).toHaveLength(51);
    expect(d.capped).toBe(true);
  });
});
