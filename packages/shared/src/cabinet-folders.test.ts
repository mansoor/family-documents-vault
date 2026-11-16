import { describe, expect, it } from 'vitest';
import { CABINET_LIMITS, layoutProblem, type CabinetLayout } from './cabinet.js';
import {
  addFolderTree,
  compareFolders,
  folderPlace,
  folderTreeWords,
  FOLDERS_CABINET,
} from './cabinet-folders.js';

/** Ids as a vault gives them: each its own. */
const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};

const MINE: CabinetLayout = {
  arranged_by: 'person_kind',
  cabinets: [
    {
      id: 'study',
      name: 'Study',
      hidden: false,
      drawers: [
        {
          id: 'top',
          name: 'Top',
          hidden: false,
          folders: [{ id: 'tax', name: 'Tax', hidden: false, filter: { category: 'tax' } }],
        },
      ],
    },
  ],
};

describe('a folder tree, as cabinet folders (C4)', () => {
  it('reads a tree in order: each part in turn, a folder before those inside it, numbers as numbers', () => {
    const paths = ['Taxes/2025', 'Bills', 'Taxes', 'Taxes/2024', 'Taxes/10', 'bills/Water'];
    expect([...paths].sort(compareFolders)).toEqual([
      'Bills',
      'bills/Water',
      'Taxes',
      'Taxes/10',
      'Taxes/2024',
      'Taxes/2025',
    ]);
  });

  it('puts each folder in its top folder’s drawer, named by the rest of its path', () => {
    expect(folderPlace('Taxes')).toEqual({ drawer: 'Taxes', folder: 'Taxes' });
    expect(folderPlace('Taxes/2025')).toEqual({ drawer: 'Taxes', folder: '2025' });
    expect(folderPlace('Sara/School/Middle')).toEqual({
      drawer: 'Sara',
      folder: 'School / Middle',
    });
    // Never " › ", which joins a place's names (C3); never past 80 characters.
    expect(folderPlace('Home › Bills/x').drawer).toBe('Home - Bills');
    expect([...folderPlace(`Top/${'a'.repeat(200)}`).folder]).toHaveLength(CABINET_LIMITS.name);
  });

  it('draws a first cabinet, “My folders”, when there is none', () => {
    const got = addFolderTree(
      null,
      [
        { path: 'Taxes/2025', documents: 2 },
        { path: 'Bills/Water', documents: 1 },
        { path: 'Taxes', documents: 1 },
      ],
      ids(),
    );
    expect(got.layout.arranged_by).toBeNull();
    expect(got.layout.cabinets.map((c) => c.name)).toEqual([FOLDERS_CABINET]);
    const [cab] = got.layout.cabinets;
    expect(
      cab?.drawers.map((d) => [d.name, d.folders.map((f) => [f.name, f.filter.source_folder])]),
    ).toEqual([
      ['Bills', [['Water', 'Bills/Water']]],
      [
        'Taxes',
        [
          ['Taxes', 'Taxes'],
          ['2025', 'Taxes/2025'],
        ],
      ],
    ]);
    expect(got.added).toEqual({ cabinets: 1, drawers: 2, folders: 3 });
    expect(Object.values(got.counts).sort()).toEqual([1, 1, 2]);
    expect(layoutProblem(got.layout)).toBeNull();
  });

  it('adds beside what is there, changing none of it, and leaves the input as it was', () => {
    const before = JSON.stringify(MINE);
    const got = addFolderTree(MINE, [{ path: 'Taxes', documents: 1 }], ids());
    expect(JSON.stringify(MINE)).toBe(before);
    expect(got.layout.arranged_by).toBe('person_kind');
    expect(got.layout.cabinets[0]).toEqual(MINE.cabinets[0]);
    expect(got.layout.cabinets[1]?.name).toBe(FOLDERS_CABINET);
  });

  it('adds into a shown “My folders”, its drawers by name, and skips a folder asked for already', () => {
    const first = addFolderTree(MINE, [{ path: 'Taxes/2025', documents: 1 }], ids());
    const again = addFolderTree(
      first.layout,
      [
        { path: 'taxes/2025', documents: 1 },
        { path: 'TAXES/2026', documents: 3 },
        { path: 'Bills', documents: 1 },
      ],
      () => `m${Math.random().toString(36).slice(2, 8)}`,
    );
    expect(again.already).toBe(1);
    expect(again.added).toEqual({ cabinets: 0, drawers: 1, folders: 2 });
    expect(again.layout.cabinets).toHaveLength(2);
    const tree = again.layout.cabinets[1];
    expect(tree?.drawers.map((d) => [d.name, d.folders.map((f) => f.name)])).toEqual([
      ['Taxes', ['2025', '2026']],
      ['Bills', ['Bills']],
    ]);
  });

  it('counts a folder asked for by a hidden folder as there already, and never adds into a hidden cabinet', () => {
    const hidden: CabinetLayout = {
      arranged_by: null,
      cabinets: [
        {
          id: 'old',
          name: FOLDERS_CABINET,
          hidden: true,
          drawers: [
            {
              id: 'd',
              name: 'Taxes',
              hidden: false,
              folders: [
                {
                  id: 'f',
                  name: 'Taxes',
                  hidden: true,
                  filter: { source_folder: 'Taxes', notes: 'exclude' },
                },
              ],
            },
          ],
        },
      ],
    };
    const got = addFolderTree(
      hidden,
      [
        { path: 'Taxes', documents: 1 },
        { path: 'Bills', documents: 1 },
      ],
      ids(),
    );
    expect(got.already).toBe(1);
    expect(got.layout.cabinets.map((c) => [c.name, c.hidden])).toEqual([
      [FOLDERS_CABINET, true],
      [FOLDERS_CABINET, false],
    ]);
  });

  it('keeps the end of a long name, and never gives two siblings one name', () => {
    const long = 'a'.repeat(100);
    const got = addFolderTree(
      null,
      [
        { path: `Box/${long} 2024`, documents: 1 },
        { path: `Box/${long} 2025`, documents: 1 },
        { path: `${long}-first/x`, documents: 1 },
        { path: `${long}-second/x`, documents: 1 },
      ],
      ids(),
    );
    const cab = got.layout.cabinets[0];
    const box = cab?.drawers.find((d) => d.name === 'Box');
    const names = box?.folders.map((f) => f.name) ?? [];
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^….* 2024$/);
    expect(names[1]).toMatch(/^….* 2025$/);
    for (const n of names) expect([...n].length).toBeLessThanOrEqual(CABINET_LIMITS.name);
    // Two top folders alike but for their ends: two drawers, named apart.
    const tops = cab?.drawers.filter((d) => d.name !== 'Box').map((d) => d.name) ?? [];
    expect(tops).toHaveLength(2);
    expect(new Set(tops.map((t) => t.toLowerCase())).size).toBe(2);
    expect(layoutProblem(got.layout)).toBeNull();

    // A folder of the person's own of that name already: the new one is "(2)".
    const theirs: CabinetLayout = {
      arranged_by: null,
      cabinets: [
        {
          id: 'mf',
          name: FOLDERS_CABINET,
          hidden: false,
          drawers: [
            {
              id: 'tx',
              name: 'Taxes',
              hidden: false,
              folders: [{ id: 'y', name: '2025', hidden: false, filter: { category: 'tax' } }],
            },
            { id: 'old', name: 'Bills', hidden: true, folders: [] },
          ],
        },
      ],
    };
    const more = addFolderTree(
      theirs,
      [
        { path: 'Taxes/2025', documents: 1 },
        { path: 'Bills/Water', documents: 1 },
      ],
      ids(),
    );
    const drawers = more.layout.cabinets[0]?.drawers ?? [];
    expect(drawers.find((d) => d.id === 'tx')?.folders.map((f) => f.name)).toEqual([
      '2025',
      '2025 (2)',
    ]);
    // A hidden drawer of that name is no place to add to, and keeps its name to itself.
    expect(drawers.map((d) => [d.name, d.hidden])).toEqual([
      ['Taxes', false],
      ['Bills', true],
      ['Bills (2)', false],
    ]);
  });

  it('compares folders by the keys it is given, as the vault lowers them', () => {
    const layout: CabinetLayout = {
      arranged_by: null,
      cabinets: [
        {
          id: 'c',
          name: 'Study',
          hidden: false,
          drawers: [
            {
              id: 'd',
              name: 'Top',
              hidden: false,
              folders: [
                { id: 'f', name: 'Straße', hidden: false, filter: { source_folder: 'Straße' } },
              ],
            },
          ],
        },
      ],
    };
    const key = (path: string) => (path === 'Straße' ? 'strasse' : path.toLowerCase());
    const got = addFolderTree(layout, [{ path: 'STRASSE', key: 'strasse', documents: 1 }], ids(), {
      key,
    });
    expect(got.already).toBe(1);
    expect(got.added.folders).toBe(0);
  });

  it('leaves out, and counts, what a cabinet cannot hold', () => {
    const many = Array.from({ length: CABINET_LIMITS.folders + 5 }, (_, i) => ({
      path: `Box/${String(i).padStart(4, '0')}`,
      documents: 1,
    }));
    const got = addFolderTree(null, many, ids());
    expect(got.added.folders).toBe(CABINET_LIMITS.folders);
    expect(got.left_out).toBe(5);
    expect(layoutProblem(got.layout)).toBeNull();
  });

  it('adds nothing when there is nothing new, and says so', () => {
    const got = addFolderTree(MINE, [], ids());
    expect(got.layout).toEqual(MINE);
    expect(folderTreeWords(got.added)).toBe('Your cabinet has a folder for each of them already.');
    expect(folderTreeWords({ cabinets: 1, drawers: 2, folders: 3 })).toBe(
      '3 new folders, 2 new drawers, in the cabinet “My folders” (new).',
    );
    expect(folderTreeWords({ cabinets: 0, drawers: 0, folders: 1 })).toBe(
      '1 new folder, in the cabinet “My folders”.',
    );
  });
});
