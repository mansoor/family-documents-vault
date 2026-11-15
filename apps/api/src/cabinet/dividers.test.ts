import { randomUUID } from 'node:crypto';
import { createDb, createPool, withPrincipal, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  PIN_LIMITS,
  schoolStages,
  type AlsoIn,
  type CabinetCounts,
  type CabinetFolder,
  type CabinetLayout,
  type CabinetView,
  type DocumentPage,
  type FolderContents,
  type FolderDividers,
  type Tokens,
} from '@fdv/shared';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Dividers and pins in somebody's cabinet (0.9.0, C2; 0099), through the
 * API as each member of a household, and in the database as the
 * application role.
 *
 * A folder's papers are grouped behind dividers — by year, or the folder's
 * own date ranges — each counted as the table counts, so the dividers of a
 * folder add up to its count. A paper pinned into a folder by hand is shown
 * first, counted once, and said to be "also in" it — only while its person
 * may still open it, out of the Trash. Every test here is from the side of
 * whoever must not see: somebody else's paper made Only me, a sensitive
 * paper kept to the adults from a teen, the Trash, a caregiver after a
 * revoke, another household.
 */

type Person = 'owner' | 'adult' | 'teen';

const unUuid = (s: string) =>
  s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

const SECRETS = {
  /** Olive's letter about the house, which Sam pins; then she makes it Only me. */
  letter: 'OLIVE-HOUSE-LETTER-C2',
  /** Tia's clinic letter, which she pins; then it is kept to the adults. */
  clinic: 'TIA-CLINIC-LETTER-C2',
  /** Tia's medical record, kept to the adults from the start: never hers. */
  adultsMedical: 'TIA-ADULTS-MEDICAL-C2',
  /** Sam's Only me medical paper, which Olive reads as his caregiver, until he revokes. */
  samMedical: 'SAM-ONLY-ME-MEDICAL-C2 samcareword',
  /** A paper of another household. */
  elsewhere: 'ANOTHER-HOUSEHOLD-C2',
};

describe.skipIf(!testAdminUrl())('dividers and pins in my cabinet (C2)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  const people = {} as Record<Person, Tokens>;
  const accounts = {} as Record<Person, string>;
  const ids = {} as Record<string, string>;
  let nth = 0;

  const call = (
    who: Person,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(people[who]),
      remoteAddress: `10.99.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const ok = async <T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.json() as T;
  };
  const member = (who: Person) => people[who].member_id;
  const mine = (who: Person) => ok<CabinetView>(call(who, 'GET', '/api/v1/cabinet'));
  const saved = async (who: Person, layout: CabinetLayout, extra: object = {}) => {
    const at = await mine(who);
    return ok<CabinetView>(
      call(who, 'PUT', '/api/v1/cabinet', { layout, version: at.version, ...extra }),
    );
  };
  const counts = (who: Person) =>
    ok<CabinetCounts>(call(who, 'GET', '/api/v1/cabinet/counts')).then((c) => c.counts);
  const opened = (who: Person, folder: string) =>
    ok<FolderContents>(call(who, 'GET', `/api/v1/cabinet/folders/${folder}`));
  const behind = async (who: Person, folder: string, divider: string) => {
    const page = await ok<DocumentPage>(
      call(
        who,
        'GET',
        `/api/v1/cabinet/folders/${folder}/documents?divider=${encodeURIComponent(divider)}&limit=200`,
      ),
    );
    return { total: page.total, titles: page.items.map((d) => d.title) };
  };
  const pin = (who: Person, folder: string, documentIds: string[]) =>
    call(who, 'POST', `/api/v1/cabinet/folders/${folder}/pins`, { document_ids: documentIds });
  const unpin = (who: Person, folder: string, documentId: string) =>
    call(who, 'DELETE', `/api/v1/cabinet/folders/${folder}/pins/${documentId}`);
  const alsoIn = (who: Person, id: string) => call(who, 'GET', `/api/v1/documents/${id}/also-in`);
  /** Everything a person is told of a folder: its contents, each divider's papers, its count. */
  const everything = async (who: Person, folder: string) => {
    const c = await opened(who, folder);
    const pages = await Promise.all(c.dividers.map((d) => behind(who, folder, d.key)));
    return unUuid(JSON.stringify([c, pages, await counts(who)]));
  };
  /** A layout of one cabinet, one drawer, and these folders. */
  const oneDrawer = (
    folders: Array<Omit<CabinetFolder, 'hidden'> & { hidden?: boolean }>,
  ): CabinetLayout => ({
    arranged_by: null,
    cabinets: [
      {
        id: 'c1',
        name: 'Mine',
        hidden: false,
        drawers: [
          {
            id: 'd1',
            name: 'Drawer',
            hidden: false,
            folders: folders.map((f) => ({ hidden: false, ...f })),
          },
        ],
      },
    ],
  });
  const asAdmin = (text: string, values: unknown[] = []) =>
    admin.query<Record<string, unknown>>(text, values);

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    people.owner = await h.setup({ display_name: 'Olive Khan' });
    people.adult = await h.join(people.owner, {
      name: 'Sam Khan',
      email: 'c2-sam@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Tia Khan',
      email: 'c2-tia@example.test',
      role: 'teen',
    });
    for (const who of Object.keys(people) as Person[]) {
      accounts[who] = (await ok<{ account_id: string }>(call(who, 'GET', '/api/v1/me'))).account_id;
    }
    const day = (date: string) => ({ date, precision: 'day' });
    const file = async (who: Person, body: object) =>
      (await ok<{ id: string }>(call(who, 'POST', '/api/v1/documents', body))).id;
    const school = async (title: string, date: string) =>
      file('owner', {
        title,
        type_key: 'diploma',
        owner_member_id: member('teen'),
        visibility: 'household',
        issued: day(date),
      });
    // Tia's school papers, from before school to high school.
    ids.nursery = await school('Nursery photo day', '2010-06-01');
    ids.elementary = await school('Elementary report', '2015-03-01');
    ids.middle = await school('Middle school report', '2021-02-01');
    ids.high = await school('High school report', '2024-10-01');
    ids.adultsMedical = await file('owner', {
      title: SECRETS.adultsMedical,
      type_key: 'medical_record',
      owner_member_id: member('teen'),
      visibility: 'adults',
      issued: day('2022-01-15'),
    });
    ids.clinic = await file('owner', {
      title: SECRETS.clinic,
      type_key: 'medical_record',
      owner_member_id: member('teen'),
      visibility: 'household',
      issued: day('2023-10-05'),
    });
    ids.letter = await file('owner', {
      title: SECRETS.letter,
      type_key: 'other',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day('2016-05-01'),
    });
    ids.samTax = await file('adult', {
      title: 'Sam’s tax return',
      type_key: 'tax_return',
      owner_member_id: member('adult'),
      visibility: 'household',
      issued: day('2024-04-10'),
    });
    ids.samMedical = await file('adult', {
      title: SECRETS.samMedical,
      type_key: 'medical_record',
      owner_member_id: member('adult'),
      visibility: 'private',
      issued: day('2023-03-03'),
    });
    ids.toTrash = await file('owner', {
      title: 'A council letter',
      type_key: 'other',
      owner_member_id: member('owner'),
      visibility: 'household',
      issued: day('2019-09-09'),
    });
    // Another household, made in the database: a paper nobody here may name.
    const other = randomUUID();
    await asAdmin("insert into household (id, name) values ($1, 'Elsewhere')", [other]);
    ids.elsewhere = (
      await asAdmin(
        `insert into document (household_id, title, type_key, visibility)
         values ($1, $2, 'other', 'household') returning id`,
        [other, SECRETS.elsewhere],
      )
    ).rows[0]?.id as string;
    ids.otherHousehold = other;
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('says it can', async () => {
    const caps = await ok<{ features: { cabinet_dividers?: boolean; cabinet_pins?: boolean } }>(
      call('owner', 'GET', '/api/v1/capabilities'),
    );
    expect(caps.features.cabinet_dividers).toBe(true);
    expect(caps.features.cabinet_pins).toBe(true);
  });

  describe('year dividers', () => {
    const tias = () =>
      oneDrawer([{ id: 'tia', name: 'Tia', filter: { member_id: member('teen') } }]);

    it('group a folder by the year each paper is about, newest first, adding up to its count', async () => {
      await saved('owner', tias());
      const c = await opened('owner', 'tia');
      expect(c.dividers.map((d) => [d.key, d.count])).toEqual([
        ['year:2024', 1],
        ['year:2023', 1],
        ['year:2022', 1],
        ['year:2021', 1],
        ['year:2015', 1],
        ['year:2010', 1],
      ]);
      expect(c.pinned).toEqual([]);
      expect(c.total).toBe(6);
      expect((await counts('owner')).tia).toBe(6);
      expect(await behind('owner', 'tia', 'year:2021')).toEqual({
        total: 1,
        titles: ['Middle school report'],
      });
    });

    it('never show a teen a year whose only paper is kept to the adults, nor its title', async () => {
      await saved('teen', tias());
      const c = await opened('teen', 'tia');
      expect(c.dividers.map((d) => d.key)).not.toContain('year:2022');
      expect(c.total).toBe(5);
      expect((await counts('teen')).tia).toBe(5);
      expect(
        (await call('teen', 'GET', '/api/v1/cabinet/folders/tia/documents?divider=year:2022'))
          .statusCode,
      ).toBe(200);
      expect(await behind('teen', 'tia', 'year:2022')).toEqual({ total: 0, titles: [] });
      expect(await everything('teen', 'tia')).not.toContain(SECRETS.adultsMedical);
    });

    it('can be turned off: one list, no dividers', async () => {
      await saved(
        'owner',
        oneDrawer([
          {
            id: 'tia',
            name: 'Tia',
            filter: { member_id: member('teen') },
            dividers: { years: false, ranges: [] },
          },
        ]),
      );
      const c = await opened('owner', 'tia');
      expect(c.dividers).toEqual([
        { key: 'all', kind: 'all', name: '', from: null, to: null, count: 6 },
      ]);
      expect((await behind('owner', 'tia', 'all')).total).toBe(6);
      // A divider the folder does not have is not one.
      expect(
        (await call('owner', 'GET', '/api/v1/cabinet/folders/tia/documents?divider=year:2024'))
          .statusCode,
      ).toBe(404);
    });
  });

  describe('date-range dividers', () => {
    // Tia, five by 1 September 2014: the owner's own example.
    const stages = schoolStages('2009-04-20') as NonNullable<ReturnType<typeof schoolStages>>;
    const school = (dividers: FolderDividers): CabinetLayout =>
      oneDrawer([
        { id: 'school', name: 'School', filter: { member_id: member('teen') }, dividers },
      ]);

    it('are the school stages from a date of birth', () => {
      expect(stages).toEqual([
        { name: 'College', from: '2027-09-01', to: null },
        { name: 'High school', from: '2023-09-01', to: '2027-08-31' },
        { name: 'Middle school', from: '2020-09-01', to: '2023-08-31' },
        { name: 'Elementary', from: '2014-09-01', to: '2020-08-31' },
      ]);
    });

    it('replace the years: each paper behind the range that holds its date, the rest behind Other years', async () => {
      await saved('owner', school({ years: true, ranges: stages }));
      const c = await opened('owner', 'school');
      expect(c.dividers.map((d) => [d.name, d.count, d.from, d.to])).toEqual([
        ['College', 0, '2027-09-01', null],
        ['High school', 2, '2023-09-01', '2027-08-31'],
        ['Middle school', 2, '2020-09-01', '2023-08-31'],
        ['Elementary', 1, '2014-09-01', '2020-08-31'],
        ['Other years', 1, null, null],
      ]);
      expect(c.total).toBe(6);
      expect((await counts('owner')).school).toBe(6);
      const high = c.dividers.find((d) => d.name === 'High school');
      expect((await behind('owner', 'school', high?.key as string)).titles.sort()).toEqual(
        ['High school report', SECRETS.clinic].sort(),
      );
      expect((await behind('owner', 'school', 'other')).titles).toEqual(['Nursery photo day']);
      // A teen: the medical record kept to the adults is behind no divider of hers.
      await saved('teen', school({ years: true, ranges: stages }));
      const t = await opened('teen', 'school');
      expect(t.dividers.find((d) => d.name === 'Middle school')?.count).toBe(1);
      expect(t.total).toBe(5);
      expect(await everything('teen', 'school')).not.toContain(SECRETS.adultsMedical);
    });

    it('give a year shared by two ranges, typed as years, to the later one: the owner’s own example', async () => {
      await saved(
        'owner',
        school({
          years: true,
          ranges: [
            { name: 'Elementary', from: '2014', to: '2020' },
            { name: 'Middle school', from: '2020', to: '2023' },
            { name: 'High school', from: '2023', to: '2027' },
            { name: 'College', from: '2027', to: null },
          ],
        }),
      );
      const c = await opened('owner', 'school');
      expect(c.dividers.map((d) => [d.name, d.count, d.from, d.to])).toEqual([
        ['College', 0, '2027-01-01', null],
        ['High school', 2, '2023-01-01', '2026-12-31'],
        ['Middle school', 2, '2020-01-01', '2022-12-31'],
        ['Elementary', 1, '2014-01-01', '2019-12-31'],
        ['Other years', 1, null, null],
      ]);
      expect(c.total).toBe((await counts('owner')).school);
      const middle = c.dividers.find((d) => d.name === 'Middle school');
      expect((await behind('owner', 'school', middle?.key as string)).titles.sort()).toEqual(
        ['Middle school report', SECRETS.adultsMedical].sort(),
      );
      // Typed as a full date, the same year is an overlap.
      const r = await call('owner', 'PUT', '/api/v1/cabinet', {
        layout: school({
          years: true,
          ranges: [
            { name: 'Elementary', from: '2014', to: '2020-12-31' },
            { name: 'Middle school', from: '2020', to: '2023' },
          ],
        }),
        version: (await mine('owner')).version,
      });
      expect(r.json<{ error: { code: string } }>().error.code).toBe('cabinet_divider_overlap');
    });

    it('take years of four figures alone: 0000 refused as it is saved; a paper dated outside is behind Other years', async () => {
      const at = await mine('owner');
      for (const bad of ['0000-01-01', '0000', '0999-12-31']) {
        const r = await call('owner', 'PUT', '/api/v1/cabinet', {
          layout: school({ years: true, ranges: [{ name: 'Long ago', from: bad, to: null }] }),
          version: at.version,
        });
        expect(r.statusCode, bad).toBe(422);
        expect(r.json<{ error: { code: string } }>().error.code).toBe('cabinet_divider_dates');
      }
      const ancient = (
        await asAdmin(
          `insert into document (household_id, title, type_key, visibility, owner_member_id,
                                 issued_on, issued_precision)
           values ($1, 'A charter of 1215 copied in 0500', 'diploma', 'household', $2,
                   '0500-06-01', 'day')
           returning id`,
          [people.owner.household_id, member('teen')],
        )
      ).rows[0]?.id as string;
      try {
        await saved(
          'owner',
          oneDrawer([{ id: 'old', name: 'Old', filter: { member_id: member('teen') } }]),
        );
        const c = await opened('owner', 'old');
        expect(c.dividers.at(-1)).toMatchObject({ key: 'other', name: 'Other years', count: 1 });
        expect(c.dividers.map((d) => d.key)).not.toContain('year:0500');
        expect(c.total).toBe((await counts('owner')).old);
        expect((await behind('owner', 'old', 'other')).titles).toEqual([
          'A charter of 1215 copied in 0500',
        ]);
        for (const key of ['year:0500', 'year:0000', 'range:0']) {
          const r = await call(
            'owner',
            'GET',
            `/api/v1/cabinet/folders/old/documents?divider=${encodeURIComponent(key)}`,
          );
          expect(r.statusCode, key).toBe(404);
        }
      } finally {
        await asAdmin('delete from document where id = $1', [ancient]);
      }
    });

    it('are refused when they overlap, or are not ranges, each with its own code; nothing saved', async () => {
      const before = await mine('owner');
      const refusals: Array<[FolderDividers, string]> = [
        [
          {
            years: true,
            ranges: [
              { name: 'Elementary', from: '2014-01-01', to: '2020-12-31' },
              { name: 'Middle', from: '2020-01-01', to: '2023-12-31' },
            ],
          },
          'cabinet_divider_overlap',
        ],
        [
          {
            years: true,
            ranges: [
              { name: 'College', from: '2027-09-01', to: null },
              { name: 'Later', from: '2030-01-01', to: null },
            ],
          },
          'cabinet_divider_overlap',
        ],
        [
          { years: true, ranges: [{ name: 'Backwards', from: '2020-01-01', to: '2019-01-01' }] },
          'cabinet_divider_dates',
        ],
        [
          { years: true, ranges: [{ name: 'Nowhere', from: null, to: null }] },
          'cabinet_divider_dates',
        ],
        [
          { years: true, ranges: [{ name: 'Not a day', from: '2020-02-30', to: null }] },
          'cabinet_divider_dates',
        ],
        [
          { years: true, ranges: [{ name: '  ', from: '2020-01-01', to: null }] },
          'cabinet_divider_name_missing',
        ],
        [
          { years: true, ranges: [{ name: 'x'.repeat(81), from: '2020-01-01', to: null }] },
          'cabinet_divider_name_too_long',
        ],
        [
          {
            years: true,
            ranges: Array.from({ length: 21 }, (_, i) => ({
              name: `Y${i}`,
              from: `${2000 + i}-01-01`,
              to: `${2000 + i}-12-31`,
            })),
          },
          'cabinet_too_many_dividers',
        ],
      ];
      for (const [dividers, code] of refusals) {
        const r = await call('owner', 'PUT', '/api/v1/cabinet', {
          layout: school(dividers),
          version: before.version,
        });
        expect(r.statusCode, r.body).toBe(422);
        expect(r.json<{ error: { code: string; message: string } }>().error.code).toBe(code);
      }
      const overlap = await call('owner', 'PUT', '/api/v1/cabinet', {
        layout: school(refusals[0]?.[0] as FolderDividers),
        version: before.version,
      });
      expect(overlap.json<{ error: { message: string } }>().error.message).toMatch(
        /“Elementary”.*“Middle”.*share days/,
      );
      expect((await mine('owner')).version).toBe(before.version);
    });
  });

  describe('pins', () => {
    const samFolders = () =>
      oneDrawer([
        { id: 'tax', name: 'Tax', filter: { category: 'tax' } },
        { id: 'house', name: 'House', filter: { category: 'property' } },
      ]);

    it('show a pinned paper first, count it once, and say it is also in the folder', async () => {
      await saved('adult', samFolders());
      expect((await counts('adult')).tax).toBe(1);
      await ok(pin('adult', 'tax', [ids.letter as string, ids.samTax as string]));
      const c = await opened('adult', 'tax');
      expect(c.pinned.map((d) => d.title).sort()).toEqual(
        [SECRETS.letter, 'Sam’s tax return'].sort(),
      );
      // The tax return is pinned and asked for both: counted once, shown above the dividers.
      expect(c.dividers).toEqual([]);
      expect(c.total).toBe(2);
      expect((await counts('adult')).tax).toBe(2);
      const also = await ok<AlsoIn>(alsoIn('adult', ids.letter as string));
      expect(also.items).toEqual([
        { id: 'tax', name: 'Tax', path: ['Mine', 'Drawer', 'Tax'], pinned: true },
      ]);
      // Pinning again is nothing new; unpinning puts it back where its question says.
      await ok(pin('adult', 'tax', [ids.samTax as string]));
      expect((await unpin('adult', 'tax', ids.samTax as string)).statusCode).toBe(204);
      expect((await unpin('adult', 'tax', ids.samTax as string)).statusCode).toBe(204);
      const after = await opened('adult', 'tax');
      expect(after.pinned.map((d) => d.title)).toEqual([SECRETS.letter]);
      expect(after.dividers.map((d) => [d.key, d.count])).toEqual([['year:2024', 1]]);
      expect(after.total).toBe(2);
    });

    it('somebody else’s paper made Only me: the pin shows, counts and says nothing', async () => {
      await ok(
        call('owner', 'POST', `/api/v1/documents/${ids.letter}/visibility`, {
          visibility: 'private',
        }),
      );
      const c = await opened('adult', 'tax');
      expect(c.pinned).toEqual([]);
      expect(c.total).toBe(1);
      expect((await counts('adult')).tax).toBe(1);
      expect((await alsoIn('adult', ids.letter as string)).statusCode).toBe(404);
      expect(await everything('adult', 'tax')).not.toContain(SECRETS.letter);
      // Nor can it be pinned again; an unpin is answered as any is (204), saying nothing.
      expect((await pin('adult', 'house', [ids.letter as string])).statusCode).toBe(404);
      const told = await unpin('adult', 'house', ids.letter as string);
      expect([told.statusCode, told.body]).toEqual([204, '']);
      // Olive, its person, sees it still — in nobody's cabinet but her own.
      expect((await ok<AlsoIn>(alsoIn('owner', ids.letter as string))).items).toEqual([]);
      // Made the family's again, it is pinned again: the pin was Sam's arrangement all along.
      await asAdmin("update document set visibility = 'household' where id = $1", [ids.letter]);
      expect((await opened('adult', 'tax')).pinned.map((d) => d.title)).toEqual([SECRETS.letter]);
    });

    it('a sensitive paper kept to the adults: a teen’s pin of it shows, counts and says nothing', async () => {
      await saved(
        'teen',
        oneDrawer([{ id: 'mine', name: 'Mine', filter: { category: 'education' } }]),
      );
      await ok(pin('teen', 'mine', [ids.clinic as string]));
      expect((await opened('teen', 'mine')).pinned.map((d) => d.title)).toEqual([SECRETS.clinic]);
      expect((await counts('teen')).mine).toBe(5);
      await ok(
        call('owner', 'POST', `/api/v1/documents/${ids.clinic}/visibility`, {
          visibility: 'adults',
        }),
      );
      const c = await opened('teen', 'mine');
      expect(c.pinned).toEqual([]);
      expect(c.total).toBe(4);
      expect((await counts('teen')).mine).toBe(4);
      expect((await alsoIn('teen', ids.clinic as string)).statusCode).toBe(404);
      expect(await everything('teen', 'mine')).not.toContain(SECRETS.clinic);
      // Never one she could pin: the medical record kept to the adults from the start.
      expect((await pin('teen', 'mine', [ids.adultsMedical as string])).statusCode).toBe(404);
      // A list with it among others pins none of them.
      expect(
        (await pin('teen', 'mine', [ids.high as string, ids.adultsMedical as string])).statusCode,
      ).toBe(404);
      expect((await opened('teen', 'mine')).pinned).toEqual([]);
    });

    it('the Trash: a pinned paper there shows and counts in no folder, cannot be pinned, and comes back with it', async () => {
      await ok(pin('adult', 'house', [ids.toTrash as string]));
      expect((await counts('adult')).house).toBe(1);
      expect((await call('owner', 'DELETE', `/api/v1/documents/${ids.toTrash}`)).statusCode).toBe(
        204,
      );
      expect((await opened('adult', 'house')).pinned).toEqual([]);
      expect((await counts('adult')).house).toBe(0);
      // Olive sees her Trash; it is in no folder of hers, and none she may pin.
      await saved('owner', samFolders());
      const refused = await pin('owner', 'house', [ids.toTrash as string]);
      expect(refused.statusCode).toBe(422);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('cabinet_pin_in_trash');
      await ok(call('owner', 'POST', `/api/v1/documents/${ids.toTrash}/restore`));
      expect((await counts('adult')).house).toBe(1);
      // Removed for good, its pins go with it.
      await asAdmin('delete from document where id = $1', [ids.toTrash]);
      const left = await asAdmin(
        'select count(*)::int as n from cabinet_pin where document_id = $1',
        [ids.toTrash],
      );
      expect(left.rows[0]?.n).toBe(0);
    });

    it('a caregiver may pin what a grant lets them read, and loses it when the grant ends', async () => {
      await ok(
        call('adult', 'POST', `/api/v1/members/${member('adult')}/caregivers`, {
          caregiver_member_id: member('owner'),
        }),
      );
      await saved(
        'owner',
        oneDrawer([{ id: 'care', name: 'Sam’s care', filter: { category: 'tax' } }]),
      );
      await ok(pin('owner', 'care', [ids.samMedical as string]));
      expect((await opened('owner', 'care')).pinned.map((d) => d.title)).toEqual([
        SECRETS.samMedical,
      ]);
      expect((await ok<AlsoIn>(alsoIn('owner', ids.samMedical as string))).items[0]?.pinned).toBe(
        true,
      );
      // A pin is never a write to the paper.
      expect(
        (await asAdmin('select visibility from document where id = $1', [ids.samMedical])).rows[0],
      ).toEqual({ visibility: 'private' });
      expect(
        (
          await call(
            'adult',
            'POST',
            `/api/v1/members/${member('adult')}/caregivers/${member('owner')}/revoke`,
          )
        ).statusCode,
      ).toBe(204);
      const c = await opened('owner', 'care');
      expect(c.pinned).toEqual([]);
      expect(c.total).toBe(1);
      expect((await counts('owner')).care).toBe(1);
      expect((await alsoIn('owner', ids.samMedical as string)).statusCode).toBe(404);
      expect((await pin('owner', 'care', [ids.samMedical as string])).statusCode).toBe(404);
      expect(await everything('owner', 'care')).not.toContain(SECRETS.samMedical);
      // Their own pin, of a paper they may no longer open, is still theirs to let go (204).
      const pinRows = () =>
        asAdmin(
          'select count(*)::int as n from cabinet_pin where member_id = $1 and document_id = $2',
          [member('owner'), ids.samMedical],
        );
      expect((await pinRows()).rows[0]?.n).toBe(1);
      const told = await unpin('owner', 'care', ids.samMedical as string);
      expect([told.statusCode, told.body]).toEqual([204, '']);
      expect((await pinRows()).rows[0]?.n).toBe(0);
    });

    it('a caregiver is told which hits are theirs only as a caregiver, in search as in lists; and Only me means their own', async () => {
      await ok(
        call('adult', 'POST', `/api/v1/members/${member('adult')}/caregivers`, {
          caregiver_member_id: member('owner'),
        }),
      );
      const looks = async () =>
        (await asAdmin('select count(*)::int as n from caregiver_view')).rows[0]?.n;
      const before = await looks();
      const found = await ok<{ items: Array<{ document_id: string; caregiver?: boolean }> }>(
        call('owner', 'GET', '/api/v1/search?q=samcareword'),
      );
      expect(found.items.find((h) => h.document_id === ids.samMedical)?.caregiver).toBe(true);
      // Sam, its person, is told nothing of the kind.
      const own = await ok<{ items: Array<{ document_id: string; caregiver?: boolean }> }>(
        call('adult', 'GET', '/api/v1/search?q=samcareword'),
      );
      expect(own.items.find((h) => h.document_id === ids.samMedical)).not.toHaveProperty(
        'caregiver',
      );
      // Searching writes no look.
      expect(await looks()).toBe(before);
      // Only me is Olive's own: never Sam's, read through the grant — in the
      // list, in search, and in a folder that asks it, and its count.
      const listed = await ok<DocumentPage>(
        call('owner', 'GET', '/api/v1/documents?sort=title&visibility=private&limit=200'),
      );
      expect(listed.items.map((d) => d.id)).not.toContain(ids.samMedical);
      expect(listed.items.every((d) => d.owner_member_id === member('owner'))).toBe(true);
      const older = await ok<{ items: Array<{ id: string }> }>(
        call('owner', 'GET', '/api/v1/documents?visibility=private'),
      );
      expect(older.items.map((d) => d.id)).not.toContain(ids.samMedical);
      const searched = await ok<{ items: Array<{ document_id: string }> }>(
        call('owner', 'GET', '/api/v1/search?q=samcareword&visibility=private'),
      );
      expect(searched.items.map((h) => h.document_id)).not.toContain(ids.samMedical);
      await saved(
        'owner',
        oneDrawer([
          { id: 'care', name: 'Sam’s care', filter: { category: 'tax' } },
          { id: 'mine-only', name: 'Only me', filter: { visibility: 'private' } },
          { id: 'medical', name: 'Medical', filter: { category: 'medical' } },
        ]),
      );
      expect((await counts('owner'))['mine-only']).toBe(listed.total);
      expect(await everything('owner', 'mine-only')).not.toContain(SECRETS.samMedical);
      // Still his to read as his caregiver, marked so, in the folder that asks for Medical.
      const medical = await opened('owner', 'medical');
      const pages = await Promise.all(
        medical.dividers.map((d) => behind('owner', 'medical', d.key)),
      );
      expect(pages.flatMap((pg) => pg.titles)).toContain(SECRETS.samMedical);
      // Sam's own Only me is his, as ever.
      const his = await ok<DocumentPage>(
        call('adult', 'GET', '/api/v1/documents?sort=title&visibility=private&limit=200'),
      );
      expect(his.items.map((d) => d.id)).toContain(ids.samMedical);
      expect(
        (
          await call(
            'adult',
            'POST',
            `/api/v1/members/${member('adult')}/caregivers/${member('owner')}/revoke`,
          )
        ).statusCode,
      ).toBe(204);
    });

    it('another household’s paper is nobody’s here to pin', async () => {
      const r = await pin('owner', 'care', [ids.elsewhere as string]);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain(SECRETS.elsewhere);
      expect((await unpin('owner', 'care', ids.elsewhere as string)).statusCode).toBe(204);
      expect(
        (
          await asAdmin('select count(*)::int as n from cabinet_pin where document_id = $1', [
            ids.elsewhere,
          ])
        ).rows[0]?.n,
      ).toBe(0);
      expect((await alsoIn('owner', ids.elsewhere as string)).statusCode).toBe(404);
    });

    it('go only into a folder of the caller’s own, which they may open', async () => {
      // Sam's folder "house" is not Olive's; nor is one that is not there.
      expect((await pin('teen', 'house', [ids.high as string])).statusCode).toBe(404);
      expect((await pin('owner', 'nope', [ids.high as string])).statusCode).toBe(404);
      expect((await call('owner', 'GET', '/api/v1/cabinet/folders/nope')).statusCode).toBe(404);
      expect((await call('teen', 'GET', '/api/v1/cabinet/folders/house')).statusCode).toBe(404);
      // Not an id at all; and unpinning one is nothing (204).
      expect((await pin('owner', 'care', ['not-an-id'])).statusCode).toBe(404);
      expect((await unpin('owner', 'care', 'not-an-id')).statusCode).toBe(204);
      // A hidden folder of their own is not offered, and not taken.
      await saved(
        'teen',
        oneDrawer([
          { id: 'mine', name: 'Mine', filter: { category: 'education' } },
          { id: 'tucked', name: 'Tucked away', filter: {}, hidden: true },
        ]),
      );
      expect((await pin('teen', 'tucked', [ids.high as string])).statusCode).toBe(404);
    });

    it('move with a merged folder, and go with a folder taken away', async () => {
      await saved('adult', samFolders());
      await ok(pin('adult', 'house', [ids.letter as string]));
      // House merged into Tax: its pin moves with it.
      await saved('adult', oneDrawer([{ id: 'tax', name: 'Tax', filter: { category: 'tax' } }]), {
        pins_moved: [{ from: 'house', to: 'tax' }],
      });
      expect((await opened('adult', 'tax')).pinned.map((d) => d.title).sort()).toEqual(
        [SECRETS.letter].sort(),
      );
      // Merged twice before one save — House into Tax, then Tax into Other — they follow both.
      await saved('adult', samFolders());
      await ok(pin('adult', 'house', [ids.samTax as string]));
      await saved(
        'adult',
        oneDrawer([{ id: 'other', name: 'Other', filter: { category: 'other' } }]),
        {
          pins_moved: [
            { from: 'house', to: 'tax' },
            { from: 'tax', to: 'other' },
          ],
        },
      );
      expect((await opened('adult', 'other')).pinned.map((d) => d.title).sort()).toEqual(
        [SECRETS.letter, 'Sam’s tax return'].sort(),
      );
      // A move from a folder the layout keeps is no move: nothing is copied.
      await saved(
        'adult',
        oneDrawer([
          { id: 'other', name: 'Other', filter: { category: 'other' } },
          { id: 'copy', name: 'Copy', filter: { category: 'tax' } },
        ]),
        { pins_moved: [{ from: 'other', to: 'copy' }] },
      );
      expect((await opened('adult', 'copy')).pinned).toEqual([]);
      expect((await opened('adult', 'other')).pinned).toHaveLength(2);
      // Other taken away: its pins go with it.
      await saved('adult', oneDrawer([{ id: 'last', name: 'Last', filter: { category: 'tax' } }]));
      const left = await asAdmin('select folder_id from cabinet_pin where member_id = $1', [
        member('adult'),
      ]);
      expect(left.rows).toEqual([]);
    });
  });

  describe('caps and concurrency', () => {
    /** `n` papers of the family's, made in the database. */
    const many = async (n: number, title: string) =>
      (
        await asAdmin(
          `insert into document (household_id, title, type_key, visibility, created_by)
           select $1, $2::text || g, 'other', 'household', null from generate_series(1, $3::int) g
           returning id`,
          [people.owner.household_id, title, n],
        )
      ).rows.map((r) => r.id as string);

    it('a folder holds at most 200 pins: the 201st is refused, unless one of them can no longer be seen', async () => {
      await saved('adult', oneDrawer([{ id: 'full', name: 'Full', filter: { category: 'tax' } }]));
      const papers = await many(PIN_LIMITS.folder + 1, 'Full ');
      await ok(pin('adult', 'full', papers.slice(0, PIN_LIMITS.folder)));
      expect((await opened('adult', 'full')).pinned).toHaveLength(PIN_LIMITS.folder);
      const over = await pin('adult', 'full', [papers[PIN_LIMITS.folder] as string]);
      expect(over.statusCode).toBe(422);
      expect(over.json<{ error: { code: string } }>().error.code).toBe('cabinet_too_many_pins');
      // One made Olive's Only me: its place is let go, and the 201st goes in.
      await asAdmin(
        "update document set visibility = 'private', owner_member_id = $2 where id = $1",
        [papers[0], member('owner')],
      );
      await ok(pin('adult', 'full', [papers[PIN_LIMITS.folder] as string]));
      expect((await opened('adult', 'full')).pinned).toHaveLength(PIN_LIMITS.folder);
      const rows = await asAdmin(
        "select count(*)::int as n from cabinet_pin where member_id = $1 and folder_id = 'full'",
        [member('adult')],
      );
      expect(rows.rows[0]?.n).toBe(PIN_LIMITS.folder);
    });

    it('a merge is refused over the cap only for pins its person still sees: hidden ones say nothing', async () => {
      const two = oneDrawer([
        { id: 'm1', name: 'M1', filter: { category: 'tax' } },
        { id: 'm2', name: 'M2', filter: { category: 'tax' } },
      ]);
      await saved('adult', two);
      const papers = await many(260, 'Merge ');
      await ok(pin('adult', 'm1', papers.slice(0, 130)));
      await ok(pin('adult', 'm2', papers.slice(130)));
      const merged = oneDrawer([{ id: 'm1', name: 'M1', filter: { category: 'tax' } }]);
      const at = await mine('adult');
      const over = await call('adult', 'PUT', '/api/v1/cabinet', {
        layout: merged,
        version: at.version,
        pins_moved: [{ from: 'm2', to: 'm1' }],
      });
      expect(over.statusCode, over.body).toBe(422);
      expect(over.json<{ error: { code: string } }>().error.code).toBe('cabinet_too_many_pins');
      expect((await mine('adult')).version).toBe(at.version);
      // Seventy of them made somebody else's Only me: what Sam cannot see is not counted.
      await asAdmin(
        "update document set visibility = 'private', owner_member_id = $2 where id = any($1::uuid[])",
        [papers.slice(0, 70), member('owner')],
      );
      await saved('adult', merged, { pins_moved: [{ from: 'm2', to: 'm1' }] });
      expect((await opened('adult', 'm1')).pinned).toHaveLength(190);
    });

    it('pins at once never pass the cap, and the same pin twice is one', async () => {
      await saved('teen', oneDrawer([{ id: 'race', name: 'Race', filter: { category: 'tax' } }]));
      const papers = await many(PIN_LIMITS.folder + 5, 'Race ');
      await ok(pin('teen', 'race', papers.slice(0, PIN_LIMITS.folder - 3)));
      const rest = papers.slice(PIN_LIMITS.folder - 3);
      const got = await Promise.all(rest.map((d) => pin('teen', 'race', [d])));
      expect(got.filter((r) => r.statusCode === 200)).toHaveLength(3);
      expect(got.filter((r) => r.statusCode === 422)).toHaveLength(rest.length - 3);
      const twice = await Promise.all(
        Array.from({ length: 6 }, () => pin('owner', 'care', [ids.high as string])),
      );
      expect(twice.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
      const rows = await asAdmin(
        "select count(*)::int as n from cabinet_pin where member_id = $1 and folder_id = 'care' and document_id = $2",
        [member('owner'), ids.high],
      );
      expect(rows.rows[0]?.n).toBe(1);
    });

    it('a pin and an unpin, or a pin and a save that takes its folder away, at once: never a pin left behind in no folder', async () => {
      for (let i = 0; i < 4; i++) {
        await saved(
          'owner',
          oneDrawer([{ id: 'race2', name: 'Race', filter: { category: 'tax' } }]),
        );
        const at = await mine('owner');
        const [pinned, put, unpinned] = await Promise.all([
          pin('owner', 'race2', [ids.middle as string]),
          call('owner', 'PUT', '/api/v1/cabinet', {
            layout: oneDrawer([{ id: 'race3', name: 'Other', filter: { category: 'tax' } }]),
            version: at.version,
          }),
          unpin('owner', 'race2', ids.middle as string),
        ]);
        expect([200, 404]).toContain(pinned.statusCode);
        expect(put.statusCode, put.body).toBe(200);
        expect(unpinned.statusCode).toBe(204);
        const left = await asAdmin(
          "select count(*)::int as n from cabinet_pin where member_id = $1 and folder_id = 'race2'",
          [member('owner')],
        );
        expect(left.rows[0]?.n).toBe(0);
      }
    });
  });

  describe('in the database, as the application role', () => {
    let one: Db;
    const principal = (who: Person, householdId = people[who].household_id) => ({
      householdId,
      accountId: accounts[who],
      memberId: people[who].member_id,
      role: people[who].role,
    });
    beforeAll(async () => {
      one = createDb(createPool(h.appUrl, 1));
      await saved('owner', oneDrawer([{ id: 'o', name: 'Olive’s', filter: {} }]));
      await saved('adult', oneDrawer([{ id: 's', name: 'Sam’s', filter: {} }]));
      await ok(pin('owner', 'o', [ids.high as string]));
      await ok(pin('adult', 's', [ids.high as string]));
    });
    afterAll(async () => {
      await one.destroy();
    });

    it('gives each person their own pins alone: an owner reads nobody else’s; another household none', async () => {
      for (const who of ['owner', 'adult', 'teen'] as Person[]) {
        const rows = await withPrincipal(one, principal(who), (trx) =>
          trx.selectFrom('cabinet_pin').select('member_id').execute(),
        );
        expect(
          rows.every((r) => r.member_id === member(who)),
          who,
        ).toBe(true);
      }
      const elsewhere = await withPrincipal(
        one,
        principal('owner', ids.otherHousehold as string),
        (trx) => trx.selectFrom('cabinet_pin').select('member_id').execute(),
      );
      expect(elsewhere).toEqual([]);
    });

    it('lets nobody write another’s: not an insert, an update, a delete or an upsert', async () => {
      const hh = people.owner.household_id;
      const row = (who: Person, folder: string) => ({
        household_id: hh,
        member_id: member(who),
        folder_id: folder,
        document_id: ids.middle as string,
      });
      await expect(
        withPrincipal(one, principal('adult'), (trx) =>
          trx.insertInto('cabinet_pin').values(row('owner', 'o')).execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      // PG 16: an upsert's conflicting row is held to the update rule too.
      await expect(
        withPrincipal(one, principal('adult'), (trx) =>
          trx
            .insertInto('cabinet_pin')
            .values({ ...row('owner', 'o'), document_id: ids.high as string })
            .onConflict((oc) =>
              oc
                .columns(['household_id', 'member_id', 'folder_id', 'document_id'])
                .doUpdateSet({ folder_id: 'taken' })
                .where('cabinet_pin.folder_id', '=', 'o'),
            )
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      const updated = await withPrincipal(one, principal('owner'), async (trx) =>
        Number(
          (
            await trx
              .updateTable('cabinet_pin')
              .set({ folder_id: 'moved' })
              .where('member_id', '=', member('adult'))
              .executeTakeFirst()
          ).numUpdatedRows,
        ),
      );
      expect(updated).toBe(0);
      const deleted = await withPrincipal(one, principal('owner'), async (trx) =>
        Number(
          (
            await trx
              .deleteFrom('cabinet_pin')
              .where('member_id', '=', member('adult'))
              .executeTakeFirst()
          ).numDeletedRows,
        ),
      );
      expect(deleted).toBe(0);
      // Into another household: refused.
      await expect(
        withPrincipal(one, principal('owner', ids.otherHousehold as string), (trx) =>
          trx.insertInto('cabinet_pin').values(row('owner', 'o')).execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      // Their own upsert, to their own row, is theirs to make.
      await withPrincipal(one, principal('adult'), (trx) =>
        trx
          .insertInto('cabinet_pin')
          .values({ ...row('adult', 's'), document_id: ids.high as string })
          .onConflict((oc) =>
            oc
              .columns(['household_id', 'member_id', 'folder_id', 'document_id'])
              .doUpdateSet({ pinned_at: new Date() })
              .where('cabinet_pin.folder_id', '=', 's'),
          )
          .execute(),
      );
      expect((await opened('adult', 's')).pinned.map((d) => d.title)).toEqual([
        'High school report',
      ]);
      expect((await opened('owner', 'o')).pinned.map((d) => d.title)).toEqual([
        'High school report',
      ]);
    });

    it('gives a caller who says nothing, or a link, no pin', async () => {
      const pool = createPool(h.appUrl, 1);
      try {
        for (const actor of ['', 'link', 'upload', 'anonymous']) {
          const client = await pool.connect();
          try {
            await client.query('begin');
            await client.query(
              `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true),
                      set_config('app.member_id', $3, true)`,
              [people.owner.household_id, actor, member('owner')],
            );
            const { rows } = await client.query<{ n: number }>(
              'select count(*)::int as n from cabinet_pin',
            );
            await client.query('rollback');
            expect(rows[0]?.n, actor).toBe(0);
          } finally {
            client.release();
          }
        }
      } finally {
        await pool.end();
      }
    });
  });
});
